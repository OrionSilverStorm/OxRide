"""Routing: A* finds sensible, optimal routes and the profiles behave as described."""

import heapq
import math

import pytest

import routing
from conftest import CALM_DAY, PLACES, TRIPS

MAIN_ROADS = {"trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link"}


def path_edges(path, profile):
    return [routing.cheapest_edge(routing.GRAPH, a, b, profile, CALM_DAY)[0]
            for a, b in zip(path, path[1:])]


def share(edges, test):
    total = sum(e["length"] for e in edges)
    return sum(e["length"] for e in edges if test(e)) / total


def dijkstra_cost(start, goal, profile, ctx):
    # Plain Dijkstra with the same edge costs: the true cheapest cost.
    G = routing.GRAPH
    best = {start: 0.0}
    todo = [(0.0, start)]
    while todo:
        cost, node = heapq.heappop(todo)
        if node == goal:
            return cost
        if cost > best.get(node, math.inf):
            continue
        for nxt in G.successors(node):
            c = cost + routing.cheapest_edge(G, node, nxt, profile, ctx)[1]
            if c < best.get(nxt, math.inf):
                best[nxt] = c
                heapq.heappush(todo, (c, nxt))
    return None


def path_cost(path, profile, ctx):
    return sum(routing.cheapest_edge(routing.GRAPH, a, b, profile, ctx)[1]
               for a, b in zip(path, path[1:]))


@pytest.mark.parametrize("a,b", TRIPS)
def test_route_found_and_shaped_right(a, b):
    r = routing.find_route(PLACES[a], PLACES[b], "regular", CALM_DAY)
    assert len(r["route"]) >= 2
    assert all(len(p) == 2 for p in r["route"])
    assert len(r["elevations_m"]) == len(r["route"])
    # starts and ends near where we asked (snapped to the nearest junction)
    assert routing.haversine_m(*PLACES[a], *r["route"][0]) < 150
    assert routing.haversine_m(*PLACES[b], *r["route"][-1]) < 150
    s = r["stats"]
    assert set(s) == {"distance_m", "climb_m", "eta_min", "cycleway_share", "lit_share", "learned_share"}
    assert s["distance_m"] > 0 and s["eta_min"] > 0
    assert 0 <= s["cycleway_share"] <= 1 and 0 <= s["lit_share"] <= 1


@pytest.mark.parametrize("profile", ["fast", "regular", "chill"])
@pytest.mark.parametrize("a,b", TRIPS[:3])
def test_astar_finds_the_cheapest_route(a, b, profile):
    # If the heuristic ever overestimates, A* returns a worse route than Dijkstra.
    p = routing.PROFILES[profile]
    s = routing.nearest_node(routing.GRAPH, *PLACES[a])
    e = routing.nearest_node(routing.GRAPH, *PLACES[b])
    path = routing.astar(routing.GRAPH, s, e, p, CALM_DAY)
    assert path[0] == s and path[-1] == e
    assert path_cost(path, p, CALM_DAY) == pytest.approx(dijkstra_cost(s, e, p, CALM_DAY), rel=1e-9)


def test_regular_avoids_main_roads_compared_to_shortest():
    shortest = {"road_type_factors": {}, "surface_factors": {}, "hill_weight": 0}
    ours, short = [], []
    for a, b in TRIPS:
        s = routing.nearest_node(routing.GRAPH, *PLACES[a])
        e = routing.nearest_node(routing.GRAPH, *PLACES[b])
        ours += path_edges(routing.astar(routing.GRAPH, s, e, routing.PROFILES["regular"], CALM_DAY),
                           routing.PROFILES["regular"])
        short += path_edges(routing.astar(routing.GRAPH, s, e, shortest, CALM_DAY), shortest)
    main = lambda e: e["highway"] in MAIN_ROADS  # noqa: E731
    cyc = lambda e: e["highway"] == "cycleway"  # noqa: E731
    assert share(ours, main) < 0.15
    assert share(ours, main) < share(short, main) / 2
    assert share(ours, cyc) > share(short, cyc)
    # ...without silly detours
    assert sum(e["length"] for e in ours) < 1.35 * sum(e["length"] for e in short)


def test_profiles_get_calmer_from_fast_to_chill():
    main = {}
    for name in ("fast", "regular", "chill"):
        edges = []
        for a, b in TRIPS:
            r = routing.find_path(PLACES[a], PLACES[b], name, CALM_DAY)
            edges += path_edges(r, routing.PROFILES[name])
        main[name] = share(edges, lambda e: e["highway"] in MAIN_ROADS)
    assert main["chill"] <= main["regular"] <= main["fast"]


def test_chill_stays_off_the_ring_road():
    for a, b in TRIPS:
        path = routing.find_path(PLACES[a], PLACES[b], "chill", CALM_DAY)
        assert not any(e["highway"] in ("trunk", "trunk_link")
                       for e in path_edges(path, routing.PROFILES["chill"]))


def edge(**kw):
    base = {"length": 100.0, "highway": "residential", "surface": "asphalt", "lit": True,
            "grade": 0.0, "bearing": 0.0, "name": "Test Street"}
    return {**base, **kw}


def test_edge_cost_prefers_cycleways_flat_and_smooth():
    p = routing.PROFILES["regular"]
    cost = lambda **kw: routing.edge_cost(edge(**kw), p, CALM_DAY)  # noqa: E731
    assert cost(highway="cycleway") < cost(highway="residential") < cost(highway="primary")
    assert cost(highway="primary") < cost(highway="trunk")
    assert cost(grade=0.05) > cost(grade=0.0)
    assert cost(grade=-0.05) == cost(grade=0.0)  # downhill costs nothing extra
    assert cost(surface="gravel") > cost(surface="asphalt")
    assert cost(surface="cobbles") > cost(surface="asphalt")


def test_night_route_prefers_lit_streets():
    # THE must-have demo: same trip, same weather, only darkness changes -> the route
    # moves onto lit streets. Old Marston -> Headington crosses dark cycle paths by day.
    night = {**CALM_DAY, "dark": True}
    start, end = PLACES["Old Marston"], PLACES["Headington shops"]
    day_r = routing.find_route(start, end, "regular", CALM_DAY)
    night_r = routing.find_route(start, end, "regular", night)
    assert night_r["route"] != day_r["route"]
    assert night_r["stats"]["lit_share"] > day_r["stats"]["lit_share"]


def test_unknown_profile_is_an_error():
    with pytest.raises(KeyError):
        routing.find_route(PLACES["Station"], PLACES["Carfax"], "turbo", CALM_DAY)


def test_no_cycling_streets_are_not_in_the_graph():
    # Cornmarket and Queen Street are no-cycling in OSM, so the bike graph never has them.
    names = {d["name"] for *_, d in routing.GRAPH.edges(data=True)}
    assert "Cornmarket Street" not in names and "Queen Street" not in names
