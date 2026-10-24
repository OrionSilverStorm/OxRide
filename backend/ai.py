"""Gemini parsing and explanations, ElevenLabs voice."""


def parse_request(text: str) -> dict:
    """Sentence -> start, end, profile, departure time (Gemini)."""
    raise NotImplementedError


def explain_route(route: dict, ctx: dict) -> str:
    """Short note on why this route was chosen (Gemini)."""
    raise NotImplementedError


def speak(text: str) -> bytes:
    """Text to speech audio (ElevenLabs)."""
    raise NotImplementedError


def search_place(q: str) -> list[dict]:
    """Nominatim lookup; 1 request/s and a User-Agent are required."""
    raise NotImplementedError
