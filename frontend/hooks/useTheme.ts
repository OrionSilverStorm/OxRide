"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
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

  // Put the palette on <html> too, so the page behind the map (what iPhones show around the
  // browser bars and notch) matches, and tint the browser bars with the card colour
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add(theme);
    root.style.colorScheme = theme;
    const card = getComputedStyle(root).getPropertyValue("--card").trim();
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", card));
    return () => {
      root.classList.remove(theme);
      root.style.colorScheme = "";
    };
  }, [theme]);

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
