"""Gemini voice commands, ElevenLabs voice, Nominatim place search.

Keys come from the environment (backend/.env locally, Vercel's Environment Variables
when deployed): GEMINI_API_KEY, GEMINI_MODEL, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID,
ELEVENLABS_MODEL. Use the Services box on /debug to check them.
"""

import functools
import json
import os
import threading
import time
from datetime import datetime

import httpx

from time_model import London

# --- Place search (Nominatim) -------------------------------------------------------------
# Nominatim's rules: identify the app, at most 1 request per second, no autocomplete.

NOMINATIM = "https://nominatim.openstreetmap.org/search"
OXFORD_VIEWBOX = "-1.37,51.82,-1.14,51.69"  # left, top, right, bottom
USER_AGENT = "OxRide/0.1 (cycle navigation hackathon project; https://oxride.vercel.app)"

_search_lock = threading.Lock()
_last_search = 0.0


@functools.lru_cache(maxsize=512)
def search_place(q: str) -> list[dict]:
    """'Radcliffe Camera' -> [{name, lat, lon}, ...], Oxford only, best match first."""
    global _last_search
    q = q.strip()
    if not q:
        return []
    with _search_lock:
        wait = 1.0 - (time.monotonic() - _last_search)
        if wait > 0:
            time.sleep(wait)
        _last_search = time.monotonic()
        r = httpx.get(NOMINATIM, timeout=8, headers={"User-Agent": USER_AGENT},
                      params={"q": q, "format": "jsonv2", "limit": 5, "bounded": 1,
                              "viewbox": OXFORD_VIEWBOX})
    r.raise_for_status()
    return [{"name": h.get("name") or h["display_name"].split(",")[0],
             "lat": float(h["lat"]), "lon": float(h["lon"])} for h in r.json()]


# --- Text to speech (ElevenLabs) ------------------------------------------------------------

@functools.lru_cache(maxsize=256)  # the same direction text never costs credits twice
def speak(text: str) -> bytes:
    """Text -> mp3 bytes."""
    from elevenlabs.client import ElevenLabs

    client = ElevenLabs(api_key=os.environ["ELEVENLABS_API_KEY"])
    audio = client.text_to_speech.convert(
        os.environ["ELEVENLABS_VOICE_ID"],
        text=text,
        model_id=os.environ.get("ELEVENLABS_MODEL") or "eleven_flash_v2_5",
        output_format="mp3_44100_64",
    )
    return b"".join(audio)


# --- Understanding the rider (Gemini) ---------------------------------------------------------

SYSTEM = """You are OxRide, a voice assistant for a cyclist riding in Oxford, UK.
The rider is on a bike and can't look at the screen. Work out what they want:
- new_route: they name somewhere to go ("take me to the station").
- reroute: a different way to the same place ("avoid the hill", "the road's closed", "quieter way").
- answer: a question or anything else ("how long left?", "will it rain?", "what's next?").
settings.destination (new_route only): a place name that a map search of Oxford will find,
  e.g. "Oxford railway station", "Radcliffe Camera", "John Radcliffe Hospital".
settings.profile: "fast", "regular" or "chill", only if they ask for faster or quieter.
settings.depart_at: only if they say when they'll leave, as local time "YYYY-MM-DDTHH:MM".
reply: one or two short spoken sentences. No lists, no emoji, no markdown.
Use the context (time, position, current route) to answer questions."""

SCHEMA = {
    "type": "object",
    "required": ["action", "reply"],
    "properties": {
        "action": {"type": "string", "enum": ["new_route", "reroute", "answer"]},
        "settings": {
            "type": "object",
            "properties": {
                "destination": {"type": "string"},
                "profile": {"type": "string", "enum": ["fast", "regular", "chill"]},
                "depart_at": {"type": "string"},
            },
        },
        "reply": {"type": "string"},
    },
}


def route_summary(route: dict | None) -> dict | None:
    # What Gemini needs to know about the current route (not thousands of points).
    if not route:
        return None
    stats = route.get("stats") or {}
    return {
        "distance_km": round((stats.get("distance_m") or 0) / 1000, 1),
        "eta_min": stats.get("eta_min"),
        "climb_m": stats.get("climb_m"),
        "share_on_cycleways": stats.get("cycleway_share"),
        "share_lit": stats.get("lit_share"),
        "next_steps": [s.get("text") for s in (route.get("steps") or [])[:3]],
    }


def thinking_for(model: str):
    """Keep Gemini's "thinking" short: a rider waits for the answer (default thinking took ~75 s)."""
    from google.genai import types

    if "gemini-3" in model or "gemini-4" in model:
        return types.ThinkingConfig(thinking_level="MINIMAL")
    if "2.5" in model and "pro" not in model:
        return types.ThinkingConfig(thinking_budget=0)  # 2.5 flash: thinking off
    return None


def interpret_voice(audio: bytes | None, text: str | None,
                    position: tuple[float, float] | None, route: dict | None,
                    mime: str = "audio/webm") -> dict:
    """What the rider said -> {action, settings, reply} (Gemini).

    action is new_route | reroute | answer; reply is a sentence or two.
    """
    from google import genai
    from google.genai import types

    model = os.environ.get("GEMINI_MODEL")
    if not model:
        raise RuntimeError("GEMINI_MODEL is not set (pick one with the Gemini test on /debug)")
    context = {"time_now": datetime.now(London).strftime("%A %Y-%m-%d %H:%M"),
               "rider_position": position, "current_route": route_summary(route)}
    parts = [f"Context: {json.dumps(context)}"]
    if audio:
        parts.append(types.Part.from_bytes(data=audio, mime_type=mime))
    else:
        parts.append(f"The rider said: {text}")

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

    def ask(thinking):
        return client.models.generate_content(
            model=model, contents=parts,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM, temperature=0.3, thinking_config=thinking,
                response_mime_type="application/json", response_json_schema=SCHEMA))

    try:
        resp = ask(thinking_for(model))
    except Exception:
        resp = ask(None)  # this model doesn't take that thinking setting: use its default
    result = json.loads(resp.text)
    if result.get("action") not in ("new_route", "reroute", "answer"):
        result["action"] = "answer"
    result.setdefault("settings", {})
    result.setdefault("reply", "Okay.")
    return result
