"""Gemini voice commands, ElevenLabs voice, Nominatim place search.

Keys come from the environment (backend/.env locally, Vercel's Environment Variables
when deployed): GEMINI_API_KEY, GEMINI_MODEL, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID,
ELEVENLABS_MODEL. Use the Services box on /debug to check them.
"""

import functools
import json
import os
import re
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

# --- Oxford names ------------------------------------------------------------------------
# What riders say -> the name a map search finds. Speech-to-text writes what it hears, so
# some keys are "sounds like" spellings (Magdalen is said "maudlin"). Used in Gemini's
# instructions and by the no-Gemini fallback below.
OXFORD_NAMES = {
    "univ": "University College", "university college": "University College",
    "maudlin": "Magdalen College", "magdalene": "Magdalen College", "magdalen": "Magdalen College",
    "maudlin bridge": "Magdalen Bridge", "magdalen bridge": "Magdalen Bridge",
    "the house": "Christ Church", "christchurch": "Christ Church", "christ church": "Christ Church",
    "rad cam": "Radcliffe Camera", "radcam": "Radcliffe Camera", "radcliffe camera": "Radcliffe Camera",
    "the bod": "Bodleian Library", "bod": "Bodleian Library", "bodleian": "Bodleian Library",
    "ashmolean": "Ashmolean Museum", "pitt rivers": "Pitt Rivers Museum",
    "sheldonian": "Sheldonian Theatre", "carfax": "Carfax Tower", "covered market": "Covered Market",
    "westgate": "Westgate Oxford",
    "station": "Oxford railway station", "train station": "Oxford railway station",
    "railway station": "Oxford railway station",
    "bus station": "Gloucester Green", "gloucester green": "Gloucester Green",
    "jr": "John Radcliffe Hospital", "john radcliffe": "John Radcliffe Hospital",
    "parks": "University Parks", "uni parks": "University Parks", "university parks": "University Parks",
    "port meadow": "Port Meadow", "brookes": "Oxford Brookes University Headington Campus",
    "iffley road": "Iffley Road Sports Centre", "the plain": "The Plain",
    "teddy hall": "St Edmund Hall", "lmh": "Lady Margaret Hall", "bnc": "Brasenose College",
    "brasenose": "Brasenose College", "catz": "St Catherine's College", "st catz": "St Catherine's College",
    "corpus": "Corpus Christi College", "keble": "Keble College", "balliol": "Balliol College",
    "merton": "Merton College", "oriel": "Oriel College", "exeter": "Exeter College",
    "jesus": "Jesus College", "lincoln": "Lincoln College", "new college": "New College",
    "queens": "The Queen's College", "queen's": "The Queen's College", "wadham": "Wadham College",
    "trinity": "Trinity College", "st johns": "St John's College", "st john's": "St John's College",
    "worcester": "Worcester College", "hertford": "Hertford College", "pembroke": "Pembroke College",
    "somerville": "Somerville College", "st hughs": "St Hugh's College", "st hugh's": "St Hugh's College",
    "st annes": "St Anne's College", "st anne's": "St Anne's College", "st hildas": "St Hilda's College",
    "st hilda's": "St Hilda's College", "mansfield": "Mansfield College", "wolfson": "Wolfson College",
    "st antonys": "St Antony's College", "st antony's": "St Antony's College", "nuffield": "Nuffield College",
}


def oxford_name(place: str | None) -> str | None:
    """'the Rad Cam' -> 'Radcliffe Camera'; None if it isn't a known nickname."""
    if not place:
        return None
    key = re.sub(r"[^a-z' ]", "", place.lower()).strip()
    key = re.sub(r"^the ", "", key)
    key = re.sub(r" college$", "", key) if key not in OXFORD_NAMES else key
    return OXFORD_NAMES.get(key) or OXFORD_NAMES.get(re.sub(r"^the ", "", place.lower().strip()))


def _names_for_prompt() -> str:
    by_place = {}
    for said, name in OXFORD_NAMES.items():
        if said != name.lower():
            by_place.setdefault(name, []).append(said)
    return "; ".join(f"{', '.join(saids)} = {name}" for name, saids in by_place.items())


