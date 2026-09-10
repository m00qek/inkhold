// Shared page chrome: the wordmark and the ruled-paper "sheet" that every auth
// view is built on. The sheet is the app's signature element (see styles.css).

import { el } from "./dom";
import { currentTheme, setTheme } from "./theme";

// The glyph shows what a click GIVES you, not the current state: in the dark you
// reach for the sun. (Same reading as the rail's post-auth toggle.)
const SUN =
  '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
const MOON = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';

function themeGlyph(): string {
  const paths = currentTheme() === "dark" ? SUN : MOON;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

/**
 * The product mark: two brackets holding a stroke.
 *
 * NOT in `ICONS`. That table is one path string per glyph, drawn by `svg()` in a
 * single `currentColor`; this one is two colours deliberately — the brackets take
 * whatever ink surrounds them, the held stroke takes `--accent`, which the token
 * file names as *brand* before it names selection or focus.
 *
 * IT IS THE SAME GEOMETRY AS `public/icon.svg` and the two must change together.
 * A favicon cannot read the app's tokens, so that file bakes the palette in and
 * this one inherits it; there is no way to share the source without shipping the
 * stylesheet to the tab strip.
 *
 * Sized by attribute rather than by CSS so it needs no rule of its own, and
 * hidden from assistive tech because the wordmark beside it already says the
 * name.
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

/** The product wordmark: the mark, then the name in the utility mono face. */
export function wordmark(): HTMLElement {
  return el(
    "p",
    { class: "wordmark" },
    el("span", { class: "wordmark__mark", html: brandMark() }),
    el("span", { class: "wordmark__name", text: "INKHOLD" }),
  );
}

/** Wraps view content in the ruled-paper sheet, with the wordmark at the top. */
export function sheet(...content: (Node | string)[]): HTMLElement {
  return el("section", { class: "sheet" }, wordmark(), ...content);
}

/**
 * The floating light/dark toggle for the pre-auth window (login, change-password,
 * connect). The app shell has its own toggle in the rail, but that lives behind
 * the auth wall — before you are in, this is the only theme control, so it is
 * chrome for the whole pre-auth window rather than any one step.
 *
 * Unlike the shell's toggle it does no repaint bookkeeping: there are no cached
 * note bitmaps on screen out here, so flipping `data-theme` (via {@link setTheme})
 * and repainting the button's own glyph is the entire job.
 */
export function themeToggle(): HTMLElement {
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

/**
 * The three-step onboarding progress dots. `now` is 1-based (1 = sign in, 2 =
 * choose a password, 3 = connect the device); earlier steps read as done. Shown
 * only on the first-run path — a returning sign-in or a re-login is not a journey
 * through three steps and gets no dots.
 */
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

/**
 * The pre-auth page frame: the floating theme toggle plus the ruled sheet. Every
 * pre-auth view (login, change-password, connect) is one of these, so the toggle
 * is present the same way on all three. The toggle is `position: fixed`, so its
 * place in the DOM does not matter — a sibling of the sheet keeps the sheet's own
 * layout untouched.
 */
export function authView(...content: (Node | string)[]): HTMLElement {
  return el("div", { class: "preauth" }, themeToggle(), sheet(...content));
}
