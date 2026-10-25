// Unit tests for lib/theme.ts. Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { autoTheme, pickTheme, toggleOverride } from "./theme.ts";

test("planning follows the phone", () => {
  assert.equal(autoTheme(false, false), "light");
  assert.equal(autoTheme(true, false), "dark");
});

test("navigation is always dark", () => {
  assert.equal(autoTheme(false, true), "dark");
  assert.equal(pickTheme(null, false, true), "dark");
});

test("a manual choice wins", () => {
  assert.equal(pickTheme("light", true, true), "light");
  assert.equal(pickTheme("dark", false, false), "dark");
});

test("toggling back to the automatic theme clears the override", () => {
  // light phone, planning: toggle to dark, then back to light (= follow the phone again)
  assert.equal(toggleOverride("light", "light"), "dark");
  assert.equal(toggleOverride("dark", "light"), null);
  // navigating (auto = dark): toggle to light keeps an override
  assert.equal(toggleOverride("dark", "dark"), "light");
});
