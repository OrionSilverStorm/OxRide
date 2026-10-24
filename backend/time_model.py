"""ETA prediction, time of day, wind and rain."""

from datetime import datetime


def get_context(depart_at: datetime) -> dict:
    """hour, is_dark, wind_speed, wind_dir, rain, temperature_c."""
    raise NotImplementedError


def time_penalty(edge_data: dict, ctx: dict) -> float:
    """1.0 = normal, 2.0 = twice as bad.

    Unlit after dark, main roads at rush hour, headwind, and cycling-restricted
    streets (Cornmarket, Queen Street) during restricted hours cost more.
    """
    return 1.0


def eta_minutes(route: dict, ctx: dict) -> float:
    raise NotImplementedError


def best_departures(start: tuple[float, float], end: tuple[float, float],
                    profile: str) -> list[dict]:
    """ETA and score for each 15-minute slot over the next three hours."""
    raise NotImplementedError
