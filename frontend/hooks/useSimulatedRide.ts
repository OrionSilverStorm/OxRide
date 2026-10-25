"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LatLon } from "@/lib/api";
import { bearingDeg, cumulativeM, offsetPoint, pointAlong, projectOnRoute } from "@/lib/nav";

const TICK_MS = 500;
const DETOUR_M = 90; // how far the "wrong turn" goes off the route

/**
 * A fake rider moving along the route at bike speed, for indoor demos.
 * wrongTurn() leaves the route sideways so off-route detection and rerouting kick in.
 * When the route changes (a reroute), the ride continues from the new route's start.
 */
export function useSimulatedRide(route: LatLon[] | null, running: boolean, speedMs = 6.7) {
  const cum = useMemo(() => (route ? cumulativeM(route) : []), [route]);
  const along = useRef(0);
  const detour = useRef<{ from: LatLon; bearing: number; gone: number } | null>(null);
  const [position, setPosition] = useState<LatLon | null>(null);

  // new route: start from its beginning (that's where the rider is after a reroute)
  useEffect(() => {
    along.current = 0;
    detour.current = null;
    setPosition(route?.[0] ?? null);
  }, [route]);

  useEffect(() => {
    if (!running || !route || route.length < 2) return;
    const id = setInterval(() => {
      const step = speedMs * (TICK_MS / 1000);
      const d = detour.current;
      if (d) {
        d.gone = Math.min(DETOUR_M, d.gone + step);
        setPosition(offsetPoint(d.from, d.bearing, d.gone));
        return;
      }
      along.current = Math.min(cum[cum.length - 1], along.current + step);
      setPosition(pointAlong(route, cum, along.current));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [running, route, cum, speedMs]);

  const wrongTurn = useCallback(() => {
    if (!route || route.length < 2 || detour.current) return;
    const here = pointAlong(route, cum, along.current);
    const seg = projectOnRoute(route, cum, here).segment;
    const heading = bearingDeg(route[seg], route[Math.min(seg + 1, route.length - 1)]);
    // turn left or right, whichever leads further away from every part of the route
    const away = (b: number) => projectOnRoute(route, cum, offsetPoint(here, b, DETOUR_M)).distanceToRoute;
    const sides = [(heading + 90) % 360, (heading + 270) % 360, (heading + 45) % 360, (heading + 315) % 360];
    const bearing = sides.reduce((best, b) => (away(b) > away(best) ? b : best));
    detour.current = { from: here, bearing, gone: 0 };
  }, [route, cum]);

  const finished = !!route && cum.length > 0 && along.current >= cum[cum.length - 1] - 1;
  return { position, wrongTurn, finished };
}
