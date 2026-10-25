"""ETA prediction, time of day, wind and rain."""
import math, json, os
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import requests

London = ZoneInfo("Europe/London")
Oxford = (51.7520, -1.2577)
hourly_vars = "wind_speed_10m,wind_direction_10m,precipitation_probability,precipitation,is_day,temperature_2m"
CACHE_MINUTES = 30  # fetch a fresh forecast at most this often
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
_weather_fetched_at = None  # when _weather_cache was fetched (UTC)
_weather_source = None      # "open-meteo", "open-meteo (old)" or "snapshot"


def _refresh_weather():
    # Fresh forecast every CACHE_MINUTES. If Open-Meteo fails: keep the last good
    # forecast, or (first call, e.g. offline demo) use weather_snapshot.json.
    global _weather_cache, _weather_fetched_at, _weather_source
    now = datetime.now(timezone.utc)
    if _weather_cache is not None and _weather_fetched_at is not None \
            and now - _weather_fetched_at < timedelta(minutes=CACHE_MINUTES):
        return
    try:
        _weather_cache = fetch_weather()
        _weather_source = "open-meteo"
        _save_weather_to_db(_weather_cache)
    except Exception as e:
        print(f"WARNING: weather fetch failed ({e!r})")
        if _weather_cache is not None:
            _weather_source = "open-meteo (old)"
        else:
            with open(SNAPSHOT) as f:
                _weather_cache = json.load(f)
            _weather_source = "snapshot"
    _weather_fetched_at = now


def _save_weather_to_db(hourly):
    # Tiger Data keeps every forecast we fetch. Skipped when no database is set up.
    if not os.environ.get("DATABASE_URL"):
        return
    try:
        import db
        db.save_weather(hourly, "forecast")
    except Exception as e:
        print(f"Weather not saved to the database: {e!r}")


def get_context(when, weekday_override=None):
    _refresh_weather()
    hourly = _weather_cache
    times = parse_times(hourly)

    utc_hour = when.astimezone(timezone.utc).replace(
        minute=0, second=0, microsecond=0
    )

    # Find the matching forecast hour
    def row(t):
        return min(
            range(len(times)),
            key=lambda j: abs((times[j] - t).total_seconds())
        )

    i = row(utc_hour)
    # Rain values are totals for the hour before their timestamp
    r = row(utc_hour + timedelta(hours=1))

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
        "rain_prob": (hourly["precipitation_probability"][r] or 0) / 100,
        "rain_mm": hourly["precipitation"][r] or 0,
        "dark": hourly["is_day"][i] == 0,
        "rush": rush,
        "temperature_c": (hourly.get("temperature_2m") or [None] * len(times))[i],
        "local": local.isoformat(),
        "weather_source": _weather_source,
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
        if lit is False or lit == "no":
            p *=1.6
        elif lit is True or lit == "yes":
            pass
        else:
            p *= 1.2


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

# One rider for every profile: fast/regular/chill only change which roads the route
# uses, not how fast you ride. 160 W would do ~18 mph on the flat, so the 15 mph cap
# sets the flat speed; hills and headwind slow you down from there.
RIDER = {
    "power": 160,
    "cda": 0.32,
    "crr": 0.005
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

def speed_ms(grade, head):
    pr = RIDER

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




def eta_minutes(edges, ctx):
    total_seconds = 0.0

    for edge in edges:
        length = edge["length"]
        grade = edge.get("grade") or 0.0
        bearing = edge.get("bearing")

        # Calculate headwind for this road
        head = headwind(bearing, ctx)

        # Predict cycling speed
        speed = speed_ms(grade, head)

        # Rain reduces speed by 10%
        if ctx["rain_mm"] > 0:
            speed *= 0.9

        # Avoid division by zero
        speed = max(speed, 0.5)

        # Time for road segment
        time_seconds = length / speed

        # Add junction delay
        total_seconds += time_seconds + 2

    return total_seconds / 60



def best_departures(route_fn, profile="regular", now=None, route_id="default"):
    if now is None:
        now = datetime.now(timezone.utc)

    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")

    now = now.astimezone(timezone.utc)

    #Rounded to next 15 minutes
    start = now.replace(second=0, microsecond=0)
    minutes = (-start.minute) % 15

    if minutes == 0 and (now.second or now.microsecond):
        minutes = 15

    start += timedelta(minutes=minutes)

    slots = []

    for k in range(13):
        t = start + timedelta(minutes=15 * k)

        ctx = get_context(t)
        edges = route_fn(ctx)
        eta = eta_minutes(edges, ctx)

        rain_prob = ctx["rain_prob"]

        # Rain and darkness penalties
        score = eta * (1 + 0.5 * rain_prob)
        score += 5 if ctx["dark"] else 0

        slots.append({
            "depart_local": t.astimezone(London).isoformat(),
            "depart_utc": t.isoformat(),
            "eta_min": round(eta, 1),
            "rain_prob": rain_prob,
            "rain_mm": ctx["rain_mm"],
            "wind_ms": ctx["wind_ms"],
            "dark": ctx["dark"],
            "score": score,
            "best": False
        })

    best_index = min(
        range(len(slots)),
        key=lambda i: slots[i]["score"]
    )

    slots[best_index]["best"] = True

    for slot in slots:
        slot["history_rain_prob"] = None
    if not os.environ.get("DATABASE_URL"):
        return slots  # no Tiger Data set up: don't try to connect
    try:
        import db
        history_cache = {}
        for slot in slots:
            local = datetime.fromisoformat(slot["depart_local"])
            if local.month not in history_cache:
                history_cache[local.month] = db.rain_chance_by_hour(local.month)
            slot["history_rain_prob"] = history_cache[local.month].get(local.hour)
        db.save_predictions(slots, route_id=route_id, profile=profile)  # once, all 13 slots
    except Exception as e:
        print("Database integration skipped:", e)
    return slots

    

SNAPSHOT = os.path.join(
    os.path.dirname(__file__),
    "weather_snapshot.json"
)

def get_weather():
    # Refresh weather_snapshot.json by hand (python -c "import time_model; time_model.get_weather()").
    # Falls back to the old snapshot if Open-Meteo is down.
    try:
        data = fetch_weather()
    except Exception:
        with open(SNAPSHOT) as f:
            return json.load(f)
    try:
        with open(SNAPSHOT, "w") as f:
            json.dump(data, f)
    except OSError:
        pass  # read-only disk (Vercel): the fresh data is still returned
    return data

def mock_route_fn(ctx):
    return [
        {
            "length": 1000,
            "grade": 0,
            "bearing": 270,
            "surface": "asphalt",
            "lit": "yes"
        }
    ]

