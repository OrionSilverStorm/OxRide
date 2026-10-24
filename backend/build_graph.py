

import osmnx as ox
import geopandas as gpd
import matplotlib.pyplot as plt
import pandas as pd 
import contextily as cx


#--------------------------------------------------
#                   Setup graph
#--------------------------------------------------

def setup():
    ox.settings.use_cache = True
    ox.settings.log_console = True


def get_area_graph(area):
    setup()

    bike = ('["highway"]["area"!~"yes"]["access"!~"private"]'
        '["highway"!~"abandoned|construction|corridor|elevator|escalator|footway|motor|no|planned|platform|proposed|raceway|steps"]'
        '["bicycle"!~"no"]["service"!~"private"]')
    shared = '["highway"="footway"]["bicycle"~"yes|designated|permissive"]'

    G = ox.graph_from_place(area, custom_filter=[bike, shared])

    setup_graph(G)

    return G

def setup_graph(graph):
    add_elevation(graph)
    add_travel_time_to_all_edges(graph)

#--------------------------------------------------
#                   Add to graph
#--------------------------------------------------

def add_elevation(graph):
    graph = ox.elevation.add_node_elevations_raster(graph, "dem.tif")
    graph = ox.elevation.add_edge_grades(graph)


def get_gradient_between_nodes(graph, start_node, end_node):

    if not graph.has_edge(start_node, end_node):
        raise ValueError(f"No edge from {start_node} to {end_node}")

    length = graph[start_node][end_node].values()[0]["length"]

    change_in_elevation = graph.nodes[end_node]["elevation"] - graph.nodes[start_node]["elevation"]

    return change_in_elevation / length

def add_edge_travel_time(graph, start_node, end_node, speed_kph):

    if not graph.has_edge(start_node, end_node):
        raise ValueError(f"No edge from {start_node} to {end_node}")

    for d in graph[start_node][end_node].values():  
        d["speed_kph"] = speed_kph

        speed_mps = speed_kph / 3.6
        d["travel_time"] = d["length"] / speed_mps

def add_travel_time_to_all_edges(graph):
    for start_node, end_node in set(graph.edges()):
        speed = 15
        add_edge_travel_time(graph, start_node, end_node, speed)

