# Tiger Data (TimescaleDB on Postgres): the shared connection. The ride log (ridelog.py)
# is the only thing stored; its tables are created there on first use.
import os
import time
from pathlib import Path

import psycopg
from dotenv import load_dotenv

load_dotenv(Path(__file__).with_name('.env'))

_conn = None
_failed_at = None  # after a failed connect, don't retry for a minute


def conn():
    """Reuse the Tiger Data connection, reconnecting if it was closed."""
    global _conn, _failed_at
    if _conn is None or _conn.closed:
        url = os.getenv('DATABASE_URL')
        if not url:
            raise RuntimeError('Missing DATABASE_URL in backend/.env')
        if _failed_at is not None and time.monotonic() - _failed_at < 60:
            raise RuntimeError('Database unreachable, retrying later')
        try:
            _conn = psycopg.connect(url, autocommit=True, connect_timeout=5)
        except psycopg.Error:
            _failed_at = time.monotonic()
            raise
    return _conn
