"""Ride logs in Tiger Data: real rides make the ETAs better and spot closed streets.

What's stored (tables are created on first use, see ensure_schema):
  rides                one row per ride: when, ride type, predicted and actual minutes
  ride_points          hypertable: every GPS point, matched to a street segment, with speed
  route_events         hypertable: "went off route" / "rerouted", matched to a street
  street_speed_hourly  continuous aggregate: average speed per street segment per hour,
                       kept up to date by Tiger Data itself
Raw GPS points are deleted after 30 days (retention policy); the hourly summary stays.
Rides are anonymous: a random id, no account. Rides from the /debug simulator are stored
with simulated = true and never feed the learned speeds or the trouble spots.

Everything here fails safe: no DATABASE_URL, or the database is down -> the app works
as before, just without learning.
"""

import math
import time
import uuid
from datetime import datetime, timezone

import numpy as np

import db
import routing
from debug import node_index

RAW_DAYS = 30            # keep raw GPS points this long
MAX_SPEED = 15.0         # m/s: faster than this between two points is a GPS jump
MAX_GAP_S = 60           # points further apart than this don't give a speed
MAX_ACCURACY_M = 40      # worse GPS than this doesn't give a speed
MIN_POINTS = 6           # a street needs this many measured points before we trust it
TROUBLE_HOURS = 2        # trouble spots look back this far...
TROUBLE_RIDES = 3        # ...and need this many different riders turning away
CACHE_S = 120            # learned speeds / trouble spots are re-read at most this often

_conn_override = None    # tests point this at their own connection / schema
_ready = False


def _conn():
    c = _conn_override or db.conn()
    ensure_schema(c)
    return c


def ensure_schema(c):
    """Create the tables, hypertables, summary and retention once (safe to repeat)."""
    global _ready
    if _ready and _conn_override is None:
        return
    for sql in [
        """CREATE TABLE IF NOT EXISTS rides (
             ride_id UUID PRIMARY KEY, started_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ,
             profile TEXT, simulated BOOLEAN NOT NULL DEFAULT false,
             start_lat DOUBLE PRECISION, start_lon DOUBLE PRECISION,
             end_lat DOUBLE PRECISION, end_lon DOUBLE PRECISION,
             planned_m REAL, predicted_min REAL, actual_min REAL, arrived BOOLEAN)""",
        """CREATE TABLE IF NOT EXISTS ride_points (
             time TIMESTAMPTZ NOT NULL, ride_id UUID NOT NULL,
             lat DOUBLE PRECISION, lon DOUBLE PRECISION, accuracy_m REAL, speed_ms REAL,
             edge_u BIGINT, edge_v BIGINT, osmid BIGINT, simulated BOOLEAN NOT NULL DEFAULT false)""",
        "SELECT create_hypertable('ride_points', by_range('time'), if_not_exists => TRUE)",
        """CREATE TABLE IF NOT EXISTS route_events (
             time TIMESTAMPTZ NOT NULL, ride_id UUID, kind TEXT NOT NULL,
             lat DOUBLE PRECISION, lon DOUBLE PRECISION, osmid BIGINT, street TEXT,
             simulated BOOLEAN NOT NULL DEFAULT false)""",
        "SELECT create_hypertable('route_events', by_range('time'), if_not_exists => TRUE)",
        """CREATE MATERIALIZED VIEW IF NOT EXISTS street_speed_hourly
             WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
             SELECT time_bucket('1 hour', time) AS bucket, edge_u, edge_v, simulated,
                    avg(speed_ms) AS avg_speed, count(*) AS points
             FROM ride_points WHERE speed_ms IS NOT NULL
             GROUP BY 1, 2, 3, 4 WITH NO DATA""",
        """SELECT add_continuous_aggregate_policy('street_speed_hourly',
             start_offset => INTERVAL '30 days', end_offset => INTERVAL '1 hour',
             schedule_interval => INTERVAL '10 minutes', if_not_exists => TRUE)""",
        f"SELECT add_retention_policy('ride_points', INTERVAL '{RAW_DAYS} days', if_not_exists => TRUE)",
    ]:
        c.execute(sql)
    _ready = True


