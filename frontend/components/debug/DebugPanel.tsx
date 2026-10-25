"use client";

// Routing debug panel (/debug). Shows what A* was given, what it explored, why it
// picked each road, and how our route compares with the shortest route, Google's
// cycling route and a route you draw. Profile numbers can be tuned live.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  debugRoute,
  getDebugProfiles,
  getServices,
  testService,
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
} from "@/lib/api";
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
    ours: true, shortest: true, google: true, drawn: true, explored: false,
  });
  const [colorBy, setColorBy] = useState<ColorBy>("route");
  const [result, setResult] = useState<DebugRouteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tableRoute, setTableRoute] = useState<DebugRouteId>("ours");
  const [sortBy, setSortBy] = useState<"order" | "cost" | "cost_per_m">("order");
  const [selected, setSelected] = useState<{ route: DebugRouteId; idx: number } | null>(null);
  const [copied, setCopied] = useState(false);
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
      debugRoute({
        start,
        end,
        profile,
        depart_at: departAt || null,
        profile_override: tuned,
        ctx_override: ctxOverride(ctxForm),
        waypoints: waypoints.length ? waypoints : null,
        google,
      })
        .then((r) => {
          if (id !== runId.current) return;
          setResult(r);
          setError(null);
          setSelected(null);
        })
        .catch((e) => id === runId.current && setError(e.message))
        .finally(() => id === runId.current && setLoading(false));
    }, 350);
    return () => clearTimeout(t);
  }, [start, end, waypoints, profile, departAt, ctxForm, tuned, google, meta]);

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

        <Section title="Map layers">
          <div className="flex flex-wrap gap-3 text-xs">
            {(["ours", "shortest", "google", "drawn", "explored"] as const).map((k) => (
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

        <Section title="Context passed to A*" right={<button className="text-xs underline" onClick={() => setCtxForm(EMPTY_CTX)}>reset</button>}>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            {(["dark", "rush"] as const).map((k) => (
              <div key={k} className="flex items-center justify-between gap-1">
                <span>
                  {k} <b className={ctx?.[k] ? "text-amber-700" : ""}>{ctx ? String(ctx[k]) : ""}</b>
                </span>
                <Seg value={ctxForm[k]} onChange={(v) => setCtxForm({ ...ctxForm, [k]: v })} options={[["auto", "auto"], ["on", "on"], ["off", "off"]]} />
              </div>
            ))}
            {(["wind_ms", "wind_from_deg", "rain_mm"] as const).map((k) => (
              <label key={k} className="flex items-center justify-between gap-1">
                <span>
                  {k} <span className="text-neutral-400">(weather {weather ? String(weather[k]) : "?"})</span>
                </span>
                <input className={num} placeholder="auto" value={ctxForm[k]} onChange={(e) => setCtxForm({ ...ctxForm, [k]: e.target.value })} />
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
