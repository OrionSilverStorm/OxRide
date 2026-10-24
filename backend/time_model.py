"""ETA prediction, time of day, wind and rain."""
import math, json, os
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import requests

London = ZoneInfo("Europe/London")
Oxford = (51.7520, -1.2577)
hourly_vars = "wind_speed_10m,wind_direction_10m,precipitation_probability,precipitation,is_day"
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
    lit = first(edge.get("lit"))

    #darkness penalty
    if ctx["dark"]:
        if lit =="no":
            p*=1.6
        elif lit not in ("yes", "no"):
            p*= 1.2


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
MAX_SPEED = 15 * 0.44704  # 15 mph: what Lime/Voi e-bikes are limited to in the UK
SPEED_SCALE = 1.0

# Same names as routing.PROFILES and the API.
PROFILES = {
    "fast": {
        "power": 160,
        "cda": 0.32,
        "crr": 0.005
    },
    "regular": {
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




def eta_minutes(edges, ctx, profile):
    total_seconds = 0.0

    for edge in edges:
        length = edge["length"]
        grade = edge.get("grade") or 0.0
        bearing = edge.get("bearing")

        # Calculate headwind for this road
        head = headwind(bearing, ctx)

        # Predict cycling speed
        speed = speed_ms(grade, head, profile)

        # Rain reduces speed by 10%
        if ctx["rain_mm"] > 0:
            speed *= 0.9

        # Avoid division by zero
        speed = max(speed, 0.5)

        # Time for this road segment
        time_seconds = length / speed

        # Add junction delay
        total_seconds += time_seconds + 2

    return total_seconds / 60



def best_departures(start: tuple[float, float], end: tuple[float, float],
                    profile: str) -> list[dict]:
    """ETA and score for each 15-minute slot over the next three hours."""
    raise NotImplementedError


if __name__ == "__main__":
    # Quick self-test: python time_model.py
    ctx = {
        "wind_ms": 10,
        "wind_from_deg": 270,
        "rain_mm": 0
    }

    headwind_route = [
        {"length": 1000, "grade": 0, "bearing": 270}
    ]

    tailwind_route = [
        {"length": 1000, "grade": 0, "bearing": 90}
    ]

    head_eta = eta_minutes(
        headwind_route, ctx, "regular"
    )

    tail_eta = eta_minutes(
        tailwind_route, ctx, "regular"
    )

    print("Headwind ETA:", head_eta)
    print("Tailwind ETA:", tail_eta)

    assert head_eta > tail_eta
    print("Stage 6 passed")

    wet_ctx = ctx.copy()
    wet_ctx["rain_mm"] = 1.0

    wet_eta = eta_minutes(
        headwind_route, wet_ctx, "regular"
    )

    assert wet_eta > head_eta
    print("Rain test passed")