# --- Matching GPS points to streets (pure, no database) -------------------------------------

def _seg_dist_m(p, a, b):
    # distance in metres from point p to segment a-b, all (lat, lon), flat-earth around p
    kx = 111320 * math.cos(math.radians(p[0]))
    ky = 110540
    ax, ay = (a[1] - p[1]) * kx, (a[0] - p[0]) * ky
    bx, by = (b[1] - p[1]) * kx, (b[0] - p[0]) * ky
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / l2))
    return math.hypot(ax + t * dx, ay + t * dy)


def _edge_shape(G, u, v, d):
    geom = d.get("geometry")
    if geom is not None:
        return [(y, x) for x, y in geom.coords]
    return [(G.nodes[u]["y"], G.nodes[u]["x"]), (G.nodes[v]["y"], G.nodes[v]["x"])]


def _bearing(a, b):
    y = math.sin(math.radians(b[1] - a[1])) * math.cos(math.radians(b[0]))
    x = (math.cos(math.radians(a[0])) * math.sin(math.radians(b[0]))
         - math.sin(math.radians(a[0])) * math.cos(math.radians(b[0])) * math.cos(math.radians(b[1] - a[1])))
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def _first(v):
    return v[0] if isinstance(v, list) and v else v


def snap(lat, lon, heading=None, max_m=40):
    """The street segment (u, v, osmid, name) a GPS point is on, or None if none is close.
    `heading` (degrees) picks the direction of travel on two-way streets."""
    G = routing.GRAPH
    # roads touching the 8 nearest junctions: in the middle of a long road the single
    # nearest junction can belong to a side street
    ids, lats, lons = node_index()
    d2 = ((lats - lat) * 110540) ** 2 + ((lons - lon) * 111320 * math.cos(math.radians(lat))) ** 2
    near = [ids[i] for i in np.argpartition(d2, min(8, len(ids) - 1))[:8]]
    candidates = {(u, v, k): d for n in near
                  for u, v, k, d in list(G.out_edges(n, keys=True, data=True)) + list(G.in_edges(n, keys=True, data=True))}
    best = None
    for (u, v, _k), d in candidates.items():
        shape = _edge_shape(G, u, v, d)
        dist = min(_seg_dist_m((lat, lon), a, b) for a, b in zip(shape, shape[1:]))
        if best is None or dist < best[0]:
            best = (dist, u, v, d)
    if best is None or best[0] > max_m:
        return None
    _, u, v, d = best
    if heading is not None and G.has_edge(v, u):
        # ride the way the rider is going
        fwd = _bearing((G.nodes[u]["y"], G.nodes[u]["x"]), (G.nodes[v]["y"], G.nodes[v]["x"]))
        if abs((heading - fwd + 180) % 360 - 180) > 90:
            u, v = v, u
            d = min(G[u][v].values(), key=lambda e: e["length"])
    return u, v, _first(d.get("osmid")), d.get("name") or ""


def _meters(a, b):
    return routing.haversine_m(a[0], a[1], b[0], b[1])


def _time(t):
    # milliseconds since 1970 (from the browser) or ISO text -> aware datetime
    if isinstance(t, (int, float)):
        return datetime.fromtimestamp(t / 1000, tz=timezone.utc)
    return datetime.fromisoformat(str(t).replace("Z", "+00:00"))


def measure(points):
    """GPS points -> rows with a speed and a street. The first point only gives the speed of
    the second (the frontend repeats the last point of the previous batch first)."""
    rows = []
    for prev, p in zip(points, points[1:]):
        t0, t1 = _time(prev["t"]), _time(p["t"])
        gap = (t1 - t0).total_seconds()
        a, b = (prev["lat"], prev["lon"]), (p["lat"], p["lon"])
        speed = None
        if 0.5 <= gap <= MAX_GAP_S and max(prev.get("acc") or 0, p.get("acc") or 0) <= MAX_ACCURACY_M:
            s = _meters(a, b) / gap
            speed = s if s <= MAX_SPEED else None
        heading = _bearing(a, b) if _meters(a, b) > 3 else None
        street = snap(p["lat"], p["lon"], heading)
        rows.append({"time": t1, "lat": p["lat"], "lon": p["lon"], "accuracy_m": p.get("acc"),
                     "speed_ms": speed, "street": street})
    return rows


