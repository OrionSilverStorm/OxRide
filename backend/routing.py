# A*, cost function and ride profiles.

from dataclasses import dataclass, field


@dataclass(frozen=True)
class RideProfile:
    name: str
    road_type_factors: dict[str, float] = field(default_factory=dict)
    surface_factors: dict[str, float] = field(default_factory=dict)
    hill_weight: float = 0.0


PROFILES: dict[str, RideProfile] = {
    "road": RideProfile("road"),
    "commuter": RideProfile("commuter"),
    "chill": RideProfile("chill"),
}


def edge_cost(edge_data: dict, profile: RideProfile, ctx: dict) -> float:
    # length * road-type factor * surface factor + hill penalty, times time_penalty
    raise NotImplementedError


def find_route(start: tuple[float, float], end: tuple[float, float],
               profile: str, ctx: dict) -> dict:
    # Same fields as the /route output.
    # route: list of [lat, lon] (drawn on the map); stats; steps from navigation.build_steps.
    raise NotImplementedError
