import type { RouteResult } from "./api";

export const mockRoute: RouteResult = {
  route: [
    [51.7536, -1.2544],
    [51.7548, -1.2580],
  ],
  stats: { distance_m: 400, climb_m: 2, eta_min: 2, cycleway_share: 0.5, lit_share: 1 },
  steps: [
    { text: "Turn left onto Walton Street in 50 m", distance_m: 50, lat: 51.7540, lon: -1.2560, maneuver: "left" },
    { text: "You have arrived", distance_m: 0, lat: 51.7548, lon: -1.2580, maneuver: "arrive" },
  ],
};
