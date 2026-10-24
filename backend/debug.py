"""Debug tools for the /debug page: show every decision A* made, and compare routes.

Reads routing.py and time_model.py but never changes them. The cost breakdown here
is checked against routing.edge_cost on every road, so if someone changes the cost
function and this file falls behind, the page shows a warning instead of lying.
"""

import math
import os
import time

import httpx
import numpy as np
from dotenv import load_dotenv
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import routing
import time_model

load_dotenv()

router = APIRouter(prefix="/debug")

LatLon = tuple[float, float]

# time_model's speed model uses different profile names from routing.py.
ETA_PROFILE = {"fast": "road", "regular": "commuter", "chill": "chill"}
MAIN_ROADS = {"trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link"}

# Pure distance: what a car-style "shortest route" would pick. No road preferences,
# no hills, no time of day.
SHORTEST_PROFILE = {"road_type_factors": {}, "surface_factors": {}, "hill_weight": 0}
NEUTRAL_CTX = {"wind_ms": 0, "wind_from_deg": 0, "rain_prob": 0, "rain_mm": 0,
               "dark": False, "rush": False}


class DebugRouteRequest(BaseModel):
    start: LatLon
    end: LatLon
    profile: str = "regular"
    depart_at: str | None = None
    profile_override: dict | None = None   # replaces routing.PROFILES[profile]
    ctx_override: dict | None = None       # e.g. {"dark": true, "wind_ms": 8}
    waypoints: list[LatLon] | None = None  # a route you draw, scored with our costs
    google: bool = False                   # also fetch Google's cycling route


# --- A* with a recorder ------------------------------------------------------

class TracingGraph:
    # Wraps the graph so we can see which junctions A* expanded, in order,
    # without touching routing.astar. A* calls successors() once per expanded node.
    def __init__(self, G):
        self.G = G
        self.nodes = G.nodes
        self.expanded = []

    def successors(self, node):
        self.expanded.append(node)
        return self.G.successors(node)

    def __getitem__(self, node):
        return self.G[node]


def traced_astar(start_node, end_node, profile, ctx):
    tg = TracingGraph(routing.GRAPH)
    t0 = time.perf_counter()
    path = routing.astar(tg, start_node, end_node, profile, ctx)
    ms = (time.perf_counter() - t0) * 1000
    return path, tg.expanded, ms


# --- Explaining one road -----------------------------------------------------

def edge_breakdown(edge, profile, ctx):
    # Same maths as routing.edge_cost, split into its parts.
    length = float(edge["length"])
    road_factor = profile["road_type_factors"].get(edge["highway"], 1.0)
    surface_factor = profile["surface_factors"].get(edge["surface"], 1.0)
    climb = max(float(edge["grade"]), 0) * length
    hill_penalty = profile["hill_weight"] * climb
    base = length * road_factor * surface_factor + hill_penalty
    tp = time_model.time_penalty(edge, ctx)
    cost = base * tp
    real = routing.edge_cost(edge, profile, ctx)
    return {
        "name": edge.get("name") or "",
        "highway": edge["highway"],
        "surface": edge["surface"],
        "lit": bool(edge["lit"]),
        "length_m": round(length, 1),
        "grade_pct": round(float(edge["grade"]) * 100, 1),
        "bearing": round(float(edge.get("bearing") or 0)),
        "road_factor": road_factor,
        "surface_factor": surface_factor,
        "hill_penalty": round(hill_penalty, 1),
        "base_cost": round(base, 1),
        "time_penalty": round(tp, 3),
        "headwind_ms": round(time_model.headwind(edge.get("bearing"), ctx), 2),
        "cost": round(real, 1),
        "cost_per_m": round(real / length, 3) if length else 0,
        "matches_edge_cost": math.isclose(cost, real, rel_tol=1e-6, abs_tol=1e-6),
    }


def edge_coords(G, a, b, edge):
    # The road's real shape if the graph has it, else a straight line.
    geom = edge.get("geometry")
    if geom is not None:
        pts = [[float(y), float(x)] for x, y in geom.coords]
        # make sure it runs a -> b
        ay, ax = G.nodes[a]["y"], G.nodes[a]["x"]
        if routing.haversine_m(ay, ax, pts[0][0], pts[0][1]) > routing.haversine_m(ay, ax, pts[-1][0], pts[-1][1]):
            pts.reverse()
        return pts
    return [[float(G.nodes[a]["y"]), float(G.nodes[a]["x"])],
            [float(G.nodes[b]["y"]), float(G.nodes[b]["x"])]]


