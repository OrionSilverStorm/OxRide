"""ETA prediction with time-of-day, wind and rain effects."""

from datetime import datetime


def predict_eta(route: list[int], depart_at: datetime, conditions: dict) -> float:
    """Return predicted ride time in seconds."""
    raise NotImplementedError


def best_departure(route: list[int], window_start: datetime, window_end: datetime) -> datetime:
    raise NotImplementedError
