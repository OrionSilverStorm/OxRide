// Relative on purpose: next.config.ts forwards /api/* to the backend (BACKEND_URL).
const API_URL = "/api";

export type LatLon = [number, number];
export type Profile = "fast" | "regular" | "chill";
export type Maneuver = "left" | "right" | "straight" | "arrive";

export interface Step {
  text: string;
  distance_m: number;
  lat: number;
  lon: number;
  maneuver: Maneuver;
}

export interface RouteResult {
  route: LatLon[];
  elevations_m: number[];
  stats: {
    distance_m: number;
    climb_m: number;
    eta_min: number;
    cycleway_share: number;
    lit_share: number;
    learned_share?: number; // share of the route whose ETA comes from real rides (Tiger Data)
  };
  steps: Step[];
  hint?: DepartureHint | null; // only when leaving now, and only if worth saying
  warning?: string | null; // "Avoiding St Aldate's: 4 riders turned back there ..." (possible closure)
}

/** "Rain should stop by about 13:00. Leave then to stay dry." (backend time_model.departure_hint) */
export interface DepartureHint {
  kind: "rain_starts" | "rain_stops" | "dark_soon" | "light_soon" | "ice" | "rush_ends";
  text: string;
  in_min: number; // 0 = leave now
  leave_at: string; // Oxford time, ISO
}

export interface RouteRequest {
  start: LatLon;
  end: LatLon;
  profile: Profile;
  depart_at?: string;
}

export type VoiceAction = "new_route" | "reroute" | "answer";

export interface VoiceRequest {
  audio_b64?: string;
  mime?: string; // what the browser recorded, e.g. "audio/webm" or "audio/mp4"
  text?: string;
  position?: LatLon;
  route?: RouteResult;
}

export interface VoiceResult {
  action: VoiceAction;
  // new_route: end (+ end_name) found from the place the rider named; start = their position
  settings: Partial<RouteRequest> & { end_name?: string };
  reply: string;
  heard?: string; // what Gemini heard, when it was sent a recording
  error?: string; // only when Gemini failed: why (for the voice log)
}

