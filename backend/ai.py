"""Gemini voice commands, ElevenLabs voice, Nominatim place search."""


def interpret_voice(audio: bytes | None, text: str | None,
                    position: tuple[float, float] | None, route: dict | None) -> dict:
    """What the rider said -> {action, settings, reply} (Gemini).

    action is new_route | reroute | answer; reply is a sentence or two.
    """
    raise NotImplementedError


def speak(text: str) -> bytes:
    """Text to speech audio (ElevenLabs)."""
    raise NotImplementedError


def search_place(q: str) -> list[dict]:
    """Nominatim lookup; 1 request/s and a User-Agent are required."""
    raise NotImplementedError
