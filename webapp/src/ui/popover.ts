// The app's ONE floating-popover SHELL — position, dismiss and the popover-level
// a11y that every anchored panel shares, factored out of `ui/menu.ts` so both the
// "⋯" overflow menu (simple rows) and the version-history menu (rich two-line
// rows) spring from the SAME machinery rather than each hand-rolling positioning.
//
// It owns only the shell: the body-level PORTAL a pop is moved to (so no
// ancestor's overflow/transform/stacking can clip or mis-anchor it), the
// trigger-anchored fixed positioning (`placePop`), and the single app-wide
// "one open at a time" registry with its document listeners — outside-click and
// Escape (which returns focus to the trigger), plus close-on-scroll/resize.
//
// What it does NOT own is what a pop CONTAINS: the rows, their roving focus, the
// aria roles. `menu.ts` keeps its item roving; `historyPanel.ts` keeps its row
// roving. Each builds its pop and its `contains()` and registers it here.

import { el } from "./dom";

/** Keep-on-screen margin and the trigger↔pop gap, in px. */
export const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 6;

/**
 * The body-level host for open popovers. A single reused node under `document.body`,
 * OUTSIDE every scroller/transformed ancestor, so a `position: fixed` pop resolves
 * against the viewport and nothing can clip it. Shared by every popover so a test
 * (and the click-away logic) has one root to reason about (`.menu-portal`).
 */
let portalRoot: HTMLElement | null = null;
export function getPortalRoot(): HTMLElement {
  if (!portalRoot || !portalRoot.isConnected) {
    portalRoot = el("div", { class: "menu-portal" });
    document.body.appendChild(portalRoot);
  }
  return portalRoot;
}

/**
 * Position an OPEN, already-portaled pop with `position: fixed`, read off the
 * trigger's viewport rect. Default: dropped below the trigger with the pop's
 * RIGHT edge aligned to the trigger's right edge. Edge-aware: a right-align that
 * runs off the LEFT flips to left-align (then clamps within the viewport); a drop
 * that runs off the BOTTOM opens upward. The pop is always left fully on-screen.
 */
export function placePop(trigger: HTMLElement, pop: HTMLElement): void {
  const r = trigger.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;

  // Horizontal — right-align to the trigger, flip to left-align if that overflows
  // the left edge, then clamp so neither edge leaves the viewport margin.
  let left = r.right - pw;
  if (left < VIEWPORT_MARGIN) left = r.left;
  if (left + pw > vw - VIEWPORT_MARGIN) left = vw - VIEWPORT_MARGIN - pw;
  if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;

  // Vertical — below the trigger, flip above if the drop overflows the bottom.
  let top = r.bottom + TRIGGER_GAP;
  if (top + ph > vh - VIEWPORT_MARGIN) {
    const above = r.top - TRIGGER_GAP - ph;
    top = above >= VIEWPORT_MARGIN ? above : Math.max(VIEWPORT_MARGIN, vh - VIEWPORT_MARGIN - ph);
  }
  if (top < VIEWPORT_MARGIN) top = VIEWPORT_MARGIN;

  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

/**
 * One registered open popover. `trigger` is where focus returns on Escape and a
 * click that must NOT dismiss; `contains` decides whether a click target is
 * "inside" this popover system (the pop is portaled elsewhere in the tree, so the
 * caller composes trigger + pop + any wrapper into one test); `close` tears it
 * down. Held app-wide so opening any popover closes the last, an outside click
 * closes it, and Escape can find it — one document listener pair for the page.
 */
export interface OpenPopover {
  trigger: HTMLElement;
  contains: (target: Node) => boolean;
  close: () => void;
}

let current: OpenPopover | null = null;
let listenersInstalled = false;

/**
 * Close whatever popover is open, if any. For a surface about to REPLACE the DOM a
 * trigger lives in (the gallery repaints on every navigation and sync bump):
 * without it, `current` would keep pointing at a detached node.
 */
export function closeOpenPopover(): void {
  current?.close();
}

function installListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  document.addEventListener("click", (e) => {
    if (!current) return;
    // A click anywhere the open popover considers "inside" (its trigger, its pop,
    // or a wrapper it owns) must not dismiss it.
    if (e.target instanceof Node && current.contains(e.target)) return;
    current.close();
  });
  // A fixed pop doesn't ride content scroll, so any ancestor scroll (capture,
  // since a nested scroller's event never bubbles to window) or a resize would
  // strand it beside a moved trigger — close it; re-opening re-anchors.
  window.addEventListener("scroll", () => current?.close(), true);
  window.addEventListener("resize", () => current?.close());
  // CAPTURE + stopPropagation: the popover is the innermost dismissable thing on
  // screen, so its Escape must not also reach the reader or the route handler.
  document.addEventListener(
    "keydown",
    (e) => {
      if (!current || e.key !== "Escape") return;
      e.stopPropagation();
      const { trigger, close } = current;
      close();
      trigger.focus();
    },
    true,
  );
}

/**
 * Register `p` as THE open popover, closing whatever was open before. The caller
 * has already portaled + positioned its pop; this only makes it the one the
 * document listeners (and the next `openPopover`) act on.
 */
export function openPopover(p: OpenPopover): void {
  installListeners();
  if (current && current !== p) current.close();
  current = p;
}

/** Deregister `p` if it is the open one — called from a popover's own `close`. */
export function clearPopover(p: OpenPopover): void {
  if (current === p) current = null;
}
