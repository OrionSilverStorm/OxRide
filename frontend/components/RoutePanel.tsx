"use client";

import type { RouteResult } from "@/lib/api";
import { formatDistance } from "@/lib/nav";
import ElevationChart from "./ElevationChart";
import SufferScore from "./SufferScore";

interface Props {
  result: RouteResult;
  whenLabel: string; // "Leaving now", "Night (22:00)", ...
  dark: boolean;
  hint: string | null; // "Leave in 20 min: ..." or nothing
  onStart: () => void;
  busy?: boolean;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Bottom sheet with the planned ride: time, distance, how calm it is, hills, start button. */
export default function RoutePanel({ result, whenLabel, dark, hint, onStart, busy }: Props) {
  const s = result.stats;
  return (
    <div className="w-full max-w-md rounded-2xl bg-white p-4 shadow-lg">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-2xl font-semibold">
            {Math.round(s.eta_min)} min <span className="text-base font-normal text-neutral-600">· {formatDistance(s.distance_m)}</span>
          </div>
          <div className="text-sm text-neutral-600">
            {pct(s.cycleway_share)} cycle paths · {pct(s.lit_share)} lit · {s.climb_m} m climb
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-1 text-xs ${dark ? "bg-neutral-900 text-white" : "bg-amber-100 text-amber-900"}`}
        >
          {whenLabel}
        </span>
      </div>

      {hint && <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{hint}</div>}

      <div className="mt-3 flex items-center gap-3">
        <SufferScore route={result.route} elevations={result.elevations_m} />
        <div className="min-w-0 flex-1">
          <ElevationChart route={result.route} elevations={result.elevations_m} />
        </div>
      </div>

      <button
        onClick={onStart}
        disabled={busy}
        className="mt-3 h-12 w-full rounded-xl bg-blue-600 font-medium text-white disabled:opacity-50"
      >
        Start ride
      </button>
    </div>
  );
}
