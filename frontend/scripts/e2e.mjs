// End-to-end check in a real (headless) browser: plan a demo trip, switch day/night,
// start a simulated ride, take a wrong turn and check it reroutes.
//
//   npm run dev            (in another terminal)
//   npm run e2e            BASE=https://oxride.vercel.app npm run e2e   to test the live site
//
// Needs Chrome or Chromium (set CHROME=/path/to/chrome if it isn't found).
// Uses the DevTools protocol over Node's built-in WebSocket: no extra packages.
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BASE = process.env.BASE ?? "http://localhost:3000";
const SHOTS = process.env.SHOTS; // folder for screenshots (optional)
const PORT = 9300 + Math.floor(Math.random() * 500);

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const names = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];
  for (const n of names) {
    try {
      return execSync(`command -v ${n}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {}
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const win = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  return process.platform === "darwin" ? mac : win;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  findChrome(),
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${mkdtempSync(path.join(tmpdir(), "oxride-e2e-"))}`,
    "--window-size=400,860",
    "--no-first-run",
    "--no-sandbox",
    "--autoplay-policy=no-user-gesture-required",
    "about:blank",
  ],
  { stdio: "ignore" },
);

let ws;
let nextId = 1;
const pending = new Map();
const consoleErrors = [];

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = targets.find((t) => t.type === "page");
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => {
          ws.onopen = r;
          ws.onerror = j;
        });
        ws.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
          } else if (msg.method === "Runtime.exceptionThrown") {
            consoleErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
          } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
            consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
          }
        };
        return;
      }
    } catch {}
    await sleep(200);
  }
  throw new Error("Could not start Chrome");
}

async function evaluate(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate failed");
  return r.result.value;
}

/** Wait until `expr` is truthy in the page. */
async function waitFor(expr, what, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await evaluate(`Boolean(${expr})`).catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

const text = () => evaluate("document.body.innerText");
const click = (label) =>
  evaluate(`(() => {
    const el = [...document.querySelectorAll("button, a")].find((b) => b.innerText.trim().startsWith(${JSON.stringify(label)}));
    if (!el) throw new Error("no button " + ${JSON.stringify(label)});
    el.click();
    return true;
  })()`);

async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(["✓", name]);
  } catch (e) {
    results.push(["✗", `${name}: ${e.message}`]);
    await shot(`FAILED-${name.replace(/\W+/g, "-")}`).catch(() => {});
  }
}

try {
  await connect();
  await send("Runtime.enable");
  await send("Page.enable");
  // No real GPS in a headless browser: deny it so the app uses demo/map start points
  await send("Browser.grantPermissions", { permissions: [] }).catch(() => {});

  await check("planning screen loads", async () => {
    await send("Page.navigate", { url: `${BASE}/` });
    await waitFor(`document.querySelector(".leaflet-container")`, "map");
    await waitFor(`[...document.querySelectorAll("button")].some(b => b.innerText.includes("Osney"))`, "demo buttons");
  });

  let dayText = "";
  await check("demo trip draws a route with stats", async () => {
    await click("Osney");
    await waitFor(`document.body.innerText.includes("Start ride")`, "route panel");
    await waitFor(`document.querySelectorAll("path.leaflet-interactive").length > 0`, "route line");
    dayText = await text();
    if (!/\d+ min/.test(dayText)) throw new Error("no ETA shown");
    if (!/cycle paths/.test(dayText) || !/lit/.test(dayText)) throw new Error("no cycle path / lit share");
    if (!/Suffer score/.test(dayText)) throw new Error("no suffer score");
    await shot("1-day-route");
  });

  await check("night route is better lit than the day route", async () => {
    const lit = (t) => Number((t.match(/(\d+)% lit/) ?? [])[1]);
    await click("Noon"); // not "Now": now might already be dark
    await waitFor(`document.body.innerText.includes("Noon (")`, "noon label");
    await waitFor(`!document.body.innerText.includes("Finding route")`, "noon route");
    await sleep(500);
    const day = lit(await text());
    await click("Night");
    await waitFor(`document.body.innerText.includes("Night (")`, "night label");
    await waitFor(`!document.body.innerText.includes("Finding route")`, "night route");
    await sleep(500);
    const night = lit(await text());
    if (!(night > day)) throw new Error(`lit share day ${day}% vs night ${night}%`);
    await shot("2-night-route");
    await click("Now");
    await waitFor(`document.body.innerText.includes("Leaving now")`, "back to now");
    await waitFor(
      `[...document.querySelectorAll("button")].some(b => b.innerText === "Start ride" && !b.disabled)`,
      "route ready",
    );
  });

  await check("start ride opens navigation with a next-turn banner", async () => {
    await click("Start ride");
    await waitFor(`location.pathname === "/navigate"`, "navigate page");
    await waitFor(`document.body.innerText.includes("Take a wrong turn")`, "navigation controls");
    await waitFor(`/\\d+ m|\\d\\.\\d km/.test(document.body.innerText)`, "distance to next turn");
    await shot("3-navigating");
  });

  const nav = (attr) => evaluate(`Number(document.querySelector("main").dataset.${attr})`);

  await check("simulated rider moves along the route", async () => {
    const a = await nav("remainingM");
    await sleep(3000);
    const b = await nav("remainingM");
    if (!(b < a - 5)) throw new Error(`distance left didn't go down (${a} m -> ${b} m)`);
  });

  await check("wrong turn triggers a reroute", async () => {
    const before = await nav("reroutes");
    await click("Take a wrong turn");
    // the rider drifts away; after >30 m for a few seconds the app plans a new route
    await waitFor(`Number(document.querySelector("main").dataset.distanceToRoute) > 30`, "rider leaving the route", 20000);
    await waitFor(`Number(document.querySelector("main").dataset.reroutes) > ${before}`, "a new route", 25000);
    await waitFor(`document.querySelector("main").dataset.offRoute === "false"`, "back on the new route", 10000);
    await shot("4-rerouted");
  });

  await check("no errors in the browser console", async () => {
    const real = consoleErrors.filter((e) => !/geolocation|Permission|wakeLock|play\(\)|NotAllowedError/i.test(e));
    if (real.length) throw new Error(real.slice(0, 3).join(" | "));
  });
} catch (e) {
  results.push(["✗", e.message]);
} finally {
  ws?.close();
  chrome.kill();
}

for (const [mark, name] of results) console.log(`${mark} ${name}`);
const failed = results.filter(([m]) => m === "✗").length;
console.log(failed ? `\n${failed} failed` : `\nAll ${results.length} checks passed (${BASE})`);
process.exit(failed ? 1 : 0);
