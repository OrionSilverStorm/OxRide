"""Time and weather: context, penalties, ETA and best time to leave."""

from datetime import timedelta

import pytest

import time_model
from conftest import CALM_DAY, NIGHT, NOON


def road(**kw):
    base = {"length": 1000, "highway": "residential", "surface": "asphalt", "lit": True,
            "grade": 0.0, "bearing": 0.0}
    return {**base, **kw}


def test_context_has_every_field():
    ctx = time_model.get_context(NOON)
    for key in ("wind_ms", "wind_from_deg", "rain_prob", "rain_mm", "dark", "rush", "local"):
        assert key in ctx
    assert isinstance(ctx["dark"], bool) and isinstance(ctx["rush"], bool)
    assert 0 <= ctx["rain_prob"] <= 1


def test_noon_is_light_and_late_evening_is_dark():
    assert time_model.get_context(NOON)["dark"] is False
    assert time_model.get_context(NIGHT)["dark"] is True


def test_rush_hour_on_weekdays_only():
    # 24 Oct 2026 is a Saturday; 08:00 Oxford time is in the morning rush on weekdays.
    saturday_8am = NOON.replace(hour=7)  # 07:00 UTC = 08:00 BST
    assert time_model.get_context(saturday_8am)["rush"] is False
    assert time_model.get_context(saturday_8am, weekday_override=1)["rush"] is True


def test_rush_hour_penalises_main_roads():
    rush = {**CALM_DAY, "rush": True}
    assert time_model.time_penalty(road(highway="primary"), rush) > 1
    assert time_model.time_penalty(road(highway="residential"), rush) == 1


def test_headwind_costs_more_than_tailwind():
    windy = {**CALM_DAY, "wind_ms": 10, "wind_from_deg": 0}
    into_wind = time_model.time_penalty(road(bearing=0), windy)
    with_wind = time_model.time_penalty(road(bearing=180), windy)
    assert into_wind > with_wind


def test_night_makes_unlit_roads_cost_more():
    # The must-have: without this, the night route can't differ from the day route.
    dark = {**CALM_DAY, "dark": True}
    assert time_model.time_penalty(road(lit=False), dark) > time_model.time_penalty(road(lit=True), dark)


def test_daytime_ignores_lighting():
    assert time_model.time_penalty(road(lit=False), CALM_DAY) == time_model.time_penalty(road(lit=True), CALM_DAY)


# --- Speed model: the measured speed table -------------------------------------------

def speed(ctx=CALM_DAY, **kw):
    return time_model.speed_ms(road(**kw), ctx) / time_model.BASE_SPEED  # 1.0 = base speed


def test_base_speed_is_15_mph_on_a_flat_main_road():
    assert time_model.speed_ms(road(highway="primary"), CALM_DAY) == pytest.approx(15 * 0.44704)


@pytest.mark.parametrize("grade,effect", [
    (0.003, 0.0), (0.007, -0.03), (0.015, -0.05), (0.025, -0.08), (0.035, -0.12), (0.05, -0.16),
    (-0.003, 0.0), (-0.007, 0.03), (-0.015, 0.05), (-0.025, 0.06), (-0.05, 0.06),
])
def test_gradient_bands(grade, effect):
    assert speed(highway="primary", grade=grade) == pytest.approx(1 + effect)


@pytest.mark.parametrize("wind,bearing,effect", [
    (7, 0, -0.014), (5, 0, -0.010), (3.5, 0, -0.005), (2.5, 0, -0.003), (1.5, 0, -0.002), (0.5, 0, 0.0),
    (7, 180, 0.017), (5, 180, 0.012), (3.5, 180, 0.006), (1.5, 180, 0.003), (0.5, 180, 0.0),
])
def test_wind_bands(wind, bearing, effect):
    # wind from the north (0°): riding north (0°) is a headwind, south (180°) a tailwind
    ctx = {**CALM_DAY, "wind_ms": wind, "wind_from_deg": 0}
    assert speed(ctx, highway="primary", bearing=bearing) == pytest.approx(1 + effect)


def test_crosswind_does_nothing():
    ctx = {**CALM_DAY, "wind_ms": 8, "wind_from_deg": 0}
    assert speed(ctx, highway="primary", bearing=90) == pytest.approx(1.0)


def test_rain_does_not_change_speed():
    wet = {**CALM_DAY, "rain_mm": 2.0, "rain_prob": 1.0}
    assert time_model.eta_minutes([road(highway="primary")], wet) == time_model.eta_minutes([road(highway="primary")], CALM_DAY)


@pytest.mark.parametrize("surface,effect", [("asphalt", 0.0), ("cobbles", -0.05), ("gravel", -0.19)])
def test_surface(surface, effect):
    assert speed(highway="primary", surface=surface) == pytest.approx(1 + effect)


