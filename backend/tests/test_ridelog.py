"""Ride logs: matching GPS to streets, speeds, learned ETAs, trouble spots, endpoints.

The database tests run against a real Tiger Data / TimescaleDB in a throwaway schema when
TEST_DATABASE_URL is set (they're skipped otherwise); nothing else needs a database.
"""

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

import main
import ridelog
import routing
import time_model
from conftest import CALM_DAY, PLACES

T0 = datetime(2026, 10, 26, 8, 0, tzinfo=timezone.utc)


def ms(t):
    return int(t.timestamp() * 1000)


def a_route():
    r = routing.find_route(PLACES["Old Marston"], PLACES["Headington shops"], "regular", CALM_DAY)
    return r


def path_of(r):
    s = routing.nearest_node(routing.GRAPH, *r["route"][0])
    e = routing.nearest_node(routing.GRAPH, *r["route"][-1])
    return routing.astar(routing.GRAPH, s, e, routing.PROFILES["regular"], CALM_DAY)


# --- Matching points to streets ------------------------------------------------------------

def test_snap_finds_the_street_and_the_direction():
    path = path_of(a_route())
    G = routing.GRAPH
    # a point in the middle of a long-ish road on the route
    a, b = max(zip(path, path[1:]), key=lambda e: min(G[e[0]][e[1]].values(), key=lambda d: d["length"])["length"])
    d = min(G[a][b].values(), key=lambda e: e["length"])
    shape = ridelog._edge_shape(G, a, b, d)
    i = len(shape) // 2  # a point on the road itself, halfway along its shape
    mid = shape[i] if len(shape) > 2 else ((shape[0][0] + shape[1][0]) / 2, (shape[0][1] + shape[1][1]) / 2)
    heading = ridelog._bearing((G.nodes[a]["y"], G.nodes[a]["x"]), (G.nodes[b]["y"], G.nodes[b]["x"]))
    u, v, osmid, name = ridelog.snap(*mid, heading)
    assert {u, v} == {a, b}
    assert (u, v) == (a, b)  # the direction the rider is going
    back = ridelog.snap(*mid, (heading + 180) % 360)
    if G.has_edge(b, a):
        assert back[:2] == (b, a)


def test_snap_ignores_points_far_from_any_street():
    assert ridelog.snap(51.7700, -1.3600) is None  # a field west of the city


def test_measure_gives_speeds_and_drops_gps_jumps():
    p0 = {"t": ms(T0), "lat": 51.7534, "lon": -1.2540, "acc": 8}
    p1 = {"t": ms(T0 + timedelta(seconds=10)), "lat": 51.7534 + 0.0006, "lon": -1.2540, "acc": 8}  # ~66 m: 6.6 m/s
    p2 = {"t": ms(T0 + timedelta(seconds=12)), "lat": 51.7534 + 0.0030, "lon": -1.2540, "acc": 8}  # 267 m in 2 s: jump
    rows = ridelog.measure([p0, p1, p2])
    assert len(rows) == 2  # the first point only gives the next one its speed
    assert rows[0]["speed_ms"] == pytest.approx(6.6, abs=0.3)
    assert rows[1]["speed_ms"] is None
    assert rows[0]["time"] == T0 + timedelta(seconds=10)


def test_measure_skips_poor_gps_and_long_gaps():
    p0 = {"t": ms(T0), "lat": 51.7534, "lon": -1.2540, "acc": 80}
    p1 = {"t": ms(T0 + timedelta(seconds=10)), "lat": 51.7540, "lon": -1.2540, "acc": 8}
    p2 = {"t": ms(T0 + timedelta(seconds=200)), "lat": 51.7546, "lon": -1.2540, "acc": 8}
    rows = ridelog.measure([p0, p1, p2])
    assert [r["speed_ms"] for r in rows] == [None, None]


# --- Using what was learned ------------------------------------------------------------------

