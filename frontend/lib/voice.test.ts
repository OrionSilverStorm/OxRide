// Unit tests for lib/voice.ts. Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWake } from "./voice.ts";

test("wake word with a command", () => {
  assert.deepEqual(parseWake("Hey OxRide take me to the station"), { heard: true, command: "take me to the station" });
  assert.deepEqual(parseWake("hey ox ride, quieter please"), { heard: true, command: "quieter please" });
  assert.deepEqual(parseWake("okay Ox Right how long left?"), { heard: true, command: "how long left?" });
  assert.deepEqual(parseWake("OxRide: chill ride to the Bodleian"), { heard: true, command: "chill ride to the Bodleian" });
});

test("wake word alone waits for the next sentence", () => {
  assert.deepEqual(parseWake("hey oxride"), { heard: true, command: "" });
  assert.deepEqual(parseWake("Hey Ox-Ride."), { heard: true, command: "" });
});

test("normal talk is ignored", () => {
  assert.equal(parseWake("take me home").heard, false);
  assert.equal(parseWake("we rode to Oxford station").heard, false);
  assert.equal(parseWake("the box rides on the rack").heard, false);
});
