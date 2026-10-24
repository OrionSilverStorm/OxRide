"""A* routing, edge cost function and ride profiles."""

from dataclasses import dataclass


@dataclass(frozen=True)
class RideProfile:
    name: str
    lit_weight: float = 0.0
    traffic_weight: float = 0.0
    hill_weight: float = 0.0


PROFILES: dict[str, RideProfile] = {}


def edge_cost(edge: dict, profile: RideProfile, conditions: dict) -> float:
    raise NotImplementedError


def find_route(graph, origin: tuple[float, float], dest: tuple[float, float],
               profile: RideProfile, conditions: dict) -> list[int]:
    raise NotImplementedError