def describe_path(path, profile, ctx, eta_profile):
    # Everything about one route, scored with the given profile and context.
    G = routing.GRAPH
    edges, rows = [], []
    for a, b in zip(path, path[1:]):
        edge, _ = routing.cheapest_edge(G, a, b, profile, ctx)
        edges.append(edge)
        row = edge_breakdown(edge, profile, ctx)
        row["coords"] = edge_coords(G, a, b, edge)
        rows.append(row)

    dist = sum(r["length_m"] for r in rows) or 1.0

    def share(test):
        return round(sum(r["length_m"] for r in rows if test(r)) / dist, 3)

    elev = [float(G.nodes[n]["elevation"]) for n in path]
    climb = sum(max(b - a, 0) for a, b in zip(elev, elev[1:]))

    by_highway = {}
    for r in rows:
        h = by_highway.setdefault(r["highway"], {"length_m": 0.0, "cost": 0.0})
        h["length_m"] += r["length_m"]
        h["cost"] += r["cost"]

    try:
        eta = round(time_model.eta_minutes(edges, ctx, eta_profile), 1)
    except Exception as e:  # the ETA model is still being written
        eta = None
        print(f"debug: eta_minutes failed: {e!r}")

    return {
        "edges": rows,
        "elevations_m": [round(e, 1) for e in elev],
        "summary": {
            "distance_m": round(dist),
            "climb_m": round(climb),
            "cost": round(sum(r["cost"] for r in rows)),
            "eta_min": eta,
            "cycleway_share": share(lambda r: r["highway"] == "cycleway"),
            "main_road_share": share(lambda r: r["highway"] in MAIN_ROADS),
            "lit_share": share(lambda r: r["lit"]),
            "rough_surface_share": share(lambda r: r["surface"] != "asphalt"),
            "max_grade_pct": max([r["grade_pct"] for r in rows], default=0),
            "turns": count_turns(rows),
        },
        "by_highway": {k: {"length_m": round(v["length_m"]), "cost": round(v["cost"])}
                       for k, v in sorted(by_highway.items(), key=lambda kv: -kv[1]["length_m"])},
        "cost_check_ok": all(r["matches_edge_cost"] for r in rows),
    }


def count_turns(rows):
    # Rough count of real turns (bearing change over 45 degrees between named roads),
    # so a twisty back-street route shows up next to a straight main road.
    turns = 0
    for prev, cur in zip(rows, rows[1:]):
        d = abs((cur["bearing"] - prev["bearing"] + 180) % 360 - 180)
        if d > 45 and prev["length_m"] > 5:
            turns += 1
    return turns


# --- Snapping other routes onto our graph -------------------------------------

_node_index = None


def node_index():
    global _node_index
    if _node_index is None:
        G = routing.GRAPH
        ids = list(G.nodes)
        _node_index = (ids,
                       np.array([G.nodes[n]["y"] for n in ids]),
                       np.array([G.nodes[n]["x"] for n in ids]))
    return _node_index


def nearest_node_fast(lat, lon):
    ids, lats, lons = node_index()
    # flat-earth distance is fine at city scale
    dy = (lats - lat) * 111_320
    dx = (lons - lon) * 111_320 * math.cos(math.radians(lat))
    d2 = dx * dx + dy * dy
    i = int(np.argmin(d2))
    return ids[i], math.sqrt(d2[i])


def shortest_between(a, b):
    if a == b:
        return [a]
    return routing.astar(routing.GRAPH, a, b, SHORTEST_PROFILE, NEUTRAL_CTX)


def join_nodes(nodes):
    # Connect a list of nodes into one path with shortest-distance hops,
    # then cut out loops (a wrong snap to a side street shows up as a there-and-back).
    path = [nodes[0]]
    for n in nodes[1:]:
        hop = shortest_between(path[-1], n)
        if hop is None:
            continue
        path.extend(hop[1:])
    clean, seen = [], {}
    for n in path:
        if n in seen:
            cut = seen[n]
            for dropped in clean[cut + 1:]:
                seen.pop(dropped, None)
            clean = clean[:cut + 1]
        else:
            seen[n] = len(clean)
            clean.append(n)
    return clean


