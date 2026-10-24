const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export type LatLon = [number, number];
export type Profile = "road" | "commuter" | "chill";
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