@pytest.mark.parametrize("edge,effect", [
    ({"highway": "cycleway"}, -0.01),                         # separate cycle track
    ({"highway": "path"}, 0.01),                              # shared foot/cycle path
    ({"highway": "secondary", "cycleway": "lane"}, 0.02),     # painted lane
    ({"highway": "secondary", "cycleway": "share_busway"}, 0.01),
    ({"highway": "secondary", "cycleway": "separate"}, 0.0),  # road with a cycle track
    ({"highway": "residential"}, -0.05),                      # side street, nothing
    ({"highway": "residential", "cycleway": ["lane", "sidewalk"]}, 0.02),
    ({"highway": "primary"}, 0.0),                            # normal road
])
def test_cycle_infrastructure(edge, effect):
    assert speed(**edge) == pytest.approx(1 + effect)


def test_effects_combine():
    # 2.5% uphill on gravel: 8% and 19% slower
    assert speed(highway="primary", grade=0.025, surface="gravel") == pytest.approx(0.92 * 0.81)


def test_eta_into_wind_is_only_slightly_slower():
    windy = {**CALM_DAY, "wind_ms": 10, "wind_from_deg": 270}
    head = time_model.eta_minutes([road(highway="primary", bearing=270)], windy)
    tail = time_model.eta_minutes([road(highway="primary", bearing=90)], windy)
    assert head > tail
    assert head / tail < 1.05  # measured: wind changes speed by under 2%


def test_best_departures_gives_slots_with_one_best():
    slots = time_model.best_departures(time_model.mock_route_fn, now=NOON)
    assert len(slots) == 13
    assert sum(s["best"] for s in slots) == 1
    times = [time_model.datetime.fromisoformat(s["depart_utc"]) for s in slots]
    assert all(b - a == timedelta(minutes=15) for a, b in zip(times, times[1:]))


# --- Weather refresh and offline backup ---------------------------------------------

def test_weather_refreshes_after_30_minutes(monkeypatch):
    calls = []
    real = time_model.fetch_weather
    monkeypatch.setattr(time_model, "fetch_weather", lambda: calls.append(1) or real())
    time_model.get_context(NOON)
    time_model.get_context(NOON)
    assert len(calls) == 1  # cached
    monkeypatch.setattr(time_model, "_weather_fetched_at",
                        time_model._weather_fetched_at - timedelta(minutes=31))
    time_model.get_context(NOON)
    assert len(calls) == 2  # refreshed


def test_offline_falls_back_to_snapshot(monkeypatch):
    def down():
        raise time_model.requests.ConnectionError("no internet")
    monkeypatch.setattr(time_model, "fetch_weather", down)
    ctx = time_model.get_context(NOON)
    assert ctx["weather_source"] == "snapshot"
    assert ctx["dark"] is False


def test_failed_refresh_keeps_last_good_forecast(monkeypatch):
    time_model.get_context(NOON)  # good fetch
    monkeypatch.setattr(time_model, "_weather_fetched_at",
                        time_model._weather_fetched_at - timedelta(minutes=31))

    def down():
        raise time_model.requests.Timeout("slow")
    monkeypatch.setattr(time_model, "fetch_weather", down)
    assert time_model.get_context(NOON)["weather_source"] == "open-meteo (old)"


def test_temperature_is_in_the_context(monkeypatch):
    snap = time_model.fetch_weather()
    monkeypatch.setattr(time_model, "fetch_weather",
                        lambda: {**snap, "temperature_2m": [11.5] * len(snap["time"])})
    assert time_model.get_context(NOON)["temperature_c"] == 11.5


# --- Best time to leave + Tiger Data --------------------------------------------------

def test_slots_carry_weather_for_the_hint():
    slot = time_model.best_departures(time_model.mock_route_fn, now=NOON)[0]
    for key in ("depart_local", "depart_utc", "eta_min", "rain_prob", "wind_ms", "dark", "best"):
        assert key in slot


def test_no_database_means_no_connection_attempt(monkeypatch):
    import sys
    monkeypatch.setitem(sys.modules, "db", None)  # importing db would now fail loudly
    slots = time_model.best_departures(time_model.mock_route_fn, now=NOON)
    assert all(s["history_rain_prob"] is None for s in slots)


def test_predictions_saved_once_per_request(monkeypatch):
    import sys
    import types
    saved = []
    fake_db = types.SimpleNamespace(rain_chance_by_hour=lambda month: {13: 0.4},
                                    save_predictions=lambda slots, **kw: saved.append(len(slots)))
    monkeypatch.setitem(sys.modules, "db", fake_db)
    monkeypatch.setenv("DATABASE_URL", "postgres://fake")
    slots = time_model.best_departures(time_model.mock_route_fn, now=NOON)
    assert saved == [13]  # one save with all 13 slots, not 13 saves
    assert any(s["history_rain_prob"] == 0.4 for s in slots)
