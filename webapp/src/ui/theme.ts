// Theme resolution and persistence. Precedence: an explicit choice (`sn.theme`,
// stamped on `<html data-theme>`), else the live OS `prefers-color-scheme`, else
// light. `index.html` also restores it inline before first paint to avoid a
// flash; `applyStoredTheme()` is the idempotent module-side copy.

import type { Theme } from "../core/types";
import { readLocal, writeLocal } from "./storage";

export const THEME_KEY = "sn.theme";

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

export function readStoredTheme(): Theme | null {
  const raw = readLocal(THEME_KEY);
  return isTheme(raw) ? raw : null;
}

/** Persist an explicit choice. A storage failure must not break the toggle. */
export function storeTheme(theme: Theme): void {
  writeLocal(THEME_KEY, theme);
}

export function currentTheme(): Theme {
  const attr = document.documentElement.getAttribute("data-theme");
  if (isTheme(attr)) return attr;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Pin a theme. Callers handle the repaint (evicting off-theme bitmaps). */
export function setTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  storeTheme(theme);
}

/** Restore a pinned theme; no stored choice leaves the OS preference live. */
export function applyStoredTheme(): void {
  const stored = readStoredTheme();
  if (stored) document.documentElement.setAttribute("data-theme", stored);
}
