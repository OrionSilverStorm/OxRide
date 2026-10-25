# OxRide

Time-aware, voice-first cycle navigation for Oxford, built for a hackathon (theme: TIME). Google Maps gives the shortest route for cars; OxRide gives the best route for a cyclist at the time they ride: it accounts for hills and the time of day (darkness, rush hour), prefers cycle paths and quiet streets over main roads, and reroutes when you go off route. You can't type while cycling, so you talk to it: Gemini works out what you want and ElevenLabs speaks the answer and the directions. Web app / PWA, mobile first.

## Challenges we're entering

- **Main prize (theme TIME), core:** the route changes with the time of day, and we recommend a departure time.
- **HRT, core:** predict ETA from gradient, surface, wind and time of day, then recommend a route and a time to leave. The hand-written A* is what we show them.
- **Gemini:** the hands-free brain; understands what the rider says and explains why it picked the route.
- **ElevenLabs:** speaks Gemini's replies, the ride briefing and the turn-by-turn directions.
- **Tiger Data:** stores hourly weather and predicted journey times; feeds the best-time-to-leave chart.
- **Hackiest Hack:** suffer score for hills, with a dragon logo.
- DEV Writing: blog post next week.

## Goals

- **Must have (this is the demo):** our own A* finds a sensible cycle route between two points in Oxford; the route is drawn on a live, deployed map; the same trip gives a different route at night than by day because of lit streets.
- **Should have:** navigation mode (live location, spoken turn-by-turn, simulate ride); rerouting when off route; PWA on a phone; ETA prediction and best time to leave; rush hour and the three profiles; place search and "use my location"; push-to-talk with Gemini (new route, reroute, question) and ElevenLabs replies.
- **Nice to have:** ElevenLabs voice with browser voice as fallback; Tiger Data storing weather and predictions; suffer score with a dragon that gets angrier the more you climb.
- **Dream:** rerouting for blocked roads.

If we fall behind, cut from the bottom up (nice to have first, e.g. Tiger Data, then ElevenLabs since the browser voice still works). Never cut the route on the map and the day/night switch.

## Stack

