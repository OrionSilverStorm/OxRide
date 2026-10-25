// Which Everforest palette to show. Pure functions so they can be unit tested:
//   npm run test:unit

export type Theme = "light" | "dark";

/** The palette without a manual choice: navigation is always dark, planning follows the phone. */
export function autoTheme(systemDark: boolean, navigating: boolean): Theme {
  return navigating || systemDark ? "dark" : "light";
}

/** A manual choice (the toggle) wins over everything else. */
export function pickTheme(override: Theme | null, systemDark: boolean, navigating: boolean): Theme {
  return override ?? autoTheme(systemDark, navigating);
}

/**
 * The override after pressing the toggle. Flipping back to what the automatic choice
 * would show clears the override, so the app follows the phone again.
 */
export function toggleOverride(current: Theme, auto: Theme): Theme | null {
  const next: Theme = current === "dark" ? "light" : "dark";
  return next === auto ? null : next;
}
