# OxRide

Time-aware cycle navigation for Oxford, built for a hackathon (theme: TIME). Google Maps gives the shortest route; OxRide gives the best route for *when* you ride: lit streets at night, quiet roads at rush hour, adjustments for wind and rain. It recommends a departure time, gives spoken turn-by-turn directions, and reroutes when you go off route. Web app / PWA, mobile first.

## Demo priorities

Must have: our own A* finds a sensible route in Oxford, drawn on a deployed map, and the same trip gives a different route at night than by day (lit streets).
If we fall behind, cut in this order: Tiger Data, ElevenLabs (browser voice still works), wind, rerouting, departure chart. Never cut the route on the map and the day/night switch.

## Stack

- **Backend (Python):** fastapi + uvicorn, osmnx + networkx (Oxford bike graph), our own A* with `heapq` (do not use networkx's shortest path), numpy, httpx, google-genai (Gemini), elevenlabs, psycopg (Tiger Data = Postgres)
- **Frontend (TypeScript, thin):** Next.js, Tailwind, shadcn/ui, react-leaflet, recharts, PWA (`manifest.json` + icons)
- **Hosting:** frontend on Vercel, backend on Vultr
- **Data:** OSM via osmnx (roads, cycleways, surface, lit, names), Nominatim (search, 1 req/s, needs User-Agent, call from backend), OpenTopoData (elevation, 100 points/request, ~1 req/s), Open-Meteo (hourly wind, rain, sunrise/sunset). Optional: DfT traffic counts, STATS19.
- **Browser APIs:** Geolocation `watchPosition` (HTTPS only), Web Speech API (voice fallback), Wake Lock (screen on while navigating)
- Map tiles: OSM or CARTO, attribution must stay visible.
- Out of scope: live traffic, search outside Oxford, offline maps, Solana/Snowflake/Presage.

## Layout

```
backend/
  build_graph.py   one-off: OSM + elevation -> graph file
  routing.py       A*, cost function, ride profiles
  navigation.py    turn-by-turn steps from a route
  time_model.py    ETA prediction, time of day, wind/rain
  ai.py            Gemini parsing + ElevenLabs voice
  db.py            Tiger Data
  main.py          API endpoints
frontend/
  app/page.tsx     planning screen: map + controls
  app/navigate/    navigation screen
  components/      Map, RoutePanel, ElevationChart, DepartureChart, SufferScore
  hooks/           useLocation, useNavigation (off-route check), useSimulatedRide
  lib/api.ts       calls to the backend
  lib/mock.ts      fake data until the backend is ready
  public/          manifest.json, app icons, dragon logo
```

## Endpoints

- `POST /route`: start, end, profile, departure time in; route, stats, steps out. Rerouting reuses it with the current position as `start`.
- `GET /best-departure`: ETA and score for each 15-minute slot
- `GET /search?q=`: place search via Nominatim
- `POST /parse`: Gemini turns a sentence into start, end, profile, departure time (+ a short note on why the route was chosen)
- `POST /speak`: ElevenLabs text to speech

Each turn-by-turn step: `{ text, distance_m, lat, lon, maneuver }`, where `maneuver` is `left | right | straight | arrive`.

## Shared backend functions

Backend files only call each other through these. If you change a signature, tell the others straight away.

```python
# time_model.py
get_context(depart_at) -> dict          # hour, is_dark, wind_speed, wind_dir, rain
time_penalty(edge_data, ctx) -> float   # 1.0 = normal, 2.0 = twice as bad
eta_minutes(route, ctx) -> float
best_departures(start, end, profile) -> list

# routing.py
find_route(start, end, profile, ctx) -> dict   # same fields as the /route output
```

Edge cost = length x road-type factor x surface factor + hill penalty, all multiplied by `time_penalty`. Profiles (road, commuter, chill) are different sets of factors. Until `time_model` exists, `time_penalty` is a stub returning 1.0.

## Ownership

- **Algorithm:** `build_graph.py`, `routing.py`, `navigation.py`
- **Time and data:** `time_model.py`, `db.py`
- **Frontend and integration:** everything in `frontend/` except PWA setup and `/search` wiring; map, panels, charts, navigation screen, live location, off-route detection, simulate ride
- **AI and pitch:** `ai.py`, `main.py`, place search, PWA setup, Vultr deploy, Devpost, demo script

Only edit your own files; ask the owner if you need a change in theirs.

## Rules

- Load the graph once at startup; never rebuild it per request.
- `routing.py` cost logic stays pure (no network), so it can be tested on a small test graph.
- External calls (Gemini, ElevenLabs, Open-Meteo, Nominatim, DB) live in `ai.py`, `time_model.py`, `db.py` or `main.py`, never in `routing.py`.
- API keys come from environment variables; never commit them. Keep `.env.example` current.
- The frontend only talks to the backend through `frontend/lib/api.ts`; keep its types in sync with `main.py`.
- Merge into `main` every couple of hours and keep `main` running: it is what gets deployed.
