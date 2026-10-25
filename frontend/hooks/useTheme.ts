"use client";

import { useState, useSyncExternalStore } from "react";
import { autoTheme, pickTheme, toggleOverride, type Theme } from "@/lib/theme";

const KEY = "oxride-theme"; // the manual choice, kept between visits
const QUERY = "(prefers-color-scheme: dark)";

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function readOverride(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null; // private mode or storage blocked: just follow the phone
  }
}

/** The palette to show now, and the toggle that overrides it. */
export function useTheme(navigating: boolean) {
  const systemDark = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
  const [override, setOverride] = useState<Theme | null>(readOverride);
  const theme = pickTheme(override, systemDark, navigating);

  const toggle = () => {
    const next = toggleOverride(theme, autoTheme(systemDark, navigating));
    setOverride(next);
    try {
      if (next) localStorage.setItem(KEY, next);
      else localStorage.removeItem(KEY);
    } catch {
      // not saved: still applies for this visit
    }
  };

  return { theme, toggle };
}
