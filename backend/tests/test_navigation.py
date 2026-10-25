"""Turn-by-turn steps: right/left/straight, name changes, roundabouts, real routes."""

import networkx as nx
import pytest

import navigation
import routing
from conftest import CALM_DAY, PLACES, TRIPS

# Small made-up street grids. ~0.001 degrees is roughly 100 m.
M = 0.001


def grid(nodes, roads):
    # nodes: {id: (lat, lon)}; roads: [(a, b, name, highway, extra)], added both ways.
    G = nx.MultiDiGraph()
    for n, (lat, lon) in nodes.items():
        G.add_node(n, y=lat, x=lon, elevation=0.0)
    for a, b, name, highway, *extra in roads:
        attrs = {"name": name, "highway": highway, "length": 100.0, **(extra[0] if extra else {})}
        G.add_edge(a, b, **attrs)
        if not attrs.get("oneway"):
            G.add_edge(b, a, **attrs)
    return G


def crossroads():
    #        3
    #        |
    #  4 --- 2 --- 5      riding 1 -> 2 heads north
    #        |
    #        1
    nodes = {1: (0, 0), 2: (M, 0), 3: (2 * M, 0), 4: (M, -M), 5: (M, M)}
    roads = [(1, 2, "Main Street", "residential"), (2, 3, "Main Street", "residential"),
             (2, 4, "West Road", "residential"), (2, 5, "East Road", "residential")]
    return grid(nodes, roads)


def test_turn_right():
    steps = navigation.build_steps(crossroads(), [1, 2, 5])
    assert [s["maneuver"] for s in steps] == ["straight", "right", "arrive"]
    assert steps[0]["text"] == "Head north on Main Street"
    assert steps[1]["text"] == "Turn right onto East Road"


def test_turn_left():
    steps = navigation.build_steps(crossroads(), [1, 2, 4])
    assert [s["maneuver"] for s in steps] == ["straight", "left", "arrive"]
    assert "left onto West Road" in steps[1]["text"]


def test_straight_on_same_road_is_one_step():
    steps = navigation.build_steps(crossroads(), [1, 2, 3])
    assert [s["maneuver"] for s in steps] == ["straight", "arrive"]
    assert steps[0]["distance_m"] == 200


def test_step_position_is_the_junction():
    steps = navigation.build_steps(crossroads(), [1, 2, 5])
    assert (steps[1]["lat"], steps[1]["lon"]) == (M, 0)
    assert (steps[-1]["lat"], steps[-1]["lon"]) == (M, M)


def test_name_change_with_nowhere_else_to_go():
    nodes = {1: (0, 0), 2: (M, 0), 3: (2 * M, 0)}
    G = grid(nodes, [(1, 2, "Long Road", "residential"), (2, 3, "Bridge Street", "residential")])
    steps = navigation.build_steps(G, [1, 2, 3])
    assert steps[1]["maneuver"] == "straight"
    assert steps[1]["text"] == "Continue onto Bridge Street"


def test_unnamed_roads_get_a_description():
    nodes = {1: (0, 0), 2: (M, 0), 3: (M, M), 4: (2 * M, 0)}
    G = grid(nodes, [(1, 2, "", "residential"), (2, 3, "", "cycleway"), (2, 4, "", "residential")])
    steps = navigation.build_steps(G, [1, 2, 3])
    assert steps[0]["text"] == "Head north on the road"
    assert steps[1]["text"] == "Turn right onto the cycle path"


def test_roundabout_counts_exits():
    # A square one-way roundabout (clockwise, as in the UK) with four arms.
    #            N(10)
    #            |
    #   W(13) - [a b] - E(11)      entering from S, leaving at E = 2nd exit
    #           [d c]
    #            |
    #            S(12)
    nodes = {"a": (M, 0), "b": (M, M), "c": (0, M), "d": (0, 0),
             10: (3 * M, 0), 11: (M, 3 * M), 12: (-2 * M, 0), 13: (0, -2 * M)}
    rb = {"junction": "roundabout", "oneway": True}
    roads = [("d", "a", "", "primary", rb), ("a", "b", "", "primary", rb),
             ("b", "c", "", "primary", rb), ("c", "d", "", "primary", rb),
             (12, "d", "South Road", "primary"), ("a", 10, "North Road", "primary"),
             ("b", 11, "East Road", "primary"), ("c", 13, "West Road", "primary")]
    G = grid(nodes, roads)
    steps = navigation.build_steps(G, [12, "d", "a", "b", 11])
    assert steps[1]["text"] == "At the roundabout, take the 2nd exit onto East Road"
    assert steps[1]["maneuver"] == "right"


def test_tiny_jog_becomes_one_instruction():
    # North on Lane A, right onto Cross Road for 10 m, then left onto Lane B: say it once.
    #   5     4
    #   |     |
    #   2 -- 3 ---- 7
    #   |
    #   1
    nodes = {1: (0, 0), 2: (M, 0), 3: (M, M / 10), 4: (2 * M, M / 10), 5: (2 * M, 0), 7: (M, M)}
    G = grid(nodes, [(1, 2, "Lane A", "residential"), (2, 5, "Lane A", "residential"),
                     (2, 3, "Cross Road", "residential", {"length": 10.0}),
                     (3, 7, "Cross Road", "residential"), (3, 4, "Lane B", "residential")])
    steps = navigation.build_steps(G, [1, 2, 3, 4])
    assert len(steps) == 3
    assert steps[1]["text"] == "Turn right onto Cross Road, then turn left onto Lane B"


def test_empty_and_single_node_paths():
    G = crossroads()
    assert navigation.build_steps(G, []) == []
    assert [s["maneuver"] for s in navigation.build_steps(G, [1])] == ["arrive"]


@pytest.mark.parametrize("a,b", TRIPS)
def test_real_route_steps_add_up(a, b):
    r = routing.find_route(PLACES[a], PLACES[b], "regular", CALM_DAY)
    steps = r["steps"]
    assert steps[-1]["maneuver"] == "arrive"
    assert all(s["maneuver"] in ("left", "right", "straight", "arrive") for s in steps)
    assert all(set(s) == {"text", "distance_m", "lat", "lon", "maneuver"} for s in steps)
    assert sum(s["distance_m"] for s in steps) == pytest.approx(r["stats"]["distance_m"], abs=len(steps))
    assert [steps[0]["lat"], steps[0]["lon"]] == r["route"][0]
    # every step after the first is a real instruction, not a 0 m blip
    assert all(s["distance_m"] > 0 for s in steps[:-1])


def test_the_plain_roundabout():
    # Station -> Iffley Road goes round The Plain: Iffley Road is the 3rd exit from Magdalen Bridge.
    r = routing.find_route(PLACES["Station"], PLACES["Iffley Road sports"], "fast", CALM_DAY)
    texts = [s["text"] for s in r["steps"]]
    assert "At the roundabout, take the 3rd exit onto Iffley Road" in texts