def densify(points, step_m=15):
    out = [points[0]]
    for (la1, lo1), (la2, lo2) in zip(points, points[1:]):
        d = routing.haversine_m(la1, lo1, la2, lo2)
        k = max(1, int(d // step_m))
        for i in range(1, k + 1):
            out.append((la1 + (la2 - la1) * i / k, lo1 + (lo2 - lo1) * i / k))
    return out


def match_polyline(points, start_node, end_node, max_snap_m=25):
    # Turn someone else's line (e.g. Google's) into a path on our graph.
    nodes = [start_node]
    for lat, lon in densify(points):
        n, d = nearest_node_fast(lat, lon)
        if d <= max_snap_m and n != nodes[-1]:
            nodes.append(n)
    nodes.append(end_node)
    return join_nodes(nodes)


# --- Google --------------------------------------------------------------------

_google_cache = {}


def decode_polyline(s):
    pts, i, lat, lon = [], 0, 0, 0
    while i < len(s):
        for which in (0, 1):
            shift = result = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if which == 0:
                lat += delta
            else:
                lon += delta
        pts.append((lat / 1e5, lon / 1e5))
    return pts


def google_route(start, end):
    # Google's bicycle route (Routes API). Needs GOOGLE_MAPS_API_KEY.
    # Cached so tweaking the profile sliders doesn't run up the bill.
    key = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not key:
        return None, "Set GOOGLE_MAPS_API_KEY in backend/.env to fetch Google's route."
    cache_key = (round(start[0], 5), round(start[1], 5), round(end[0], 5), round(end[1], 5))
    if cache_key in _google_cache:
        return _google_cache[cache_key], None

    def loc(p):
        return {"location": {"latLng": {"latitude": p[0], "longitude": p[1]}}}

    try:
        r = httpx.post(
            "https://routes.googleapis.com/directions/v2:computeRoutes",
            headers={"X-Goog-Api-Key": key,
                     "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline"},
            json={"origin": loc(start), "destination": loc(end), "travelMode": "BICYCLE"},
            timeout=10,
        )
        r.raise_for_status()
        routes = r.json().get("routes") or []
    except httpx.HTTPStatusError as e:
        return None, f"Google returned {e.response.status_code}: {e.response.text[:200]}"
    except httpx.HTTPError as e:
        return None, f"Google request failed: {e!r}"
    if not routes:
        return None, "Google found no bicycle route."
    g = routes[0]
    out = {
        "points": decode_polyline(g["polyline"]["encodedPolyline"]),
        "distance_m": g.get("distanceMeters"),
        "duration_min": round(int(g.get("duration", "0s").rstrip("s")) / 60, 1),
    }
    _google_cache[cache_key] = out
    return out, None


# --- Endpoints -------------------------------------------------------------------

@router.get("/profiles")
def profiles() -> dict:
    # The current profiles plus every road type in the graph (by total length),
    # so the page can offer a factor for each one.
    if routing.GRAPH is None:
        raise HTTPException(503, "graph not loaded")
    lengths = {}
    surfaces = set()
    for _, _, d in routing.GRAPH.edges(data=True):
        lengths[d["highway"]] = lengths.get(d["highway"], 0) + float(d["length"])
        surfaces.add(d["surface"])
    return {
        "profiles": routing.PROFILES,
        "highways": [{"highway": h, "km": round(m / 1000, 1)}
                     for h, m in sorted(lengths.items(), key=lambda kv: -kv[1])],
        "surfaces": sorted(surfaces),
        "google_enabled": bool(os.environ.get("GOOGLE_MAPS_API_KEY")),
    }


@router.post("/route")
def debug_route(req: DebugRouteRequest) -> dict:
    import main  # for main.get_ctx (weather + time of day), imported here to avoid a cycle

    G = routing.GRAPH
    if G is None:
        raise HTTPException(503, "graph not loaded: run python build_graph.py")
    if req.profile not in routing.PROFILES:
        raise HTTPException(422, f"unknown profile {req.profile!r}")

    warnings = []
    profile = req.profile_override or routing.PROFILES[req.profile]
    real_ctx = main.get_ctx(req.depart_at)
    ctx = {**real_ctx, **(req.ctx_override or {})}
    eta_profile = ETA_PROFILE.get(req.profile, "commuter")

    start_node, start_snap = nearest_node_fast(*req.start)
    end_node, end_snap = nearest_node_fast(*req.end)
    for label, d in (("Start", start_snap), ("End", end_snap)):
        if d > 50:
            warnings.append(f"{label} point is {d:.0f} m from the nearest junction in the graph.")

    def coord(n):
        return [float(G.nodes[n]["y"]), float(G.nodes[n]["x"])]

    routes = []

    # 1. ours, with the A* trace
    path, expanded, ms = traced_astar(start_node, end_node, profile, ctx)
    if path is None:
        raise HTTPException(404, "no route found")
    ours = describe_path(path, profile, ctx, eta_profile)
    ours.update({
        "id": "ours", "label": f"OxRide ({req.profile})",
        "astar": {"expanded_count": len(expanded), "ms": round(ms, 1),
                  "expanded": [coord(n) for n in expanded],
                  "graph_nodes": G.number_of_nodes()},
    })
    routes.append(ours)
    if not ours["cost_check_ok"]:
        warnings.append("Debug cost breakdown no longer matches routing.edge_cost: update debug.edge_breakdown.")

    # 2. shortest distance (car-style baseline), scored with OUR costs so they compare
    sp, sp_expanded, sp_ms = traced_astar(start_node, end_node, SHORTEST_PROFILE, NEUTRAL_CTX)
    if sp:
        r = describe_path(sp, profile, ctx, eta_profile)
        r.update({"id": "shortest", "label": "Shortest distance",
                  "astar": {"expanded_count": len(sp_expanded), "ms": round(sp_ms, 1)}})
        routes.append(r)

    # 3. Google's bicycle route, snapped onto our graph
    google_error = None
    if req.google:
        g, google_error = google_route(req.start, req.end)
        if g:
            gp = match_polyline(g["points"], start_node, end_node)
            r = describe_path(gp, profile, ctx, eta_profile)
            r.update({"id": "google", "label": "Google (bicycle)",
                      "google": {"distance_m": g["distance_m"], "duration_min": g["duration_min"],
                                 "points": [list(p) for p in g["points"]]}})
            routes.append(r)
            matched = r["summary"]["distance_m"]
            if g["distance_m"] and abs(matched - g["distance_m"]) > 0.15 * g["distance_m"]:
                warnings.append(f"Google route snapped to our graph is {matched} m vs Google's {g['distance_m']} m: "
                                "the match may be off, check the red line against the dashed one.")
        else:
            warnings.append(google_error)

    # 4. a route you drew: start -> your waypoints -> end, shortest hops between clicks
    if req.waypoints:
        nodes = [start_node] + [nearest_node_fast(*p)[0] for p in req.waypoints] + [end_node]
        dp = join_nodes(nodes)
        r = describe_path(dp, profile, ctx, eta_profile)
        r.update({"id": "drawn", "label": "Your drawn route"})
        routes.append(r)

    # A* should never lose on its own cost function. If it does, the heuristic or the
    # search has a bug (all routes share the same start and end node, so this is fair).
    best = ours["summary"]["cost"]
    for r in routes[1:]:
        if r["summary"]["cost"] < best - 1:
            warnings.append(f"{r['label']} costs {r['summary']['cost']} under our own cost function, "
                            f"less than OxRide's {best}. A* should never lose here: check the heuristic.")

    # Does darkness change anything? Compare a lit and an unlit road under this context.
    if ctx.get("dark"):
        road = {"highway": "residential", "surface": "asphalt", "bearing": None, "length": 1, "grade": 0}
        if time_model.time_penalty({**road, "lit": False}, ctx) == time_model.time_penalty({**road, "lit": True}, ctx):
            warnings.append("It's dark, but time_penalty treats unlit roads the same as lit ones, "
                            "so the night route can't differ from the day route.")

    return {
        "ctx": ctx,
        "ctx_from_weather": real_ctx,
        "profile_used": profile,
        "start_node": {"id": int(start_node), "snap_m": round(start_snap, 1), "coord": coord(start_node)},
        "end_node": {"id": int(end_node), "snap_m": round(end_snap, 1), "coord": coord(end_node)},
        "routes": routes,
        "warnings": warnings,
    }