SYSTEM = """You are OxRide, a voice assistant for a cyclist riding in Oxford, UK.
The rider is on a bike and can't look at the screen. Work out what they want:
- new_route: they name somewhere to go ("take me to the station").
- reroute: a different way to the same place ("avoid the hill", "the road's closed", "quieter way").
- answer: a question or anything else ("how long left?", "will it rain?", "what's next?").
settings.destination (new_route only): a place name that a map search of Oxford will find,
  e.g. "Oxford railway station", "Radcliffe Camera", "John Radcliffe Hospital".
  Speech-to-text often mishears Oxford names. Nicknames and how they may be written: """ + _names_for_prompt() + """.
  Always give the full name on the right.
settings.profile: "fast", "regular" or "chill", only if they ask for faster or quieter.
settings.depart_at: only if they say when they'll leave, as local time "YYYY-MM-DDTHH:MM".
reply: one or two short spoken sentences. No lists, no emoji, no markdown.
heard: what the rider said, word for word, as plain text (shown on screen so they can see a mishearing).
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
        "heard": {"type": "string"},
    },
}


# --- Plan B without Gemini ------------------------------------------------------------
# If every Gemini model fails (quota, outage), simple commands still work.

_GO = re.compile(
    r"^(?:(?:hey|ok|okay)\s+)?(?:please\s+)?(?:can you\s+)?"
    r"(?:take me|bring me|get me|go|navigate|directions|route me|ride|cycle|head|"
    r"i want to go|i'd like to go|let's go|lets go)\s+(?:back\s+)?(?:to|towards|for)\s+(?P<place>.+?)"
    r"(?:\s+please)?[.!?]*$", re.I)
_QUIET = re.compile(r"\b(quiet|quieter|calm|calmer|chill|safer|safe)\b", re.I)
_FAST = re.compile(r"\b(fast|faster|fastest|quick|quicker|quickest)\b", re.I)
_OTHER_WAY = re.compile(r"\b(reroute|re-route|another way|different way|other way|avoid|instead|route)\b", re.I)


def simple_command(text: str | None) -> dict | None:
    """'take me to univ' -> new_route to University College, without Gemini. None if unsure."""
    text = (text or "").strip()
    profile = "chill" if _QUIET.search(text) else "fast" if _FAST.search(text) else None
    go = _GO.match(text)
    if go:
        said = re.sub(r"\b(?:a |the )?(?:quiet|quieter|calm|chill|safe|safer|fast|faster|quick|quicker)\s+(?:way|route|ride)\b", "",
                      go.group("place"), flags=re.I).strip(" ,")
        said = re.sub(r"^(?:to|towards)\s+", "", said, flags=re.I)
        said = re.sub(r"^(?:the)\s+", "", said, flags=re.I) if oxford_name(said) else said
        place = oxford_name(said) or said
        settings = {"destination": place, **({"profile": profile} if profile else {})}
        return {"action": "new_route", "settings": settings, "reply": f"Going to {place}."}
    if profile and _OTHER_WAY.search(text) or profile and len(text.split()) <= 4:
        word = "quieter" if profile == "chill" else "faster"
        return {"action": "reroute", "settings": {"profile": profile}, "reply": f"Finding a {word} way."}
    return None


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


# If GEMINI_MODEL is overloaded (503), out of free quota (429) or slow, try these next.
# Picked with /debug/gemini-speed: both answered a voice command in under 2 s.
DEFAULT_FALLBACK_MODELS = "gemini-flash-lite-latest,gemini-3-flash-preview"
ATTEMPT_TIMEOUT_MS = 10_000  # per model: a rider can't wait longer


def gemini_models(override: str | None = None) -> list[str]:
    """Models to try, in order: GEMINI_MODEL, then GEMINI_FALLBACK_MODELS."""
    if override:
        return [override]
    first = os.environ.get("GEMINI_MODEL") or ""
    rest = os.environ.get("GEMINI_FALLBACK_MODELS", DEFAULT_FALLBACK_MODELS)
    models = [m.strip() for m in [first, *rest.split(",")] if m.strip()]
    return list(dict.fromkeys(models))  # no repeats, order kept


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
                    mime: str = "audio/webm", model: str | None = None, report: dict | None = None) -> dict:
    """What the rider said -> {action, settings, reply} (Gemini).

    action is new_route | reroute | answer; reply is a sentence or two.
    model overrides GEMINI_MODEL; report (if given) gets filled with how the call went.
    """
    from google import genai
    from google.genai import types

    models = gemini_models(model)
    if not models:
        raise RuntimeError("GEMINI_MODEL is not set (pick one with the Gemini test on /debug)")
    context = {"time_now": datetime.now(London).strftime("%A %Y-%m-%d %H:%M"),
               "rider_position": position, "current_route": route_summary(route)}
    parts = [f"Context: {json.dumps(context)}"]
    if audio:
        parts.append(types.Part.from_bytes(data=audio, mime_type=mime))
    else:
        parts.append(f"The rider said: {text}")

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"],
                          http_options=types.HttpOptions(timeout=ATTEMPT_TIMEOUT_MS))
    report = report if report is not None else {}

    def ask(name, thinking):
        return client.models.generate_content(
            model=name, contents=parts,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM, temperature=0.3, thinking_config=thinking,
                response_mime_type="application/json", response_json_schema=SCHEMA))

    errors = []
    for name in models:
        thinking = thinking_for(name)
        try:
            try:
                resp = ask(name, thinking)
                report["thinking"] = "short" if thinking is not None else "model default"
            except Exception as e:
                if thinking is None or "INVALID_ARGUMENT" not in str(e):
                    raise
                report["thinking"] = "model default (short thinking rejected)"
                resp = ask(name, None)  # this model doesn't take that setting
            report["model"] = name
            break
        except Exception as e:  # overloaded, out of quota, too slow, unknown model: try the next one
            errors.append(f"{name}: {type(e).__name__}: {str(e)[:120]}")
    else:
        report["errors"] = errors
        raise RuntimeError(" | ".join(errors))
    report["errors"] = errors  # models that failed before one answered
    result = json.loads(resp.text)
    if result.get("action") not in ("new_route", "reroute", "answer"):
        result["action"] = "answer"
    result.setdefault("settings", {})
    result.setdefault("reply", "Okay.")
    return result
