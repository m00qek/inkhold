// Shared page chrome for the auth views: the wordmark and the ruled-paper sheet.

import { el } from "./dom";
import { currentTheme, setTheme } from "./theme";

// The glyph shows what a click gives you: in the dark you reach for the sun.
const SUN =
  '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
const MOON = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';

function themeGlyph(): string {
  const paths = currentTheme() === "dark" ? SUN : MOON;
  return `<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

/**
 * The product mark: two brackets (current ink) holding a stroke (`--accent`).
 * Same geometry as `public/icon.svg`, which bakes the palette in; change both.
 */
export function brandMark(px = 26): string {
  return (
    `<svg width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" aria-hidden="true">` +
    '<g stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M9 3.5H6.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2H9"/>' +
    '<path d="M15 3.5h2.5a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H15"/></g>' +
    '<path d="M12 8v8" stroke="var(--accent)" stroke-width="3.4" stroke-linecap="round"/></svg>'
  );
}

function wordmark(): HTMLElement {
  return el(
    "p",
    { class: "wordmark" },
    el("span", { class: "wordmark__mark", html: brandMark() }),
    el("span", { class: "wordmark__name", text: "INKHOLD" }),
  );
}

export function sheet(...content: (Node | string)[]): HTMLElement {
  return el("main", { class: "sheet" }, wordmark(), ...content);
}

/** The floating light/dark toggle for the pre-auth views (no bitmaps to repaint). */
function themeToggle(): HTMLElement {
  const btn = el("button", {
    class: "theme",
    type: "button",
    "aria-label": "Switch between light and dark",
    title: "Light or dark",
    html: themeGlyph(),
    onClick: () => {
      setTheme(currentTheme() === "dark" ? "light" : "dark");
      btn.innerHTML = themeGlyph();
    },
  });
  return btn;
}

/** Onboarding progress dots, 1-based (sign in, password, connect); first run only. */
export function stepDots(now: 1 | 2 | 3): HTMLElement {
  const dot = (i: number) =>
    el("span", { class: `dot ${i === now ? "is-now" : i < now ? "is-done" : ""}`.trim() });
  return el(
    "div",
    { class: "dots", role: "group", "aria-label": `Step ${now} of 3` },
    dot(1),
    dot(2),
    dot(3),
  );
}

/** The pre-auth page frame: the fixed theme toggle plus the ruled sheet. */
export function authView(...content: (Node | string)[]): HTMLElement {
  return el("div", { class: "preauth" }, themeToggle(), sheet(...content));
}
