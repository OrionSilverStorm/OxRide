// Unit tests for lib/rideBuffer.ts. Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { PointBuffer } from "./rideBuffer.ts";

const pt = (s: number) => ({ t: s * 1000, lat: 51.75 + s / 10000, lon: -1.25, acc: 8 });

test("first batch waits for two points", () => {
  const b = new PointBuffer();
  b.push(pt(0));
  assert.equal(b.takeBatch(), null);
  b.push(pt(5));
  assert.deepEqual(b.takeBatch(), [pt(0), pt(5)]);
});

test("later batches start with the last point already sent", () => {
  const b = new PointBuffer();
  b.push(pt(0));
  b.push(pt(5));
  b.takeBatch();
  b.push(pt(10));
  b.push(pt(15));
  assert.deepEqual(b.takeBatch(), [pt(5), pt(10), pt(15)]);
  assert.equal(b.takeBatch(), null); // nothing new
});

test("readings less than a second apart are skipped", () => {
  const b = new PointBuffer();
  b.push(pt(0));
  b.push({ ...pt(0), t: 500 });
  b.push(pt(2));
  assert.deepEqual(b.takeBatch(), [pt(0), pt(2)]);
});

test("a failed send loses nothing", () => {
  const b = new PointBuffer();
  b.push(pt(0));
  b.push(pt(5));
  b.takeBatch(); // sent fine
  b.push(pt(10));
  const failed = b.takeBatch()!;
  b.giveBack(failed);
  b.push(pt(15));
  assert.deepEqual(b.takeBatch(), [pt(5), pt(10), pt(15)]);
});

test("a failed first batch is retried whole", () => {
  const b = new PointBuffer();
  b.push(pt(0));
  b.push(pt(5));
  const failed = b.takeBatch()!;
  b.giveBack(failed);
  assert.deepEqual(b.takeBatch(), [pt(0), pt(5)]);
});
