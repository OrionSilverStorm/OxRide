# OxRide

Time-aware, voice-first cycle navigation for Oxford, built for a hackathon (theme: TIME). Google Maps gives the shortest route; OxRide gives the best route for a cyclist at the time they ride: it prefers lit streets after dark, quiet roads at rush hour, avoids slippery gravel in rain, weighs hills, and reroutes when you go off route. You can't type while cycling, so you talk to it: Gemini works out what you want and ElevenLabs speaks the answer and the directions. Web app / PWA, mobile first.

Live: https://oxfordride.vercel.app (Vercel project miksutko/oxride). Repo: miksutko/OxRide.

This file describes what the code does now. If code and this file disagree, check the code and fix this file. Do not describe planned features as if they exist.

## Challenges we're entering

- **Main prize (theme TIME):** the route changes with the time of day (dark, rush hour, rain), plus a one-line "when to leave" hint.
- **HRT:** ETA from gradient, surface, road type and wind (TU Delft measured speeds), real riders' speeds where we have them, and the hand-written A*.
- **Gemini:** understands what the rider says (it listens to the recorded audio) and turns it into an action.
- **ElevenLabs:** speaks Gemini's replies and the turn-by-turn directions.
- **Tiger Data:** the anonymous ride log. Learns how fast people really ride each street at each hour (feeds the ETA) and spots streets riders keep turning back on (possible closures, avoided by routing).
- **Hackiest Hack:** suffer score with a dragon logo (not built).
- DEV Writing: blog post.

## Status

Built and live:
- Our own A* on the Oxford bike graph, three ride types (fast, regular, chill), route drawn on the map.
- Time of day changes the route: darkness, rush hour, rain. Leaving now only (the app has no "leave later" picker; the API accepts `depart_at`).
- Place search (Nominatim), tap or search to set the destination, GPS start.
- Navigation in the same screen: directions banner, time and distance left, spoken directions, mute, off-route detection and automatic reroute, ride type switch mid-ride.
- Voice: hold to talk, or tap to keep listening. Gemini listens to the audio; simple commands still work if Gemini fails.
- "When to leave" hint (rain starting or stopping, sunset or sunrise, ice, rush hour ending).
- Tiger Data ride log: learned street speeds in the ETA ("from real rides"), predicted vs actual on arrival, trouble-spot warning and avoidance.
- `/debug` page: cost breakdown, A* trace, comparison with shortest and Google routes, profile tuning, simulated ride, API key tests, Tiger Data section.
- Everforest light and dark themes, installable PWA.

Not built: suffer score and dragon, elevation chart, departure chart, Wake Lock, a separate navigation page.

## Stack

