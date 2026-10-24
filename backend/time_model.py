"""ETA prediction, time of day, wind and rain."""
import math, json, os
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import requests

London = ZoneInfo("Europe/London")
Oxford = (51.7520, -1.2577)
hourly_vars = "wind_speed_10m,wind_direction_10m,precipitation_probability,precipitation,is_day"


def fetch_weather():
    r = requests.get(
        "https://api.open-meteo.com/v1/forecast",
        params={
            "latitude": Oxford[0],
            "longitude": Oxford[1],
            "hourly": hourly_vars,
            "wind_speed_unit": "ms",
            "forecast_days": 3,
        },
        timeout=8,
    )
    
    r.raise_for_status()
    data = r.json()
    return data["hourly"]

def parse_times(hourly):
    return[
        datetime.fromisoformat(t).replace(tzinfo=timezone.utc)
        for t in hourly["time"]
    ]

if __name__ == "__main__":
    hourly = fetch_weather()
    times = parse_times(hourly)

    print("Hours:", len(times))
    print("Times:", times[:3])
    print("Wind:", hourly["wind_speed_10m"][:3])
    print("Timezone:", times[0].tzinfo)

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