def test_learned_speeds_change_the_eta_where_known():
    plain = a_route()
    path = path_of(plain)
    slow = {(a, b): (2.0, 50) for a, b in zip(path, path[1:])}  # riders really do 2 m/s here
    learned = routing.find_route(PLACES["Old Marston"], PLACES["Headington shops"], "regular", CALM_DAY, learned=slow)
    assert learned["stats"]["learned_share"] == 1.0
    assert learned["stats"]["eta_min"] == pytest.approx(learned["stats"]["distance_m"] / 2.0 / 60, rel=0.01)
    assert plain["stats"]["learned_share"] == 0.0
    assert learned["route"] == plain["route"]  # learning changes the ETA, not the route


def test_eta_mixes_learned_and_model_speeds():
    roads = [{"length": 600, "highway": "primary", "surface": "asphalt", "grade": 0, "bearing": 0}] * 2
    model = time_model.eta_minutes(roads, CALM_DAY)
    mixed = time_model.eta_minutes(roads, CALM_DAY, [3.0, None])
    assert mixed == pytest.approx(600 / 3.0 / 60 + model / 2, rel=0.01)


def test_trouble_streets_are_avoided():
    path = path_of(a_route())
    G = routing.GRAPH
    # block the longest road of the route
    a, b = max(zip(path, path[1:]), key=lambda e: min(G[e[0]][e[1]].values(), key=lambda d: d["length"])["length"])
    osmid = ridelog._first(min(G[a][b].values(), key=lambda d: d["length"])["osmid"])
    ctx = {**CALM_DAY, "avoid_osmids": {osmid}}
    detour = routing.find_path(PLACES["Old Marston"], PLACES["Headington shops"], "regular", ctx)
    used = {ridelog._first(min(G[x][y].values(), key=lambda d: d["length"])["osmid"]) for x, y in zip(detour, detour[1:])}
    assert osmid not in used


