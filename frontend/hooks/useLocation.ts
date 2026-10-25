"use client";

import { useEffect, useState } from "react";
import type { LatLon } from "@/lib/api";

export interface Location {
  position: LatLon | null;
  accuracy: number | null; // metres; GPS is rarely better than 5-10 m
  time: number; // when the fix was taken (ms)
  error: string | null;
}

const hasGps = () => typeof navigator !== "undefined" && !!navigator.geolocation;

/** Live GPS position via navigator.geolocation.watchPosition (needs HTTPS on phones). */
export function useLocation(enabled = true): Location {
  const [loc, setLoc] = useState<Location>({ position: null, accuracy: null, time: 0, error: null });

  useEffect(() => {
    if (!enabled || !hasGps()) return;
    const id = navigator.geolocation.watchPosition(
      (p) =>
        setLoc({ position: [p.coords.latitude, p.coords.longitude], accuracy: p.coords.accuracy, time: p.timestamp, error: null }),
      (e) => setLoc((l) => ({ ...l, error: e.message || "Location unavailable" })),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [enabled]);

  if (enabled && !hasGps()) return { ...loc, error: "This browser has no GPS access." };
  return loc;
}
