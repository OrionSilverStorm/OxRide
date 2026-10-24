"""ETA prediction, time of day, wind and rain."""
import math, json, os
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import requests

London = ZoneInfo("Europe/London")
Oxford = (51.7520, -1.2577)
hourly_vars = "wind_speed_10m,wind_direction_10m,precipitation_probability,precipitation"
wind_at_rider = 0.5


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

_weather_cache = None

def get_context(when, weekday_override=None):
    global _weather_cache

    if _weather_cache is None:
        _weather_cache = fetch_weather()

    hourly = _weather_cache
    times = parse_times(hourly)

    utc_hour = when.astimezone(timezone.utc).replace(
        minute=0, second=0, microsecond=0
    )

    # Find the matching forecast hour
    i = min(
        range(len(times)),
        key=lambda j: abs((times[j] - utc_hour).total_seconds())
    )

    local = when.astimezone(London)

    weekday = (
        weekday_override
        if weekday_override is not None
        else local.weekday()
    )

    minutes = local.hour * 60 + local.minute

    rush = weekday < 5 and (
        450 <= minutes < 570 or
        990 <= minutes < 1110
    )

    return {
        "wind_ms": hourly["wind_speed_10m"][i] or 0,
        "wind_from_deg": hourly["wind_direction_10m"][i] or 0,
        "rain_prob": (hourly["precipitation_probability"][i] or 0) / 100,
        "rain_mm": hourly["precipitation"][i] or 0,
        "dark": hourly["is_day"][i] == 0,
        "rush": rush,
        "local": local.isoformat()
    }

#how much wind helps or doesnt help
def headwind(bearing, ctx):
    if bearing is None:
        return 0.0

    wind_speed = ctx["wind_ms"]*wind_at_rider
    wind_direction = ctx["wind_from_deg"]
    angle = math.radians(bearing - wind_direction)
    return wind_speed * math.cos(angle)




def time_penalty(edge, ctx):
    p = 1.0

    def first(v):
        if isinstance(v, list):
            return v[0] if v else None
        return v

    highway = first(edge.get("highway"))
    surface = first(edge.get("surface"))
    bearing = first(edge.get("bearing"))

    #Rush hour penalty
    main_roads = {
        "trunk", "primary", "secondary",
        "trunk_link", "primary_link", "secondary_link"
    }

    if ctx["rush"] and highway in main_roads:
        p *= 1.5

    #surface penalty in rain
    if ctx["rain_mm"] > 0 and surface == "gravel":
        p *= 1.4

    #Headwind penalty
    hw = headwind(bearing, ctx)

    if hw > 0:
        p *= 1 + 0.03 * hw

    return p

MASS = 85.0       # Rider + bicycle mass (kg)
G = 9.81          # Gravitational acceleration
RHO = 1.225       # Air density
MAX_SPEED = 30 / 3.6
SPEED_SCALE = 1.0

PROFILES = {
    "road": {
        "power": 160,
        "cda": 0.32,
        "crr": 0.005
    },
    "commuter": {
        "power": 80,
        "cda": 0.50,
        "crr": 0.007
    },
    "chill": {
        "power": 55,
        "cda": 0.55,
        "crr": 0.008
    }
}

def power_needed(v, grade, head, pr):
    theta = math.atan(grade or 0.0)

    gravity = MASS * G * math.sin(theta)

    rolling = MASS * G * pr["crr"] * math.cos(theta)

    air = (
        0.5 * RHO * pr["cda"]
        * max(v + head, 0) ** 2
    )

    return (gravity + rolling + air) * v

def speed_ms(grade, head, profile):
    pr = PROFILES[profile]

    low = 0.5
    high = 25.0

    for _ in range(40):
        mid = (low + high) / 2

        required = power_needed(
            mid, grade, head, pr
        )

        if required > pr["power"]:
            high = mid
        else:
            low = mid

    speed = (low + high) / 2

    return min(speed, MAX_SPEED) * SPEED_SCALE


flat = speed_ms(0, 0, "commuter")
uphill = speed_ms(0.05, 0, "commuter")
headwind_speed = speed_ms(0, 5, "commuter")
tailwind_speed = speed_ms(0, -5, "commuter")

print("Flat:", flat * 3.6, "km/h")
print("Uphill:", uphill * 3.6, "km/h")
print("Headwind:", headwind_speed * 3.6, "km/h")
print("Tailwind:", tailwind_speed * 3.6, "km/h")

assert 15 <= flat * 3.6 <= 22
assert uphill < flat
assert headwind_speed < flat
assert tailwind_speed > flat

print("Stage 5 passed")



def eta_minutes(route: dict, ctx: dict) -> float:
    raise NotImplementedError


def best_departures(start: tuple[float, float], end: tuple[float, float],
                    profile: str) -> list[dict]:
    """ETA and score for each 15-minute slot over the next three hours."""
    raise NotImplementedError
