// Unit tests for lib/nav.ts. Run: npm run test:unit   (Node 23+ runs TypeScript directly)
import { test } from "node:test";
import assert from "node:assert/strict";

import { cumulativeM, currentStepIndex, distanceM, ON_ROUTE, projectOnRoute, stepsAlongM, updateOffRoute } from "./nav.ts";
import type { LatLon, Step } from "./api.ts";

// Test helper: the point `metres` from p heading `bearing` degrees.
function offset(p: LatLon, bearing: number, metres: number): LatLon {
  const R = 6371000;
  const d = metres / R;
  const b = (bearing * Math.PI) / 180;
  const lat1 = (p[0] * Math.PI) / 180;
  const lon1 = (p[1] * Math.PI) / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [(lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI];
}

// An L-shaped route in Oxford: 1 km north, then 1 km east.
const A: LatLon = [51.75, -1.26];
const B = offset(A, 0, 1000);
const C = offset(B, 90, 1000);
const ROUTE: LatLon[] = [A, B, C];
const CUM = cumulativeM(ROUTE);

const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (±${tol})`);

test("distances along the route", () => {
  near(distanceM(A, B), 1000, 1);
  near(CUM[2], 2000, 2);
});

test("projecting the rider onto the route", () => {
  const onRoute = projectOnRoute(ROUTE, CUM, offset(A, 0, 500));
  near(onRoute.distanceToRoute, 0, 1);
  near(onRoute.alongM, 500, 2);
  const beside = projectOnRoute(ROUTE, CUM, offset(offset(B, 90, 500), 0, 50)); // 50 m north of the east leg
  near(beside.distanceToRoute, 50, 2);
  near(beside.alongM, 1500, 3);
});

const STEPS: Step[] = [
  { text: "Head north on Test Road", distance_m: 1000, lat: A[0], lon: A[1], maneuver: "straight" },
  { text: "Turn right onto East Street", distance_m: 1000, lat: B[0], lon: B[1], maneuver: "right" },
  { text: "You have arrived", distance_m: 0, lat: C[0], lon: C[1], maneuver: "arrive" },
];

test("current step follows the rider along the route", () => {
  const along = stepsAlongM(ROUTE, CUM, STEPS);
  near(along[1], 1000, 2);
  assert.equal(currentStepIndex(along, 0), 0); // still on Test Road
  assert.equal(currentStepIndex(along, 980), 0); // about to turn
  assert.equal(currentStepIndex(along, 1100), 1); // turned onto East Street
  assert.equal(currentStepIndex(along, 2000), 2); // arrived
});

test("nearest step start is not the current step", () => {
  // 700 m along Test Road, the turn at B is nearer than the start A, but we're still on Test Road
  const along = stepsAlongM(ROUTE, CUM, STEPS);
  const p = offset(A, 0, 700);
  assert.ok(distanceM(p, B) < distanceM(p, A));
  assert.equal(currentStepIndex(along, projectOnRoute(ROUTE, CUM, p).alongM), 0);
});

test("off route only after a few seconds more than 30 m away", () => {
  let s = updateOffRoute(ON_ROUTE, 50, 0);
  assert.equal(s.offRoute, false); // just went off: could be GPS jitter
  s = updateOffRoute(s, 55, 2000);
  assert.equal(s.offRoute, false);
  s = updateOffRoute(s, 60, 4500);
  assert.equal(s.offRoute, true);
  assert.deepEqual(updateOffRoute(s, 10, 5000), ON_ROUTE); // back on the route resets
});

test("poor GPS accuracy raises the off-route limit", () => {
  let s = updateOffRoute(ON_ROUTE, 45, 0, { accuracyM: 50 });
  s = updateOffRoute(s, 45, 10000, { accuracyM: 50 });
  assert.equal(s.offRoute, false);
});

test("moving points: bearing, offset and point along the route", async () => {
  const { bearingDeg, offsetPoint, pointAlong } = await import("./nav.ts");
  near(bearingDeg(A, B), 0, 0.5);
  near(bearingDeg(B, C), 90, 0.5);
  near(distanceM(A, offsetPoint(A, 45, 250)), 250, 0.5);
  near(distanceM(pointAlong(ROUTE, CUM, 1500), offset(B, 90, 500)), 0, 2);
  assert.deepEqual(pointAlong(ROUTE, CUM, -5), A);
  assert.deepEqual(pointAlong(ROUTE, CUM, 99999), C);
});
