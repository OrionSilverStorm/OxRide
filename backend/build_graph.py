# One-off script: download Oxford's bike network, add elevation, grade and bearing,
# fill in missing tags, and save the graph to a file for routing.py to load.
#
# Run it:  python build_graph.py        (takes several minutes, only needed once)
#
# Every edge (road) ends up with:  length, highway, surface, lit, name, bearing, grade
# Every node (junction) has:       x (lon), y (lat), elevation
#
# Elevation comes from a local raster file (dem.tif) if one is next to this script,
# otherwise from the OpenTopoData website. The raster needs `pip install rasterio`.

import os
import pickle
import time

import httpx
import osmnx as ox

HERE = os.path.dirname(os.path.abspath(__file__))
PLACE = "Oxford, UK"
OUT_PATH = os.path.join(HERE, "oxford_graph.pkl")
DEM_PATH = os.path.join(HERE, "dem.tif")


# --------------------------------------------------
#                   Setup and download
# --------------------------------------------------

def setup():
    ox.settings.use_cache = True
    ox.settings.log_console = True

    # osmnx only keeps a short list of tags on each road. We also need these.
    for tag in ("lit", "surface", "cycleway", "bicycle"):
        if tag not in ox.settings.useful_tags_way:
            ox.settings.useful_tags_way.append(tag)


def get_area_graph(area):
    bike = ('["highway"]["area"!~"yes"]["access"!~"private"]'
            '["highway"!~"abandoned|construction|corridor|elevator|escalator|footway|motor|no|planned|platform|proposed|raceway|steps"]'
            '["bicycle"!~"no"]["service"!~"private"]')
    shared = '["highway"="footway"]["bicycle"~"yes|designated|permissive"]'

    G = ox.graph_from_place(area, custom_filter=[bike, shared])

    # Keep only the part of the map you can actually ride around in both directions.
    # Otherwise one-way streets can leave dead ends where A* finds no route.
    G = ox.truncate.largest_component(G, strongly=True)
    return G


# --------------------------------------------------
#                   Elevation and grade
# --------------------------------------------------

def add_elevation(G):
    if os.path.exists(DEM_PATH):
        ox.elevation.add_node_elevations_raster(G, DEM_PATH)
    else:
        add_elevations_from_opentopodata(G)

    # grade = rise / length for every road (signed: negative = downhill)
    ox.elevation.add_edge_grades(G)


def add_elevations_from_opentopodata(G):
    # OpenTopoData takes 100 points per request and about 1 request per second.
    nodes = list(G.nodes())
    last_elevation = 0.0

    for i in range(0, len(nodes), 100):
        batch = nodes[i:i + 100]
        locations = "|".join(f"{G.nodes[n]['y']},{G.nodes[n]['x']}" for n in batch)
        results = ask_opentopodata(locations)

        for node, result in zip(batch, results):
            elevation = result["elevation"]
            if elevation is None:  # no data for this point, reuse the previous value
                elevation = last_elevation
            G.nodes[node]["elevation"] = elevation
            last_elevation = elevation

        print(f"elevation: {min(i + 100, len(nodes))}/{len(nodes)} nodes")
        time.sleep(1.1)


def ask_opentopodata(locations):
    url = "https://api.opentopodata.org/v1/srtm30m"
    for attempt in range(5):
        response = httpx.get(url, params={"locations": locations}, timeout=30)
        if response.status_code == 200:
            return response.json()["results"]
        time.sleep(3 * (attempt + 1))  # rate limited or busy, wait and try again
    raise RuntimeError(f"OpenTopoData kept failing: {response.status_code} {response.text}")


# --------------------------------------------------
#                   Clean up tags
# --------------------------------------------------

# OpenStreetMap "lit" values that mean the road has street lights
LIT_YES = {"yes", "24/7", "automatic", "sunset-sunrise"}

# Roads that are usually lit when nobody has tagged them
LIT_BY_DEFAULT = {"primary", "secondary", "tertiary", "trunk", "residential", "living_street",
                  "unclassified", "primary_link", "secondary_link", "tertiary_link", "trunk_link"}

# Surfaces boiled down to three words: asphalt, cobbles, gravel
ASPHALT = {"asphalt", "paved", "concrete", "concrete:plates", "concrete:lanes", "chipseal"}
COBBLES = {"cobblestone", "sett", "paving_stones", "unhewn_cobblestone", "cobblestone:flattened"}

# Roads that are usually gravel/dirt when the surface isn't tagged
GRAVEL_BY_DEFAULT = {"track", "path", "bridleway"}


def first(value):
    # After simplifying, a road can have a list of values (e.g. two highway types).
    # Keep the first one.
    if isinstance(value, list):
        return value[0] if value else None
    return value


def clean_surface(surface, highway):
    if surface is None:
        return "gravel" if highway in GRAVEL_BY_DEFAULT else "asphalt"
    if surface in ASPHALT:
        return "asphalt"
    if surface in COBBLES:
        return "cobbles"
    return "gravel"  # gravel, dirt, grass, sand, ground, ...


def fill_defaults(G):
    lit_guessed = 0
    surface_guessed = 0
    total = 0

    for _, _, _, edge in G.edges(keys=True, data=True):
        total += 1

        highway = first(edge.get("highway")) or "unclassified"
        edge["highway"] = highway
        edge["name"] = first(edge.get("name")) or ""

        surface = first(edge.get("surface"))
        if surface is None:
            surface_guessed += 1
        edge["surface"] = clean_surface(surface, highway)

        lit = first(edge.get("lit"))
        if lit is None:
            lit_guessed += 1
            edge["lit"] = highway in LIT_BY_DEFAULT
        else:
            edge["lit"] = lit in LIT_YES

    print(f"{total} roads. surface guessed on {surface_guessed}, lit guessed on {lit_guessed}")


# --------------------------------------------------
#                   Put it together
# --------------------------------------------------

def build_graph(place=PLACE, out_path=OUT_PATH):
    setup()
    G = get_area_graph(place)
    print(f"downloaded {len(G.nodes)} nodes, {len(G.edges)} roads")

    add_elevation(G)
    ox.bearing.add_edge_bearings(G)
    fill_defaults(G)

    with open(out_path, "wb") as f:
        pickle.dump(G, f)
    print(f"saved {out_path} ({os.path.getsize(out_path) / 1e6:.1f} MB)")


if __name__ == "__main__":
    build_graph()
