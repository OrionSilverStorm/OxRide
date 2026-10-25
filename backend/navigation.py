"""Turn-by-turn steps from a route.

build_steps(G, path) turns the list of node ids from A* into instructions:
    {text, distance_m, lat, lon, maneuver}
- lat, lon:    where the maneuver happens (the junction).
- distance_m:  how far you ride after it, until the next step.
- maneuver:    left | right | straight | arrive (the frontend picks the arrow from this).

How it decides:
- Each road leaving a junction is compared with the road arriving there. The turn angle
  uses the road's real shape near the junction, not the straight line between its ends.
- A new step starts when the road changes (different name, or a different kind of
  unnamed road) or when you turn at a real junction. If the road just bends and there is
  nowhere else to go, no instruction.
- Roundabouts become one step: "At the roundabout, take the 2nd exit onto ...".
- Pure: no network, so it can be tested on a small graph.
"""

import math

STRAIGHT_DEG = 30   # turns smaller than this are "straight"
TURN_DEG = 45       # on the same road, only bends bigger than this get an instruction
SHARP_DEG = 135     # "sharp left/right"
JOG_M = 15          # a step shorter than this is joined to the next one ("..., then turn left ...")
QUIET_M = 40        # "Continue onto X" shorter than this is not worth saying

# What to call a road with no name.
UNNAMED = {
    "cycleway": "the cycle path",
    "path": "the path",
    "footway": "the footpath",
    "pedestrian": "the pedestrian street",
    "track": "the track",
    "bridleway": "the bridleway",
    "service": "the service road",
    "living_street": "the street",
}

COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]
ORDINALS = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"]


def _bearing(p, q):
    # Compass bearing in degrees from point p to q, both (lat, lon).
    lat1, lat2 = math.radians(p[0]), math.radians(q[0])
    dlon = math.radians(q[1] - p[1])
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def _turn(bearing_in, bearing_out):
    # Signed turn in degrees: positive = right, negative = left, range -180..180.
    return (bearing_out - bearing_in + 540) % 360 - 180


def _shape(G, a, b, edge):
    # The road's points from a to b as (lat, lon). Uses the road's real shape if known.
    start = (G.nodes[a]["y"], G.nodes[a]["x"])
    end = (G.nodes[b]["y"], G.nodes[b]["x"])
    geom = edge.get("geometry")
    if geom is None:
        return [start, end]
    pts = [(y, x) for x, y in geom.coords]
    if math.dist(pts[0], start) > math.dist(pts[-1], start):
        pts.reverse()
    return pts


def _first(v):
    return v[0] if isinstance(v, list) else v


def _road_name(edge):
    name = _first(edge.get("name")) or ""
    if name:
        return name
    return UNNAMED.get(_first(edge.get("highway")), "the road")


def _is_roundabout(edge):
    return _first(edge.get("junction")) in ("roundabout", "circular")


def _legs(G, path):
    # One entry per road along the path, with its bearings where it starts and ends.
    legs = []
    for a, b in zip(path, path[1:]):
        edge = min(G[a][b].values(), key=lambda d: d.get("length", 0))
        pts = _shape(G, a, b, edge)
        legs.append({
            "a": a, "b": b,
            "name": _road_name(edge),
            "named": bool(_first(edge.get("name"))),
            "length": float(edge.get("length", 0)),
            "start_bearing": _bearing(pts[0], pts[1]),
            "end_bearing": _bearing(pts[-2], pts[-1]),
            "roundabout": _is_roundabout(edge),
        })
    return legs


def _choices(G, node, came_from):
    # How many roads you could take from this junction (not counting going back).
    return sum(1 for n in G.successors(node) if n != came_from)


def _turn_words(delta):
    if abs(delta) < STRAIGHT_DEG:
        return "straight", "Continue"
    side = "right" if delta > 0 else "left"
    if abs(delta) >= SHARP_DEG:
        return side, f"Turn sharp {side}"
    if abs(delta) < 60:
        return side, f"Bear {side}"
    return side, f"Turn {side}"


