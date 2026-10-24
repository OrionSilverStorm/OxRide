# A*, cost function and ride profiles.
#
# How it fits together:
#   find_route -> find_path -> astar -> edge_cost -> time_model.time_penalty
# The graph (GRAPH) is a networkx MultiDiGraph made by build_graph.py. Until that exists,
# sample_graph.py builds a small fake one with the same attribute names.

import heapq
import math

import time_model

GRAPH = None  # set once at startup with set_graph()


def set_graph(g):
    global GRAPH
    GRAPH = g


# ---------------------------------------------------------------------------
# Ride profiles
# ---------------------------------------------------------------------------
# A profile says how much each kind of rider likes each kind of road.
# A factor multiplies a road's length: below 1 = looks shorter (A* likes it),
# above 1 = looks longer (A* avoids it). The keys are OpenStreetMap "highway"
# and "surface" values. A road type not listed here gets factor 1.0.
# hill_weight = metres of extra "flat distance" we charge per metre climbed.
# All these numbers are first guesses, tune them by looking at real routes.

PROFILES = {
    "fast": {
        "road_type_factors": {"cycleway": 1.0, "residential": 1.0, "tertiary": 1.0,
                              "secondary": 1.0, "primary": 1.0},
        "surface_factors": {"asphalt": 1.0, "gravel": 2.0},
        "hill_weight": 8,
    },
    "regular": {
        "road_type_factors": {"cycleway": 0.7, "residential": 1.0, "tertiary": 1.3,
                              "secondary": 1.8, "primary": 2.5},
        "surface_factors": {"asphalt": 1.0, "gravel": 1.5},
        "hill_weight": 15,
    },
    "chill": {
        "road_type_factors": {"cycleway": 0.5, "residential": 0.8, "tertiary": 2.0,
                              "secondary": 3.5, "primary": 5.0},
        "surface_factors": {"asphalt": 1.0, "gravel": 1.3},
        "hill_weight": 25,
    },
}


# ---------------------------------------------------------------------------
# Distance helper
# ---------------------------------------------------------------------------

def haversine_m(lat1, lon1, lat2, lon2):
    # Straight-line distance in metres between two lat/lon points.
    r = 6371000  # earth radius in metres
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dphi = p2 - p1
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


# ---------------------------------------------------------------------------
# Cost of one road
# ---------------------------------------------------------------------------

def edge_cost(edge, profile, ctx):
    # edge = the facts about one road (length, highway, surface, lit, grade, ...)
    length = edge["length"]  # metres

    # look up this road's type in the profile; use 1.0 if the profile doesn't list it
    road_factor = profile["road_type_factors"].get(edge["highway"], 1.0)
    surface_factor = profile["surface_factors"].get(edge["surface"], 1.0)

    # grade = rise / length, so 0.05 = 5% uphill. Only uphill costs extra.
    climb = max(edge["grade"], 0) * length  # metres climbed on this road
    hill_penalty = profile["hill_weight"] * climb

    cost = length * road_factor * surface_factor + hill_penalty

    # night, rush hour, headwind... (time_model decides; 1.0 = no change)
    cost = cost * time_model.time_penalty(edge, ctx)
    return cost


def cheapest_edge(G, u, v, profile, ctx):
    # Two nodes can be joined by more than one road (MultiDiGraph).
    # Return the cheapest one and its cost.
    best_edge = None
    best_cost = math.inf
    for edge in G[u][v].values():
        cost = edge_cost(edge, profile, ctx)
        if cost < best_cost:
            best_edge = edge
            best_cost = cost
    return best_edge, best_cost


# ---------------------------------------------------------------------------
# A*
# ---------------------------------------------------------------------------

