"""Voice and search: ai.py and the /search, /voice, /speak endpoints.

Gemini, ElevenLabs and Nominatim are replaced by fakes: no network, no credits.
The fakes record what our code sends, so the tests check the requests too.
"""

import base64
import json
import types

import pytest
from fastapi.testclient import TestClient

import ai
import main


@pytest.fixture(autouse=True)
def clean_caches(monkeypatch):
    ai.search_place.cache_clear()
    ai.speak.cache_clear()
    monkeypatch.setattr(ai.time, "sleep", lambda s: None)  # don't really wait for the rate limit


@pytest.fixture
def client():
    with TestClient(main.app) as c:
        yield c


# --- search_place -------------------------------------------------------------------------

class FakeResponse:
    def __init__(self, data):
        self.data = data

    def raise_for_status(self):
        pass

    def json(self):
        return self.data


def test_search_place_asks_nominatim_politely(monkeypatch):
    sent = {}

    def fake_get(url, **kw):
        sent.update(url=url, **kw)
        return FakeResponse([{"name": "Radcliffe Camera", "display_name": "Radcliffe Camera, Oxford",
                              "lat": "51.7534", "lon": "-1.2540"}])
    monkeypatch.setattr(ai.httpx, "get", fake_get)
    hits = ai.search_place("Radcliffe Camera")
    assert hits == [{"name": "Radcliffe Camera", "lat": 51.7534, "lon": -1.254}]
    assert "nominatim" in sent["url"]
    assert sent["headers"]["User-Agent"].startswith("OxRide")
    assert sent["params"]["bounded"] == 1 and sent["params"]["viewbox"] == ai.OXFORD_VIEWBOX


def test_search_place_caches_and_waits_between_requests(monkeypatch):
    calls, waits = [], []
    monkeypatch.setattr(ai.httpx, "get", lambda url, **kw: calls.append(kw["params"]["q"]) or FakeResponse([]))
    monkeypatch.setattr(ai.time, "sleep", waits.append)
    ai.search_place("Jericho")
    ai.search_place("Jericho")       # cached: no second request
    ai.search_place("Summertown")    # new request straight after: must wait
    assert calls == ["Jericho", "Summertown"]
    assert waits and 0 < waits[-1] <= 1


def test_search_place_ignores_empty_text(monkeypatch):
    monkeypatch.setattr(ai.httpx, "get", lambda *a, **k: pytest.fail("should not call Nominatim"))
    assert ai.search_place("   ") == []


# --- speak ---------------------------------------------------------------------------------

class FakeElevenLabs:
    calls = []

    def __init__(self, api_key):
        self.text_to_speech = types.SimpleNamespace(convert=self.convert)

    def convert(self, voice_id, *, text, model_id, output_format):
        FakeElevenLabs.calls.append((voice_id, text, model_id))
        return iter([b"ID3", b"mp3-bytes"])


@pytest.fixture
def fake_elevenlabs(monkeypatch):
    import elevenlabs.client
    FakeElevenLabs.calls = []
    monkeypatch.setattr(elevenlabs.client, "ElevenLabs", FakeElevenLabs)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    monkeypatch.setenv("ELEVENLABS_VOICE_ID", "voice-123")
    monkeypatch.delenv("ELEVENLABS_MODEL", raising=False)
    return FakeElevenLabs


def test_speak_returns_mp3_and_caches(fake_elevenlabs):
    assert ai.speak("Turn left onto Broad Street") == b"ID3mp3-bytes"
    ai.speak("Turn left onto Broad Street")
    assert fake_elevenlabs.calls == [("voice-123", "Turn left onto Broad Street", "eleven_flash_v2_5")]