def _step(text, maneuver, G, node, distance=0.0):
    return {"text": text, "distance_m": distance, "lat": float(G.nodes[node]["y"]),
            "lon": float(G.nodes[node]["x"]), "maneuver": maneuver}


def build_steps(G, path):
    """Each step: {text, distance_m, lat, lon, maneuver}; maneuver is left|right|straight|arrive."""
    if not path:
        return []
    if len(path) == 1:
        return [_step("You have arrived", "arrive", G, path[0])]

    legs = _legs(G, path)
    first = legs[0]
    heading = COMPASS[round(first["start_bearing"] / 45) % 8]
    steps = [_step(f"Head {heading} on {first['name']}", "straight", G, first["a"], first["length"])]
    current = first["name"]

    i = 1
    while i < len(legs):
        prev, leg = legs[i - 1], legs[i]

        if leg["roundabout"]:
            # Ride round until we leave, counting the exits we pass.
            entry_bearing = prev["end_bearing"]
            entry_node = leg["a"]
            length = 0.0
            exits = 0
            while i < len(legs) and legs[i]["roundabout"]:
                length += legs[i]["length"]
                node = legs[i]["b"]
                # an exit = a road off the roundabout at this node
                if any(not _is_roundabout(d) for n in G.successors(node)
                       for d in G[node][n].values()):
                    exits += 1
                i += 1
            if i < len(legs):
                out = legs[i]
                maneuver, _ = _turn_words(_turn(entry_bearing, out["start_bearing"]))
                nth = ORDINALS[min(max(exits, 1), len(ORDINALS)) - 1]
                steps.append(_step(f"At the roundabout, take the {nth} exit onto {out['name']}",
                                   maneuver, G, entry_node, length + out["length"]))
                current = out["name"]
                i += 1
            else:
                steps[-1]["distance_m"] += length  # route ends on the roundabout
            continue

        delta = _turn(prev["end_bearing"], leg["start_bearing"])
        same_road = leg["name"] == current
        real_junction = _choices(G, leg["a"], prev["a"]) > 1

        if same_road and (abs(delta) < TURN_DEG or not real_junction):
            steps[-1]["distance_m"] += leg["length"]  # just keep going
        elif not real_junction:
            # The road changes name but there is nowhere else to go.
            steps.append(_step(f"Continue onto {leg['name']}", "straight", G, leg["a"], leg["length"]))
            current = leg["name"]
        else:
            maneuver, verb = _turn_words(delta)
            if same_road:
                text = f"{verb} to stay on {leg['name']}"
            elif maneuver == "straight":
                text = f"Continue onto {leg['name']}"
            else:
                text = f"{verb} onto {leg['name']}"
            steps.append(_step(text, maneuver, G, leg["a"], leg["length"]))
            current = leg["name"]
        i += 1

    steps.append(_step("You have arrived", "arrive", G, path[-1]))
    steps = _tidy(steps)
    for s in steps:
        s["distance_m"] = round(s["distance_m"])
    return steps


def _tidy(steps):
    # Make the list nicer to hear while riding:
    # - a short "Continue onto X" (a road just changing name) is folded into the step before
    # - a very short step is joined to the next: "Turn right onto A, then turn left onto B"
    out = []
    joined = set()  # ids of steps that already hold two actions
    for s in steps:
        prev = out[-1] if out else None
        if (prev and s["maneuver"] == "straight" and s["text"].startswith("Continue onto")
                and s["distance_m"] < QUIET_M):
            prev["distance_m"] += s["distance_m"]
            continue
        if (prev and s["maneuver"] != "arrive" and prev["distance_m"] < JOG_M
                and id(prev) not in joined):
            prev["text"] = f"{prev['text']}, then {s['text'][0].lower()}{s['text'][1:]}"
            prev["distance_m"] += s["distance_m"]
            joined.add(id(prev))
            continue
        out.append(s)
    return out
