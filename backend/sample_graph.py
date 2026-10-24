# A small fake graph with the same attributes build_graph.py will produce,
# so routing.py can be written and tested before the real Oxford download exists.
#
# Run it:  python sample_graph.py
#
# Nodes:  y (lat), x (lon), elevation (m)
# Edges:  length (m), highway, surface, lit (bool), name, bearing (deg), grade (rise/length)
#
# Four ways to get from START to END:
#   Main Road    short, flat, busy main road ("primary")
#   Hill Lane    short, quiet, but steep
#   River Path   long cycleway, the first part is unlit
#   Quiet Street long, flat, lit residential street

import math

import networkx as nx

from routing import haversine_m

START = (51.7500, -1.2700)
END = (51.7600, -1.2500)


def bearing_deg(lat1, lon1, lat2, lon2):
    # Compass direction (0-360, 0 = north) from point 1 to point 2.
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dlambda = math.radians(lon2 - lon1)
    y = math.sin(dlambda) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dlambda)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def add_road(G, a, b, highway, surface, lit, name):
    # Add a two-way road. Length, bearing and grade are worked out from the nodes,
    # the same way build_graph.py will do it.
    na, nb = G.nodes[a], G.nodes[b]
    length = haversine_m(na["y"], na["x"], nb["y"], nb["x"])
    forward = bearing_deg(na["y"], na["x"], nb["y"], nb["x"])
    grade = (nb["elevation"] - na["elevation"]) / length
    facts = dict(length=length, highway=highway, surface=surface, lit=lit, name=name)
    G.add_edge(a, b, bearing=forward, grade=grade, **facts)
    G.add_edge(b, a, bearing=(forward + 180) % 360, grade=-grade, **facts)


def build_sample_graph():
    G = nx.MultiDiGraph()

    #  id      lat       lon      elevation
    nodes = {
        "S":  (51.7500, -1.2700, 60),   # start
        "E":  (51.7600, -1.2500, 60),   # end
        "M1": (51.7520, -1.2640, 60),   # Main Road
        "M2": (51.7570, -1.2560, 61),
        "H1": (51.7550, -1.2640, 105),  # Hill Lane (45 m climb)
        "C1": (51.7490, -1.2600, 59),   # River Path
        "C2": (51.7515, -1.2500, 59),
        "Q1": (51.7560, -1.2700, 62),   # Quiet Street
        "Q2": (51.7590, -1.2600, 62),
    }
    for node, (lat, lon, elevation) in nodes.items():
        G.add_node(node, y=lat, x=lon, elevation=elevation)

    # Main Road: primary, lit, asphalt
    add_road(G, "S", "M1", "primary", "asphalt", True, "Main Road")
    add_road(G, "M1", "M2", "primary", "asphalt", True, "Main Road")
    add_road(G, "M2", "E", "primary", "asphalt", True, "Main Road")

    # Hill Lane: residential, lit, steep
    add_road(G, "S", "H1", "residential", "asphalt", True, "Hill Lane")
    add_road(G, "H1", "E", "residential", "asphalt", True, "Hill Lane")

    # River Path: cycleway, the first stretch has no street lights
    add_road(G, "S", "C1", "cycleway", "asphalt", False, "River Path")
    add_road(G, "C1", "C2", "cycleway", "asphalt", True, "River Path")
    add_road(G, "C2", "E", "cycleway", "asphalt", True, "River Path")

    # Quiet Street: residential, lit, flat
    add_road(G, "S", "Q1", "residential", "asphalt", True, "Quiet Street")
    add_road(G, "Q1", "Q2", "residential", "asphalt", True, "Quiet Street")
    add_road(G, "Q2", "E", "residential", "asphalt", True, "Quiet Street")

    return G


if __name__ == "__main__":
    import routing
    import time_model

    routing.set_graph(build_sample_graph())

    # time_model.time_penalty is still a stub that returns 1.0, so fake the night rule
    # here: unlit roads cost 3x after dark.
    def fake_time_penalty(edge, ctx):
        if ctx["is_dark"] and not edge["lit"]:
            return 3.0
        return 1.0

    time_model.time_penalty = fake_time_penalty

    day = {"hour": 13, "is_dark": False}
    night = {"hour": 23, "is_dark": True}

    for profile in routing.PROFILES:
        for label, ctx in (("day", day), ("night", night)):
            path = routing.find_path(START, END, profile, ctx)
            street = routing.GRAPH["S"][path[1]][0]["name"]
            result = routing.find_route(START, END, profile, ctx)
            s = result["stats"]
            print(f"{profile:8} {label:6} -> {street:13} "
                  f"{s['distance_m']} m, climb {s['climb_m']} m, "
                  f"cycleway {s['cycleway_share']}, lit {s['lit_share']}")
