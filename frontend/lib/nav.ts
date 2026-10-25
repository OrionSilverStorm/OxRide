// Pure ride logic (no React, no browser APIs), so it can be unit tested:
// node --test lib/*.test.ts
// Distances are metres, positions are [lat, lon].

import type { LatLon, Slot, Step } from "./api";

const EARTH_R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

export function bearingDeg(a: LatLon, b: LatLon): number {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** The point `metres` away from p in direction `bearing` (degrees). */
export function offsetPoint(p: LatLon, bearing: number, metres: number): LatLon {
  const d = metres / EARTH_R;
  const b = rad(bearing);
  const lat1 = rad(p[0]);
  const lon1 = rad(p[1]);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [(lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI];
}

/** Distance from the start of the route to each of its points. */
export function cumulativeM(route: LatLon[]): number[] {
  const out = [0];
  for (let i = 1; i < route.length; i++) out.push(out[i - 1] + distanceM(route[i - 1], route[i]));
  return out;
}

export interface Projection {
  distanceToRoute: number; // how far p is from the route line
  alongM: number; // how far along the route the closest point is
  segment: number; // index of the route segment it is on
}

/** Closest point on the route to p. Searches segments from `fromSegment` on. */
export function projectOnRoute(route: LatLon[], cum: number[], p: LatLon, fromSegment = 0): Projection {
  // flat-earth metres around p: plenty accurate within a city
  const kx = 111320 * Math.cos(rad(p[0]));
  const ky = 110540;
  const xy = (q: LatLon): [number, number] => [(q[1] - p[1]) * kx, (q[0] - p[0]) * ky];
  let best: Projection = { distanceToRoute: Infinity, alongM: 0, segment: 0 };
  if (route.length === 1) return { distanceToRoute: distanceM(route[0], p), alongM: 0, segment: 0 };
  for (let i = Math.max(0, fromSegment); i < route.length - 1; i++) {
    const [ax, ay] = xy(route[i]);
    const [bx, by] = xy(route[i + 1]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const d = Math.hypot(cx, cy);
    if (d < best.distanceToRoute) {
      best = { distanceToRoute: d, alongM: cum[i] + t * (cum[i + 1] - cum[i]), segment: i };
    }
  }
  return best;
}

/** The point `d` metres along the route (clamped to its ends). */
export function pointAlong(route: LatLon[], cum: number[], d: number): LatLon {
  if (d <= 0) return route[0];
  const total = cum[cum.length - 1];
  if (d >= total) return route[route.length - 1];
  let i = 0;
  while (cum[i + 1] < d) i++;
  const t = (d - cum[i]) / (cum[i + 1] - cum[i] || 1);
  return [route[i][0] + t * (route[i + 1][0] - route[i][0]), route[i][1] + t * (route[i + 1][1] - route[i][1])];
}

/** Where along the route each step happens. Steps come in order, so search forward. */
export function stepsAlongM(route: LatLon[], cum: number[], steps: Step[]): number[] {
  let seg = 0;
  return steps.map((s) => {
    const p = projectOnRoute(route, cum, [s.lat, s.lon], seg);
    seg = p.segment;
    return p.alongM;
  });
}

/** Index of the next maneuver ahead of the rider (the last step once everything is passed). */
export function nextStepIndex(stepAlong: number[], alongM: number, passedM = 8): number {
  for (let i = 1; i < stepAlong.length; i++) {
    if (stepAlong[i] > alongM + passedM) return i;
  }
  return stepAlong.length - 1;
}

// --- Off route -------------------------------------------------------------------------

export interface OffRouteState {
  since: number | null; // when the rider first went too far from the route
  offRoute: boolean;
}

export const ON_ROUTE: OffRouteState = { since: null, offRoute: false };

/** "More than ~30 m off the route for a few seconds" (GPS jitter alone doesn't count). */
export function updateOffRoute(
  state: OffRouteState,
  distanceToRoute: number,
  nowMs: number,
  { thresholdM = 30, holdMs = 4000, accuracyM = 0 } = {},
): OffRouteState {
  const limit = Math.max(thresholdM, accuracyM);
  if (distanceToRoute <= limit) return ON_ROUTE;
  const since = state.since ?? nowMs;
  return { since, offRoute: nowMs - since >= holdMs };
}

// --- Spoken directions ---------------------------------------------------------------------

export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

/**
 * What to say for the upcoming step, at most twice per step: once early ("In 200 metres,
 * turn left...") and once at the turn. `said` remembers what was already spoken.
 */
export function announcement(
  index: number,
  step: Step,
  distToStepM: number,
  said: Set<string>,
): { key: string; text: string } | null {
  const near = `${index}:near`;
  const far = `${index}:far`;
  if (distToStepM <= 40 && !said.has(near)) {
    return { key: near, text: step.maneuver === "arrive" ? "You have arrived." : step.text };
  }
  if (step.maneuver !== "arrive" && distToStepM > 60 && distToStepM <= 250 && !said.has(far) && !said.has(near)) {
    const metres = Math.round(distToStepM / 50) * 50;
    return { key: far, text: `In ${metres} metres, ${step.text.charAt(0).toLowerCase()}${step.text.slice(1)}` };
  }
  return null;
}

// --- Best time to leave -------------------------------------------------------------------------

/** One line like "Leave in 30 min: less chance of rain (80% → 10%) and 2 min faster", or null. */
export function departureHint(slots: Slot[], nowMs: number): string | null {
  if (slots.length < 2) return null;
  const first = slots[0];
  const best = slots.find((s) => s.best) ?? first;
  if (best === first) return null;
  const reasons: string[] = [];
  const rainDrop = first.rain_prob - best.rain_prob;
  if (rainDrop >= 0.3) {
    reasons.push(
      best.rain_prob < 0.1
        ? "the rain should have stopped"
        : `less chance of rain (${Math.round(first.rain_prob * 100)}% → ${Math.round(best.rain_prob * 100)}%)`,
    );
  }
  if (first.wind_ms - best.wind_ms >= 3) reasons.push("less wind");
  const saved = first.eta_min - best.eta_min;
  if (saved >= 1) reasons.push(`${Math.round(saved)} min faster`);
  if (first.dark && !best.dark) reasons.push("it's light");
  if (!reasons.length) return null;
  const inMin = Math.max(0, Math.round((Date.parse(best.depart_utc) - nowMs) / 60000));
  const when = inMin < 60 ? `in ${inMin} min` : `at ${best.depart_local.slice(11, 16)}`;
  const list = reasons.length === 1 ? reasons[0] : `${reasons.slice(0, -1).join(", ")} and ${reasons.at(-1)}`;
  return `Leave ${when}: ${list}.`;
}

// --- Suffer score (Hackiest Hack) ---------------------------------------------------------------

export const DRAGON_MOODS = ["Sleepy", "Curious", "Grumpy", "Angry", "Furious"] as const;

/** 0-100 from how much and how steeply the route climbs; mood 0 (sleepy) to 4 (furious). */
export function sufferScore(route: LatLon[], elevations: number[]): { score: number; mood: number; climbM: number } {
  let climb = 0;
  let steepClimb = 0;
  for (let i = 1; i < route.length && i < elevations.length; i++) {
    const rise = elevations[i] - elevations[i - 1];
    if (rise <= 0) continue;
    climb += rise;
    const run = distanceM(route[i - 1], route[i]);
    if (run > 0 && rise / run > 0.04) steepClimb += rise; // steeper than 4%
  }
  const score = Math.min(100, Math.round(climb * 0.8 + steepClimb * 2));
  const mood = score < 10 ? 0 : score < 25 ? 1 : score < 45 ? 2 : score < 70 ? 3 : 4;
  return { score, mood, climbM: Math.round(climb) };
}

// --- Departure presets -------------------------------------------------------------------------

/** "YYYY-MM-DDTHH:MM" in the browser's local time (the backend reads it as Oxford time). */
export function localIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The next time it's `hour`:00 (today if still ahead, else tomorrow). */
export function nextAt(hour: number, now: Date): string {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return localIso(d);
}

// Trips where the night route clearly differs from the day route (backend/benchmark.py --night).
export const DEMO_TRIPS: { name: string; start: LatLon; end: LatLon }[] = [
  { name: "Osney → Iffley Road", start: [51.751, -1.278], end: [51.747, -1.24] },
  { name: "Old Marston → Headington", start: [51.774, -1.24], end: [51.76, -1.2135] },
];
