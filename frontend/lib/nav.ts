// Where the rider is along the route: current step, distance left, off route.
// Pure functions (no React, no browser APIs) so they can be unit tested:
//   npm run test:unit
// Distances are metres, positions are [lat, lon].

import type { LatLon, Step } from "./api";

const EARTH_R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
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
  if (route.length === 1) return { distanceToRoute: distanceM(route[0], p), alongM: 0, segment: 0 };
  // flat-earth metres around p: plenty accurate within a city
  const kx = 111320 * Math.cos(rad(p[0]));
  const ky = 110540;
  const xy = (q: LatLon): [number, number] => [(q[1] - p[1]) * kx, (q[0] - p[0]) * ky];
  let best: Projection = { distanceToRoute: Infinity, alongM: 0, segment: 0 };
  for (let i = Math.max(0, fromSegment); i < route.length - 1; i++) {
    const [ax, ay] = xy(route[i]);
    const [bx, by] = xy(route[i + 1]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best.distanceToRoute) {
      best = { distanceToRoute: d, alongM: cum[i] + t * (cum[i + 1] - cum[i]), segment: i };
    }
  }
  return best;
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

/**
 * The step the rider is on now: the last maneuver they've passed (the first step
 * before they've passed any). Its instruction is what they're following.
 */
export function currentStepIndex(stepAlong: number[], alongM: number, passedM = 8): number {
  let i = 0;
  for (let k = 1; k < stepAlong.length; k++) if (stepAlong[k] <= alongM + passedM) i = k;
  return i;
}

// --- Off route -------------------------------------------------------------------------

export interface OffRouteState {
  since: number | null; // when the rider first went too far from the route (ms)
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
  if (distanceToRoute <= Math.max(thresholdM, accuracyM)) return ON_ROUTE;
  const since = state.since ?? nowMs;
  return { since, offRoute: nowMs - since >= holdMs };
}

// --- Moving a point (used by the simulated ride on /debug) ------------------------------

/** Compass bearing in degrees from a to b. */
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

/** The point `d` metres along the route (clamped to its ends). */
export function pointAlong(route: LatLon[], cum: number[], d: number): LatLon {
  if (d <= 0) return route[0];
  if (d >= cum[cum.length - 1]) return route[route.length - 1];
  let i = 0;
  while (cum[i + 1] < d) i++;
  const t = (d - cum[i]) / (cum[i + 1] - cum[i] || 1);
  return [route[i][0] + t * (route[i + 1][0] - route[i][0]), route[i][1] + t * (route[i + 1][1] - route[i][1])];
}

/**
 * The part of the route still ahead of a rider `d` metres along it: the point they're at,
 * then every route point after it. The map draws this, so the line shrinks as you ride.
 */
export function routeAhead(route: LatLon[], cum: number[], d: number): LatLon[] {
  if (d <= 0) return route;
  const ahead = route.filter((_, i) => cum[i] > d);
  return ahead.length ? [pointAlong(route, cum, d), ...ahead] : [route[route.length - 1]];
}
