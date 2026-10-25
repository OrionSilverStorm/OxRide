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


def test_speed_is_15_mph_on_the_flat_and_slower_uphill():
    flat = time_model.speed_ms(0.0, 0.0)
    assert flat == pytest.approx(15 * 0.44704, rel=1e-3)
    assert time_model.speed_ms(0.05, 0.0) < flat
    assert time_model.speed_ms(0.0, 5.0) < flat  # headwind


def test_eta_slower_into_wind_and_in_rain():
    windy = {**CALM_DAY, "wind_ms": 10, "wind_from_deg": 270}
    head = time_model.eta_minutes([road(bearing=270)], windy)
    tail = time_model.eta_minutes([road(bearing=90)], windy)
    assert head > tail
    wet = time_model.eta_minutes([road(bearing=270)], {**windy, "rain_mm": 1.0})
    assert wet > head


def test_best_departures_gives_slots_with_one_best():
    slots = time_model.best_departures(time_model.mock_route_fn, now=NOON)
    assert len(slots) == 13
    assert sum(s["best"] for s in slots) == 1
    times = [time_model.datetime.fromisoformat(s["depart_utc"]) for s in slots]
    assert all(b - a == timedelta(minutes=15) for a, b in zip(times, times[1:]))
