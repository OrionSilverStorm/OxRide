"""Tiger Data (Postgres/Timescale) access."""

import os

DATABASE_URL = os.environ.get("DATABASE_URL", "")


def get_conn():
    raise NotImplementedError
