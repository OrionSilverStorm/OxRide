"""ETA prediction, time of day, wind and rain."""
import math, json, os
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import requests

London = ZoneInfo("Europe/London")
Oxford = (51.7520, -1.2577)
hourly_vars = "wind_speed_10m,wind_direction_10m,precipitation_probability,precipitation,is_day,temperature_2m"
CACHE_MINUTES = 30  # fetch a fresh forecast at most this often
wind_at_rider = 1.0  # the speed table uses forecast wind speeds directly


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

    #darkness penalty: lit is True/False in the graph (build_graph fills gaps by road type)
    if ctx.get("dark") and not lit:
        p *= 1.6


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
        p /= 1 + _band(HEADWIND, hw)  # e.g. 6+ m/s headwind = 1.4% slower = 1.4% more cost

    return p

# --- Speed model --------------------------------------------------------------------
# Measured effects on real cycling speed, applied to a flat asphalt base speed.
# Source: cycling speed research from TU Delft (Netherlands), as collected by the team.
# Each table is (lower bound, effect) from the biggest bound down.

BASE_SPEED = 15 * 0.44704  # 15 mph on flat asphalt with no wind

# along-the-road wind in m/s (forecast wind x cos of the angle to the road)
TAILWIND = [(6, 0.017), (4, 0.012), (3, 0.006), (2, 0.007), (1, 0.003), (0, 0.0)]
HEADWIND = [(6, -0.014), (4, -0.010), (3, -0.005), (2, -0.003), (1, -0.002), (0, 0.0)]

# gradient as a fraction (0.04 = 4%)
UPHILL = [(0.04, -0.16), (0.03, -0.12), (0.02, -0.08), (0.01, -0.05), (0.005, -0.03), (0, 0.0)]
DOWNHILL = [(0.02, 0.06), (0.01, 0.05), (0.005, 0.03), (0, 0.0)]

# The graph has 3 surface groups; each value is the length-weighted mix of what
# that group really is in Oxford's OSM data:
#   cobbles: 68% paving stones (-4%), ~12% setts/cobblestones (-20%), rest asphalt
#   gravel:  grass, dirt, ground, unpaved (-21%) and 15% compacted (-7%)
SURFACE = {"asphalt": 0.0, "cobbles": -0.05, "gravel": -0.19}

SIDE_STREETS = {"residential", "living_street", "service", "unclassified"}
SHARED_PATHS = {"path", "footway", "pedestrian", "bridleway"}


def _band(table, x):
    for bound, effect in table:
        if x >= bound:
            return effect
    return 0.0


def _first(v):
    return v[0] if isinstance(v, list) and v else v


def wind_effect(bearing, ctx):
    along = headwind(bearing, ctx)  # m/s; positive = into the wind
    return _band(HEADWIND, along) if along > 0 else _band(TAILWIND, -along)


def grade_effect(grade):
    grade = grade or 0.0
    return _band(UPHILL, grade) if grade > 0 else _band(DOWNHILL, -grade)


def infra_effect(edge):
    # cycle infrastructure (from the OSM highway and cycleway tags)
    highway = _first(edge.get("highway"))
    cycleway = edge.get("cycleway")
    cycleway = set(cycleway) if isinstance(cycleway, list) else {cycleway}
    if highway == "cycleway":
        return -0.01  # separate cycle track
    if highway in SHARED_PATHS:
        return 0.01   # shared foot/cycle path
    if cycleway & {"lane", "opposite_lane"}:
        return 0.02   # painted cycle lane
    if cycleway & {"share_busway", "opposite_share_busway"}:
        return 0.01   # shared bus lane
    if cycleway & {"track", "opposite_track", "separate"}:
        return 0.0    # road with a cycle track
    if highway in SIDE_STREETS:
        return -0.05  # side street with nothing for bikes
    return 0.0        # normal road


def speed_factor(edge, ctx):
    # How much faster (>1) or slower (<1) than BASE_SPEED this road is right now.
    # Rain: no effect on speed in the measurements.
    f = 1.0
    f *= 1 + wind_effect(edge.get("bearing"), ctx)
    f *= 1 + grade_effect(edge.get("grade"))
    f *= 1 + SURFACE.get(_first(edge.get("surface")), 0.0)
    f *= 1 + infra_effect(edge)
    return f


def speed_ms(edge, ctx):
    return BASE_SPEED * speed_factor(edge, ctx)


def eta_minutes(edges, ctx):
    total_seconds = 0.0
    for edge in edges:
        # time for the road, plus a 2 s allowance for the junction at its end
        total_seconds += edge["length"] / speed_ms(edge, ctx) + 2
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

