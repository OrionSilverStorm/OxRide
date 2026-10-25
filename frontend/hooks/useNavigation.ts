"use client";

import { useEffect, useMemo, useState } from "react";
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

/** Tracks the next step and detects being off the route. */
export function useNavigation(route: RouteResult | null, position: LatLon | null, accuracy: number | null = null): NavState {
  const cum = useMemo(() => (route ? cumulativeM(route.route) : []), [route]);
  const stepAlong = useMemo(() => (route ? stepsAlongM(route.route, cum, route.steps) : []), [route, cum]);
  const proj = useMemo(
    () => (route && position && route.route.length ? projectOnRoute(route.route, cum, position) : null),
    [route, cum, position],
  );

  // Off route = too far away for a few seconds; each new position updates it.
  const [off, setOff] = useState<{ route: RouteResult | null; state: OffRouteState }>({ route, state: ON_ROUTE });
  useEffect(() => {
    if (!proj) return;
    setOff((o) => ({
      route,
      state: updateOffRoute(o.route === route ? o.state : ON_ROUTE, proj.distanceToRoute, Date.now(), {
        accuracyM: accuracy ?? 0,
      }),
    }));
  }, [proj, route, accuracy]);

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
    offRoute: off.route === route && off.state.offRoute, // a fresh route always starts on route
  };
}
