"use client";

import type { LatLon } from "@/lib/api";
import { DRAGON_MOODS, sufferScore } from "@/lib/nav";

// The dragon gets bigger, redder and shakier the more the route climbs.
const LOOK = [
  { size: 44, filter: "grayscale(1) opacity(0.6)", shake: false },
  { size: 52, filter: "none", shake: false },
  { size: 58, filter: "sepia(0.6) saturate(3) hue-rotate(-40deg)", shake: false },
  { size: 66, filter: "sepia(1) saturate(6) hue-rotate(-50deg)", shake: true },
  { size: 74, filter: "sepia(1) saturate(9) hue-rotate(-55deg) drop-shadow(0 0 6px rgb(239 68 68))", shake: true },
];

/** Hill suffer score with the OxRide dragon (Hackiest Hack). */
export default function SufferScore({ route, elevations }: { route: LatLon[]; elevations: number[] }) {
  const { score, mood, climbM } = sufferScore(route, elevations);
  const look = LOOK[mood];
  return (
    <div className="flex items-center gap-2" title={`${climbM} m of climbing`}>
      <div className="flex h-[74px] w-[80px] items-center justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/dragon.png"
          alt={`${DRAGON_MOODS[mood]} dragon`}
          width={look.size}
          style={{ filter: look.filter }}
          className={look.shake ? "animate-[dragon-shake_0.35s_ease-in-out_infinite]" : ""}
        />
      </div>
      <div className="leading-tight">
        <div className="text-xs text-neutral-500">Suffer score</div>
        <div className="text-lg font-semibold">{score}/100</div>
        <div className="text-xs text-neutral-600">{DRAGON_MOODS[mood]} dragon</div>
      </div>
    </div>
  );
}
