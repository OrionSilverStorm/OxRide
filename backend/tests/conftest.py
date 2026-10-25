"""Shared test setup.

Run from the repo root:  .venv/bin/python -m pytest backend/tests
(Windows: .venv\\Scripts\\python -m pytest backend\\tests)

No test touches the network: weather comes from backend/weather_snapshot.json
(24-26 Oct 2026), so results don't change with the real forecast.
"""

import json
import os
import sys
from datetime import datetime, timezone

import pytest

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND)

import routing  # noqa: E402
import time_model  # noqa: E402

GRAPH_PATH = os.path.join(BACKEND, "oxford_graph.pkl")
SNAPSHOT = os.path.join(BACKEND, "weather_snapshot.json")

# Times inside the snapshot. Noon is light, 22:00 is dark.
NOON = datetime(2026, 10, 24, 12, 0, tzinfo=timezone.utc)
NIGHT = datetime(2026, 10, 24, 22, 0, tzinfo=timezone.utc)

PLACES = {
    "Station": (51.7535, -1.2700),
    "Radcliffe Camera": (51.7534, -1.2540),
    "Carfax": (51.7518, -1.2578),
    "Summertown": (51.7768, -1.2643),
    "Old Marston": (51.7740, -1.2400),
    "Headington shops": (51.7600, -1.2135),
    "Templars Square": (51.7345, -1.2100),
    "Iffley village": (51.7290, -1.2380),
    "Iffley Road sports": (51.7470, -1.2400),
    "Osney": (51.7510, -1.2780),
}

TRIPS = [
    ("Station", "Radcliffe Camera"),
    ("Summertown", "Carfax"),
    ("Old Marston", "Headington shops"),
    ("Templars Square", "Radcliffe Camera"),
    ("Iffley village", "Station"),
    ("Osney", "Iffley Road sports"),
]

# A plain daytime context: dry, no wind, not rush hour.
CALM_DAY = {"wind_ms": 0, "wind_from_deg": 0, "rain_prob": 0, "rain_mm": 0,
            "dark": False, "rush": False}


@pytest.fixture(autouse=True)
def offline_weather(monkeypatch):
    # Every test reads the saved forecast instead of calling Open-Meteo.
    with open(SNAPSHOT) as f:
        snapshot = json.load(f)
    monkeypatch.setattr(time_model, "fetch_weather", lambda: snapshot)
    monkeypatch.setattr(time_model, "_weather_cache", None)


@pytest.fixture(scope="session", autouse=True)
def graph():
    # Load the real Oxford graph once for the whole run.
    routing.load_graph(GRAPH_PATH)
    return routing.GRAPH