def astar(G, start, goal, profile, ctx):
    # start and goal are node ids. Returns a list of node ids, or None if no route.

    # The "guess" for the distance still to go is the straight-line distance to the goal.
    # Some roads cost LESS than their length (factor below 1), so we shrink the guess by
    # the smallest factor in the profile. A guess that is too big can make A* miss the
    # best route.
    min_factor = min(list(profile["road_type_factors"].values()) + [1.0])
    goal_lat = G.nodes[goal]["y"]
    goal_lon = G.nodes[goal]["x"]

    def guess(node):
        return min_factor * haversine_m(G.nodes[node]["y"], G.nodes[node]["x"],
                                        goal_lat, goal_lon)

    cost_so_far = {start: 0.0}   # cheapest known cost to reach each node
    came_from = {}               # node -> the node we reached it from (to rebuild the path)
    todo = [(guess(start), start)]  # priority queue of (score, node), lowest score first
    finished = set()             # nodes we are completely done with

    while todo:
        _, node = heapq.heappop(todo)  # most promising node

        if node in finished:
            continue  # a stale duplicate entry, skip it
        if node == goal:
            # walk backwards from the goal to the start
            path = [node]
            while node in came_from:
                node = came_from[node]
                path.append(node)
            path.reverse()
            return path
        finished.add(node)

        # look at every road leaving this node
        for neighbour in G.successors(node):
            if neighbour in finished:
                continue
            _, cost = cheapest_edge(G, node, neighbour, profile, ctx)
            new_cost = cost_so_far[node] + cost
            # found a cheaper way to reach this neighbour?
            if new_cost < cost_so_far.get(neighbour, math.inf):
                cost_so_far[neighbour] = new_cost
                came_from[neighbour] = node
                heapq.heappush(todo, (new_cost + guess(neighbour), neighbour))

    return None


# ---------------------------------------------------------------------------
# What the rest of the app calls
# ---------------------------------------------------------------------------

def nearest_node(G, lat, lon):
    # Snap a tapped point to the closest junction. (Loops over every node; fine for a city.)
    best_node = None
    best_dist = math.inf
    for node, data in G.nodes(data=True):
        d = haversine_m(lat, lon, data["y"], data["x"])
        if d < best_dist:
            best_node = node
            best_dist = d
    return best_node


def find_path(start, end, profile_name, ctx):
    # start and end are (lat, lon). Returns a list of node ids.
    profile = PROFILES[profile_name]
    start_node = nearest_node(GRAPH, start[0], start[1])
    end_node = nearest_node(GRAPH, end[0], end[1])
    return astar(GRAPH, start_node, end_node, profile, ctx)


def find_route(start, end, profile_name, ctx):
    # Same fields as the /route output:
    #   route         list of [lat, lon] (drawn on the map)
    #   elevations_m  one per route point
    #   stats         distance, climb, cycleway/lit shares, ETA
    #   steps         turn-by-turn from navigation.build_steps
    profile = PROFILES[profile_name]
    path = find_path(start, end, profile_name, ctx)
    if path is None:
        raise ValueError("no route found")

    route = [[GRAPH.nodes[n]["y"], GRAPH.nodes[n]["x"]] for n in path]
    elevations = [GRAPH.nodes[n]["elevation"] for n in path]

    # add up the facts of every road along the path
    distance = 0.0
    cycleway = 0.0
    lit = 0.0
    for a, b in zip(path, path[1:]):
        edge, _ = cheapest_edge(GRAPH, a, b, profile, ctx)
        distance += edge["length"]
        if edge["highway"] == "cycleway":
            cycleway += edge["length"]
        if edge["lit"]:
            lit += edge["length"]

    climb = 0.0
    for before, after in zip(elevations, elevations[1:]):
        climb += max(after - before, 0)

    stats = {
        "distance_m": round(distance),
        "climb_m": round(climb),
        # placeholder: 15 km/h flat. Replace with time_model.eta_minutes(...) when it exists.
        "eta_min": round(distance / 250, 1),
        "cycleway_share": round(cycleway / distance, 2) if distance else 0.0,
        "lit_share": round(lit / distance, 2) if distance else 0.0,
    }

    return {
        "route": route,
        "elevations_m": elevations,
        "stats": stats,
        "steps": [],  # navigation.build_steps(GRAPH, path) once navigation.py is written
    }
