// The shared floating-popover shell for the "⋯" menu and the history menu: a
// body-level portal, trigger-anchored fixed positioning, and one app-wide
// "one open at a time" registry with outside-click/Escape/scroll dismissal.
// Callers own the contents and their roving focus.

import { el } from "./dom";

export const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 6;

/**
 * The body-level host for open popovers, outside every scroller/transformed
 * ancestor so a `position: fixed` pop resolves against the viewport.
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
 * Position an open, portaled pop below the trigger, right-aligned; flips to
 * left-align or upward when it would leave the viewport.
 */
export function placePop(trigger: HTMLElement, pop: HTMLElement): void {
  const r = trigger.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;

  let left = r.right - pw;
  if (left < VIEWPORT_MARGIN) left = r.left;
  if (left + pw > vw - VIEWPORT_MARGIN) left = vw - VIEWPORT_MARGIN - pw;
  if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;

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
 * One registered open popover. `contains` decides what counts as inside, since
 * the pop is portaled away from its trigger.
 */
export interface OpenPopover {
  trigger: HTMLElement;
  contains: (target: Node) => boolean;
  close: () => void;
}

let current: OpenPopover | null = null;
let listenersInstalled = false;

/** Close any open popover; call before replacing the DOM its trigger lives in. */
export function closeOpenPopover(): void {
  current?.close();
}

function installListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  document.addEventListener("click", (e) => {
    if (!current) return;
    if (e.target instanceof Node && current.contains(e.target)) return;
    current.close();
  });
  // A fixed pop doesn't ride content scroll: close on any (captured) scroll or
  // resize rather than strand it beside a moved trigger.
  window.addEventListener("scroll", () => current?.close(), true);
  window.addEventListener("resize", () => current?.close());
  // Capture + stopPropagation so Escape doesn't also reach the reader or router.
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

/** Register `p` as the open popover, closing the previous one. */
export function openPopover(p: OpenPopover): void {
  installListeners();
  if (current && current !== p) current.close();
  current = p;
}

export function clearPopover(p: OpenPopover): void {
  if (current === p) current = null;
}
