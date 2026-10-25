"use client";

import { useEffect, useState } from "react";
import type { LatLon } from "@/lib/api";

export interface Location {
  position: LatLon | null;
  accuracy: number | null; // metres; GPS is rarely better than 5-10 m
  error: string | null;
}

/** Live GPS position via navigator.geolocation.watchPosition (needs HTTPS on phones). */
export function useLocation(enabled = true): Location {
  const [loc, setLoc] = useState<Location>({ position: null, accuracy: null, error: null });

  useEffect(() => {
    if (!enabled) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLoc((l) => ({ ...l, error: "This browser has no GPS access." }));
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (p) => setLoc({ position: [p.coords.latitude, p.coords.longitude], accuracy: p.coords.accuracy, error: null }),
      (e) => setLoc((l) => ({ ...l, error: e.message || "Location unavailable" })),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [enabled]);

  return loc;
}
