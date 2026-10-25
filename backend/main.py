"""API endpoints. Parses the request, calls one or two functions, returns JSON."""

import base64
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Literal

import requests
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import ai
import debug
import ridelog
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
    # Real rides (Tiger Data): measured speeds for the ETA, streets riders are turning away from
    learned, trouble = {}, []
    if os.environ.get("DATABASE_URL"):
        hour = datetime.fromisoformat(ctx["local"]).hour if ctx.get("local") else datetime.now(time_model.London).hour
        learned = ridelog.learned_speeds(hour)
        trouble = ridelog.trouble_spots()
        if trouble:
            ctx = {**ctx, "avoid_osmids": {t["osmid"] for t in trouble}}
    try:
        result = routing.find_route(req.start, req.end, req.profile, ctx, learned=learned)
    except ValueError:
        raise HTTPException(status_code=404, detail="no route found")
    result["warning"] = trouble_warning(trouble, result["route"])
    # "Leave in 20 min: the rain stops" -- only when leaving now, and only if it's worth saying
    result["hint"] = None
    if not req.depart_at or req.depart_at == "null":
        try:
            result["hint"] = time_model.departure_hint(datetime.now(timezone.utc), result["stats"]["eta_min"])
        except Exception as e:
            print(f"WARNING: departure hint failed ({e!r})")
    return result

def trouble_warning(trouble, route, near_m=250):
    # Say why the route bends away from a street, if it's one riders keep turning back on
    for t in trouble:
        if any(routing.haversine_m(t["lat"], t["lon"], p[0], p[1]) < near_m for p in route[::3] + route[-1:]):
            return (f"Avoiding {t['street']}: {t['riders']} riders turned back there in the last "
                    f"{ridelog.TROUBLE_HOURS} hours (possible closure).")
    return None


# --- Ride logs (Tiger Data). Never break riding: failures answer ok=false. ------------------

class RideStart(BaseModel):
    start: LatLon
    end: LatLon
    profile: Profile = "regular"
    predicted_min: float | None = None
    planned_m: float | None = None
    simulated: bool = False


class RidePoint(BaseModel):
    t: float | str  # ms since 1970 (browser) or ISO time
    lat: float
    lon: float
    acc: float | None = None


class RidePoints(BaseModel):
    points: list[RidePoint]
    simulated: bool = False


class RideEvent(BaseModel):
    kind: Literal["off_route", "reroute"]
    lat: float
    lon: float
    simulated: bool = False


class RideEnd(BaseModel):
    arrived: bool
    actual_min: float | None = None  # only used for simulated rides (sped-up ride clock)


def _logged(fn):
    if not os.environ.get("DATABASE_URL"):
        return {"ok": False, "message": "ride logging is off (no DATABASE_URL)"}
    try:
        return {"ok": True, **(fn() or {})}
    except Exception as e:
        print(f"WARNING: ride log failed ({e!r})")
        return {"ok": False, "message": f"{type(e).__name__}: {str(e)[:200]}"}


@app.post("/rides")
def ride_start(req: RideStart) -> dict:
    return _logged(lambda: {"ride_id": ridelog.start_ride(
        req.start, req.end, req.profile, req.predicted_min, req.planned_m, req.simulated)})


@app.post("/rides/{ride_id}/points")
def ride_points(ride_id: uuid.UUID, req: RidePoints) -> dict:
    return _logged(lambda: {"saved": ridelog.add_points(
        str(ride_id), [p.model_dump() for p in req.points], req.simulated)})


@app.post("/rides/{ride_id}/events")
def ride_event(ride_id: uuid.UUID, req: RideEvent) -> dict:
    return _logged(lambda: ridelog.add_event(str(ride_id), req.kind, req.lat, req.lon, req.simulated))


@app.post("/rides/{ride_id}/end")
def ride_end(ride_id: uuid.UUID, req: RideEnd) -> dict:
    return _logged(lambda: ridelog.end_ride(str(ride_id), req.arrived, req.actual_min))


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
        # Plan B: simple commands ("take me to univ", "quieter please") work without Gemini
        result = ai.simple_command(req.text)
        if result is None:
            # "error" is for debugging (curl / Vercel logs); the app only uses action, settings, reply
            return {"action": "answer", "settings": {}, "reply": "Sorry, I couldn't understand that. Try again?",
                    "error": f"{type(e).__name__}: {str(e)[:300]}"}

    settings = dict(result.get("settings") or {})
    place = settings.pop("destination", None)
    place = ai.oxford_name(place) or place  # "Univ" -> "University College" for the map search
    if result["action"] == "new_route":
        hits = []
        if place:
            try:
                hits = ai.search_place(place)
            except Exception as e:
                print(f"WARNING: place search failed ({e!r})")
        if not hits:
            return {"action": "answer", "settings": {}, "heard": result.get("heard"),
                    "reply": f"Sorry, I couldn't find {place or 'that place'} in Oxford."}
        settings["end"] = [hits[0]["lat"], hits[0]["lon"]]
        settings["end_name"] = hits[0]["name"]
    if req.position and result["action"] in ("new_route", "reroute"):
        settings["start"] = list(req.position)
    # heard: what Gemini heard (the app shows it, most useful when it was sent a recording)
    return {"action": result["action"], "settings": settings, "reply": result["reply"],
            "heard": result.get("heard")}


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
