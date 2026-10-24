"""Turn-by-turn steps from a route."""


def build_steps(graph, route_nodes: list[int]) -> list[dict]:
    """Each step: {text, distance_m, lat, lon, maneuver}; maneuver is left|right|straight|arrive."""
    raise NotImplementedError