- **Backend (Python):** fastapi, our own A* with `heapq` (never networkx's shortest path), networkx graph in a pickle, numpy, requests, google-genai (Gemini), elevenlabs, psycopg (Tiger Data = TimescaleDB on Postgres). osmnx only for the one-off graph build (`requirements-build.txt`).
- **Frontend (TypeScript):** Next.js 16, Tailwind + shadcn theme variables, react-leaflet, recharts (only on `/debug`), lucide icons.
- **Hosting:** one Vercel project (`vercel.json` services): `/api/*` goes to the FastAPI backend (`backend/vercel_app.py`), everything else to Next.js. Every push to `main` deploys.
- **Data:** OSM via osmnx (roads, cycleways, surface, lit, names), OpenTopoData (elevation, build time only), Open-Meteo (hourly forecast: wind, rain, temperature, day/night; cached 30 min, `weather_snapshot.json` as offline backup), Nominatim (search, called from the backend).
- **Browser APIs:** Geolocation (Leaflet `locate({watch: true})`), microphone (`getUserMedia`, recorded to 16 kHz WAV), Web Speech as the fallback voice. All need HTTPS.
- Map tiles: OpenStreetMap, darkened with a CSS filter in dark mode. Attribution stays visible.
- Out of scope: live traffic, search outside Oxford, offline maps.

## Layout

```
backend/
  build_graph.py     one-off: OSM + elevation -> oxford_graph.pkl
  routing.py         A*, edge cost, ride profiles, find_route
  navigation.py      turn-by-turn steps from a path
  time_model.py      weather + context, time_penalty, speed model + ETA, departure_hint, sun times
  ai.py              Gemini (interpret_voice, simple_command), ElevenLabs (speak), Nominatim (search_place)
  db.py              Tiger Data connection (conn), shared by ridelog.py
  ridelog.py         Tiger Data ride log: schema, street matching, learned speeds, trouble spots, /debug stats
  main.py            API endpoints
  debug.py           /debug/* endpoints: cost breakdown, A* trace, route comparison, API key tests, Tiger Data stats
  benchmark.py       ours vs shortest vs Google on fixed trips; --night finds day/night demo trips
  vercel_app.py      Vercel entry point (mounts main.app under /api)
  weather_snapshot.json  offline weather backup (also used by tests)
  tests/             pytest: routing, time model, hint, navigation, API, ai, services, ride log (no network)
frontend/
  app/page.tsx       the app (loads components/Map.tsx)
  app/debug/         routing debug panel (components/debug/)
  components/Map.tsx the whole rider screen: map, search, ride type, sheet, navigation, voice, mute, theme
  components/MapLoader.tsx  loads Map in the browser only
  components/VoiceLog.tsx   mic debug log, shown with ?voicelog
  components/debug/  DebugPanel (controls, simulated ride, Tiger Data section), DebugMap, DebugLoader
  hooks/useVoice.ts  mic: hold to talk or tap to keep listening; record engine (Gemini) or browser speech-to-text
  hooks/useTheme.ts  light/dark + toggle
  hooks/useRideLog.ts  sends the ride to Tiger Data (start, points every 15 s, off-route events, end)
  lib/api.ts         the only place that calls the backend
  lib/nav.ts         where the rider is along the route: current step, distance left, off route (+ test)
  lib/speak.ts       say(): ElevenLabs via /speak, browser voice fallback
  lib/heard.ts       what the speech-to-text heard -> what to send (+ test)
  lib/recorder.ts    records the mic; lib/wav.ts converts to 16 kHz WAV (+ test)
  lib/voiceLog.ts    mic debug log and mic engine switch
  lib/theme.ts       which palette shows (+ test)
  lib/rideBuffer.ts  GPS points waiting to be sent to the ride log (+ test)
  scripts/           dev-api.mjs (starts the backend), test.mjs (npm test)
  public/            manifest.json, icons
```

## How it works

### Graph build (one-off, `build_graph.py`)

Downloads Oxford's bike network with osmnx, adds elevation per node (OpenTopoData), computes `grade` and `bearing` per edge, fills missing `lit` and `surface` with defaults by road type, saves `backend/oxford_graph.pkl`. Never runs while serving.

Graph contract: each **edge** has `length` (m), `highway`, `surface` (`asphalt | gravel | cobbles`), `lit` (bool), `name`, `bearing` (deg), `grade` (rise/length), `osmid`; each **node** has `x` (lon), `y` (lat), `elevation` (m). Cornmarket and Queen Street are no-cycling in OSM, so they aren't in the graph at all.

### Plan a ride: `POST /route`

1. `main.route(req)`: `ctx = time_model.get_context(depart_at or now)` (falls back to a dry, calm, daylight context if the weather fails).
2. If `DATABASE_URL` is set: `ridelog.learned_speeds(hour)` and `ridelog.trouble_spots()`; trouble streets go into `ctx["avoid_osmids"]`.
3. `routing.find_route(start, end, profile, ctx, learned)`: snaps to the nearest nodes, runs A*, builds the result.
4. Edge cost (`routing.edge_cost`) = length x road-type factor x surface factor + hill penalty, all x `time_model.time_penalty(edge, ctx)`:
   - dark: unlit x1.6, unknown x1.2
   - rush hour: trunk/primary/secondary x1.5
   - rain and gravel: x1.4
   - trouble street (`avoid_osmids`): x5
   - headwind: about 1% (wind changes cycling speed by under 2%, so it barely changes the route)
5. ETA: `time_model.eta_minutes(edges, ctx, learned)`: per edge, a real riders' speed if known, otherwise the TU Delft speed model (base 15 mph, adjusted for gradient, surface, road type, wind) plus junction time.
6. `main` adds `warning` (a trouble street near the route) and, when leaving now, `hint` from `time_model.departure_hint(now, eta_min)`.

Context (`get_context`): `{wind_ms, wind_from_deg, rain_prob, rain_mm, dark, rush, temperature_c, local, weather_source}`. Rush hour = weekdays, morning and evening (ends 9:30 and 18:30).

### When to leave (`departure_hint`)

At most one line, only for leaving within the next 60 min. It reads the cached forecast at now, +15, +30, +45 and +60 min (plus the arrival time); no extra A* runs. Cases, in order: rain about to start (leave now), rain about to stop, sunset or sunrise soon, icy roads (<= 2 °C), rush hour ending. Rain counts from a 50% chance. Shown under the route until the rider has gone 100 m.

### Place search: `GET /search?q=`

`ai.search_place(q)` -> Nominatim, limited to Oxford, User-Agent set -> `[{name, lat, lon}]`.

### Navigating (all in `components/Map.tsx`)

- GPS from Leaflet `locate({watch: true})`; `lib/nav.ts` finds the current step and distance left.
- Off route: more than 30 m from the line for a few seconds -> `POST /route` from the current position (a reroute).
- Directions are spoken with `lib/speak.ts` (ElevenLabs via `/speak`, browser voice if that fails). Mute silences directions and replies.
- The route line shrinks as you ride; you can drag the map freely.

### Voice: `POST /voice`

1. `hooks/useVoice.ts` records the mic (hold, or tap to keep listening) and sends a WAV as `audio_b64`, with position and current route. The browser speech-to-text engine is optional (switch in `?voicelog`) and sends `text` instead.
2. `ai.interpret_voice(audio, text, position, route, mime)`: Gemini with structured JSON output, a fallback model list, 10 s per attempt. Returns `{action: "new_route" | "reroute" | "answer", settings, reply}`.
3. If Gemini fails, `ai.simple_command(text)` handles simple commands ("take me to univ", "quieter please").
4. `main` resolves a named place with `ai.search_place`. The app speaks `reply` and, for `new_route`/`reroute`, plans the route.

### Speaking: `POST /speak`

`ai.speak(text)` -> ElevenLabs (`eleven_flash_v2_5` unless `ELEVENLABS_MODEL` is set) -> mp3. 503 means no audio: the browser voice is used.

### Tiger Data ride log (`ridelog.py`, `hooks/useRideLog.ts`)

- Anonymous: a random ride id, no account. The frontend starts a ride when a route is planned (not on reroutes), sends GPS points every 15 s, logs `off_route` events, and ends the ride on arrival (within 25 m), on exit, or when the page closes.
- Tables (created on first use by `ridelog.ensure_schema`):
  - `rides`: ride_id, started/ended, profile, simulated, start/end, planned_m, predicted_min, actual_min, arrived
  - `ride_points` (hypertable, kept 30 days): time, ride_id, lat, lon, accuracy, speed, matched edge (u, v, osmid)
  - `route_events` (hypertable): off_route / reroute, where, which street
  - `street_speed_hourly` (continuous aggregate): average speed per edge per hour; kept after the raw points expire
- Points are matched to the nearest street within 40 m, using the heading for direction. Speed between points counts only for gaps of 0.5 to 60 s, accuracy up to 40 m, at most 15 m/s.
- `learned_speeds(hour)`: a street is used for the ETA once it has 6+ real points within an hour either side. Cached 120 s.
- `trouble_spots()`: 3+ different real riders going off route on one street within 2 h.
- Simulated rides (the `/debug` simulated ride) are stored with `simulated = true` and never feed learning.
- Every failure is swallowed: with no database, or a broken one, routing works exactly as before.

### Data shapes

```
RouteRequest {start:[lat,lon], end:[lat,lon], profile:"fast"|"regular"|"chill", depart_at: ISO | null}
RouteResult  {route:[[lat,lon],...], elevations_m:[...],
              stats:{distance_m, climb_m, eta_min, learned_share, cycleway_share, lit_share},
              steps:[Step], hint: Hint | null, warning: string | null}
Step         {text, distance_m, lat, lon, maneuver:"left"|"right"|"straight"|"arrive"}
Hint         {kind, text, in_min, leave_at}   # kind: rain_starts|rain_stops|dark_soon|light_soon|ice|rush_ends
VoiceResult  {action:"new_route"|"reroute"|"answer", settings:{...}, reply}
```

## Route behaviour

- Profiles: `fast`, `regular`, `chill` (same names in the UI, API and code), each a set of factors in `routing.PROFILES`. Chill = cycle paths and quiet roads even if longer; regular = prefers cycle paths, avoids repeated climbs; fast = close to the shortest route.
- What changes the route: darkness (lit streets), rush hour (quiet roads), rain (avoid gravel), hills, trouble streets from the ride log. Wind only changes the ETA.

## Design system: Everforest

All UI uses the Everforest colour theme, medium contrast. Use only the colours below. Do not add other hex values or Tailwind default colours.

Define them once as CSS variables in globals.css and map them into the Tailwind config and the shadcn theme. Components use the semantic names (background, card, primary and so on), never raw hex.

### Dark palette (night, and the navigation screen)
- background: #2D353B
- card / bottom sheet: #343F44
- raised surface / input: #3D484D
- border: #475258
- text: #D3C6AA
- muted text: #859289
- primary (route line, main buttons): #A7C080
- secondary accent: #83C092
- warning (rain, wind, steep hills): #E69875
- danger (off route, closed road): #E67E80
- info: #7FBBB3

### Light palette (daytime planning screen)
- background: #FDF6E3
- card / bottom sheet: #F4F0D9
- raised surface / input: #EFEBD4
- border: #E6E2CC
- text: #5C6A72
- muted text: #939F91
- primary: #8DA101
- secondary accent: #35A77C
- warning: #F57D26
- danger: #F85552
- info: #3A94C5

### When each palette shows
Follow the phone's setting by default. Switch to dark automatically from sunset to sunrise, using the sunset time we already fetch from Open-Meteo. The navigation screen is always dark so it is easy to read on a bike. A manual toggle overrides all of this.

### Shape and layout
- Mobile first, 390px wide. The map fills the screen and the controls float over it.
- Bottom sheet for planning. A banner at the top for the next turn while navigating.
- Rounded corners (rounded-2xl on cards), one soft shadow level, 8px spacing grid.
- Font: Inter. Next-turn text is 20px bold (kept compact so the map stays visible), secondary text 14 to 16px.
- Every button has a tap area of at least 48px (map buttons and ride-type chips are drawn at 36 to 40px with a 48px tap area, `.tap-48`). The push-to-talk button is 56px, centred at the bottom on both screens, and it pulses while listening. Mute (both screens) silences directions and replies, so ElevenLabs isn't called; replies still show on screen. The bottom sheet only appears when it has something to show (a chosen place, or the ride).
- Route line is 6px in the primary colour with a thin outline in the background colour. Alternative routes are muted grey.
- Charts use one colour with no gridlines. The best departure slot is highlighted in the warning colour.
- Map tiles: OpenStreetMap in both palettes, darkened with a CSS filter (`.tiles-dark`) in the dark one (CARTO's tiles now need an API key). Keep the OpenStreetMap attribution visible.
- iPhones: the page behind the map is the card colour of the current palette (`<html>` gets the theme class), so no light strips show around Safari's bars.

### Rules
- Text must keep a readable contrast against its background in direct sunlight. Do not put muted text on a raised surface.
- No emoji, no gradients, no purple, no more than two font weights per screen.
- No modals while navigating.
- Check each new screen against this section. After building one, screenshot it and fix anything that breaks these rules.

## Endpoints

All under `/api` on Vercel.

- `GET /health`: is the graph loaded.
- `POST /route`: `RouteRequest` in, `RouteResult` out. Rerouting reuses it with the current position as `start`.
- `GET /search?q=`: place search.
- `POST /voice`: `{audio_b64 | text, mime, position, route}` in, `VoiceResult` out.
- `POST /speak`: `{text}` in, mp3 out (503 = use the browser voice).
- `POST /rides`, `POST /rides/{id}/points`, `POST /rides/{id}/events`, `POST /rides/{id}/end`: the ride log. Never error: they return `ok: false` if logging is off or fails.
- `/debug/*` (only for the `/debug` page and admins): `profiles`, `route`, `services`, `services/{name}/test`, `gemini-speed`, `rides/live`, `rides/speeds`, `rides/accuracy`, `rides/trouble`.

## Shared backend functions

Backend files call each other through these. If you change a signature, update this list.

```python
# time_model.py
get_context(when) -> dict
time_penalty(edge, ctx) -> float            # 1.0 = normal, 2.0 = twice as bad
eta_minutes(edges, ctx, learned=None) -> float
departure_hint(now, eta_min) -> dict | None
sun_times(day) -> (sunrise, sunset)

# routing.py
find_route(start, end, profile, ctx, learned=None) -> dict   # the RouteResult minus hint/warning
find_path(start, end, profile, ctx) -> list[node] | None

# ridelog.py
learned_speeds(hour) -> {(u, v): (m/s, points)}
trouble_spots() -> [{osmid, street, riders, lat, lon}]

# db.py
conn() -> psycopg connection (reused; fails fast for a minute after a failed connect)
```

## Environment variables

See `.env.example`. Locally in `backend/.env`; on Vercel in Project > Settings > Environment Variables. `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL`, `DATABASE_URL`, `GOOGLE_MAPS_API_KEY` (optional, `/debug` and benchmark only). Every service is optional: without it that feature falls back or switches off.

## Ownership

- **Algorithm:** `build_graph.py`, `routing.py`, `navigation.py`
- **Time and data:** `time_model.py`, `db.py`, `ridelog.py`
- **Frontend and integration:** `frontend/`
- **AI and pitch:** `ai.py`, `main.py`, the voice loop, place search, PWA, Vercel deploy, Devpost, demo script

## Rules

- Load the graph once at startup; never rebuild it per request.
- `routing.py` stays pure (no network, no database): learned speeds and trouble streets are passed in as data. It can be tested on a small test graph.
- External calls (Gemini, ElevenLabs, Open-Meteo, Nominatim, Tiger Data) live in `ai.py`, `time_model.py`, `db.py`, `ridelog.py` or `main.py`, never in `routing.py`.
- API keys come from environment variables; never commit them. Keep `.env.example` current.
- The frontend only talks to the backend through `frontend/lib/api.ts`; keep its types in sync with `main.py`.
- Demo and testing controls go on `/debug`, never on the rider screen.
- Keep `main` running: it is what gets deployed.
- Run `npm test` (in `frontend/`) before pushing: backend tests, frontend unit tests and type check. GitHub runs the same on every push (`.github/workflows/tests.yml`). A new feature gets a test: backend in `backend/tests/`, frontend logic in `lib/*.test.ts`. Tiger Data tests run against a throwaway schema when `TEST_DATABASE_URL` is set.
- Remove code when its feature is dropped; don't leave unused endpoints, placeholders or tables behind.