def test_warning_names_the_street_near_the_route():
    r = a_route()
    p = r["route"][len(r["route"]) // 2]
    spot = {"osmid": 1, "street": "Marston Road", "riders": 4, "lat": p[0], "lon": p[1], "last": ""}
    far = {**spot, "lat": 51.70, "lon": -1.20}
    assert main.trouble_warning([spot], r["route"]).startswith("Avoiding Marston Road: 4 riders turned back")
    assert main.trouble_warning([far], r["route"]) is None
    assert main.trouble_warning([], r["route"]) is None


# --- Endpoints without a database: riding never breaks ----------------------------------------

@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with TestClient(main.app) as c:
        yield c


def test_ride_endpoints_say_off_without_a_database(client):
    rid = str(uuid.uuid4())
    start = client.post("/rides", json={"start": [51.75, -1.25], "end": [51.76, -1.21], "profile": "regular"})
    assert start.status_code == 200 and start.json()["ok"] is False
    assert client.post(f"/rides/{rid}/points", json={"points": [{"t": 0, "lat": 51.75, "lon": -1.25}]}).json()["ok"] is False
    assert client.post(f"/rides/{rid}/events", json={"kind": "off_route", "lat": 51.75, "lon": -1.25}).json()["ok"] is False
    assert client.post(f"/rides/{rid}/end", json={"arrived": True}).json()["ok"] is False
    assert client.get("/debug/rides/live").json()["ok"] is False


def test_ride_endpoints_survive_a_broken_database(client, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://nowhere")

    def boom(*a, **k):
        raise RuntimeError("database unreachable")
    monkeypatch.setattr(ridelog, "start_ride", boom)
    body = client.post("/rides", json={"start": [51.75, -1.25], "end": [51.76, -1.21]}).json()
    assert body["ok"] is False and "unreachable" in body["message"]


def test_route_works_when_the_database_is_down(client, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://nowhere")
    monkeypatch.setattr(ridelog, "_cache", {})
    monkeypatch.setattr(ridelog, "_conn", lambda: (_ for _ in ()).throw(RuntimeError("down")))
    r = client.post("/route", json={"start": list(PLACES["Station"]), "end": list(PLACES["Carfax"])})
    assert r.status_code == 200 and r.json()["warning"] is None


def test_bad_ride_input_is_rejected(client):
    assert client.post("/rides/not-a-uuid/end", json={"arrived": True}).status_code == 422
    assert client.post(f"/rides/{uuid.uuid4()}/events", json={"kind": "crash", "lat": 1, "lon": 2}).status_code == 422


# --- Against a real Tiger Data / TimescaleDB (throwaway schema) ------------------------------

DB_URL = os.environ.get("TEST_DATABASE_URL")
needs_db = pytest.mark.skipif(not DB_URL, reason="set TEST_DATABASE_URL to run against Tiger Data")


@pytest.fixture
def tiger(monkeypatch):
    import psycopg
    schema = f"oxride_test_{uuid.uuid4().hex[:8]}"
    conn = psycopg.connect(DB_URL, autocommit=True)
    conn.execute(f"CREATE SCHEMA {schema}")
    conn.execute(f"SET search_path TO {schema}, public")
    monkeypatch.setattr(ridelog, "_conn_override", conn)
    monkeypatch.setattr(ridelog, "_cache", {})
    try:
        yield conn
    finally:
        conn.execute(f"DROP SCHEMA {schema} CASCADE")
        conn.close()


def ride_along(route, start, every_m=5, speed=5.0):
    # GPS points along a route at `speed` m/s, one every `every_m` metres
    # (a phone gives about one reading a second, so ~5 m apart at 5 m/s)
    pts, t = [{"t": ms(start), "lat": route[0][0], "lon": route[0][1], "acc": 8}], start
    for a, b in zip(route, route[1:]):
        seg = routing.haversine_m(a[0], a[1], b[0], b[1])
        n = max(1, int(seg // every_m))
        for k in range(1, n + 1):
            f = k / n
            t += timedelta(seconds=seg / n / speed)
            pts.append({"t": ms(t), "lat": a[0] + (b[0] - a[0]) * f, "lon": a[1] + (b[1] - a[1]) * f, "acc": 8})
    return pts


@needs_db
def test_a_full_ride_is_stored_and_learned(tiger):
    r = a_route()
    now = datetime.now(timezone.utc)
    rid = ridelog.start_ride(r["route"][0], r["route"][-1], "regular", r["stats"]["eta_min"], r["stats"]["distance_m"])
    saved = ridelog.add_points(rid, ride_along(r["route"], now - timedelta(minutes=15)))
    assert saved > 10
    ridelog.add_event(rid, "off_route", *r["route"][5])
    out = ridelog.end_ride(rid, arrived=True)
    assert out["predicted_min"] == pytest.approx(r["stats"]["eta_min"], abs=0.1)
    live = ridelog.stats_live()
    assert live["rides_real"] == 1 and live["points_real"] == saved and live["events_24h"] == 1
    hour = (now - timedelta(minutes=15)).astimezone(time_model.London).hour
    speeds = ridelog.learned_speeds(hour)
    assert speeds and all(1.0 < s < 8.0 for s, n in speeds.values())
    assert ridelog.stats_speeds(None)
    assert ridelog.stats_accuracy()[-1]["predicted_min"] == out["predicted_min"]


@needs_db
def test_simulated_rides_never_teach_or_block(tiger):
    r = a_route()
    now = datetime.now(timezone.utc)
    for _ in range(4):
        rid = ridelog.start_ride(r["route"][0], r["route"][-1], "regular", 10, 1000, simulated=True)
        ridelog.add_points(rid, ride_along(r["route"], now - timedelta(minutes=10)), simulated=True)
        ridelog.add_event(rid, "off_route", *r["route"][5], simulated=True)
    hour = (now - timedelta(minutes=10)).astimezone(time_model.London).hour
    assert ridelog.learned_speeds(hour) == {}
    assert ridelog.trouble_spots() == []
    assert ridelog.stats_speeds(None, include_simulated=True)  # but the dashboard can show them
    assert ridelog.stats_trouble(include_simulated=True)


@needs_db
def test_three_riders_turning_back_make_a_trouble_spot(tiger):
    r = a_route()
    spot = r["route"][len(r["route"]) // 2]
    for n in range(3):
        rid = ridelog.start_ride(r["route"][0], r["route"][-1], "regular", 10, 1000)
        ridelog.add_event(rid, "off_route", *spot)
        if n < 2:
            ridelog._cache.clear()
            assert ridelog.trouble_spots() == []  # one or two riders isn't enough
    ridelog._cache.clear()
    spots = ridelog.trouble_spots()
    assert len(spots) == 1 and spots[0]["riders"] == 3
