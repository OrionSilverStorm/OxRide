// Relative on purpose: next.config.ts forwards /api/* to the backend (BACKEND_URL).
const API_URL = "/api";

export type LatLon = [number, number];
export type Profile = "fast" | "regular" | "chill";
export type Maneuver = "left" | "right" | "straight" | "arrive";

export interface NavStep { instruction: string; distance_m: number; lat: number; lon: number }
export interface NavigationData { distance_m: number; duration_s: number; steps: NavStep[] }

// Same request body as /route
export async function getNavigation(body: object): Promise<NavigationData> {
  const res = await fetch("/api/navigation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

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
  };
  steps: Step[];
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
}

/** One 15-minute departure option from /best-departure. */
export interface Slot {
  depart_local: string;
  depart_utc: string;
  eta_min: number;
  rain_prob: number;
  rain_mm?: number;
  wind_ms: number;
  dark: boolean;
  score?: number;
  best: boolean;
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

export const health = () => request<{ status: string }>("/health");

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

export const speak = (text: string) =>
  request<{ audio: string | null }>("/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

export const getBestDeparture = (start: LatLon, end: LatLon, profile: Profile) =>
  request<Slot[]>(
    `/best-departure?start=${start.join(",")}&end=${end.join(",")}&profile=${profile}`,
  );

export const searchPlace = (q: string) => request<Place[]>(`/search?q=${encodeURIComponent(q)}`);

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

export type DebugRouteId = "ours" | "shortest" | "google" | "drawn";

export interface DebugRoute {
  id: DebugRouteId;
  label: string;
  edges: DebugEdge[];
  elevations_m: number[];
  summary: DebugSummary;
  by_highway: Record<string, { length_m: number; cost: number }>;
  cost_check_ok: boolean;
  astar?: { expanded_count: number; ms: number; expanded?: LatLon[]; graph_nodes?: number };
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
