"""Tiger Data (Postgres) storage for hourly weather and predicted journey times."""

import os

DATABASE_URL = os.environ.get("DATABASE_URL", "")


def get_conn():
    raise NotImplementedError


def save_weather(rows: list[dict]) -> None:
    raise NotImplementedError


def save_prediction(row: dict) -> None:
    raise NotImplementedError
