"""API endpoints. Parses the request, calls one or two functions, returns JSON."""

import base64
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Literal

import requests
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import ai
import debug
import routing
import time_model

GRAPH_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "oxford_graph.pkl")

LatLon = tuple[float, float]
Profile = Literal["fast", "regular", "chill"]


@asynccontextmanager
async def lifespan(app):
    # Load the graph once, when the server starts (skipped if it's already loaded).
    if routing.GRAPH is not None:
        pass
    elif os.path.exists(GRAPH_PATH):
        routing.load_graph(GRAPH_PATH)
    else:
        print(f"WARNING: {GRAPH_PATH} not found. Run `python build_graph.py` first.")
    yield


app = FastAPI(title="OxRide", lifespan=lifespan)

# The website runs on another address (localhost:3000, Vercel), so the browser needs
# this to allow it to call the API.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# /debug/*: the routing debug panel (frontend/app/debug).
app.include_router(debug.router)

class RouteRequest(BaseModel):
    start: LatLon
    end: LatLon
    profile: Profile = "regular"
    depart_at: str | None = None


class VoiceRequest(BaseModel):
    audio_b64: str | None = None
    mime: str = "audio/webm"  # what the browser recorded (iPhones: audio/mp4)
    text: str | None = None
    position: LatLon | None = None
    route: dict | None = None


class SpeakRequest(BaseModel):
    text: str

class NavStep(BaseModel):
    instruction: str      # "Turn right onto Woodstock Rd"
    distance_m: float     # Length of this step
    lat: float            # Where the step starts
    lon: float

class NavigationData(BaseModel):
    distance_m: float     # Total trip distance
    duration_s: float     # Total trip time
    steps: list[NavStep]


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
def route(req: RouteRequest) -> dict:
    if routing.GRAPH is None:
        raise HTTPException(status_code=503, detail="graph not loaded: run python build_graph.py")

    ctx = get_ctx(req.depart_at)
    try:
        return routing.find_route(req.start, req.end, req.profile, ctx)
    except ValueError:
        raise HTTPException(status_code=404, detail="no route found")

@app.post("/navigation")
def navigation(req: RouteRequest) -> NavigationData:
    # Turn-by-turn for the same route /route returns (same A*, same time of day).
    r = route(req)
    return NavigationData(
        distance_m=r["stats"]["distance_m"],
        duration_s=round(r["stats"]["eta_min"] * 60),
        steps=[NavStep(instruction=s["text"], distance_m=s["distance_m"], lat=s["lat"], lon=s["lon"])
               for s in r["steps"]],
    )

def parse_point(text):
    # "51.75,-1.25" -> (51.75, -1.25)
    try:
        lat, lon = (float(x) for x in text.split(","))
        return lat, lon
    except ValueError:
        raise HTTPException(status_code=422, detail=f"expected 'lat,lon', got {text!r}")


@app.get("/best-departure")
def best_departure(start: str, end: str, profile: Profile = "regular") -> list:
    # One A* run for leaving now, then the same route's ETA for every 15-minute slot.
    if routing.GRAPH is None:
        raise HTTPException(status_code=503, detail="graph not loaded")
    s, e = parse_point(start), parse_point(end)
    ctx = get_ctx(None)
    path = routing.find_path(s, e, profile, ctx)
    if path is None:
        raise HTTPException(status_code=404, detail="no route found")
    edges = routing.route_edges(path, routing.PROFILES[profile], ctx)
    return time_model.best_departures(lambda _ctx: edges, profile=profile, route_id=f"{start}->{end}")


@app.get("/search")
def search(q: str) -> list:
    try:
        return ai.search_place(q)
    except Exception as e:
        print(f"WARNING: place search failed ({e!r})")
        raise HTTPException(status_code=502, detail="place search is unavailable")


@app.post("/voice")
def voice(req: VoiceRequest) -> dict:
    # Gemini works out what the rider wants; a named place is turned into coordinates.
    if not req.audio_b64 and not (req.text or "").strip():
        raise HTTPException(status_code=422, detail="send audio_b64 or text")
    try:
        audio = base64.b64decode(req.audio_b64) if req.audio_b64 else None
    except ValueError:
        raise HTTPException(status_code=422, detail="audio_b64 is not base64")
    try:
        result = ai.interpret_voice(audio, req.text, req.position, req.route, req.mime)
    except Exception as e:
        print(f"WARNING: Gemini failed ({e!r})")
        return {"action": "answer", "settings": {}, "reply": "Sorry, I couldn't understand that. Try again?"}

    settings = dict(result.get("settings") or {})
    place = settings.pop("destination", None)
    if result["action"] == "new_route":
        hits = []
        if place:
            try:
                hits = ai.search_place(place)
            except Exception as e:
                print(f"WARNING: place search failed ({e!r})")
        if not hits:
            return {"action": "answer", "settings": {},
                    "reply": f"Sorry, I couldn't find {place or 'that place'} in Oxford."}
        settings["end"] = [hits[0]["lat"], hits[0]["lon"]]
        settings["end_name"] = hits[0]["name"]
    if req.position and result["action"] in ("new_route", "reroute"):
        settings["start"] = list(req.position)
    return {"action": result["action"], "settings": settings, "reply": result["reply"]}


@app.post("/speak")
def speak(req: SpeakRequest) -> Response:
    # ElevenLabs speech as an mp3 the browser can play directly.
    # 503 = no audio (ElevenLabs down, out of credits, no key): use the browser's own voice.
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=422, detail="nothing to say")
    try:
        return Response(content=ai.speak(text[:500]), media_type="audio/mpeg")
    except Exception as e:
        print(f"WARNING: ElevenLabs failed ({e!r})")
        raise HTTPException(status_code=503, detail="speech is unavailable")
