"use client";

import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { LatLon } from "@/lib/api";
import { cumulativeM } from "@/lib/nav";

/** Elevation profile along the route: one colour, no gridlines. */
export default function ElevationChart({ route, elevations }: { route: LatLon[]; elevations: number[] }) {
  if (route.length < 2 || elevations.length < 2) return null;
  const cum = cumulativeM(route);
  const every = Math.max(1, Math.ceil(route.length / 120)); // at most ~120 points
  const data = route
    .map((_, i) => ({ km: cum[i] / 1000, m: Math.round(elevations[i] ?? 0) }))
    .filter((_, i) => i % every === 0 || i === route.length - 1);
  const lo = Math.min(...data.map((d) => d.m));
  const hi = Math.max(...data.map((d) => d.m));

  return (
    <div className="w-full">
      <div className="flex justify-between text-[11px] text-neutral-500">
        <span>Elevation</span>
        <span>
          {lo}–{hi} m
        </span>
      </div>
      <div className="h-14 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
            <XAxis dataKey="km" type="number" domain={[0, "dataMax"]} hide />
            <YAxis domain={[lo - 2, hi + 2]} hide />
            <Tooltip
              formatter={(v) => [`${v} m`, "Elevation"]}
              labelFormatter={(km) => `${Number(km).toFixed(1)} km`}
            />
            <Area type="monotone" dataKey="m" stroke="#2563eb" fill="#2563eb" fillOpacity={0.15} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
