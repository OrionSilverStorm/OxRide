"""The HTTP API the frontend relies on: shapes match CLAUDE.md and lib/api.ts."""

import pytest
from fastapi.testclient import TestClient

import main
import vercel_app
from conftest import NOON, PLACES

TRIP = {"start": list(PLACES["Old Marston"]), "end": list(PLACES["Headington shops"])}


@pytest.fixture(scope="module")
def client():
    with TestClient(main.app) as c:
        yield c


def test_health(client):
    assert client.get("/health").json() == {"status": "ok", "graph_loaded": True}


@pytest.mark.parametrize("profile", ["fast", "regular", "chill"])
def test_route_contract(client, profile):
    r = client.post("/route", json={**TRIP, "profile": profile})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"route", "elevations_m", "stats", "steps"}
    assert len(body["route"]) == len(body["elevations_m"])
    assert body["steps"][-1]["maneuver"] == "arrive"


def test_route_accepts_a_departure_time(client):
    for when in (NOON.isoformat(), "2026-10-24T13:00", None, ""):
        r = client.post("/route", json={**TRIP, "profile": "regular", "depart_at": when})
        assert r.status_code == 200, when


def test_route_rejects_bad_input(client):
    assert client.post("/route", json={**TRIP, "profile": "turbo"}).status_code == 422
    assert client.post("/route", json={**TRIP, "depart_at": "tomorrow-ish"}).status_code == 422
    assert client.post("/route", json={"start": [51.75, -1.25]}).status_code == 422


def test_debug_route_explains_itself(client):
    r = client.post("/debug/route", json={**TRIP, "profile": "regular", "depart_at": NOON.isoformat()})
    assert r.status_code == 200
    body = r.json()
    ours = body["routes"][0]
    assert ours["id"] == "ours" and ours["cost_check_ok"]
    assert ours["astar"]["expanded_count"] > 0
    # A* never loses on its own cost function
    assert not any("A* should never lose" in w for w in body["warnings"])


def test_vercel_paths_have_the_api_prefix():
    with TestClient(vercel_app.app) as c:
        assert c.get("/api/health").json()["graph_loaded"] is True
        assert c.post("/api/route", json={**TRIP, "profile": "regular"}).status_code == 200


def test_best_departure_endpoint(client):
    start = ",".join(map(str, PLACES["Old Marston"]))
    end = ",".join(map(str, PLACES["Headington shops"]))
    r = client.get(f"/best-departure?start={start}&end={end}&profile=regular")
    assert r.status_code == 200
    slots = r.json()
    assert len(slots) == 13 and sum(s["best"] for s in slots) == 1
    assert all(s["eta_min"] > 0 for s in slots)


def test_best_departure_rejects_bad_points(client):
    assert client.get("/best-departure?start=nowhere&end=51.7,-1.2").status_code == 422
