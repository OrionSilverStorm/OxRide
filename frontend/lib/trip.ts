// Hands the planned trip from the planning screen to /navigate (sessionStorage).
import type { LatLon, Profile, RouteResult } from "./api";

export interface Trip {
  start: LatLon;
  end: LatLon;
  endName?: string;
  profile: Profile;
  departAt: string | null; // null = now
  result: RouteResult;
}

const KEY = "oxride:trip";

export function saveTrip(trip: Trip) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(trip));
  } catch {
    // private mode or storage full: /navigate will say there's no trip
  }
}

export function loadTrip(): Trip | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Trip) : null;
  } catch {
    return null;
  }
}
