"""API endpoints. /route is real; the others return fake JSON until their functions are ready."""

import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Literal

import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import routing
import time_model

GRAPH_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "oxford_graph.pkl")

LatLon = tuple[float, float]
Profile = Literal["fast", "regular", "chill"]


@asynccontextmanager
async def lifespan(app):
    # Load the graph once, when the server starts.
    if os.path.exists(GRAPH_PATH):
        routing.load_graph(GRAPH_PATH)
    else:
        print(f"WARNING: {GRAPH_PATH} not found. Run `python build_graph.py` first.")
    yield


app = FastAPI(title="OxRide", lifespan=lifespan)

# The website runs on another address (localhost:3000, Vercel), so the browser needs
# this to allow it to call the API.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

class RouteRequest(BaseModel):
    start: LatLon
    end: LatLon
    profile: Profile = "regular"
    depart_at: str | None = None


class VoiceRequest(BaseModel):
    audio_b64: str | None = None
    text: str | None = None
    position: LatLon | None = None
    route: dict | None = None


class SpeakRequest(BaseModel):
    text: str


def parse_depart_at(depart_at):
    # The request sends text (or nothing). get_context needs a real datetime.
    # Nothing, "", or "null" means leaving now. A time without a timezone is Oxford time.
    if not depart_at or depart_at == "null":
        return datetime.now(timezone.utc)
    try:
        when = datetime.fromisoformat(depart_at)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"depart_at is not a date/time: {depart_at!r}")
    if when.tzinfo is None:
        when = when.replace(tzinfo=time_model.London)
    return when


def get_ctx(depart_at):
    when = parse_depart_at(depart_at)
    try:
        return time_model.get_context(when)
    except requests.RequestException as e:
        # Open-Meteo is down or slow: route anyway, as a dry ride with no wind.
        print(f"WARNING: weather fetch failed ({e}), using a default context")
        return {"wind_ms": 0, "wind_from_deg": 0, "rain_prob": 0, "rain_mm": 0,
                "dark": False, "rush": False, "local": when.isoformat()}


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "graph_loaded": routing.GRAPH is not None}


@app.post("/route")
async def route(req: RouteRequest) -> dict:
    if routing.GRAPH is None:
        raise HTTPException(status_code=503, detail="graph not loaded: run python build_graph.py")

    ctx = get_ctx(req.depart_at)
    try:
        return routing.find_route(req.start, req.end, req.profile, ctx)
    except ValueError:
        raise HTTPException(status_code=404, detail="no route found")


@app.get("/best-departure")
async def best_departure(start: str, end: str, profile: Profile = "regular") -> list:
    return []


@app.get("/search")
async def search(q: str) -> list:
    return []


@app.post("/voice")
async def voice(req: VoiceRequest) -> dict:
    return {"action": "answer", "settings": {}, "reply": "Okay."}


@app.post("/speak")
async def speak(req: SpeakRequest) -> dict:
    return {"audio": None}
