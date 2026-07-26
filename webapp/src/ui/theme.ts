// Theme resolution and persistence.
//
// Precedence, highest first:
//   1. an explicit choice the user made with the toggle, stored under `sn.theme`
//      and stamped onto `<html data-theme>`;
//   2. the OS `prefers-color-scheme`, followed *live* — while nothing is pinned
//      there is no `data-theme` attribute at all, so the media query in
//      styles.css drives the tokens and an OS flip applies immediately;
//   3. light, the stylesheet's default.
//
// The attribute is the single source of truth at runtime: `currentTheme()` reads
// it first and falls back to the media query, which is exactly rule 1-then-2.
// Storage only exists so the choice survives a reload.
//
// Storage goes through ./storage, which cannot throw — see the note there on why
// an unguarded `localStorage` read is a boot hazard.
//
// The restore happens twice, deliberately. `index.html` carries a tiny inline
// script that stamps the attribute before first paint (a deferred module bundle
// can — and usually does — run after the browser has already painted the body
// background, which is a visible flash of the wrong theme). `applyStoredTheme()`
// re-applies it from the entry module so the behaviour still holds anywhere the
// inline script isn't present or was blocked, and so it is unit-testable. It is
// idempotent, so running both costs nothing.

import type { Theme } from "../core/types";
import { readLocal, writeLocal } from "./storage";

/** localStorage key, mirroring the `sn.mode` convention in main.ts. */
export const THEME_KEY = "sn.theme";

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

/** The pinned choice, or null when the user has never chosen (follow the OS). */
export function readStoredTheme(): Theme | null {
  const raw = readLocal(THEME_KEY);
  return isTheme(raw) ? raw : null;
}

/** Persist an explicit choice. A storage failure must not break the toggle. */
export function storeTheme(theme: Theme): void {
  writeLocal(THEME_KEY, theme);
}

/** Resolve the theme in force right now: pinned attribute, else the OS, else light. */
export function currentTheme(): Theme {
  const attr = document.documentElement.getAttribute("data-theme");
  if (isTheme(attr)) return attr;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Pin a theme: stamp the attribute and remember it. Callers are responsible for
 * the repaint (evicting off-theme bitmaps and bumping the render engines) —
 * this only moves the preference.
 */
export function setTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  storeTheme(theme);
}

/**
 * Restore a previously pinned theme onto `<html>`. No stored choice means no
 * attribute, which is what keeps the OS preference live. Safe to call more than
 * once and safe to call before the app shell exists.
 */
export function applyStoredTheme(): void {
  const stored = readStoredTheme();
  if (stored) document.documentElement.setAttribute("data-theme", stored);
}
