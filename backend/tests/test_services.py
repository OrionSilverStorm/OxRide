"""The Services box on /debug: shows which keys are set, never their values.

These tests never call Gemini or ElevenLabs (no credits spent): they only check
the "key missing" paths and that values don't leak.
"""

import pytest
from fastapi.testclient import TestClient

import debug
import main


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(debug, "_last_test", {})
    with TestClient(main.app) as c:
        yield c


def test_services_shows_only_true_false(client, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "secret-value-123")
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    r = client.get("/debug/services")
    assert r.status_code == 200
    assert "secret-value-123" not in r.text
    body = r.json()
    assert body["gemini"]["GEMINI_API_KEY"] is True
    assert body["elevenlabs"]["ELEVENLABS_API_KEY"] is False
    assert all(isinstance(v, bool) for svc in body.values() for v in svc.values())


@pytest.mark.parametrize("name,var", [
    ("gemini", "GEMINI_API_KEY"),
    ("elevenlabs", "ELEVENLABS_API_KEY"),
    ("database", "DATABASE_URL"),
    ("google_maps", "GOOGLE_MAPS_API_KEY"),
])
def test_missing_key_is_reported_without_calling_out(client, monkeypatch, name, var):
    monkeypatch.delenv(var, raising=False)
    body = client.post(f"/debug/services/{name}/test").json()
    assert body["ok"] is False
    assert var in body["message"]


def test_unknown_service_is_404(client):
    assert client.post("/debug/services/openai/test").status_code == 404


def test_tests_are_rate_limited(client, monkeypatch):
    monkeypatch.setattr(debug, "_last_test", {"gemini": debug.time.time()})
    body = client.post("/debug/services/gemini/test").json()
    assert body["ok"] is False and "Wait" in body["message"]


def test_wrong_gemini_model_lists_the_right_names(client, monkeypatch):
    import types
    from google import genai

    class FakeClient:
        def __init__(self, api_key):
            self.models = types.SimpleNamespace(
                generate_content=self.fail,
                list=lambda: [types.SimpleNamespace(name="models/gemini-x-flash"),
                              types.SimpleNamespace(name="models/gemini-old-flash"),
                              types.SimpleNamespace(name="models/gemini-x-flash-image"),
                              types.SimpleNamespace(name="models/gemini-x-pro")])

        def fail(self, *, model, contents):
            if model != "gemini-x-flash":
                raise RuntimeError(f"404 models/{model} is not found")
            return types.SimpleNamespace(text="ok")

    monkeypatch.setattr(genai, "Client", FakeClient)
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    monkeypatch.setenv("GEMINI_MODEL", "models/flash")
    body = client.post("/debug/services/gemini/test").json()
    assert body["ok"] is False
    assert body["models"] == ["gemini-x-flash"]  # only the one that really answered
    assert "models/flash" in body["message"]


def test_gemini_speed_times_a_voice_command(client, monkeypatch):
    import ai
    def fake(audio, text, position, route, model=None, report=None):
        report.update(model=model, thinking="short")
        return {"action": "answer", "settings": {}, "reply": "ok"}
    monkeypatch.setattr(ai, "interpret_voice", fake)
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    body = client.post("/debug/gemini-speed?model=gemini-x-flash").json()
    assert body["ok"] and body["model"] == "gemini-x-flash" and body["thinking"] == "short"
    assert isinstance(body["seconds"], float)
