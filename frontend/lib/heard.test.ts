// Unit tests for lib/heard.ts. Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { heardText, readyToSend, type Heard } from "./heard.ts";

test("hold-to-talk joins everything heard, finished or not", () => {
  const r: Heard[] = [
    { text: "take me to", final: true },
    { text: " the Bodleian ", final: false },
  ];
  assert.equal(heardText(r), "take me to the Bodleian");
  assert.equal(heardText([]), "");
});

test("Chrome: each finished sentence is sent once", () => {
  const sent = new Map<number, string>();
  assert.deepEqual(
    readyToSend([{ text: "quieter please", final: false }], sent, false),
    [],
  );
  assert.deepEqual(
    readyToSend([{ text: "quieter please", final: true }], sent, false),
    ["quieter please"],
  );
  // the same results come again with the next event: not sent twice
  const two: Heard[] = [
    { text: "quieter please", final: true },
    { text: "how long left", final: true },
  ];
  assert.deepEqual(readyToSend(two, sent, false), ["how long left"]);
  assert.deepEqual(readyToSend(two, sent, true), []);
});

test("iPhone: unfinished text is sent after a pause, then only the new part", () => {
  const sent = new Map<number, string>();
  // never marked finished: nothing until the pause
  assert.deepEqual(
    readyToSend([{ text: "take me to univ", final: false }], sent, false),
    [],
  );
  assert.deepEqual(
    readyToSend([{ text: "take me to univ", final: false }], sent, true),
    ["take me to univ"],
  );
  // the next sentence is added onto the same result
  const grown: Heard[] = [
    { text: "take me to univ faster please", final: false },
  ];
  assert.deepEqual(readyToSend(grown, sent, true), ["faster please"]);
  // it is finally marked finished: nothing new to send
  assert.deepEqual(
    readyToSend(
      [{ text: "take me to univ faster please", final: true }],
      sent,
      false,
    ),
    [],
  );
});

test("rewritten words that were already sent are not sent again", () => {
  const sent = new Map<number, string>([[0, "take me to you knee"]]);
  assert.deepEqual(
    readyToSend([{ text: "take me to Univ", final: true }], sent, true),
    [],
  );
});