export interface Place {
  name: string;
  lat: number;
  lon: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

export const getRoute = (body: RouteRequest) =>
  request<RouteResult>("/route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const sendVoice = (body: VoiceRequest) =>
  request<VoiceResult>("/voice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** ElevenLabs speech as mp3. Throws when there's no audio (then use the browser's voice). */
export async function speak(text: string): Promise<Blob> {
  const res = await fetch(`${API_URL}/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.blob();
}

export const searchPlace = (q: string) => request<Place[]>(`/search?q=${encodeURIComponent(q)}`);

// --- Ride logs (Tiger Data). Never throw: logging must not break riding. ---

export interface RidePoint {
  t: number; // ms since 1970
  lat: number;
  lon: number;
  acc?: number | null;
}

export interface RideResultTimes {
  predicted_min: number | null;
  actual_min: number;
}

async function quiet<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true, // still sent if the page is closing
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.ok ? (data as T) : null;
  } catch {
    return null;
  }
}

export const startRide = (body: {
  start: LatLon;
  end: LatLon;
  profile: Profile;
  predicted_min: number | null;
  planned_m: number;
  simulated?: boolean;
}) => quiet<{ ride_id: string }>("/rides", body);

export const sendRidePoints = (rideId: string, points: RidePoint[], simulated = false) =>
  quiet<{ saved: number }>(`/rides/${rideId}/points`, { points, simulated });

export const sendRideEvent = (rideId: string, kind: "off_route" | "reroute", at: LatLon, simulated = false) =>
  quiet(`/rides/${rideId}/events`, { kind, lat: at[0], lon: at[1], simulated });

export const endRide = (rideId: string, arrived: boolean, actualMin?: number) =>
  quiet<RideResultTimes>(`/rides/${rideId}/end`, { arrived, actual_min: actualMin });

// --- Debug panel (/debug). Mirrors backend/debug.py. ---

export interface ProfileParams {
  road_type_factors: Record<string, number>;
  surface_factors: Record<string, number>;
  hill_weight: number;
}

export interface DebugProfiles {
  profiles: Record<Profile, ProfileParams>;
  highways: { highway: string; km: number }[];
  surfaces: string[];
  google_enabled: boolean;
}

export interface DebugEdge {
  name: string;
  highway: string;
  surface: string;
  lit: boolean;
  length_m: number;
  grade_pct: number;
  bearing: number;
  road_factor: number;
  surface_factor: number;
  hill_penalty: number;
  base_cost: number;
  time_penalty: number;
  headwind_ms: number;
  cost: number;
  cost_per_m: number;
  matches_edge_cost: boolean;
  coords: LatLon[];
}

export interface DebugSummary {
  distance_m: number;
  climb_m: number;
  cost: number;
  eta_min: number | null;
  cycleway_share: number;
  main_road_share: number;
  lit_share: number;
  rough_surface_share: number;
  max_grade_pct: number;
  turns: number;
}

export type DebugRouteId = "ours" | "shortest" | "google" | "drawn" | "baseline";

export interface DebugRoute {
  id: DebugRouteId;
  label: string;
  edges: DebugEdge[];
  elevations_m: number[];
  summary: DebugSummary;
  by_highway: Record<string, { length_m: number; cost: number }>;
  cost_check_ok: boolean;
  astar?: { expanded_count: number; ms: number; expanded?: LatLon[]; graph_nodes?: number };
  line?: LatLon[]; // ours only: the whole route as one line (simulated ride)
  steps?: Step[]; // ours only: turn-by-turn
  google?: { distance_m: number | null; duration_min: number; points: LatLon[] };
}

export type DebugCtx = Record<string, number | boolean | string>;

export interface DebugRouteResult {
  ctx: DebugCtx;
  ctx_from_weather: DebugCtx;
  profile_used: ProfileParams;
  start_node: { id: number; snap_m: number; coord: LatLon };
  end_node: { id: number; snap_m: number; coord: LatLon };
  routes: DebugRoute[];
  warnings: string[];
}

export interface DebugRouteRequest {
  start: LatLon;
  end: LatLon;
  profile: Profile;
  depart_at?: string | null;
  profile_override?: ProfileParams | null;
  ctx_override?: DebugCtx | null;
  waypoints?: LatLon[] | null;
  google?: boolean;
}

export const getDebugProfiles = () => request<DebugProfiles>("/debug/profiles");

export const debugRoute = (body: DebugRouteRequest) =>
  request<DebugRouteResult>("/debug/route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// --- Services box on /debug: are the API keys set up? Mirrors debug.py. ---

export type ServiceName = "gemini" | "elevenlabs" | "database" | "google_maps";

export const getServices = () =>
  request<Record<ServiceName, Record<string, boolean>>>("/debug/services");

export interface ServiceTest {
  ok: boolean;
  message: string;
  ms?: number;
  models?: string[]; // Gemini: model names to pick from when GEMINI_MODEL isn't set
  audio?: string; // ElevenLabs: base64 mp3
}

export const testService = (name: ServiceName) =>
  request<ServiceTest>(`/debug/services/${name}/test`, { method: "POST" });

// --- Tiger Data page on /debug ---

export interface RideStatsLive {
  rides_real: number;
  rides_simulated: number;
  rides_arrived: number;
  last_ride: string | null;
  points_real: number;
  points_simulated: number;
  events_24h: number;
  raw_days_kept: number;
}

export interface StreetSpeed {
  coords: LatLon[];
  speed_ms: number;
  points: number;
  name: string;
}

export interface RideAccuracy {
  ended_at: string;
  predicted_min: number;
  actual_min: number;
  error_pct: number | null;
  simulated: boolean;
}

export interface TroubleSpot {
  osmid: number;
  street: string;
  riders: number;
  events: number;
  lat: number;
  lon: number;
  last: string;
  active: boolean;
}

type Stats<T> = { ok: true; data: T } | { ok: false; message: string };

export const getRideStatsLive = () => request<Stats<RideStatsLive>>("/debug/rides/live");
export const getStreetSpeeds = (hour: number | null, simulated: boolean) =>
  request<Stats<StreetSpeed[]>>(`/debug/rides/speeds?simulated=${simulated}${hour === null ? "" : `&hour=${hour}`}`);
export const getRideAccuracy = (simulated: boolean) =>
  request<Stats<RideAccuracy[]>>(`/debug/rides/accuracy?simulated=${simulated}`);
export const getTroubleSpots = (simulated: boolean, hours = 24) =>
  request<Stats<TroubleSpot[]>>(`/debug/rides/trouble?simulated=${simulated}&hours=${hours}`);
