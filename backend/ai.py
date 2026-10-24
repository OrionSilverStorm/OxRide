"""Gemini request parsing and ElevenLabs voice output."""


def parse_request(text: str) -> dict:
    """Turn a natural-language request into origin, destination and ride preferences (Gemini)."""
    raise NotImplementedError


def speak(text: str) -> bytes:
    """Synthesize speech audio for the given text (ElevenLabs)."""
    raise NotImplementedError
