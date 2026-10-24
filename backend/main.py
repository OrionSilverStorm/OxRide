"""API endpoints. Returns fake JSON until the real functions are ready."""

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="OxRide")

LatLon = tuple[float, float]


class RouteRequest(BaseModel):
    start: LatLon
    end: LatLon
    profile: str = "commuter"
    depart_at: str | None = None


class ParseRequest(BaseModel):
    text: str


class SpeakRequest(BaseModel):
    text: str


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/route")
def route(req: RouteRequest) -> dict:
    return {
        "route": [req.start, req.end],
        "stats": {"distance_m": 0, "climb_m": 0, "eta_min": 0,
                  "cycleway_share": 0.0, "lit_share": 0.0},
        "steps": [{"text": "Arrive", "distance_m": 0,
                   "lat": req.end[0], "lon": req.end[1], "maneuver": "arrive"}],
    }


@app.get("/best-departure")
def best_departure(start: str, end: str, profile: str = "commuter") -> list:
    return []


@app.get("/search")
def search(q: str) -> list:
    return []


@app.post("/parse")
def parse(req: ParseRequest) -> dict:
    return {"start": None, "end": None, "profile": "commuter",
            "depart_at": None, "note": ""}


@app.post("/speak")
def speak(req: SpeakRequest) -> dict:
    return {"audio": None}
