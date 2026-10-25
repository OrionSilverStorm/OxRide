// Unit tests for lib/wav.ts and lib/voiceLog.ts formatting. Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeWav, peakLevel, toBase64, toMono } from "./wav.ts";
import { formatLog } from "./voiceLog.ts";

test("WAV header and samples", () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 0.5]), 16000);
  const v = new DataView(wav.buffer);
  const text = (at: number, n: number) =>
    String.fromCharCode(...wav.subarray(at, at + n));
  assert.equal(wav.length, 44 + 4 * 2);
  assert.equal(text(0, 4), "RIFF");
  assert.equal(text(8, 4), "WAVE");
  assert.equal(v.getUint16(22, true), 1); // mono
  assert.equal(v.getUint32(24, true), 16000); // sample rate
  assert.equal(v.getUint32(40, true), 8); // data bytes
  assert.equal(v.getInt16(44, true), 0);
  assert.equal(v.getInt16(46, true), 32767);
  assert.equal(v.getInt16(48, true), -32768);
});

test("stereo is averaged to mono; peak finds silence", () => {
  const mono = toMono([new Float32Array([1, 0]), new Float32Array([0, 0])]);
  assert.deepEqual([...mono], [0.5, 0]);
  assert.equal(peakLevel(new Float32Array([0, -0.25, 0.1])), 0.25);
  assert.equal(peakLevel(new Float32Array(10)), 0);
});

test("base64", () => {
  assert.equal(toBase64(new Uint8Array([79, 120, 82])), "T3hS"); // "OxR"
});

test("log lines show the time and the gap since the line before", () => {
  const t0 = new Date(2026, 9, 25, 10, 42, 7, 250).getTime();
  const out = formatLog([
    { t: t0, msg: "press" },
    { t: t0 + 1200, msg: "heard: take me to univ" },
  ]);
  assert.equal(
    out,
    "10:42:07.250  +0.0s  press\n10:42:08.450  +1.2s  heard: take me to univ",
  );
});
