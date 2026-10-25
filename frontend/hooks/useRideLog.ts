"use client";

// Logs the ride to Tiger Data (via /rides): start, GPS points every 15 s, off-route events,
// and the end with predicted vs actual time. Anonymous: a random ride id, no account.
// Never throws and never blocks riding: if logging is off or fails, nothing changes.

import { useCallback, useEffect, useRef } from "react";
import {
  endRide,
  sendRideEvent,
  sendRidePoints,
  startRide,
  type LatLon,
  type Profile,
  type RidePoint,
  type RideResultTimes,
} from "@/lib/api";
import { PointBuffer } from "@/lib/rideBuffer";

const FLUSH_MS = 15_000;

export function useRideLog(simulated = false) {
  const rideId = useRef<string | null>(null);
  const starting = useRef<Promise<void> | null>(null);
  const buffer = useRef(new PointBuffer());

  const flush = useCallback(async () => {
    const id = rideId.current;
    const batch = id ? buffer.current.takeBatch() : null;
    if (!id || !batch) return;
    if (!(await sendRidePoints(id, batch, simulated))) buffer.current.giveBack(batch);
  }, [simulated]);

  /** Finish the current ride. Returns predicted vs actual minutes if it was logged.
   *  Safe to call again (or when no ride is open): it then just returns null. */
  const end = useCallback(
    async (arrived: boolean, simulatedMinutes?: number): Promise<RideResultTimes | null> => {
      await starting.current;
      const id = rideId.current;
      if (!id) return null;
      rideId.current = null; // closed from now on, even before the last points are sent
      const batch = buffer.current.takeBatch();
      buffer.current.reset();
      if (batch) await sendRidePoints(id, batch, simulated);
      return endRide(id, arrived, simulatedMinutes);
    },
    [simulated],
  );

  /** A new ride (not a reroute): ends any ride still open as not arrived. */
  const start = useCallback(
    (plan: { eta_min: number | null; distance_m: number }, from: LatLon, to: LatLon, profile: Profile) => {
      const previous = rideId.current ? end(false) : Promise.resolve(null);
      starting.current = previous.then(async () => {
        buffer.current.reset();
        const r = await startRide({
          start: from,
          end: to,
          profile,
          predicted_min: plan.eta_min,
          planned_m: plan.distance_m,
          simulated,
        });
        rideId.current = r?.ride_id ?? null;
      });
    },
    [end, simulated],
  );

  /** A GPS reading during the ride. */
  const point = useCallback((p: RidePoint) => {
    if (rideId.current || starting.current) buffer.current.push(p);
  }, []);

  /** The rider went off the route here (feeds the trouble spots). */
  const event = useCallback(
    (kind: "off_route" | "reroute", at: LatLon) => {
      const id = rideId.current;
      if (id) sendRideEvent(id, kind, at, simulated);
    },
    [simulated],
  );

  // Send points every 15 s, and close the ride if the page is closed mid-ride
  useEffect(() => {
    const timer = setInterval(flush, FLUSH_MS);
    const closing = () => {
      if (rideId.current) end(false);
    };
    window.addEventListener("pagehide", closing);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", closing);
    };
  }, [flush, end]);

  return { start, point, event, end, active: () => !!rideId.current };
}