- **Backend (Python):** fastapi + uvicorn, osmnx + networkx (Oxford bike graph), our own A* with `heapq` (do not use networkx's shortest path), numpy, httpx, google-genai (Gemini, takes audio directly, no separate speech-to-text), elevenlabs, psycopg (Tiger Data = Postgres)
- **Frontend (TypeScript, thin):** Next.js, Tailwind (or Bootstrap) + shadcn/ui, react-leaflet, PWA (`manifest.json` + icons)
- **Hosting:** frontend and backend on Vercel as one project (`vercel.json` services): `/api/*` goes to the FastAPI backend, everything else to Next.js
- **Data:** OSM via osmnx (roads, cycleways, surface, lit, names), Nominatim (search, 1 req/s, needs User-Agent, call from backend), OpenTopoData (elevation, 100 points/request, ~1 req/s), Open-Meteo (hourly wind, rain, temperature, sunrise/sunset). Optional: DfT traffic counts, STATS19.
- **Browser APIs:** Geolocation `watchPosition`, microphone (`getUserMedia` + `MediaRecorder`), Wake Lock (screen on while navigating). All need HTTPS (Vercel). Web Speech API is the free fallback for speech in and out.
- Map tiles: OSM or CARTO, attribution must stay visible.
- Out of scope: live traffic, search outside Oxford, offline maps.

## Layout

```
backend/
  build_graph.py   one-off: OSM + elevation -> graph file
  routing.py       A*, cost function, ride profiles
  navigation.py    turn-by-turn steps from a route
  time_model.py    ETA prediction, time of day, wind/rain/temperature
  ai.py            Gemini voice commands + ElevenLabs voice (+ Nominatim search)
  db.py            Tiger Data
  main.py          API endpoints
  debug.py         /debug/* endpoints: cost breakdown, A* trace, route comparison, API key tests
  benchmark.py     ours vs shortest vs Google on fixed trips; --night finds day/night demo trips
  vercel_app.py    Vercel entry point (mounts main.app under /api)
  tests/           pytest suite: routing, time model, navigation, API, ai (no network, no credits)
frontend/
  app/page.tsx     the app: planning and navigation both live in components/Map.tsx
  app/navigate/    placeholder (navigation currently happens in Map.tsx)
  app/debug/       routing debug panel (components/debug/)
  components/      Map (search, ride type, route, directions banner, voice command, mute), placeholders
  hooks/           useVoice (mic: hold to talk, or tap to keep listening; speech-to-text or record-for-Gemini engine), useTheme (light/dark + toggle); the others are placeholders
  lib/api.ts       calls to the backend
  lib/nav.ts       where the rider is along the route: current step, distance left, off route (+ nav.test.ts)
  lib/speak.ts     say(): ElevenLabs via /speak, browser voice fallback; isSpeaking() so the mic ignores the app; stopSpeaking()
  lib/heard.ts     what the mic heard -> what to send (iPhones don't mark sentences finished) (+ heard.test.ts)
  lib/voiceLog.ts  mic debug log, shown on the phone with ?voicelog (components/VoiceLog.tsx); mic engine switch
  lib/recorder.ts  record engine: records the mic, converts to 16 kHz WAV (lib/wav.ts, + wav.test.ts) for Gemini
  lib/theme.ts     which Everforest palette shows: phone setting, dark while navigating, manual toggle (+ theme.test.ts)
  lib/mock.ts      fake data until the backend is ready
  scripts/         dev-api.mjs (cross-platform backend start), test.mjs (npm test)
  public/          manifest.json, app icons, dragon logo
```

## What each file is for

### Backend

- **`build_graph.py`**: run once, offline. Turns the real world into the data A* searches. Downloads Oxford's bike network with osmnx, adds elevation per node (OpenTopoData), computes `grade` and `bearing` per edge, fills in missing `lit` and `surface` tags with defaults by road type, and saves the graph file. Never runs while the app is serving requests.
  - Graph contract (everyone relies on these names): each **edge** has `length` (m), `highway`, `surface`, `lit` (bool), `name`, `bearing` (deg), `grade` (rise/length); each **node** has `x` (lon), `y` (lat), `elevation` (m).
- **`routing.py`**: finds the best path. Loads the graph once at startup. Snaps start/end lat-lon to the nearest nodes, runs our own A* (`heapq`), and prices each edge with `edge_cost` (length x road-type factor x surface factor + hill penalty, x `time_penalty`). Returns the route as a list of `[lat, lon]` (this is what the map draws), plus stats, plus steps. Must-have: this file alone is the demo.
- **`navigation.py`**: turns the path into instructions. Takes the list of node ids from A*, compares the direction of travel before and after each junction, and produces steps `{text, distance_m, lat, lon, maneuver}` with street names. Needed for spoken directions, the next-turn display and off-route handling, not for drawing the route. Should-have: build it after the route works.
- **`time_model.py`**: everything that depends on *when* you ride. `get_context` fetches weather (Open-Meteo) and works out darkness and rush hour; `time_penalty` says how bad one road is right now; `eta_minutes` predicts ride time (slower on hills and into a headwind); `best_departures` scores every 15-minute slot for the next 3 hours. This is the TIME and HRT part.
- **`ai.py`**: the outside-world helpers for voice and search. `interpret_voice` sends what the rider said (plus position and current route) to Gemini and gets back `{action, settings, reply}`; `speak` turns text into audio (ElevenLabs); `search_place` turns "Radcliffe Camera" into coordinates (Nominatim).
- **`db.py`**: Tiger Data (Postgres). Stores hourly weather and predicted journey times so the best-time-to-leave chart has data. Called by `time_model.py`; nothing else touches the DB. Cut first if time runs short.
- **`main.py`**: the doorway. FastAPI app that exposes the endpoints and calls the functions above. Contains no logic of its own: it parses the request, calls one or two functions, returns JSON. Currently returns fake JSON so the frontend can build against it.
- **`requirements.txt`**: backend Python dependencies.

### Frontend

- **`app/page.tsx`**: planning screen. Map, tap to set start/end, profile picker, departure time, route stats, charts.
- **`app/navigate/page.tsx`**: navigation screen. Live dot, next turn, simulate ride, push-to-talk.
- **`components/Map.tsx`**: the react-leaflet map: route line, start/end markers, live position dot, tile attribution. Currently also the navigation mode (directions banner, time left, ride type, mute, voice command), using `lib/nav.ts`.
- **`components/RoutePanel.tsx`**: distance, climb, ETA, share on cycleways, share on lit roads.
- **`components/ElevationChart.tsx`**: elevation profile along the route.
- **`components/DepartureChart.tsx`**: ETA/score per 15-minute slot from `/best-departure`.
- **`components/SufferScore.tsx`**: hill suffer score and the dragon logo (Hackiest Hack).
- **`components/VoiceButton.tsx`**: big push-to-talk button.
- **`hooks/useLocation.ts`**: live GPS via `watchPosition`.
- **`hooks/useNavigation.ts`**: tracks the next step and detects "more than ~30 m off route for a few seconds", then asks for a new route from the current position.
- **`hooks/useSimulatedRide.ts`**: fake position moving along the route at bike speed, plus the "take a wrong turn" button, for indoor demos.
- **`hooks/useVoice.ts`**: records the mic, sends it to `/voice`, plays the spoken reply (ElevenLabs, Web Speech as fallback).
- **`lib/api.ts`**: the only place the frontend calls the backend. Typed functions mirror the endpoints.
- **`lib/mock.ts`**: fake route data so the UI can be built before the backend works.
- **`public/manifest.json`** (+ icons, dragon logo): makes it an installable PWA.

## Pipeline: who calls whom

Pseudo-calls in the order they happen. `file.py: function()` means that function in that file.

### Data shapes passed around

```
RouteRequest  {start:[lat,lon], end:[lat,lon], profile:"fast"|"regular"|"chill", depart_at: ISO string | null (null = now)}
ctx           {hour, is_dark, wind_speed, wind_dir, rain, temperature_c}      # from time_model.get_context
RouteResult   {route:[[lat,lon],...],          # drawn on the map
               elevations_m:[...],             # one per route point, for ElevationChart + suffer score
               stats:{distance_m, climb_m, eta_min, cycleway_share, lit_share},
               steps:[Step],
               hint: Hint | null}              # only when leaving now (see "Best time to leave")
Hint          {kind, text, in_min, leave_at}   # kind: rain_starts|rain_stops|dark_soon|light_soon|ice|rush_ends
Step          {text, distance_m, lat, lon, maneuver:"left"|"right"|"straight"|"arrive"}
Slot          {depart_at, eta_min, rain, wind_speed}                           # one per 15-minute departure option
VoiceResult   {action:"new_route"|"reroute"|"answer", settings:{...RouteRequest fields...}, reply}
```

### 0. One-off graph build (before anything else)

1. `backend/build_graph.py: build_graph(place, out_path)`
   - `osmnx.graph_from_place("Oxford, UK", network_type="bike")` downloads roads, cycleways, tags.
   - Elevation for every node from OpenTopoData (100 points per request, ~1 request/s).
   - Per edge: `grade = (elev_end - elev_start) / length`, plus `osmnx.bearing.add_edge_bearings`.
   - Fill missing `lit` and `surface` with defaults by `highway` type.
   - Needs `pip install -r backend/requirements-build.txt` (osmnx); the server itself only needs `requirements.txt`.
   - Save the graph as a pickle, `backend/oxford_graph.pkl` (GraphML turns `lit` into text). `routing.load_graph(path)` loads it at startup. Print how many edges had real vs defaulted `lit`/`surface`.
   - `highway`, `name`, `surface`, `lit` are single values (lists flattened, gaps filled). `surface` is one of `asphalt | gravel | cobbles`.

### 1. Server startup

1. `backend/main.py` starts (uvicorn).
2. `backend/routing.py` loads the graph file into memory once (`G`). Never reloaded per request.

### 2. Plan a ride (tap start and end, press go)

1. `frontend/app/page.tsx` holds start, end, profile, departure time in state and calls `getRoute()`.
2. `frontend/lib/api.ts: getRoute(body)` sends `POST /route` with a `RouteRequest`.
3. `backend/main.py: route(req)`
   1. `ctx = time_model.get_context(req.depart_at)`
   2. `return routing.find_route(req.start, req.end, req.profile, ctx)`
4. `backend/time_model.py: get_context(depart_at)`
   - Reads the Open-Meteo hourly forecast (fetched once and cached ~30 min, not per call) and picks the row for `depart_at`.
   - Sets `is_dark` from sunrise/sunset, and fills `hour`, `wind_speed`, `wind_dir`, `rain`, `temperature_c`.
   - Calls `db.save_weather(rows)` when it refreshes the forecast (skip if Tiger Data is cut).
5. `backend/routing.py: find_route(start, end, profile, ctx)`
   1. Snap `start` and `end` to node ids: `osmnx.distance.nearest_nodes(G, lon, lat)`.
   2. `path = astar(G, s, e, cost_fn)`; the cost for each edge is `edge_cost(edge_data, PROFILES[profile], ctx)`.
   3. `edge_cost`: `length x road_type_factor x surface_factor + hill_penalty(grade)`, then `x time_model.time_penalty(edge_data, ctx)`.
   4. `time_model.py: time_penalty(edge_data, ctx)`: higher for unlit roads when `is_dark`, main roads at rush hour, headwind (compare `edge_data["bearing"]` with `ctx["wind_dir"]`), and Cornmarket/Queen Street during restricted hours. Stub returns 1.0 until written.
   5. Build the response from `path`:
      - `route` = `[[G.nodes[n]["y"], G.nodes[n]["x"]] for n in path]`
      - `elevations_m` = `[G.nodes[n]["elevation"] for n in path]`
      - `stats`: sum of edge `length`; sum of positive elevation gain; length-weighted share where `highway == "cycleway"`; length-weighted share where `lit` is true; `eta_min = time_model.eta_minutes(...)`
      - `steps = navigation.build_steps(G, path)` (Should-have; return `[]` until it exists)
6. `backend/navigation.py: build_steps(G, path)`
   - For each consecutive pair of nodes read the edge `name`, `length`, `bearing`.
   - At each junction: bearing change near 0 -> `straight`; clear positive -> `right`; clear negative -> `left`.
   - Merge consecutive straights on the same street into one step. Last step is `arrive`.
7. `backend/time_model.py: eta_minutes(route, ctx)`: sum of (edge length / speed) per edge; speed drops on hills and into a headwind.
8. Back in the browser: `Map.tsx` draws `route`; `RoutePanel.tsx` shows `stats`; `ElevationChart.tsx` plots `elevations_m`; `SufferScore.tsx` is computed from `elevations_m`/`climb_m`.

### 3. Best time to leave

Built as: `time_model.departure_hint(now, eta_min)`, returned as `hint` by `POST /route` when leaving now, and shown under the distance and arrival time until the rider has gone 100 m. Agreed rules: at most one hint, only for leaving within 60 min, rain counts as likely from 50%. Cases in priority order: rain about to start (leave now), rain about to stop, sunset soon / sunrise soon, icy roads (<= 2 °C), rush hour ending. "Faster later" and "less wind later" were dropped: wind changes speed by under 2%.

What it is: a small hint, not the main feature. The route is always planned for the departure time in the request (`depart_at`, which is *now* unless the rider picked another time). The hint is one extra line under the route, such as "Leave in 20 min: the rain stops and the ride is 3 min faster". If no later slot is clearly better, show no hint. The departure chart and the database are extras (cut them first), but keep the one-line hint: it is the TIME theme and HRT's "recommend a time to leave".

1. `frontend/components/DepartureChart.tsx` (or just a text line in `RoutePanel.tsx`) calls `api.ts: getBestDeparture(start, end, profile)` -> `GET /best-departure`.
2. `backend/main.py: best_departure(...)` -> `time_model.best_departures(start, end, profile)`.
3. `backend/time_model.py: best_departures(start, end, profile)`
   ```
   route = routing.find_route(start, end, profile, get_context(now))   # ONE A* run, for leaving now
   for t in [now, now+15min, ... now+3h]:                              # 12 slots
       ctx   = get_context(t)                                          # just reads the cached forecast row
       eta   = eta_minutes(route, ctx)                                 # cheap: no new A*
       db.save_prediction({t, eta, rain, wind_speed})                  # optional, Tiger Data
   return [Slot, ...]
   ```
   The route is held fixed across slots, so this is one A* run plus 12 cheap ETA calculations. The frontend picks the best slot (lowest ETA, or rain/wind clearly better than now) and writes the hint line from the slot's `rain` and `wind_speed`.

### 4. Place search

1. Search box in `page.tsx` -> `api.ts: searchPlace(q)` -> `GET /search?q=Radcliffe Camera`
2. `backend/main.py: search(q)` -> `ai.search_place(q)` -> Nominatim (1 request/s, User-Agent set) -> `[{name, lat, lon}]`

### 5. Navigating

1. `frontend/app/navigate/page.tsx` receives the `RouteResult` and wires up the hooks.
2. `frontend/hooks/useLocation.ts`: `watchPosition` gives the live position. (Demo: `useSimulatedRide(route)` supplies a fake position moving at bike speed instead.)
3. `frontend/hooks/useNavigation.ts: useNavigation(route, position)`
   - Finds the next `Step`.
   - Measures distance from `position` to the route line; if more than ~30 m for a few seconds, `offRoute = true`.
4. When `offRoute` (or the "take a wrong turn" demo button): `api.getRoute({start: position, end, profile, depart_at: now})` -> same flow as section 2.
5. When the next step is near: `api.speak(step.text)` -> section 6 below -> play audio. Fallback: Web Speech `speechSynthesis`.
6. Wake Lock is requested when the screen opens.

### 6. Speaking

1. `frontend/lib/api.ts: speak(text)` -> `POST /speak`
2. `backend/main.py: speak(req)` -> `ai.speak(text)` -> ElevenLabs -> audio bytes -> browser plays them.

### 7. Talking to it (push-to-talk)

1. `frontend/components/VoiceButton.tsx` (held) -> `hooks/useVoice.ts` starts `MediaRecorder`.
2. On release: `api.ts: sendVoice({audio_b64, position, route})` -> `POST /voice`.
3. `backend/main.py: voice(req)` -> `ai.interpret_voice(audio, text, position, route)`
4. `backend/ai.py: interpret_voice(...)`: sends the audio, position and current route to Gemini; returns a `VoiceResult`, for example
   `{action: "new_route", settings: {end: "Radcliffe Camera", ...}, reply: "Quiet route to the Radcliffe Camera, skipping the hill."}`
5. If `settings` names a place, `main.py` resolves it with `ai.search_place(name)` into coordinates first.
6. Back in the browser, `useVoice.ts`:
   1. `api.speak(reply)` and play the audio.
   2. If `action` is `new_route` or `reroute`: `api.getRoute(...)` with the new settings (section 2), then speak the new steps.
   3. If `action` is `answer`: nothing more to do.
7. Fallback: if Gemini audio or ElevenLabs is slow or fails, use Web Speech API for speech in and out.

## Route behaviour

- Wind does not change the route: measured data (TU Delft) shows it changes cycling speed by under 2%, so it only affects the ETA.
- Profiles: `fast`, `regular`, `chill` (same names in the UI, API and code). Each profile is a different set of cost factors in `routing.PROFILES`: chill = cycle paths and quiet roads even if longer, regular = prefers cycle paths and avoids repeated climbs, fast = mostly the shortest route.
- The route depends on departure time: darkness (prefer lit streets), rush hour (quiet roads over main roads), rain (slippery gravel), hills (suffer score), and Oxford-specific cycling restrictions (avoid Cornmarket and Queen Street during restricted hours).

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

- `POST /route`: start, end, profile, departure time in; route, stats, steps out. Rerouting reuses it with the current position as `start`.
- `GET /best-departure`: ETA and score for each 15-minute slot
- `GET /search?q=`: place search via Nominatim
- `POST /voice`: what the rider said (audio, or text as fallback), current position and current route in; `{ action, settings, reply }` out, where `action` is `new_route | reroute | answer`. Gemini does the thinking; the action then goes through `POST /route`. Replies stay to a sentence or two.
- `POST /speak`: ElevenLabs text to speech (Gemini's reply, then the new directions)

Each turn-by-turn step: `{ text, distance_m, lat, lon, maneuver }`, where `maneuver` is `left | right | straight | arrive`.

## Shared backend functions

Backend files only call each other through these. If you change a signature, tell the others straight away.

```python
# time_model.py
get_context(depart_at) -> dict          # hour, is_dark, wind_speed, wind_dir, rain, temperature_c
time_penalty(edge_data, ctx) -> float   # 1.0 = normal, 2.0 = twice as bad
eta_minutes(route, ctx) -> float
best_departures(start, end, profile) -> list

# routing.py
find_route(start, end, profile, ctx) -> dict   # same fields as the /route output
```

Edge cost = length x road-type factor x surface factor + hill penalty, all multiplied by `time_penalty`. Until `time_model` exists, `time_penalty` is a stub returning 1.0.

## Ownership

- **Algorithm:** `build_graph.py`, `routing.py`, `navigation.py`
- **Time and data:** `time_model.py`, `db.py`
- **Frontend and integration:** `frontend/` (map, panels, charts, navigation screen, live location, off-route detection, simulate ride, push-to-talk button)
- **AI and pitch:** `ai.py`, `main.py`, the voice loop, place search, PWA setup, Vercel deploy, Devpost, demo script

Only edit your own files; ask the owner if you need a change in theirs.

## Rules

- Load the graph once at startup; never rebuild it per request.
- `routing.py` cost logic stays pure (no network), so it can be tested on a small test graph.
- External calls (Gemini, ElevenLabs, Open-Meteo, Nominatim, DB) live in `ai.py`, `time_model.py`, `db.py` or `main.py`, never in `routing.py`.
- API keys come from environment variables; never commit them. Keep `.env.example` current.
- The frontend only talks to the backend through `frontend/lib/api.ts`; keep its types in sync with `main.py`.
- Merge into `main` every couple of hours and keep `main` running: it is what gets deployed.
- Run `npm test` (in `frontend/`) before pushing: backend tests, frontend unit tests and type check. GitHub runs the same on every push (`.github/workflows/tests.yml`). A new feature gets a test: backend in `backend/tests/`, frontend logic in `lib/*.test.ts`.
