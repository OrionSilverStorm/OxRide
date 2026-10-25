"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import L from "leaflet";
import {
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import type { DebugEdge, DebugRouteId, DebugRouteResult, LatLon, StreetSpeed, TroubleSpot } from "@/lib/api";

export type ColorBy = "route" | "cost" | "highway";

export const ROUTE_COLORS: Record<DebugRouteId, string> = {
  ours: "#2563eb",
  shortest: "#6b7280",
  google: "#dc2626",
  drawn: "#9333ea",
  baseline: "#9ca3af",
};

const riderIcon = L.divIcon({
  className: "",
  html: '<div style="width:18px;height:18px;background:#f59e0b;border:3px solid white;border-radius:50%;box-shadow:0 0 6px rgba(0,0,0,.5)"></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

const HIGHWAY_COLORS: Record<string, string> = {
  cycleway: "#16a34a",
  path: "#0d9488",
  residential: "#3b82f6",
  living_street: "#60a5fa",
  service: "#94a3b8",
  unclassified: "#64748b",
  tertiary: "#f59e0b",
  secondary: "#f97316",
  primary: "#dc2626",
  trunk: "#7f1d1d",
  footway: "#a16207",
  pedestrian: "#db2777",
  track: "#78716c",
  bridleway: "#65a30d",
};

export const highwayColor = (h: string) => HIGHWAY_COLORS[h.replace("_link", "")] ?? "#111827";

// Cost per metre: 0.5 (a cycleway the profile loves) is green, 3+ is red.
export function costColor(perM: number) {
  const t = Math.min(Math.max(Math.log(perM / 0.5) / Math.log(6), 0), 1);
  return `hsl(${Math.round(120 * (1 - t))} 85% 42%)`;
}

const OXFORD_CENTER: LatLon = [51.752, -1.2577];
const OXFORD_BOUNDS = L.latLngBounds([51.69, -1.37], [51.82, -1.14]);

const dot = (color: string, label: string) =>
  L.divIcon({
    className: "",
    html: `<div style="width:22px;height:22px;background:${color};border:3px solid white;border-radius:50%;box-shadow:0 0 4px rgba(0,0,0,.5);color:white;font:bold 11px/16px sans-serif;text-align:center">${label}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
const startIcon = dot("#16a34a", "A");
const endIcon = dot("#dc2626", "B");
const waypointIcon = (i: number) => dot("#9333ea", String(i + 1));

interface Props {
  rider?: LatLon | null; // the simulated ride's position
  speeds?: StreetSpeed[]; // Tiger Data: real riding speed per street
  trouble?: TroubleSpot[]; // Tiger Data: where riders turned back
  start: LatLon | null;
  end: LatLon | null;
  waypoints: LatLon[];
  result: DebugRouteResult | null;
  visible: Record<DebugRouteId | "explored", boolean>;
  colorBy: ColorBy;
  selected: { route: DebugRouteId; idx: number } | null;
  onMapClick: (p: LatLon) => void;
  onMoveStart: (p: LatLon) => void;
  onMoveEnd: (p: LatLon) => void;
  onMoveWaypoint: (i: number, p: LatLon) => void;
  onEdgeClick: (route: DebugRouteId, idx: number) => void;
}

function ClickHandler({ onClick }: { onClick: (p: LatLon) => void }) {
  useMapEvents({ click: (e) => onClick([e.latlng.lat, e.latlng.lng]) });
  return null;
}

// Zoom to the route when start or end changes (not on every slider tweak).
function FitToRoute({ result, keyStr }: { result: DebugRouteResult | null; keyStr: string }) {
  const map = useMap();
  const last = useRef("");
  useEffect(() => {
    if (!result || last.current === keyStr) return;
    last.current = keyStr;
    const pts = result.routes.flatMap((r) => r.edges.flatMap((e) => e.coords));
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
  }, [result, keyStr, map]);
  return null;
}

// Zoom to the edge picked in the table.
function FlyToEdge({ edge }: { edge: DebugEdge | null }) {
  const map = useMap();
  useEffect(() => {
    if (edge) map.fitBounds(L.latLngBounds(edge.coords), { maxZoom: 18, padding: [80, 80] });
  }, [edge, map]);
  return null;
}

function edgeTooltip(e: DebugEdge, i: number) {
  return (
    <div className="text-xs leading-tight">
      <b>
        #{i} {e.name || "(no name)"}
      </b>
      <br />
      {e.highway} · {e.surface} · {e.lit ? "lit" : "unlit"} · {e.length_m} m · {e.grade_pct}%
      <br />
      ({e.length_m} × {e.road_factor} × {e.surface_factor} + {e.hill_penalty}) × {e.time_penalty} ={" "}
      <b>{e.cost}</b>
    </div>
  );
}

/** Riding speed colour: red = slow (≤ 3 m/s), green = fast (≥ 7 m/s). */
export function speedColor(ms: number) {
  const t = Math.max(0, Math.min(1, (ms - 3) / 4));
  return `hsl(${Math.round(t * 120)} 75% 42%)`;
}

export default function DebugMap(p: Props) {
  const routes = p.result?.routes ?? [];
  // draw ours last so it sits on top
  const order: DebugRouteId[] = ["baseline", "shortest", "google", "drawn", "ours"];
  const sorted = [...routes].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const selectedEdge =
    p.selected && routes.find((r) => r.id === p.selected!.route)?.edges[p.selected.idx];
  const expanded = p.result?.routes.find((r) => r.id === "ours")?.astar?.expanded ?? [];

  return (
    <MapContainer
      center={OXFORD_CENTER}
      zoom={14}
      minZoom={12}
      maxBounds={OXFORD_BOUNDS}
      maxBoundsViscosity={1.0}
      preferCanvas
      className="h-full w-full"
    >
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        opacity={0.6}
      />
      <ClickHandler onClick={p.onMapClick} />
      <FitToRoute result={p.result} keyStr={`${p.start}|${p.end}`} />
      <FlyToEdge edge={selectedEdge ?? null} />

      {/* Every junction A* looked at, light = early, dark = late */}
      {p.visible.explored &&
        expanded.map((c, i) => (
          <CircleMarker
            key={i}
            center={c}
            radius={2.5}
            pathOptions={{
              stroke: false,
              fillOpacity: 0.6,
              fillColor: `hsl(28 95% ${75 - (45 * i) / Math.max(expanded.length, 1)}%)`,
            }}
            interactive={false}
          />
        ))}

      {/* Google's own line, before snapping to our graph */}
      {p.visible.google &&
        routes
          .filter((r) => r.google)
          .map((r) => (
            <Polyline
              key="google-raw"
              positions={r.google!.points}
              pathOptions={{ color: ROUTE_COLORS.google, weight: 2, dashArray: "4 6", opacity: 0.9 }}
              interactive={false}
            />
          ))}

      {sorted
        .filter((r) => p.visible[r.id])
        .map((r) =>
          r.edges.map((e, i) => {
            const color =
              p.colorBy === "cost" ? costColor(e.cost_per_m) : p.colorBy === "highway" ? highwayColor(e.highway) : ROUTE_COLORS[r.id];
            const isOurs = r.id === "ours";
            return (
              <Polyline
                key={`${r.id}-${i}`}
                positions={e.coords}
                pathOptions={{
                  color: p.colorBy === "route" || isOurs ? color : ROUTE_COLORS[r.id],
                  weight: isOurs ? 6 : 4,
                  opacity: isOurs ? 0.9 : 0.7,
                  dashArray: r.id === "shortest" ? "8 6" : r.id === "baseline" ? "3 7" : undefined,
                }}
                eventHandlers={{ click: () => p.onEdgeClick(r.id, i) }}
              >
                <Tooltip sticky>{edgeTooltip(e, i)}</Tooltip>
              </Polyline>
            );
          }),
        )}

      {selectedEdge && (
        <Polyline
          positions={selectedEdge.coords}
          pathOptions={{ color: "#facc15", weight: 12, opacity: 0.8 }}
          interactive={false}
        />
      )}

      {/* Tiger Data: how fast people really ride each street */}
      {p.speeds?.map((s, i) => (
        <Polyline
          key={`speed-${i}`}
          positions={s.coords}
          pathOptions={{ color: speedColor(s.speed_ms), weight: 7, opacity: 0.85 }}
        >
          <Tooltip sticky>
            {s.name || "unnamed"}: {(s.speed_ms * 3.6).toFixed(1)} km/h from {s.points} GPS points
          </Tooltip>
        </Polyline>
      ))}

      {/* Tiger Data: where riders went off route */}
      {p.trouble?.map((t) => (
        <CircleMarker
          key={`trouble-${t.osmid}`}
          center={[t.lat, t.lon]}
          radius={6 + Math.min(t.riders, 6) * 2}
          pathOptions={{ color: "#b91c1c", fillColor: t.active ? "#ef4444" : "#fca5a5", fillOpacity: 0.7, weight: 2 }}
        >
          <Tooltip>
            {t.street || "unnamed"}: {t.riders} riders, {t.events} times{t.active ? " (3+ riders: enough to avoid)" : ""}
          </Tooltip>
        </CircleMarker>
      ))}

      {p.rider && <Marker position={p.rider} icon={riderIcon} zIndexOffset={1000} />}
      {p.start && (
        <Marker
          position={p.start}
          icon={startIcon}
          draggable
          eventHandlers={{ dragend: (e) => { const l = e.target.getLatLng(); p.onMoveStart([l.lat, l.lng]); } }}
        />
      )}
      {p.end && (
        <Marker
          position={p.end}
          icon={endIcon}
          draggable
          eventHandlers={{ dragend: (e) => { const l = e.target.getLatLng(); p.onMoveEnd([l.lat, l.lng]); } }}
        />
      )}
      {p.waypoints.map((w, i) => (
        <Marker
          key={i}
          position={w}
          icon={waypointIcon(i)}
          draggable
          eventHandlers={{ dragend: (e) => { const l = e.target.getLatLng(); p.onMoveWaypoint(i, [l.lat, l.lng]); } }}
        />
      ))}
    </MapContainer>
  );
}
