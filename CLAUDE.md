# OxRide

Bike routing that picks the best route for *when* you ride (night → lit streets, rush hour → avoid busy roads, rain/headwind → adjust) and suggests the best departure time.

## Stack

- **Backend:** Python, FastAPI (`backend/main.py`)
- **Graph:** OpenStreetMap (OSMnx) + elevation, built once by `build_graph.py` into a graph file
- **Routing:** A* over the graph with a ride-profile-weighted cost function
- **AI:** Gemini (parse natural-language requests), ElevenLabs (voice)
- **DB:** Tiger Data (Postgres/Timescale) via `db.py`
- **Frontend:** Next.js (App Router) + TypeScript

## Layout

- `backend/build_graph.py` — one-off: OSM + elevation → graph file
- `backend/routing.py` — A*, cost function, ride profiles
- `backend/time_model.py` — ETA prediction, time-of-day, wind/rain
- `backend/ai.py` — Gemini parsing + ElevenLabs voice
- `backend/db.py` — Tiger Data access
- `backend/main.py` — API endpoints
- `frontend/app/page.tsx` — map + controls
- `frontend/components/` — Map, RoutePanel, ElevationChart, DepartureChart
- `frontend/lib/api.ts` — typed calls to the backend

## Rules

- Load the graph once at startup; never rebuild it per request.
- Routing and cost logic stay pure (no I/O) so they can be tested without the network.
- All external calls (Gemini, ElevenLabs, weather, DB) go through `ai.py` / `db.py` / `time_model.py`, not `main.py` or `routing.py`.
- API keys come from environment variables; never commit them. Keep `.env.example` current.
- The frontend only talks to the backend through `frontend/lib/api.ts`.
- Keep API request/response types in sync between `main.py` and `lib/api.ts`.
