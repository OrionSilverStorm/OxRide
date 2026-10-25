"use client";

// Routing debug panel (/debug). Shows what A* was given, what it explored, why it
// picked each road, and how our route compares with the shortest route, Google's
// cycling route and a route you draw. Profile numbers can be tuned live.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  debugRoute,
  getDebugProfiles,
  getRideAccuracy,
  getRideStatsLive,
  getServices,
  getStreetSpeeds,
  getTroubleSpots,
  testService,
  type RideAccuracy,
  type RideResultTimes,
  type RideStatsLive,
  type StreetSpeed,
  type TroubleSpot,
  type ServiceName,
  type ServiceTest,
  type DebugCtx,
  type DebugProfiles,
  type DebugRoute,
  type DebugRouteId,
  type DebugRouteResult,
  type DebugSummary,
  type LatLon,
  type Profile,
  type ProfileParams,
  type Step,
} from "@/lib/api";
import {
  bearingDeg,
  cumulativeM,
  distanceM,
  currentStepIndex,
  offsetPoint,
  ON_ROUTE,
  pointAlong,
  projectOnRoute,
  stepsAlongM,
  updateOffRoute,
  type OffRouteState,
} from "@/lib/nav";
import { CartesianGrid, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";
import { useRideLog } from "@/hooks/useRideLog";
import DebugMap, { ROUTE_COLORS, costColor, highwayColor, type ColorBy } from "./DebugMap";

type ClickMode = "start" | "end" | "waypoint" | "none";
type Tri = "auto" | "on" | "off";

interface CtxForm {
  dark: Tri;
  rush: Tri;
  wind_ms: string;
  wind_from_deg: string;
  rain_mm: string;
}

const EMPTY_CTX: CtxForm = { dark: "auto", rush: "auto", wind_ms: "", wind_from_deg: "", rain_mm: "" };

// Radcliffe Camera -> Iffley Road: a trip with a real choice between main roads and back streets.
const DEMO_START: LatLon = [51.7534, -1.2540];
const DEMO_END: LatLon = [51.7407, -1.2310];

function ctxOverride(f: CtxForm): DebugCtx | null {
  const o: DebugCtx = {};
  if (f.dark !== "auto") o.dark = f.dark === "on";
  if (f.rush !== "auto") o.rush = f.rush === "on";
  for (const k of ["wind_ms", "wind_from_deg", "rain_mm"] as const) {
    if (f[k] !== "" && !Number.isNaN(Number(f[k]))) o[k] = Number(f[k]);
  }
  return Object.keys(o).length ? o : null;
}

// --- One-click scenarios and extreme demo trips --------------------------------------

type Scenario = "live" | "day" | "night" | "rush" | "rain" | "headwind" | "tailwind" | "custom";

const SCENARIO_LABEL: [Scenario, string][] = [
  ["live", "Live"], ["day", "Day"], ["night", "Night"], ["rush", "Rush hour"],
  ["rain", "Rain"], ["headwind", "Headwind"], ["tailwind", "Tailwind"],
];

const CALM: CtxForm = { dark: "off", rush: "off", wind_ms: "0", wind_from_deg: "0", rain_mm: "0" };

// The context for a scenario. Wind blows along the trip (A -> B), 8 m/s.
function scenarioForm(s: Scenario, start: LatLon | null, end: LatLon | null): CtxForm {
  const along = start && end ? Math.round(bearingDeg(start, end)) : 0;
  switch (s) {
    case "live": return EMPTY_CTX;
    case "night": return { ...CALM, dark: "on" };
    case "rush": return { ...CALM, rush: "on" };
    case "rain": return { ...CALM, rain_mm: "2" };
    case "headwind": return { ...CALM, wind_ms: "8", wind_from_deg: String(along) }; // wind comes from B
    case "tailwind": return { ...CALM, wind_ms: "8", wind_from_deg: String((along + 180) % 360) };
    default: return CALM;
  }
}

// Trips where each scenario changes the route the most (found with backend/benchmark.py-style search).
const DEMO_TRIPS: { label: string; start: LatLon; end: LatLon; scenario: Scenario; profile?: Profile; note: string }[] = [
  { label: "Night: Iffley Rd → Osney", start: [51.747, -1.24], end: [51.751, -1.278], scenario: "night",
    note: "lit share 36% by day → 96% at night, and shorter" },
  { label: "Rush hour: Iffley Rd → Westgate", start: [51.747, -1.24], end: [51.75, -1.26], scenario: "rush",
    note: "main roads 24% → 0% (a long detour)" },
  { label: "Ride type: Osney → Summertown", start: [51.751, -1.278], end: [51.7768, -1.2643], scenario: "day", profile: "chill",
    note: "chill 10% main roads vs 86% on the shortest route" },
  { label: "Rain: Radcliffe Cam → Wolvercote", start: [51.7534, -1.254], end: [51.78, -1.285], scenario: "rain",
    note: "small: rain only makes gravel less attractive" },
  { label: "Wind: Osney → Templars Sq", start: [51.751, -1.278], end: [51.7345, -1.21], scenario: "headwind",
    note: "route stays the same; only the ETA moves (TU Delft data)" },
];

// --- Simulated ride ---------------------------------------------------------------------

const TICK_MS = 250;
const RIDE_SPEED = 6.7; // m/s, 15 mph
const DETOUR_M = 120; // how far the wrong turn goes

interface Ride {
  line: LatLon[] | null; // the route this progress belongs to
  along: number;
  detour: { from: LatLon; bearing: number; gone: number } | null;
  off: OffRouteState;
}

const freshRide = (line: LatLon[] | null): Ride => ({ line, along: 0, detour: null, off: ON_ROUTE });

/** A dot riding `line`. wrongTurn() leaves the route; onOffRoute fires after the usual few seconds. */
function useDebugRide(line: LatLon[] | null, running: boolean, speedUp: number, onOffRoute: (p: LatLon) => void) {
  const cum = useMemo(() => (line ? cumulativeM(line) : []), [line]);
  const total = cum.at(-1) ?? 0;
  const [state, setState] = useState<Ride>(() => freshRide(line));
  const ride = state.line === line ? state : freshRide(line); // a new route starts from its beginning
  const offRef = useRef(onOffRoute);
  useEffect(() => {
    offRef.current = onOffRoute;
  });

  const position = useMemo<LatLon | null>(() => {
    if (!line || !line.length) return null;
    const d = ride.detour;
    return d ? offsetPoint(d.from, d.bearing, d.gone) : pointAlong(line, cum, ride.along);
  }, [line, cum, ride.along, ride.detour]);

  useEffect(() => {
    if (!running || !line || line.length < 2) return;
    const id = setInterval(() => {
      const step = RIDE_SPEED * speedUp * (TICK_MS / 1000);
      setState((s) => {
        const r = s.line === line ? s : freshRide(line);
        if (r.detour) {
          const detour = { ...r.detour, gone: Math.min(DETOUR_M, r.detour.gone + RIDE_SPEED * (TICK_MS / 1000)) };
          const here = offsetPoint(detour.from, detour.bearing, detour.gone);
          const off = updateOffRoute(r.off, projectOnRoute(line, cum, here).distanceToRoute, Date.now());
          return { ...r, detour, off };
        }
        return { ...r, along: Math.min(total, r.along + step) };
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [running, line, cum, total, speedUp]);

  const wrongTurn = useCallback(() => {
    if (!line || line.length < 2) return;
    setState((s) => {
      const r = s.line === line ? s : freshRide(line);
      if (r.detour) return r;
      const here = pointAlong(line, cum, r.along);
      const seg = projectOnRoute(line, cum, here).segment;
      const heading = bearingDeg(line[seg], line[Math.min(seg + 1, line.length - 1)]);
      // turn whichever way leads furthest from every part of the route
      const away = (b: number) => projectOnRoute(line, cum, offsetPoint(here, b, DETOUR_M)).distanceToRoute;
      const bearing = [90, 270, 45, 315].map((t) => (heading + t) % 360).reduce((a, b) => (away(b) > away(a) ? b : a));
      return { ...r, detour: { from: here, bearing, gone: 0 } };
    });
  }, [line, cum]);

  // tell the panel once when the rider becomes off route
  const offRoute = ride.off.offRoute;
  useEffect(() => {
    if (offRoute && position) offRef.current(position);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offRoute]);

  const reset = useCallback(() => setState(freshRide(line)), [line]);
  return { position, along: ride.along, total, cum, offRoute: ride.off.offRoute, detouring: !!ride.detour, wrongTurn, reset };
}

function RideStatus({ line, cum, steps, along, total, etaMin }: {
  line: LatLon[]; cum: number[]; steps: Step[]; along: number; total: number; etaMin: number | null;
}) {
  const stepAlong = useMemo(() => stepsAlongM(line, cum, steps), [line, cum, steps]);
  const i = currentStepIndex(stepAlong, along);
  const left = Math.max(0, total - along);
  return (
    <div className="rounded bg-neutral-900 p-2 text-white">
      <div className="font-semibold">{steps[i]?.text ?? "—"}</div>
      <div className="text-xs opacity-80">then {steps[i + 1]?.text ?? "arrive"}</div>
      <div className="mt-1 text-xs opacity-80">
        {(left / 1000).toFixed(2)} km left{etaMin != null && total ? ` · ${Math.max(0, Math.round((etaMin * left) / total))} min` : ""}
      </div>
    </div>
  );
}

// Paste-ready Python for routing.PROFILES.
function toPython(name: string, p: ProfileParams) {
  const dict = (d: Record<string, number>) =>
    "{" + Object.entries(d).map(([k, v]) => `"${k}": ${v}`).join(", ") + "}";
  return `    "${name}": {\n        "road_type_factors": ${dict(p.road_type_factors)},\n        "surface_factors": ${dict(p.surface_factors)},\n        "hill_weight": ${p.hill_weight},\n    },`;
}

// --- Comparison table ----------------------------------------------------------

const pct = (v: number) => `${Math.round(v * 100)}%`;

const METRICS: { key: keyof DebugSummary; label: string; fmt: (v: number) => string; better: "low" | "high"; hint: string }[] = [
  { key: "distance_m", label: "Distance", fmt: (v) => `${(v / 1000).toFixed(2)} km`, better: "low", hint: "Total length" },
  { key: "eta_min", label: "Est. time", fmt: (v) => `${v} min`, better: "low", hint: "time_model.eta_minutes with this context" },
  { key: "climb_m", label: "Climb", fmt: (v) => `${v} m`, better: "low", hint: "Sum of uphill elevation" },
  { key: "max_grade_pct", label: "Steepest", fmt: (v) => `${v}%`, better: "low", hint: "Steepest single road" },
  { key: "cycleway_share", label: "On cycleways", fmt: pct, better: "high", hint: "Share of distance on highway=cycleway" },
  { key: "main_road_share", label: "On main roads", fmt: pct, better: "low", hint: "trunk / primary / secondary" },
  { key: "lit_share", label: "Lit", fmt: pct, better: "high", hint: "Share of distance on lit roads" },
  { key: "rough_surface_share", label: "Rough surface", fmt: pct, better: "low", hint: "gravel or cobbles" },
  { key: "turns", label: "Turns", fmt: String, better: "low", hint: "Bearing changes over 45°" },
  { key: "cost", label: "Our cost", fmt: (v) => v.toLocaleString(), better: "low", hint: "Sum of routing.edge_cost. OxRide should always be lowest." },
];

function Comparison({ routes }: { routes: DebugRoute[] }) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr>
          <th />
          {routes.map((r) => (
            <th key={r.id} className="px-1 text-right font-semibold" style={{ color: ROUTE_COLORS[r.id] }}>
              {r.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {METRICS.map((m) => {
          const vals = routes.map((r) => r.summary[m.key] as number | null);
          const nums = vals.filter((v): v is number => v != null);
          const best = m.better === "low" ? Math.min(...nums) : Math.max(...nums);
          return (
            <tr key={m.key} className="border-t border-neutral-100" title={m.hint}>
              <td className="py-0.5 pr-2 text-neutral-500">{m.label}</td>
              {vals.map((v, i) => (
                <td
                  key={i}
                  className={`px-1 text-right tabular-nums ${v === best && nums.some((n) => n !== best) ? "font-bold text-green-700" : ""}`}
                >
                  {v == null ? "–" : m.fmt(v)}
                </td>
              ))}
            </tr>
          );
        })}
        {routes.some((r) => r.google) && (
          <tr className="border-t border-neutral-100" title="What Google itself says">
            <td className="py-0.5 pr-2 text-neutral-500">Google says</td>
            {routes.map((r) => (
              <td key={r.id} className="px-1 text-right tabular-nums">
                {r.google ? `${((r.google.distance_m ?? 0) / 1000).toFixed(2)} km, ${r.google.duration_min} min` : ""}
              </td>
            ))}
          </tr>
        )}
        <tr className="border-t border-neutral-100" title="Junctions A* expanded before reaching the goal">
          <td className="py-0.5 pr-2 text-neutral-500">A* expanded</td>
          {routes.map((r) => (
            <td key={r.id} className="px-1 text-right tabular-nums">
              {r.astar ? `${r.astar.expanded_count} (${r.astar.ms} ms)` : ""}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

// --- Small UI bits -------------------------------------------------------------

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="border-b border-neutral-200 px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded border border-neutral-300 text-xs">
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`px-2 py-1 ${value === v ? "bg-neutral-900 text-white" : "bg-white hover:bg-neutral-100"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// --- Services: are the API keys set up on this server? ------------------------------

const SERVICE_LABELS: Record<ServiceName, string> = {
  gemini: "Gemini",
  elevenlabs: "ElevenLabs",
  database: "Tiger Data",
  google_maps: "Google Maps (optional)",
};

function ServicesBox() {
  const [vars, setVars] = useState<Record<ServiceName, Record<string, boolean>> | null>(null);
  const [results, setResults] = useState<Partial<Record<ServiceName, ServiceTest | "running">>>({});

  useEffect(() => {
    getServices().then(setVars).catch(() => setVars(null));
  }, []);

  const run = async (name: ServiceName) => {
    setResults((r) => ({ ...r, [name]: "running" }));
    try {
      const res = await testService(name);
      setResults((r) => ({ ...r, [name]: res }));
      if (res.audio) new Audio(`data:audio/mpeg;base64,${res.audio}`).play().catch(() => {});
    } catch (e) {
      setResults((r) => ({ ...r, [name]: { ok: false, message: (e as Error).message } }));
    }
  };

  if (!vars) return <p className="text-xs text-neutral-500">Can&apos;t read the server&apos;s settings.</p>;

  return (
    <div className="space-y-2 text-xs">
      {(Object.keys(vars) as ServiceName[]).map((name) => {
        const res = results[name];
        return (
          <div key={name} className="rounded border border-neutral-200 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{SERVICE_LABELS[name]}</span>
              <button
                onClick={() => run(name)}
                disabled={res === "running"}
                className="rounded border border-neutral-300 px-2 py-0.5 hover:bg-neutral-100 disabled:opacity-50"
              >
                {res === "running" ? "testing…" : "Test"}
              </button>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 text-neutral-600">
              {Object.entries(vars[name]).map(([v, set]) => (
                <span key={v} className={set ? "text-green-700" : "text-neutral-400"}>
                  {set ? "✓" : "✗"} {v}
                </span>
              ))}
            </div>
            {res && res !== "running" && (
              <div className={`mt-1 ${res.ok ? "text-green-700" : "text-red-700"}`}>
                {res.ok ? "Works: " : "Problem: "}
                {res.message}
                {res.ms != null && <span className="text-neutral-400"> ({res.ms} ms)</span>}
                {res.models && (
                  <ul className="mt-1 list-disc pl-4 text-neutral-700">
                    {res.models.map((m) => <li key={m} className="font-mono">{m}</li>)}
                  </ul>
                )}
              </div>
            )}
          </div>
        );
      })}
      <p className="text-neutral-500">
        Keys are set in Vercel (Settings → Environment Variables) or backend/.env locally. Values are never shown.
        After changing them on Vercel, redeploy.
      </p>
    </div>
  );
}


// --- Tiger Data: what the ride log has learned ------------------------------------------

type Loaded<T> = T | string | null; // data, an error message, or not loaded yet

const unwrap = <T,>(r: { ok: true; data: T } | { ok: false; message: string }): T | string => (r.ok ? r.data : r.message);

function TigerDataBox({ onSpeeds, onTrouble }: {
  onSpeeds: (s: StreetSpeed[] | undefined) => void;
  onTrouble: (t: TroubleSpot[] | undefined) => void;
}) {
  const [withSim, setWithSim] = useState(false);
  const [hour, setHour] = useState<number | null>(null);
  const [showSpeeds, setShowSpeeds] = useState(false);
  const [showTrouble, setShowTrouble] = useState(false);
  const [live, setLive] = useState<Loaded<RideStatsLive>>(null);
  const [speeds, setSpeeds] = useState<Loaded<StreetSpeed[]>>(null);
  const [accuracy, setAccuracy] = useState<Loaded<RideAccuracy[]>>(null);
  const [trouble, setTrouble] = useState<Loaded<TroubleSpot[]>>(null);
  const [tick, setTick] = useState(0); // bump to refresh

  const fail = (e: Error) => `Backend not reachable (${e.message})`;
  useEffect(() => {
    getRideStatsLive().then((r) => setLive(unwrap(r))).catch((e) => setLive(fail(e)));
    getRideAccuracy(withSim).then((r) => setAccuracy(unwrap(r))).catch((e) => setAccuracy(fail(e)));
    getTroubleSpots(withSim).then((r) => setTrouble(unwrap(r))).catch((e) => setTrouble(fail(e)));
  }, [withSim, tick]);
  useEffect(() => {
    getStreetSpeeds(hour, withSim).then((r) => setSpeeds(unwrap(r))).catch((e) => setSpeeds(fail(e)));
  }, [hour, withSim, tick]);

  useEffect(() => {
    onSpeeds(showSpeeds && Array.isArray(speeds) ? speeds : undefined);
  }, [showSpeeds, speeds, onSpeeds]);
  useEffect(() => {
    onTrouble(showTrouble && Array.isArray(trouble) ? trouble : undefined);
  }, [showTrouble, trouble, onTrouble]);

  if (typeof live === "string") return <p className="text-xs text-neutral-500">{live}</p>;
  if (!live) return <p className="text-xs text-neutral-500">Loading…</p>;

  const acc = Array.isArray(accuracy) ? accuracy : [];
  const errs = acc.map((a) => a.error_pct).filter((e): e is number => e != null);
  const meanErr = errs.length ? errs.reduce((a, b) => a + Math.abs(b), 0) / errs.length : null;
  const maxMin = Math.max(10, ...acc.map((a) => Math.max(a.predicted_min, a.actual_min)));

  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={withSim} onChange={(e) => setWithSim(e.target.checked)} />
          include simulated rides
        </label>
        <button className="underline" onClick={() => setTick((n) => n + 1)}>refresh</button>
      </div>

      {/* Counters */}
      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          ["Real rides", live.rides_real],
          ["Simulated", live.rides_simulated],
          ["Arrived", live.rides_arrived],
          ["Real GPS points", live.points_real.toLocaleString()],
          ["Sim. points", live.points_simulated.toLocaleString()],
          ["Off-route (24 h)", live.events_24h],
        ].map(([label, v]) => (
          <div key={label} className="rounded bg-neutral-100 p-1.5">
            <div className="text-base font-semibold tabular-nums">{v}</div>
            <div className="text-neutral-500">{label}</div>
          </div>
        ))}
      </div>
      <p className="text-neutral-500">
        Last ride {live.last_ride ? new Date(live.last_ride).toLocaleString() : "never"}. Raw GPS points are kept{" "}
        {live.raw_days_kept} days; the hourly street speeds stay. Simulated rides never change real routes or ETAs.
      </p>

      {/* Real speeds per street */}
      <div className="rounded border border-neutral-200 p-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="font-medium">Real speed per street</span>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={showSpeeds} onChange={(e) => setShowSpeeds(e.target.checked)} />
            show on map
          </label>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="range" min={-1} max={23} value={hour ?? -1} className="flex-1"
            onChange={(e) => setHour(Number(e.target.value) < 0 ? null : Number(e.target.value))}
          />
          <span className="w-20 text-right tabular-nums">{hour == null ? "all hours" : `${hour}:00–${hour + 1}:00`}</span>
        </div>
        <p className="mt-1 text-neutral-500">
          {typeof speeds === "string" ? speeds : speeds ? `${speeds.length} streets with data` : "Loading…"}
          {" · "}red = slow, green = fast. Routing uses a street once it has 6+ real points in that hour.
        </p>
      </div>

      {/* Predicted vs actual */}
      <div className="rounded border border-neutral-200 p-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="font-medium">Predicted vs actual time</span>
          <span className="text-neutral-500">
            {meanErr != null ? `average miss ${meanErr.toFixed(0)}% over ${errs.length} rides` : "no finished rides yet"}
          </span>
        </div>
        {typeof accuracy === "string" && <p className="text-red-700">{accuracy}</p>}
        {acc.length > 0 && (
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 4, right: 8, bottom: 14, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" />
                <XAxis type="number" dataKey="predicted_min" name="Predicted" unit=" min" domain={[0, Math.ceil(maxMin)]}
                  tick={{ fontSize: 10 }} label={{ value: "predicted (min)", position: "insideBottom", offset: -8, fontSize: 10 }} />
                <YAxis type="number" dataKey="actual_min" name="Actual" unit=" min" domain={[0, Math.ceil(maxMin)]} tick={{ fontSize: 10 }} />
                <ReferenceLine segment={[{ x: 0, y: 0 }, { x: maxMin, y: maxMin }]} stroke="#a3a3a3" strokeDasharray="4 4" />
                <ChartTooltip formatter={(v) => `${Number(v).toFixed(1)} min`} />
                <Scatter data={acc.filter((a) => !a.simulated)} fill="#2563eb" name="Real" />
                <Scatter data={acc.filter((a) => a.simulated)} fill="#a3a3a3" name="Simulated" />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        )}
        <p className="text-neutral-500">On the dashed line = perfect. Above it = slower than we said. Blue = real, grey = simulated.</p>
      </div>

      {/* Trouble spots */}
      <div className="rounded border border-neutral-200 p-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="font-medium">Trouble spots (last 24 h)</span>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={showTrouble} onChange={(e) => setShowTrouble(e.target.checked)} />
            show on map
          </label>
        </div>
        {typeof trouble === "string" && <p className="text-red-700">{trouble}</p>}
        {Array.isArray(trouble) && trouble.length === 0 && <p className="text-neutral-500">Nobody has gone off route.</p>}
        {Array.isArray(trouble) && trouble.length > 0 && (
          <ul className="space-y-0.5">
            {trouble.map((t) => (
              <li key={t.osmid} className="flex justify-between gap-2">
                <span className={t.active ? "font-medium text-red-700" : ""}>{t.street || "unnamed street"}</span>
                <span className="text-neutral-500 tabular-nums">
                  {t.riders} riders · {t.events}× · {new Date(t.last).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-neutral-500">3+ real riders going off route on one street within 2 h = routes avoid it and riders get a warning.</p>
      </div>
    </div>
  );
}

const num = "w-16 rounded border border-neutral-300 px-1 py-0.5 text-right text-xs tabular-nums";

// --- The panel -------------------------------------------------------------------

export default function DebugPanel() {
  const [meta, setMeta] = useState<DebugProfiles | null>(null);
  const [start, setStart] = useState<LatLon | null>(DEMO_START);
  const [end, setEnd] = useState<LatLon | null>(DEMO_END);
  const [waypoints, setWaypoints] = useState<LatLon[]>([]);
  const [mode, setMode] = useState<ClickMode>("none");
  const [profile, setProfile] = useState<Profile>("regular");
  const [departAt, setDepartAt] = useState("");
  const [ctxForm, setCtxForm] = useState<CtxForm>(EMPTY_CTX);
  const [tuned, setTuned] = useState<ProfileParams | null>(null);
  const [google, setGoogle] = useState(false);
  const [visible, setVisible] = useState<Record<DebugRouteId | "explored", boolean>>({
    ours: true, shortest: true, google: true, drawn: true, baseline: true, explored: false,
  });
  const [colorBy, setColorBy] = useState<ColorBy>("route");
  const [result, setResult] = useState<DebugRouteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tableRoute, setTableRoute] = useState<DebugRouteId>("ours");
  const [sortBy, setSortBy] = useState<"order" | "cost" | "cost_per_m">("order");
  const [selected, setSelected] = useState<{ route: DebugRouteId; idx: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [scenario, setScenario] = useState<Scenario>("live");
  const [demoNote, setDemoNote] = useState<string | null>(null);
  const [rideOn, setRideOn] = useState(false);
  const [speedUp, setSpeedUp] = useState<"1" | "5" | "20">("5");
  const [reroutes, setReroutes] = useState(0);
  const [speedLayer, setSpeedLayer] = useState<StreetSpeed[] | undefined>();
  const [troubleLayer, setTroubleLayer] = useState<TroubleSpot[] | undefined>();
  const [simResult, setSimResult] = useState<RideResultTimes | null>(null);
  const runId = useRef(0);

  useEffect(() => {
    getDebugProfiles()
      .then((m) => {
        setMeta(m);
        setGoogle(m.google_enabled);
      })
      .catch((e) => setError(`Backend not reachable (${e.message}). Is it running on port 8000?`));
  }, []);

  const params: ProfileParams | null = tuned ?? meta?.profiles[profile] ?? null;

  // Re-run whenever an input changes (debounced so sliders don't spam the backend).
  useEffect(() => {
    if (!start || !end || !meta) return;
    const id = ++runId.current;
    const t = setTimeout(() => {
      setLoading(true);
      const base = { start, end, profile, depart_at: departAt || null, profile_override: tuned };
      const compare = scenario !== "live" && scenario !== "day" && scenario !== "custom";
      Promise.all([
        debugRoute({ ...base, ctx_override: ctxOverride(ctxForm), waypoints: waypoints.length ? waypoints : null, google }),
        // the same trip on a calm day, to show what the scenario changed
        compare ? debugRoute({ ...base, ctx_override: ctxOverride(CALM) }) : Promise.resolve(null),
      ])
        .then(([r, calm]) => {
          if (id !== runId.current) return;
          const calmRoute = calm?.routes.find((x) => x.id === "ours");
          if (calmRoute) r.routes.push({ ...calmRoute, id: "baseline", label: "Same trip, calm day", astar: undefined });
          setResult(r);
          setError(null);
          setSelected(null);
        })
        .catch((e) => id === runId.current && setError(e.message))
        .finally(() => id === runId.current && setLoading(false));
    }, 350);
    return () => clearTimeout(t);
  }, [start, end, waypoints, profile, departAt, ctxForm, tuned, google, meta, scenario]);

  const pickScenario = (s: Scenario, from = start, to = end) => {
    setScenario(s);
    setCtxForm(scenarioForm(s, from, to));
  };

  const runDemo = (t: (typeof DEMO_TRIPS)[number]) => {
    setStart(t.start);
    setEnd(t.end);
    setWaypoints([]);
    if (t.profile) setProfile(t.profile);
    setTuned(null);
    setDemoNote(t.note);
    setRideOn(false);
    pickScenario(t.scenario, t.start, t.end);
  };

  // Simulated ride: follows our route; after a wrong turn it re-plans from the dot
  const ours = result?.routes.find((r) => r.id === "ours");
  // Simulated rides are logged to Tiger Data too (marked simulated, never used for learning).
  // Ride time is counted from distance at 15 mph, so 5× and 20× still log a normal-speed ride.
  const simLog = useRideLog(true);
  const { point: simPoint, end: endSim } = simLog;
  const simClock = useRef<{ startMs: number; meters: number; last: LatLon | null } | null>(null);
  const ride = useDebugRide(ours?.line ?? null, rideOn, Number(speedUp), (p) => {
    simLog.event("off_route", p);
    setReroutes((n) => n + 1);
    setWaypoints([]);
    setStart(p); // re-plans from where the rider is
  });

  const startOrPause = () => {
    if (!rideOn && !simClock.current && ours && start && end) {
      simLog.start(ours.summary, start, end, profile);
      simClock.current = { startMs: Date.now(), meters: 0, last: null };
      setSimResult(null);
    }
    setRideOn((v) => !v);
  };

  const resetRide = () => {
    setRideOn(false);
    ride.reset();
    simLog.end(false);
    simClock.current = null;
  };

  // feed the dot's positions to the log, and close the ride at the end of the route
  const ridePos = ride.position;
  useEffect(() => {
    const c = simClock.current;
    if (!rideOn || !c || !ridePos) return;
    if (c.last) c.meters += distanceM(c.last, ridePos);
    c.last = ridePos;
    simPoint({ t: c.startMs + (c.meters / RIDE_SPEED) * 1000, lat: ridePos[0], lon: ridePos[1], acc: 5 });
    if (ride.total > 0 && ride.along >= ride.total && !ride.detouring) {
      simClock.current = null;
      endSim(true, c.meters / RIDE_SPEED / 60).then((r) => {
        setRideOn(false);
        setSimResult(r);
      });
    }
  }, [ridePos, rideOn, ride.along, ride.total, ride.detouring, simPoint, endSim]);

  const onMapClick = (p: LatLon) => {
    if (mode === "start") { setStart(p); setMode("end"); }
    else if (mode === "end") { setEnd(p); setMode("none"); }
    else if (mode === "waypoint") setWaypoints((w) => [...w, p]);
  };

  const setFactor = (group: "road_type_factors" | "surface_factors", key: string, v: string) => {
    if (!params) return;
    const next = { ...params, [group]: { ...params[group] } };
    if (v === "") delete next[group][key];
    else next[group][key] = Number(v);
    setTuned(next);
  };

  const tableData = result?.routes.find((r) => r.id === tableRoute) ?? result?.routes[0];
  const rows = useMemo(() => {
    const list = (tableData?.edges ?? []).map((e, i) => ({ e, i }));
    if (sortBy === "cost") list.sort((a, b) => b.e.cost - a.e.cost);
    if (sortBy === "cost_per_m") list.sort((a, b) => b.e.cost_per_m - a.e.cost_per_m);
    return list;
  }, [tableData, sortBy]);

  const ctx = result?.ctx;
  const weather = result?.ctx_from_weather;
  const gmapsUrl =
    start && end
      ? `https://www.google.com/maps/dir/?api=1&origin=${start[0]},${start[1]}&destination=${end[0]},${end[1]}&travelmode=bicycling`
      : null;

  return (
    <div className="flex h-dvh w-full flex-col md:flex-row">
      <aside className="order-2 h-1/2 overflow-y-auto border-neutral-200 bg-white text-sm md:order-1 md:h-full md:w-[480px] md:shrink-0 md:border-r">
        <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-2">
          <h1 className="font-semibold">OxRide routing debug</h1>
          <span className="text-xs text-neutral-500">{loading ? "running A*…" : result ? "up to date" : ""}</span>
        </div>

        {error && <div className="m-3 rounded bg-red-50 p-2 text-xs text-red-700">{error}</div>}
        {result?.warnings.map((w, i) => (
          <div key={i} className="mx-3 mt-2 rounded bg-amber-50 p-2 text-xs text-amber-800">⚠ {w}</div>
        ))}

        <Section title="Services (API keys)">
          <ServicesBox />
        </Section>

        <Section title="Trip">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Seg
              value={mode}
              onChange={setMode}
              options={[["start", "Set A"], ["end", "Set B"], ["waypoint", "Draw route"], ["none", "Pan"]]}
            />
            {waypoints.length > 0 && (
              <button className="text-xs text-purple-700 underline" onClick={() => setWaypoints([])}>
                clear {waypoints.length} waypoint{waypoints.length > 1 ? "s" : ""}
              </button>
            )}
          </div>
          <p className="mb-2 text-xs text-neutral-500">
            {mode === "waypoint"
              ? "Click the map to add points your route must pass through (e.g. trace Google's line). Shortest hops between them."
              : "Pick a mode, then click the map. Markers can be dragged."}
          </p>
          <div className="mb-2">
            <div className="mb-1 text-xs text-neutral-500">Scenario</div>
            <div className="flex flex-wrap gap-1">
              {SCENARIO_LABEL.map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => pickScenario(k)}
                  className={`rounded border px-2 py-1 text-xs ${scenario === k ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-300 bg-white hover:bg-neutral-100"}`}
                >
                  {label}
                </button>
              ))}
              {scenario === "custom" && <span className="px-1 py-1 text-xs text-neutral-500">custom (edited below)</span>}
            </div>
          </div>
          <div className="mb-2">
            <div className="mb-1 text-xs text-neutral-500">Demo trips (extreme cases)</div>
            <div className="flex flex-wrap gap-1">
              {DEMO_TRIPS.map((t) => (
                <button
                  key={t.label}
                  onClick={() => runDemo(t)}
                  title={t.note}
                  className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs hover:bg-neutral-100"
                >
                  {t.label}
                </button>
              ))}
            </div>
            {demoNote && <p className="mt-1 text-xs text-neutral-600">Shows: {demoNote}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Seg value={profile} onChange={(v) => { setProfile(v); setTuned(null); }} options={[["fast", "fast"], ["regular", "regular"], ["chill", "chill"]]} />
            <input
              type="datetime-local"
              value={departAt}
              onChange={(e) => setDepartAt(e.target.value)}
              className="rounded border border-neutral-300 px-1 py-0.5 text-xs"
              title="Departure (Oxford time). Empty = now."
            />
            {departAt && <button className="text-xs underline" onClick={() => setDepartAt("")}>now</button>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-1" title={meta?.google_enabled ? "" : "Set GOOGLE_MAPS_API_KEY in backend/.env"}>
              <input type="checkbox" checked={google} disabled={!meta?.google_enabled} onChange={(e) => setGoogle(e.target.checked)} />
              Google route {meta && !meta.google_enabled && <span className="text-neutral-400">(no API key)</span>}
            </label>
            {gmapsUrl && (
              <a href={gmapsUrl} target="_blank" rel="noreferrer" className="text-blue-700 underline">
                open in Google Maps ↗
              </a>
            )}
          </div>
        </Section>

        {result && (
          <Section title="Comparison">
            <Comparison routes={result.routes} />
            <p className="mt-2 text-xs text-neutral-500">
              Every route is scored with the same cost function, profile and context, so the costs compare
              directly. Snapped A to junction {result.start_node.snap_m} m away, B {result.end_node.snap_m} m.
            </p>
          </Section>
        )}

        {ours?.line && ours.steps && (
          <Section
            title="Simulated ride"
            right={reroutes > 0 ? <span className="text-xs text-neutral-500">rerouted {reroutes}×</span> : undefined}
          >
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <button
                onClick={startOrPause}
                className="rounded bg-blue-600 px-3 py-1 text-xs text-white"
              >
                {rideOn ? "Pause" : ride.along > 0 ? "Resume" : "Start ride"}
              </button>
              <Seg value={speedUp} onChange={setSpeedUp} options={[["1", "1×"], ["5", "5×"], ["20", "20×"]]} />
              <button
                onClick={ride.wrongTurn}
                disabled={!rideOn || ride.detouring}
                className="rounded border border-neutral-300 px-3 py-1 text-xs disabled:opacity-50"
              >
                Wrong turn
              </button>
              <button
                onClick={resetRide}
                className="text-xs underline"
              >
                reset
              </button>
            </div>
            <RideStatus line={ours.line} cum={ride.cum} steps={ours.steps} along={ride.along} total={ride.total}
              etaMin={ours.summary.eta_min} />
            {ride.detouring && (
              <p className="mt-1 text-xs text-amber-700">
                {ride.offRoute ? "Off route: finding a new way…" : "Leaving the route… (re-plans after ~4 s more than 30 m away)"}
              </p>
            )}
            {simResult && (
              <p className="mt-1 text-xs text-green-700">
                Logged to Tiger Data (simulated): predicted {simResult.predicted_min ?? "?"} min, took{" "}
                {simResult.actual_min.toFixed(1)} min.
              </p>
            )}
          </Section>
        )}

        <Section title="Tiger Data (ride log)">
          <TigerDataBox onSpeeds={setSpeedLayer} onTrouble={setTroubleLayer} />
        </Section>

        <Section title="Map layers">
          <div className="flex flex-wrap gap-3 text-xs">
            {(["ours", "shortest", "google", "drawn", "baseline", "explored"] as const).map((k) => (
              <label key={k} className="flex items-center gap-1">
                <input type="checkbox" checked={visible[k]} onChange={(e) => setVisible({ ...visible, [k]: e.target.checked })} />
                <span style={{ color: k === "explored" ? "#ea580c" : ROUTE_COLORS[k] }}>
                  {k === "explored" ? `A* explored (${result?.routes[0]?.astar?.expanded_count ?? 0})` : k}
                </span>
              </label>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs">
            Colour our route by
            <Seg value={colorBy} onChange={setColorBy} options={[["route", "plain"], ["cost", "cost / m"], ["highway", "road type"]]} />
          </div>
          {colorBy === "cost" && (
            <div className="mt-1 flex items-center gap-1 text-[10px] text-neutral-500">
              cheap
              {[0.5, 0.8, 1.2, 1.8, 3].map((v) => (
                <span key={v} className="inline-block h-2 w-6" style={{ background: costColor(v) }} />
              ))}
              expensive (cost per metre)
            </div>
          )}
        </Section>

        <Section title="Context passed to A*" right={<button className="text-xs underline" onClick={() => pickScenario("live")}>reset</button>}>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            {(["dark", "rush"] as const).map((k) => (
              <div key={k} className="flex items-center justify-between gap-1">
                <span>
                  {k} <b className={ctx?.[k] ? "text-amber-700" : ""}>{ctx ? String(ctx[k]) : ""}</b>
                </span>
                <Seg value={ctxForm[k]} onChange={(v) => { setScenario("custom"); setCtxForm({ ...ctxForm, [k]: v }); }} options={[["auto", "auto"], ["on", "on"], ["off", "off"]]} />
              </div>
            ))}
            {(["wind_ms", "wind_from_deg", "rain_mm"] as const).map((k) => (
              <label key={k} className="flex items-center justify-between gap-1">
                <span>
                  {k} <span className="text-neutral-400">(weather {weather ? String(weather[k]) : "?"})</span>
                </span>
                <input className={num} placeholder="auto" value={ctxForm[k]} onChange={(e) => { setScenario("custom"); setCtxForm({ ...ctxForm, [k]: e.target.value }); }} />
              </label>
            ))}
            <div className="col-span-2 text-neutral-500">
              local time: {ctx ? String(ctx.local) : "–"} · rain chance {ctx ? pct(Number(ctx.rain_prob)) : "–"}
            </div>
          </div>
        </Section>

        {params && meta && (
          <Section
            title={`Profile "${profile}"${tuned ? " (tuned)" : ""}`}
            right={
              <div className="flex gap-2 text-xs">
                {tuned && <button className="underline" onClick={() => setTuned(null)}>reset</button>}
                <button
                  className="underline"
                  onClick={() => {
                    navigator.clipboard.writeText(toPython(profile, params));
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? "copied!" : "copy as Python"}
                </button>
              </div>
            }
          >
            <p className="mb-2 text-xs text-neutral-500">
              Road factor multiplies length (below 1 = A* likes it). Empty = not in the profile = 1.0.
              Hill weight = extra metres charged per metre climbed.
            </p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              {meta.highways.map(({ highway, km }) => (
                <label key={highway} className="flex items-center justify-between gap-1">
                  <span className="truncate">
                    <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: highwayColor(highway) }} />
                    {highway} <span className="text-neutral-400">{km} km</span>
                  </span>
                  <input
                    className={num}
                    type="number"
                    step="0.1"
                    min="0.1"
                    placeholder="1.0"
                    value={params.road_type_factors[highway] ?? ""}
                    onChange={(e) => setFactor("road_type_factors", highway, e.target.value)}
                  />
                </label>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-neutral-100 pt-2 text-xs">
              {meta.surfaces.map((s) => (
                <label key={s} className="flex items-center justify-between gap-1">
                  surface: {s}
                  <input
                    className={num}
                    type="number"
                    step="0.1"
                    min="0.1"
                    placeholder="1.0"
                    value={params.surface_factors[s] ?? ""}
                    onChange={(e) => setFactor("surface_factors", s, e.target.value)}
                  />
                </label>
              ))}
              <label className="flex items-center justify-between gap-1">
                hill_weight
                <input
                  className={num}
                  type="number"
                  step="1"
                  min="0"
                  value={params.hill_weight}
                  onChange={(e) => setTuned({ ...params, hill_weight: Number(e.target.value) })}
                />
              </label>
            </div>
          </Section>
        )}

        {tableData && (
          <Section title="Where the cost goes">
            <table className="w-full text-xs">
              <thead className="text-neutral-500">
                <tr>
                  <th className="text-left font-normal">road type</th>
                  <th className="text-right font-normal">distance</th>
                  <th className="text-right font-normal">cost</th>
                  <th className="text-right font-normal">cost / m</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(tableData.by_highway).map(([h, v]) => (
                  <tr key={h} className="border-t border-neutral-100">
                    <td>
                      <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: highwayColor(h) }} />
                      {h}
                    </td>
                    <td className="text-right tabular-nums">{pct(v.length_m / tableData.summary.distance_m)}</td>
                    <td className="text-right tabular-nums">{pct(v.cost / tableData.summary.cost)}</td>
                    <td className="text-right tabular-nums">{v.length_m ? (v.cost / v.length_m).toFixed(2) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        {result && tableData && (
          <Section
            title={`Every road (${tableData.edges.length})`}
            right={
              <Seg
                value={sortBy}
                onChange={setSortBy}
                options={[["order", "in order"], ["cost", "by cost"], ["cost_per_m", "by cost/m"]]}
              />
            }
          >
            <div className="mb-2">
              <Seg
                value={tableData.id}
                onChange={(v) => { setTableRoute(v); setSelected(null); }}
                options={result.routes.map((r) => [r.id, r.label] as [DebugRouteId, string])}
              />
            </div>
            <p className="mb-1 text-xs text-neutral-500">
              cost = (length × road × surface + hill) × time. Click a row to find it on the map.
            </p>
            <div className="max-h-[420px] overflow-auto">
              <table className="w-full text-[11px] tabular-nums">
                <thead className="sticky top-0 bg-white text-neutral-500">
                  <tr>
                    {["#", "street", "type", "surf", "lit", "m", "grade", "road×", "surf×", "hill+", "time×", "wind", "cost", "/m"].map((h) => (
                      <th key={h} className="px-0.5 text-right font-normal first:text-left [&:nth-child(2)]:text-left">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ e, i }) => {
                    const isSel = selected?.route === tableData.id && selected.idx === i;
                    return (
                      <tr
                        key={i}
                        onClick={() => setSelected({ route: tableData.id, idx: i })}
                        className={`cursor-pointer border-t border-neutral-100 hover:bg-neutral-50 ${isSel ? "bg-yellow-100" : ""} ${e.matches_edge_cost ? "" : "text-red-600"}`}
                      >
                        <td className="px-0.5">{i}</td>
                        <td className="max-w-[90px] truncate px-0.5" title={e.name}>{e.name || "–"}</td>
                        <td className="px-0.5 text-right" style={{ color: highwayColor(e.highway) }}>{e.highway}</td>
                        <td className="px-0.5 text-right">{e.surface === "asphalt" ? "" : e.surface}</td>
                        <td className="px-0.5 text-right">{e.lit ? "" : "✗"}</td>
                        <td className="px-0.5 text-right">{Math.round(e.length_m)}</td>
                        <td className={`px-0.5 text-right ${e.grade_pct > 3 ? "text-red-600" : ""}`}>{e.grade_pct}</td>
                        <td className="px-0.5 text-right">{e.road_factor}</td>
                        <td className="px-0.5 text-right">{e.surface_factor}</td>
                        <td className="px-0.5 text-right">{e.hill_penalty || ""}</td>
                        <td className={`px-0.5 text-right ${e.time_penalty > 1 ? "text-amber-700" : ""}`}>{e.time_penalty}</td>
                        <td className="px-0.5 text-right">{e.headwind_ms}</td>
                        <td className="px-0.5 text-right font-medium">{Math.round(e.cost)}</td>
                        <td className="px-0.5 text-right" style={{ color: costColor(e.cost_per_m) }}>{e.cost_per_m.toFixed(2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>
        )}
      </aside>

      <main className="relative order-1 h-1/2 md:order-2 md:h-full md:flex-1">
        {mode !== "none" && (
          <div className="pointer-events-none absolute top-2 left-1/2 z-[1000] -translate-x-1/2 rounded bg-neutral-900/80 px-3 py-1 text-xs text-white">
            {mode === "start" ? "Click to set A" : mode === "end" ? "Click to set B" : "Click to add a waypoint"}
          </div>
        )}
        <DebugMap
          rider={ride.position && (rideOn || ride.along > 0 || ride.detouring) ? ride.position : null}
          speeds={speedLayer}
          trouble={troubleLayer}
          start={start}
          end={end}
          waypoints={waypoints}
          result={result}
          visible={visible}
          colorBy={colorBy}
          selected={selected}
          onMapClick={onMapClick}
          onMoveStart={setStart}
          onMoveEnd={setEnd}
          onMoveWaypoint={(i, p) => setWaypoints((w) => w.map((x, j) => (j === i ? p : x)))}
          onEdgeClick={(route, idx) => { setTableRoute(route); setSelected({ route, idx }); }}
        />
      </main>
    </div>
  );
}
