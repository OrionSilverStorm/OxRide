import argparse
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).with_name('.env'))

OXFORD = (51.752, -1.258)
_conn = None
def conn():
    """Reuse the Tiger Data connection, reconnecting if it was closed."""
    global _conn
    if _conn is None or _conn.closed:
        url = os.getenv('DATABASE_URL')
        if not url:
            raise RuntimeError('Missing DATABASE_URL in backend/.env')
        _conn = psycopg.connect(url, autocommit=True, connect_timeout=10)
    return _conn

def setup():
    """Create database tables."""
    db = conn()
    db.execute('''
        CREATE TABLE IF NOT EXISTS weather (
            time TIMESTAMPTZ NOT NULL,
            source TEXT NOT NULL,
            wind_ms DOUBLE PRECISION,
            wind_from_deg DOUBLE PRECISION,
            rain_mm DOUBLE PRECISION,
            rain_prob DOUBLE PRECISION,
            is_day BOOLEAN,
            UNIQUE (time, source)
        )
    ''')
    db.execute("SELECT create_hypertable('weather', by_range('time'), if_not_exists => TRUE)")
    db.execute('''
        CREATE TABLE IF NOT EXISTS predictions (
            id BIGSERIAL PRIMARY KEY,
            depart_time TIMESTAMPTZ NOT NULL,
            route_id TEXT NOT NULL,
            profile TEXT NOT NULL,
            eta_min DOUBLE PRECISION,
            score DOUBLE PRECISION,
            rain_prob DOUBLE PRECISION,
            dark BOOLEAN,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    ''')
    db.execute('''
        CREATE TABLE IF NOT EXISTS rides (
            id BIGSERIAL PRIMARY KEY,
            time TIMESTAMPTZ NOT NULL,
            route_id TEXT NOT NULL,
            predicted_minutes DOUBLE PRECISION,
            actual_minutes DOUBLE PRECISION,
            source TEXT
        )
    ''')
    print('Database tables ready')

def save_weather(hourly, source):
    """Save hourly weather."""
    if source not in ('forecast', 'history'):
        raise ValueError('source must be forecast or history')

    n = len(hourly['time'])
    def column(key):
        return hourly.get(key, [None] * n)

    dates = [datetime.fromisoformat(t).replace(tzinfo=timezone.utc)
             for t in hourly['time']]
    winds = column('wind_speed_10m')
    directions = column('wind_direction_10m')
    rain = column('precipitation')
    probs = column('precipitation_probability')
    days = column('is_day')

    rows = [
        (dates[i], source, winds[i], directions[i], rain[i],
         probs[i] / 100.0 if probs[i] is not None else None,
         bool(days[i]) if days[i] is not None else None)
        for i in range(n)
    ]
    sql = '''
        INSERT INTO weather
          (time, source, wind_ms, wind_from_deg, rain_mm, rain_prob, is_day)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (time, source) DO NOTHING
    '''
    db = conn()
    with db.cursor() as cur:
        for start in range(0, len(rows), 1000):
            with db.transaction():
                cur.executemany(sql, rows[start:start + 1000])
    return len(rows)  # Rows processed




def fetch_history(days=730):
    """Fetch past weather."""
    # Allow for archive lag.
    end = datetime.now(timezone.utc).date() - timedelta(days=7)
    start = end - timedelta(days=days - 1)
    r = requests.get(
        'https://archive-api.open-meteo.com/v1/archive',
        params={
            'latitude': OXFORD[0],
            'longitude': OXFORD[1],
            'start_date': start.isoformat(),
            'end_date': end.isoformat(),
            'hourly': 'wind_speed_10m,wind_direction_10m,precipitation,is_day',
            'wind_speed_unit': 'ms',
            'timezone': 'GMT',
        },
        timeout=60,
    )
    r.raise_for_status()
    return r.json()['hourly']



def rain_chance_by_hour(month):
    """Get rain chance by hour."""
    if not 1 <= month <= 12:
        raise ValueError('month must be 1..12')
    try:
        rows = conn().execute('''
            SELECT
                EXTRACT(HOUR FROM time AT TIME ZONE 'Europe/London')::int AS hour,
                AVG((rain_mm > 0.2)::int) AS chance
            FROM weather
            WHERE source = 'history'
              AND EXTRACT(MONTH FROM time AT TIME ZONE 'Europe/London') = %s
            GROUP BY 1 ORDER BY 1
        ''', (month,)).fetchall()
        return {hour: float(chance) for hour, chance in rows if chance is not None}
    except (psycopg.Error, OSError, RuntimeError) as exc:
        print(f'Historical database unavailable: {exc}')
        return {}

def save_predictions(slots, route_id='default', profile='commuter'):
    """Save departure predictions."""
    rows = [
        (datetime.fromisoformat(s['depart_utc']), route_id, profile,
         s['eta_min'], s['score'], s['rain_prob'], s['dark'])
        for s in slots
    ]
    try:
        with conn().cursor() as cur:
            with conn().transaction():
                cur.executemany('''
                    INSERT INTO predictions
                      (depart_time, route_id, profile, eta_min, score, rain_prob, dark)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                ''', rows)
        return True
    except (psycopg.Error, OSError, RuntimeError) as exc:
        print(f'Predictions not saved (database unavailable): {exc}')
        return False


def create_daily_aggregate():
    """Create daily weather summary."""
    conn().execute('''
        CREATE MATERIALIZED VIEW IF NOT EXISTS weather_daily
        WITH (timescaledb.continuous) AS
        SELECT time_bucket('1 day', time) AS day,
               sum(rain_mm) AS rain,
               avg(wind_ms) AS wind
        FROM weather
        WHERE source = 'history'
        GROUP BY 1
        WITH NO DATA
    ''')
    print('Continuous aggregate created')


def check():
    print('Connected to:', conn().execute('SELECT version()').fetchone()[0].split(' on ')[0])
    print('Weather rows by source:')
    for source, count, earliest, latest in conn().execute('''
        SELECT source, count(*), min(time), max(time)
        FROM weather GROUP BY source ORDER BY source
    ''').fetchall():
        print(source, count, earliest, latest)
    print('Historical rain probability by local hour (current month):')
    print(rain_chance_by_hour(datetime.now(timezone.utc).month))


def main():
    parser = argparse.ArgumentParser(description='OxRide Tiger Data operations')
    parser.add_argument('action', choices=['setup', 'forecast', 'history', 'check', 'aggregate'])
    args = parser.parse_args()

    if args.action == 'setup':
        setup()
    elif args.action == 'forecast':
        from time_model import fetch_weather
        print('Forecast rows processed:', save_weather(fetch_weather(), 'forecast'))
    elif args.action == 'history':
        print('Fetching historical weather...')
        print('Historical rows processed:', save_weather(fetch_history(), 'history'))
    elif args.action == 'check':
        check()
    elif args.action == 'aggregate':
        create_daily_aggregate()


if __name__ == '__main__':
    main()