"""The "when to leave" hint: each case, the 60-minute limit, and the priority order."""

from datetime import date, datetime, timedelta, timezone


import time_model

# 25 Oct 2026 is a Sunday (no rush hour) unless a test says otherwise.
NOON = datetime(2026, 10, 26, 12, 0, tzinfo=timezone.utc)  # Monday, 12:00 GMT


def weather(by_hour, rush=lambda t: False):
    # Fake get_context: by_hour(t) returns the weather for time t.
    def ctx(t, weekday_override=None):
        w = {"rain_prob": 0.0, "rain_mm": 0.0, "temperature_c": 12.0, **by_hour(t)}
        return {"wind_ms": 0, "wind_from_deg": 0, "dark": False, "rush": rush(t), **w,
                "local": t.astimezone(time_model.London).isoformat()}
    return ctx


def hint_at(monkeypatch, now, eta_min, by_hour, rush=lambda t: False):
    monkeypatch.setattr(time_model, "get_context", weather(by_hour, rush))
    return time_model.departure_hint(now, eta_min)


def test_sun_times_for_oxford():
    def local(t):
        return t.astimezone(time_model.London).strftime("%H:%M")
    rise, sset = time_model.sun_times(date(2026, 6, 21))
    assert local(rise) in ("04:44", "04:45", "04:46") and local(sset) in ("21:26", "21:27", "21:28")
    rise, sset = time_model.sun_times(date(2026, 12, 21))
    assert local(rise) in ("08:08", "08:09", "08:10") and local(sset) in ("15:55", "15:56", "15:57")


def test_no_hint_on_a_plain_day(monkeypatch):
    assert hint_at(monkeypatch, NOON, 15, lambda t: {}) is None


def test_rain_about_to_start(monkeypatch):
    # dry until 12:59, raining from 13:00; a 15-minute ride now arrives dry
    h = hint_at(monkeypatch, NOON + timedelta(minutes=20), 15,
                lambda t: {"rain_prob": 0.8, "rain_mm": 1.0} if t.hour >= 13 else {})
    assert h["kind"] == "rain_starts" and h["in_min"] == 0
    assert h["text"] == "Rain from about 13:00. Leave now to arrive dry."  # 13:00 UTC = 13:00 GMT


def test_no_rain_start_hint_if_you_would_get_wet_anyway(monkeypatch):
    # rain at 13:00 but the ride takes 50 min from 12:20: you'd arrive in the rain
    h = hint_at(monkeypatch, NOON + timedelta(minutes=20), 50,
                lambda t: {"rain_prob": 0.8, "rain_mm": 1.0} if t.hour >= 13 else {})
    assert h is None or h["kind"] != "rain_starts"


def test_rain_about_to_stop(monkeypatch):
    h = hint_at(monkeypatch, NOON + timedelta(minutes=10), 15,
                lambda t: {"rain_prob": 0.9, "rain_mm": 2.0} if t.hour < 13 else {})
    assert h["kind"] == "rain_stops"
    assert h["in_min"] == 50 and "T13:00" in h["leave_at"]
    assert h["text"] == "Rain should stop by about 13:00. Leave then to stay dry."


def test_rain_stopping_after_an_hour_is_too_long_to_wait(monkeypatch):
    assert hint_at(monkeypatch, NOON, 15, lambda t: {"rain_prob": 0.9} if t.hour < 14 else {}) is None


def test_rain_counts_as_likely_from_50_percent(monkeypatch):
    assert hint_at(monkeypatch, NOON + timedelta(minutes=20), 10,
                   lambda t: {"rain_prob": 0.5} if t.hour >= 13 else {})["kind"] == "rain_starts"
    assert hint_at(monkeypatch, NOON + timedelta(minutes=20), 10,
                   lambda t: {"rain_prob": 0.4} if t.hour >= 13 else {}) is None


def test_sunset_soon(monkeypatch):
    sunset = time_model.sun_times(NOON.date())[1]
    h = hint_at(monkeypatch, sunset - timedelta(minutes=40), 15, lambda t: {})
    assert h["kind"] == "dark_soon"
    assert "Leave within 25 min to arrive before dark" in h["text"]


def test_no_sunset_hint_when_it_is_hours_away_or_too_late(monkeypatch):
    sunset = time_model.sun_times(NOON.date())[1]
    assert hint_at(monkeypatch, sunset - timedelta(hours=3), 15, lambda t: {}) is None
    assert hint_at(monkeypatch, sunset - timedelta(minutes=10), 15, lambda t: {}) is None  # can't make it


def test_sunrise_soon(monkeypatch):
    sunrise = time_model.sun_times(NOON.date())[0]
    h = hint_at(monkeypatch, sunrise - timedelta(minutes=30), 15, lambda t: {})
    assert h["kind"] == "light_soon" and h["in_min"] == 30


def test_ice(monkeypatch):
    morning = datetime(2026, 12, 9, 10, 20, tzinfo=timezone.utc)  # well after sunrise
    h = hint_at(monkeypatch, morning, 15, lambda t: {"temperature_c": 0.5 if t.hour < 11 else 3.5})
    assert h["kind"] == "ice" and "T11:00" in h["leave_at"]


def test_rush_hour_ends(monkeypatch):
    evening = datetime(2026, 7, 6, 17, 0, tzinfo=timezone.utc)  # Monday 18:00 BST, light until ~21:20
    h = hint_at(monkeypatch, evening, 15, lambda t: {},
                rush=lambda t: t.astimezone(time_model.London).hour * 60 + t.astimezone(time_model.London).minute < 1110)
    assert h["kind"] == "rush_ends" and h["in_min"] == 30
    assert h["text"] == "Rush hour ends at 18:30: quieter roads if you leave then."


def test_only_one_hint_and_rain_comes_first(monkeypatch):
    # rain about to stop AND rush hour about to end: rain wins
    evening = datetime(2026, 7, 6, 17, 0, tzinfo=timezone.utc)
    h = hint_at(monkeypatch, evening, 15,
                lambda t: {"rain_prob": 0.9, "rain_mm": 2.0} if t.hour < 17 or t.minute < 30 and t.hour == 17 else {},
                rush=lambda t: True)
    assert h["kind"] in ("rain_stops",)


def test_route_carries_the_hint_only_when_leaving_now(monkeypatch):
    from fastapi.testclient import TestClient
    import main
    from conftest import PLACES
    trip = {"start": list(PLACES["Station"]), "end": list(PLACES["Carfax"]), "profile": "regular"}
    with TestClient(main.app) as c:
        later = c.post("/route", json={**trip, "depart_at": "2026-10-24T13:00"}).json()
        assert later["hint"] is None
        monkeypatch.setattr(time_model, "departure_hint", lambda now, eta: {"kind": "x", "text": "t", "in_min": 0, "leave_at": ""})
        now = c.post("/route", json=trip).json()
        assert now["hint"]["kind"] == "x"