# --- Writing ----------------------------------------------------------------------------------

def start_ride(start, end, profile, predicted_min, planned_m, simulated=False):
    ride_id = uuid.uuid4()
    _conn().execute(
        """INSERT INTO rides (ride_id, started_at, profile, simulated, start_lat, start_lon,
                              end_lat, end_lon, planned_m, predicted_min)
           VALUES (%s, now(), %s, %s, %s, %s, %s, %s, %s, %s)""",
        (ride_id, profile, simulated, start[0], start[1], end[0], end[1], planned_m, predicted_min))
    return str(ride_id)


def add_points(ride_id, points, simulated=False):
    rows = measure(points)
    if not rows:
        return 0
    with _conn().cursor() as cur:
        cur.executemany(
            """INSERT INTO ride_points (time, ride_id, lat, lon, accuracy_m, speed_ms,
                                        edge_u, edge_v, osmid, simulated)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            [(r["time"], ride_id, r["lat"], r["lon"], r["accuracy_m"], r["speed_ms"],
              *(r["street"][:3] if r["street"] else (None, None, None)), simulated) for r in rows])
    return len(rows)


def add_event(ride_id, kind, lat, lon, simulated=False):
    street = snap(lat, lon, None, max_m=60)
    osmid, name = (street[2], street[3]) if street else (None, None)
    _conn().execute(
        """INSERT INTO route_events (time, ride_id, kind, lat, lon, osmid, street, simulated)
           VALUES (now(), %s, %s, %s, %s, %s, %s, %s)""",
        (ride_id, kind, lat, lon, osmid, name, simulated))


def end_ride(ride_id, arrived, simulated_minutes=None):
    # Real rides: actual time = now - start. A simulated ride (sped up on /debug) reports
    # its own ride-clock minutes, which are only accepted for simulated rides.
    row = _conn().execute(
        """UPDATE rides SET ended_at = now(), arrived = %s,
                  actual_min = CASE WHEN simulated AND %s::real IS NOT NULL THEN %s::real
                                    ELSE EXTRACT(EPOCH FROM now() - started_at) / 60 END
           WHERE ride_id = %s RETURNING predicted_min, actual_min""",
        (arrived, simulated_minutes, simulated_minutes, ride_id)).fetchone()
    if not row:
        return None
    return {"predicted_min": round(row[0], 1) if row[0] is not None else None,
            "actual_min": round(row[1], 1)}


# --- Reading for routing (cached, real rides only) ---------------------------------------------

_cache = {}


def _cached(key, fn):
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < CACHE_S:
        return hit[1]
    try:
        value = fn()
    except Exception as e:  # no database, or it's down: route without learning
        print(f"ridelog: {key} unavailable ({e!r})")
        value = {} if key.startswith("speeds") else []
    _cache[key] = (time.monotonic(), value)
    return value


def learned_speeds(hour):
    """{(u, v): (average m/s, points)} for street segments with enough real riding around
    this hour of the day (the hour before and after count too)."""
    def read():
        rows = _conn().execute(
            """SELECT edge_u, edge_v, sum(avg_speed * points) / sum(points), sum(points)
               FROM street_speed_hourly
               WHERE NOT simulated
                 AND ((EXTRACT(HOUR FROM bucket AT TIME ZONE 'Europe/London')::int - %s + 24) %% 24) IN (0, 1, 23)
               GROUP BY 1, 2 HAVING sum(points) >= %s""",
            (hour, MIN_POINTS)).fetchall()
        return {(u, v): (float(s), int(n)) for u, v, s, n in rows}
    return _cached(f"speeds:{hour}", read)


def trouble_spots():
    """Streets that several different riders turned away from recently (possible closure)."""
    def read():
        rows = _conn().execute(
            """SELECT osmid, max(street), count(DISTINCT ride_id), avg(lat), avg(lon), max(time)
               FROM route_events
               WHERE NOT simulated AND osmid IS NOT NULL AND time > now() - %s * INTERVAL '1 hour'
               GROUP BY osmid HAVING count(DISTINCT ride_id) >= %s""",
            (TROUBLE_HOURS, TROUBLE_RIDES)).fetchall()
        return [{"osmid": o, "street": s or "this street", "riders": r, "lat": la, "lon": lo,
                 "last": t.isoformat()} for o, s, r, la, lo, t in rows]
    return _cached("trouble", read)


# --- Reading for the /debug Tiger Data page ----------------------------------------------------

def stats_live():
    c = _conn()
    rides = c.execute(
        """SELECT count(*) FILTER (WHERE NOT simulated), count(*) FILTER (WHERE simulated),
                  count(*) FILTER (WHERE arrived AND NOT simulated), max(started_at)
           FROM rides""").fetchone()
    points = c.execute(
        "SELECT count(*) FILTER (WHERE NOT simulated), count(*) FILTER (WHERE simulated) FROM ride_points"
    ).fetchone()
    events = c.execute(
        "SELECT count(*) FROM route_events WHERE time > now() - INTERVAL '24 hours'").fetchone()
    return {"rides_real": rides[0], "rides_simulated": rides[1], "rides_arrived": rides[2],
            "last_ride": rides[3].isoformat() if rides[3] else None,
            "points_real": points[0], "points_simulated": points[1], "events_24h": events[0],
            "raw_days_kept": RAW_DAYS}


def stats_speeds(hour=None, include_simulated=False):
    """Average real speed per street segment (optionally at one hour of the day), with its shape."""
    G = routing.GRAPH
    rows = _conn().execute(
        """SELECT edge_u, edge_v, sum(avg_speed * points) / sum(points), sum(points)
           FROM street_speed_hourly
           WHERE (%s OR NOT simulated)
             AND (%s::int IS NULL OR EXTRACT(HOUR FROM bucket AT TIME ZONE 'Europe/London')::int = %s)
           GROUP BY 1, 2""",
        (include_simulated, hour, hour)).fetchall()
    out = []
    for u, v, speed, n in rows:
        if not G.has_edge(u, v):
            continue
        d = min(G[u][v].values(), key=lambda e: e["length"])
        out.append({"coords": [[float(a), float(b)] for a, b in _edge_shape(G, u, v, d)],
                    "speed_ms": round(float(speed), 2), "points": int(n), "name": d.get("name") or ""})
    return out


def stats_accuracy(include_simulated=False, limit=200):
    rows = _conn().execute(
        """SELECT ended_at, predicted_min, actual_min, simulated FROM rides
           WHERE arrived AND predicted_min IS NOT NULL AND actual_min IS NOT NULL AND (%s OR NOT simulated)
           ORDER BY ended_at DESC LIMIT %s""",
        (include_simulated, limit)).fetchall()
    return [{"ended_at": e.isoformat(), "predicted_min": round(p, 1), "actual_min": round(a, 1),
             "error_pct": round(100 * (a - p) / p, 1) if p else None, "simulated": s}
            for e, p, a, s in reversed(rows)]


def stats_trouble(hours=24, include_simulated=False):
    rows = _conn().execute(
        """SELECT osmid, max(street), count(DISTINCT ride_id), count(*), avg(lat), avg(lon), max(time)
           FROM route_events
           WHERE osmid IS NOT NULL AND time > now() - %s * INTERVAL '1 hour' AND (%s OR NOT simulated)
           GROUP BY osmid ORDER BY 3 DESC, 4 DESC LIMIT 50""",
        (hours, include_simulated)).fetchall()
    return [{"osmid": o, "street": s or "", "riders": r, "events": n, "lat": la, "lon": lo,
             "last": t.isoformat(), "active": r >= TROUBLE_RIDES} for o, s, r, n, la, lo, t in rows]
