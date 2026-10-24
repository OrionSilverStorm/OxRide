"""API endpoints. /route is real; the others return fake JSON until their functions are ready."""

import os
from contextlib import asynccontextmanager
from typing import Literal

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


def get_ctx(depart_at):
    try:
        return time_model.get_context(depart_at)
    except NotImplementedError:
        # time_model isn't written yet, so pretend it's a dry daytime ride.
        # Delete this fallback once get_context works.
        return {"hour": 12, "is_dark": False, "wind_speed": 0, "wind_dir": 0,
                "rain": 0, "temperature_c": 12}


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "graph_loaded": routing.GRAPH is not None}


@app.post("/route")
def route(req: RouteRequest) -> dict:
    if routing.GRAPH is None:
        raise HTTPException(status_code=503, detail="graph not loaded: run python build_graph.py")

    ctx = get_ctx(req.depart_at)
    try:
        return routing.find_route(req.start, req.end, req.profile, ctx)
    except ValueError:
        raise HTTPException(status_code=404, detail="no route found")


@app.get("/best-departure")
def best_departure(start: str, end: str, profile: Profile = "regular") -> list:
    return []


@app.get("/search")
def search(q: str) -> list:
    return []


@app.post("/voice")
def voice(req: VoiceRequest) -> dict:
    return {"action": "answer", "settings": {}, "reply": "Okay."}


@app.post("/speak")
def speak(req: SpeakRequest) -> dict:
    return {"audio": None}
