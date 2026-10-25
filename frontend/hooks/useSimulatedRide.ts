import type { LatLon, RouteResult } from "@/lib/api";

/** Moves a fake dot along the route at bike speed; wrongTurn() demos rerouting. */
export function useSimulatedRide(route: RouteResult): { position: LatLon | null; start: () => void; wrongTurn: () => void } {
  return { position: null, start: () => {}, wrongTurn: () => {} };
}
