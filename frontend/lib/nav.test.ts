// Unit tests for lib/nav.ts. Run: node --test lib/   (Node 23+ runs TypeScript directly)
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  announcement,
  bearingDeg,
  cumulativeM,
  departureHint,
  distanceM,
  formatDistance,
  nextAt,
  nextStepIndex,
  offsetPoint,
  ON_ROUTE,
  pointAlong,
  projectOnRoute,
  stepsAlongM,
  sufferScore,
  updateOffRoute,
} from "./nav.ts";
import type { LatLon, Slot, Step } from "./api.ts";

// An L-shaped route: 1 km north, then 1 km east (roughly), in Oxford.
const A: LatLon = [51.75, -1.26];
const B = offsetPoint(A, 0, 1000);
const C = offsetPoint(B, 90, 1000);
const ROUTE: LatLon[] = [A, B, C];
const CUM = cumulativeM(ROUTE);

const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (±${tol})`);

test("distance and bearing", () => {
  near(distanceM(A, B), 1000, 1);
  near(bearingDeg(A, B), 0, 0.5);
  near(bearingDeg(B, C), 90, 0.5);
  near(CUM[2], 2000, 2);
});

test("projecting the rider onto the route", () => {
  const onRoute = projectOnRoute(ROUTE, CUM, pointAlong(ROUTE, CUM, 500));
  near(onRoute.distanceToRoute, 0, 1);
  near(onRoute.alongM, 500, 2);
  const beside = projectOnRoute(ROUTE, CUM, offsetPoint(pointAlong(ROUTE, CUM, 1500), 0, 50));
  near(beside.distanceToRoute, 50, 2);
  near(beside.alongM, 1500, 3);
});

test("pointAlong clamps to the ends", () => {
  assert.deepEqual(pointAlong(ROUTE, CUM, -10), A);
  assert.deepEqual(pointAlong(ROUTE, CUM, 99999), C);
});

const STEPS: Step[] = [
  { text: "Head north on Test Road", distance_m: 1000, lat: A[0], lon: A[1], maneuver: "straight" },
  { text: "Turn right onto East Street", distance_m: 1000, lat: B[0], lon: B[1], maneuver: "right" },
  { text: "You have arrived", distance_m: 0, lat: C[0], lon: C[1], maneuver: "arrive" },
];

test("next step follows the rider", () => {
  const along = stepsAlongM(ROUTE, CUM, STEPS);
  near(along[1], 1000, 2);
  assert.equal(nextStepIndex(along, 0), 1);
  assert.equal(nextStepIndex(along, 990), 1);
  assert.equal(nextStepIndex(along, 1100), 2);
  assert.equal(nextStepIndex(along, 2000), 2);
});

test("off route only after a few seconds more than 30 m away", () => {
  let s = updateOffRoute(ON_ROUTE, 50, 0);
  assert.equal(s.offRoute, false); // just went off: could be GPS jitter
  s = updateOffRoute(s, 55, 2000);
  assert.equal(s.offRoute, false);
  s = updateOffRoute(s, 60, 4500);
  assert.equal(s.offRoute, true);
  s = updateOffRoute(s, 10, 5000);
  assert.deepEqual(s, ON_ROUTE); // back on the route resets
});

test("poor GPS accuracy raises the off-route limit", () => {
  let s = updateOffRoute(ON_ROUTE, 45, 0, { accuracyM: 50 });
  s = updateOffRoute(s, 45, 10000, { accuracyM: 50 });
  assert.equal(s.offRoute, false);
});

test("announcements: early warning once, then at the turn", () => {
  const said = new Set<string>();
  const first = announcement(1, STEPS[1], 210, said);
  assert.equal(first?.text, "In 200 metres, turn right onto East Street");
  said.add(first!.key);
  assert.equal(announcement(1, STEPS[1], 180, said), null); // not again
  const atTurn = announcement(1, STEPS[1], 30, said);
  assert.equal(atTurn?.text, "Turn right onto East Street");
  said.add(atTurn!.key);
  assert.equal(announcement(1, STEPS[1], 10, said), null);
  assert.equal(announcement(2, STEPS[2], 20, said)?.text, "You have arrived.");
  assert.equal(announcement(1, STEPS[1], 600, new Set()), null); // too far to bother
});

test("formatDistance", () => {
  assert.equal(formatDistance(4), "10 m");
  assert.equal(formatDistance(184), "180 m");
  assert.equal(formatDistance(1260), "1.3 km");
});

const slot = (minutes: number, eta: number, rain: number, extra: Partial<Slot> = {}): Slot => {
  const t = new Date(Date.UTC(2026, 9, 24, 12, minutes));
  return {
    depart_utc: t.toISOString(),
    depart_local: t.toISOString().replace("Z", "+01:00"),
    eta_min: eta,
    rain_prob: rain,
    wind_ms: 3,
    dark: false,
    best: false,
    ...extra,
  };
};
const NOW = Date.UTC(2026, 9, 24, 12, 0);

test("departure hint when a later slot is clearly better", () => {
  const slots = [slot(0, 14, 0.8), slot(15, 13, 0.5), slot(30, 12, 0.05, { best: true })];
  assert.equal(departureHint(slots, NOW), "Leave in 30 min: the rain should have stopped and 2 min faster.");
});

test("no departure hint when leaving now is best or the gain is tiny", () => {
  assert.equal(departureHint([slot(0, 12, 0, { best: true }), slot(15, 12, 0)], NOW), null);
  assert.equal(departureHint([slot(0, 12.3, 0.1), slot(15, 12, 0.05, { best: true })], NOW), null);
  assert.equal(departureHint([], NOW), null);
});

test("suffer score grows with climbing", () => {
  const flat = sufferScore(ROUTE, [60, 60, 60]);
  assert.equal(flat.score, 0);
  assert.equal(flat.mood, 0);
  const hill = sufferScore(ROUTE, [60, 120, 125]); // 65 m, but spread over 1 km: not steep
  assert.ok(hill.score > flat.score);
  const steep = sufferScore([A, offsetPoint(A, 0, 300)], [60, 90]); // 10% climb
  assert.ok(steep.score > sufferScore([A, offsetPoint(A, 0, 3000)], [60, 90]).score);
  assert.equal(sufferScore(ROUTE, [100, 400, 700]).mood, 4);
});

test("nextAt picks today or tomorrow", () => {
  const morning = new Date(2026, 9, 24, 9, 30);
  assert.equal(nextAt(22, morning), "2026-10-24T22:00");
  const lateNight = new Date(2026, 9, 24, 23, 0);
  assert.equal(nextAt(22, lateNight), "2026-10-25T22:00");
});

test("elevation noise on a flat route doesn't anger the dragon", () => {
  // 2 km flat with ±1.5 m jitter every 10 m (like the real elevation data)
  const pts: LatLon[] = [];
  const ele: number[] = [];
  for (let i = 0; i <= 200; i++) {
    pts.push(offsetPoint(A, 90, i * 10));
    ele.push(60 + (i % 2 ? 1.5 : -1.5));
  }
  const s = sufferScore(pts, ele);
  assert.ok(s.score < 10, `score ${s.score}`);
  assert.equal(s.mood, 0);
});
