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
  text?: string;
  position?: LatLon;
  route?: RouteResult;
}

export interface VoiceResult {
  action: VoiceAction;
  settings: Partial<RouteRequest>;
  reply: string;
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