def test_speak_endpoint_returns_playable_mp3(client, fake_elevenlabs):
    r = client.post("/speak", json={"text": "Hello"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/mpeg"
    assert r.content == b"ID3mp3-bytes"


def test_speak_endpoint_says_503_when_elevenlabs_fails(client, monkeypatch):
    # the frontend then uses the browser's own voice
    def broken(text):
        raise RuntimeError("quota exceeded")
    monkeypatch.setattr(ai, "speak", broken)
    assert client.post("/speak", json={"text": "Hello"}).status_code == 503


def test_speak_endpoint_needs_text(client):
    assert client.post("/speak", json={"text": "  "}).status_code == 422


# --- interpret_voice ------------------------------------------------------------------------

class FakeGemini:
    reply = {"action": "answer", "settings": {}, "reply": "About ten minutes."}
    calls = []
    failing = {}  # model name -> error to raise

    def __init__(self, api_key, http_options=None):
        self.http_options = http_options
        self.models = types.SimpleNamespace(generate_content=self.generate_content)

    def generate_content(self, *, model, contents, config):
        FakeGemini.calls.append({"model": model, "contents": contents, "config": config})
        if model in FakeGemini.failing:
            raise FakeGemini.failing[model]
        return types.SimpleNamespace(text=json.dumps(FakeGemini.reply))


@pytest.fixture
def fake_gemini(monkeypatch):
    from google import genai
    FakeGemini.calls = []
    FakeGemini.failing = {}
    FakeGemini.reply = {"action": "answer", "settings": {}, "reply": "About ten minutes."}
    monkeypatch.setenv("GEMINI_FALLBACK_MODELS", "backup-a,backup-b")
    monkeypatch.setattr(genai, "Client", FakeGemini)
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("GEMINI_MODEL", "gemini-test-flash")
    return FakeGemini


ROUTE = {"route": [[51.75, -1.25]] * 500,
         "stats": {"distance_m": 2800, "eta_min": 11.2, "climb_m": 20, "cycleway_share": 0.6, "lit_share": 0.9},
         "steps": [{"text": "Turn left onto Broad Street"}, {"text": "Continue onto Parks Road"},
                   {"text": "Turn right onto South Parks Road"}, {"text": "You have arrived"}]}


def test_interpret_voice_sends_audio_and_a_short_context(fake_gemini):
    out = ai.interpret_voice(b"fake-audio", None, (51.75, -1.25), ROUTE, mime="audio/mp4")
    assert out["reply"] == "About ten minutes."
    call = fake_gemini.calls[0]
    assert call["model"] == "gemini-test-flash"
    context, audio = call["contents"]
    assert audio.inline_data.mime_type == "audio/mp4" and audio.inline_data.data == b"fake-audio"
    ctx = json.loads(context.removeprefix("Context: "))
    assert ctx["current_route"]["next_steps"] == ["Turn left onto Broad Street", "Continue onto Parks Road",
                                                   "Turn right onto South Parks Road"]
    assert len(context) < 1000  # not the 500 route points
    assert call["config"].response_mime_type == "application/json"


def test_thinking_is_kept_short(fake_gemini, monkeypatch):
    monkeypatch.setenv("GEMINI_MODEL", "gemini-3.8-flash")
    ai.interpret_voice(None, "hi", None, None)
    assert fake_gemini.calls[-1]["config"].thinking_config.thinking_level.value == "MINIMAL"
    assert ai.thinking_for("gemini-2.5-flash").thinking_budget == 0
    assert ai.thinking_for("some-other-model") is None


def test_falls_back_when_a_model_rejects_the_thinking_setting(fake_gemini, monkeypatch):
    real = fake_gemini.generate_content

    def picky(self, *, model, contents, config):
        if config.thinking_config is not None:
            raise RuntimeError("400 INVALID_ARGUMENT: thinking level not supported")
        return real(self, model=model, contents=contents, config=config)
    monkeypatch.setattr(fake_gemini, "generate_content", picky)
    monkeypatch.setenv("GEMINI_MODEL", "gemini-3.8-flash")
    report = {}
    assert ai.interpret_voice(None, "hi", None, None, report=report)["reply"] == "About ten minutes."
    assert report["model"] == "gemini-3.8-flash" and "rejected" in report["thinking"]


def test_overloaded_model_falls_back_to_the_next(fake_gemini):
    fake_gemini.failing = {"gemini-test-flash": RuntimeError("503 UNAVAILABLE high demand"),
                           "backup-a": RuntimeError("429 RESOURCE_EXHAUSTED quota")}
    report = {}
    assert ai.interpret_voice(None, "hi", None, None, report=report)["reply"] == "About ten minutes."
    assert report["model"] == "backup-b"
    assert [c["model"] for c in fake_gemini.calls] == ["gemini-test-flash", "backup-a", "backup-b"]
    assert len(report["errors"]) == 2


def test_all_models_failing_is_an_error(fake_gemini):
    fake_gemini.failing = {m: RuntimeError("503 UNAVAILABLE") for m in ("gemini-test-flash", "backup-a", "backup-b")}
    with pytest.raises(RuntimeError, match="backup-b"):
        ai.interpret_voice(None, "hi", None, None)


def test_each_attempt_has_a_time_limit(fake_gemini, monkeypatch):
    seen = {}
    real_init = fake_gemini.__init__

    def spy(self, api_key, http_options=None):
        seen["timeout"] = http_options.timeout
        real_init(self, api_key, http_options)
    monkeypatch.setattr(fake_gemini, "__init__", spy)
    ai.interpret_voice(None, "hi", None, None)
    assert seen["timeout"] == ai.ATTEMPT_TIMEOUT_MS <= 10_000


def test_model_list_order_and_no_repeats(monkeypatch):
    monkeypatch.setenv("GEMINI_MODEL", "main")
    monkeypatch.setenv("GEMINI_FALLBACK_MODELS", "b, main ,c")
    assert ai.gemini_models() == ["main", "b", "c"]
    assert ai.gemini_models("only-this") == ["only-this"]


def test_interpret_voice_text_fallback(fake_gemini):
    ai.interpret_voice(None, "how long left?", None, None)
    assert fake_gemini.calls[0]["contents"][1] == "The rider said: how long left?"


def test_interpret_voice_needs_a_model(fake_gemini, monkeypatch):
    monkeypatch.delenv("GEMINI_MODEL")
    monkeypatch.setenv("GEMINI_FALLBACK_MODELS", "")
    with pytest.raises(RuntimeError, match="GEMINI_MODEL"):
        ai.interpret_voice(None, "hi", None, None)


def test_interpret_voice_cleans_up_odd_answers(fake_gemini):
    fake_gemini.reply = {"action": "dance", "reply": "Hmm"}
    out = ai.interpret_voice(None, "hi", None, None)
    assert out["action"] == "answer" and out["settings"] == {}


# --- /voice end to end ---------------------------------------------------------------------

def test_voice_new_route_finds_the_place(client, fake_gemini, monkeypatch):
    fake_gemini.reply = {"action": "new_route", "settings": {"destination": "Radcliffe Camera", "profile": "chill"},
                         "reply": "Quiet route to the Radcliffe Camera."}
    monkeypatch.setattr(ai, "search_place", lambda q: [{"name": "Radcliffe Camera", "lat": 51.7534, "lon": -1.254}])
    body = client.post("/voice", json={"audio_b64": base64.b64encode(b"x").decode(),
                                       "position": [51.76, -1.26]}).json()
    assert body["action"] == "new_route"
    assert body["settings"] == {"profile": "chill", "end": [51.7534, -1.254], "end_name": "Radcliffe Camera",
                                "start": [51.76, -1.26]}
    assert body["reply"] == "Quiet route to the Radcliffe Camera."


def test_voice_unknown_place_is_a_polite_answer(client, fake_gemini, monkeypatch):
    fake_gemini.reply = {"action": "new_route", "settings": {"destination": "Atlantis"}, "reply": "Off we go."}
    monkeypatch.setattr(ai, "search_place", lambda q: [])
    body = client.post("/voice", json={"text": "take me to Atlantis"}).json()
    assert body["action"] == "answer" and "Atlantis" in body["reply"]


def test_voice_reroute_starts_from_the_rider(client, fake_gemini):
    fake_gemini.reply = {"action": "reroute", "settings": {"profile": "chill"}, "reply": "Finding a quieter way."}
    body = client.post("/voice", json={"text": "quieter please", "position": [51.75, -1.25]}).json()
    assert body["settings"] == {"profile": "chill", "start": [51.75, -1.25]}


def test_voice_survives_gemini_failing(client, monkeypatch):
    def broken(*a, **k):
        raise RuntimeError("quota")
    monkeypatch.setattr(ai, "interpret_voice", broken)
    r = client.post("/voice", json={"text": "hello"})
    assert r.status_code == 200 and r.json()["action"] == "answer"
    assert r.json()["error"] == "RuntimeError: quota"  # says why, for debugging


def test_voice_needs_audio_or_text(client):
    assert client.post("/voice", json={}).status_code == 422
    assert client.post("/voice", json={"text": "   "}).status_code == 422


# --- /search -------------------------------------------------------------------------------

def test_search_endpoint(client, monkeypatch):
    monkeypatch.setattr(ai, "search_place", lambda q: [{"name": q, "lat": 51.75, "lon": -1.25}])
    assert client.get("/search?q=Jericho").json() == [{"name": "Jericho", "lat": 51.75, "lon": -1.25}]


def test_search_endpoint_reports_outage(client, monkeypatch):
    def down(q):
        raise ai.httpx.ConnectError("down")
    monkeypatch.setattr(ai, "search_place", down)
    assert client.get("/search?q=Jericho").status_code == 502



# --- Oxford names and the no-Gemini Plan B ----------------------------------------------

@pytest.mark.parametrize("said,name", [
    ("univ", "University College"), ("the Rad Cam", "Radcliffe Camera"), ("maudlin", "Magdalen College"),
    ("Magdalene College", "Magdalen College"), ("the Bod", "Bodleian Library"), ("the JR", "John Radcliffe Hospital"),
    ("teddy hall", "St Edmund Hall"), ("Catz", "St Catherine's College"), ("the station", "Oxford railway station"),
])
def test_oxford_nicknames(said, name):
    assert ai.oxford_name(said) == name


def test_unknown_places_are_left_alone():
    assert ai.oxford_name("Cowley Road") is None
    assert ai.oxford_name(None) is None


def test_gemini_is_told_the_nicknames(fake_gemini):
    ai.interpret_voice(None, "take me to univ", None, None)
    system = fake_gemini.calls[0]["config"].system_instruction
    assert "univ" in system and "University College" in system and "maudlin" in system


@pytest.mark.parametrize("text,expected", [
    ("take me to univ", ("new_route", "University College", None)),
    ("Take me to the Rad Cam please", ("new_route", "Radcliffe Camera", None)),
    ("can you take me to the station", ("new_route", "Oxford railway station", None)),
    ("go to Cowley Road", ("new_route", "Cowley Road", None)),
    ("take me to Jericho the quiet way", ("new_route", "Jericho", "chill")),
    ("take me a quiet way to Jericho", None),  # not a "to <place>" sentence: left to Gemini
    ("quieter route please", ("reroute", None, "chill")),
    ("faster", ("reroute", None, "fast")),
    ("how long left?", None),
    ("will it rain?", None),
])
def test_simple_commands(text, expected):
    out = ai.simple_command(text)
    if expected is None:
        assert out is None or out["action"] != "new_route" or out["settings"]["destination"] != "to Jericho"
        return
    action, place, profile = expected
    assert out["action"] == action
    assert out["settings"].get("destination") == place
    assert out["settings"].get("profile") == profile


def test_voice_uses_plan_b_when_gemini_is_down(client, monkeypatch):
    def down(*a, **k):
        raise RuntimeError("503 UNAVAILABLE")
    monkeypatch.setattr(ai, "interpret_voice", down)
    monkeypatch.setattr(ai, "search_place", lambda q: [{"name": q, "lat": 51.7521, "lon": -1.2517}])
    body = client.post("/voice", json={"text": "take me to univ", "position": [51.75, -1.26]}).json()
    assert body["action"] == "new_route"
    assert body["settings"]["end_name"] == "University College"
    assert body["reply"] == "Going to University College."


def test_voice_resolves_nicknames_from_gemini(client, fake_gemini, monkeypatch):
    fake_gemini.reply = {"action": "new_route", "settings": {"destination": "the Rad Cam"}, "reply": "Off we go."}
    searched = []
    monkeypatch.setattr(ai, "search_place", lambda q: searched.append(q) or [{"name": q, "lat": 51.75, "lon": -1.25}])
    client.post("/voice", json={"text": "rad cam"})
    assert searched == ["Radcliffe Camera"]
