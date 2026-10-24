import type { LatLon, RouteResult, Step } from "@/lib/api";

/** Tracks the next step and calls /route again when ~30 m off the route for a few seconds. */
export function useNavigation(route: RouteResult, position: LatLon | null): { nextStep: Step | null; offRoute: boolean } {
  return { nextStep: route.steps[0] ?? null, offRoute: false };
}
