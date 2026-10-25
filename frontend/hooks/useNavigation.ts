"use client";

import { useMemo, useState } from "react";
import type { LatLon, RouteResult, Step } from "@/lib/api";
import {
  cumulativeM,
  nextStepIndex,
  ON_ROUTE,
  projectOnRoute,
  stepsAlongM,
  updateOffRoute,
  type OffRouteState,
} from "@/lib/nav";

export interface NavState {
  nextStep: Step | null;
  nextIndex: number;
  distToStepM: number; // to the next maneuver
  remainingM: number; // to the destination
  distanceToRoute: number;
  offRoute: boolean; // more than ~30 m off the route for a few seconds
}

/**
 * Tracks the next step and detects being off the route.
 * `timeMs` is when `position` was measured (GPS timestamp, or the simulator's tick).
 */
export function useNavigation(
  route: RouteResult | null,
  position: LatLon | null,
  { accuracy = null, timeMs = 0 }: { accuracy?: number | null; timeMs?: number } = {},
): NavState {
  const cum = useMemo(() => (route ? cumulativeM(route.route) : []), [route]);
  const stepAlong = useMemo(() => (route ? stepsAlongM(route.route, cum, route.steps) : []), [route, cum]);
  const proj = useMemo(
    () => (route && position && route.route.length ? projectOnRoute(route.route, cum, position) : null),
    [route, cum, position],
  );

  // Off route = too far away for a few seconds. Updated once per new position
  // (React's "adjust state when an input changes" pattern; a new route starts on route).
  const [off, setOff] = useState<{ route: RouteResult | null; time: number; state: OffRouteState }>({
    route,
    time: 0,
    state: ON_ROUTE,
  });
  if (proj && (off.route !== route || off.time !== timeMs)) {
    const prev = off.route === route ? off.state : ON_ROUTE;
    setOff({ route, time: timeMs, state: updateOffRoute(prev, proj.distanceToRoute, timeMs, { accuracyM: accuracy ?? 0 }) });
  }

  const total = cum.at(-1) ?? 0;
  if (!route || !proj) {
    return { nextStep: route?.steps[0] ?? null, nextIndex: 0, distToStepM: 0, remainingM: total,
             distanceToRoute: 0, offRoute: false };
  }
  const i = route.steps.length ? nextStepIndex(stepAlong, proj.alongM) : 0;
  return {
    nextStep: route.steps[i] ?? null,
    nextIndex: i,
    distToStepM: Math.max(0, (stepAlong[i] ?? 0) - proj.alongM),
    remainingM: Math.max(0, total - proj.alongM),
    distanceToRoute: proj.distanceToRoute,
    offRoute: off.route === route && off.state.offRoute,
  };
}
