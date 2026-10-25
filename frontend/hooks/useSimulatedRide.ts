"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { LatLon } from "@/lib/api";
import { bearingDeg, cumulativeM, offsetPoint, pointAlong, projectOnRoute } from "@/lib/nav";

const TICK_MS = 500;
const DETOUR_M = 90; // how far the "wrong turn" goes off the route

interface Sim {
  route: LatLon[] | null; // the route this progress belongs to
  along: number; // metres ridden along it
  detour: { from: LatLon; bearing: number; gone: number } | null; // the wrong turn, if taken
  time: number; // when the position last changed (ms)
}

const fresh = (route: LatLon[] | null): Sim => ({ route, along: 0, detour: null, time: 0 });

/**
 * A fake rider moving along the route at bike speed, for indoor demos.
 * wrongTurn() leaves the route sideways so off-route detection and rerouting kick in.
 * When the route changes (a reroute), the ride continues from the new route's start.
 */
export function useSimulatedRide(route: LatLon[] | null, running: boolean, speedMs = 6.7) {
  const cum = useMemo(() => (route ? cumulativeM(route) : []), [route]);
  const total = cum.at(-1) ?? 0;
  const [state, setState] = useState<Sim>(() => fresh(route));
  const sim = state.route === route ? state : fresh(route); // a new route starts from its beginning

  useEffect(() => {
    if (!running || !route || route.length < 2) return;
    const id = setInterval(() => {
      const step = speedMs * (TICK_MS / 1000);
      const now = Date.now();
      setState((s) => {
        const base = s.route === route ? s : fresh(route);
        if (base.detour) {
          return { ...base, detour: { ...base.detour, gone: Math.min(DETOUR_M, base.detour.gone + step) }, time: now };
        }
        return { ...base, along: Math.min(total, base.along + step), time: now };
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [running, route, total, speedMs]);

  const wrongTurn = useCallback(() => {
    if (!route || route.length < 2) return;
    setState((s) => {
      const base = s.route === route ? s : fresh(route);
      if (base.detour) return base;
      const here = pointAlong(route, cum, base.along);
      const seg = projectOnRoute(route, cum, here).segment;
      const heading = bearingDeg(route[seg], route[Math.min(seg + 1, route.length - 1)]);
      // turn left or right, whichever leads further away from every part of the route
      const away = (b: number) => projectOnRoute(route, cum, offsetPoint(here, b, DETOUR_M)).distanceToRoute;
      const sides = [(heading + 90) % 360, (heading + 270) % 360, (heading + 45) % 360, (heading + 315) % 360];
      const bearing = sides.reduce((best, b) => (away(b) > away(best) ? b : best));
      return { ...base, detour: { from: here, bearing, gone: 0 } };
    });
  }, [route, cum]);

  const { along, detour, time } = sim;
  const position = useMemo<LatLon | null>(() => {
    if (!route || route.length === 0) return null;
    if (detour) return offsetPoint(detour.from, detour.bearing, detour.gone);
    return pointAlong(route, cum, along);
  }, [route, cum, along, detour]);

  return { position, time, wrongTurn, finished: !!route && along >= total - 1 };
}
