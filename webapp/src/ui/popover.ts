// The shared floating-popover shell for the "⋯" menu and the history menu: a
// body-level portal, trigger-anchored fixed positioning, and one app-wide
// "one open at a time" registry with outside-click/Escape/scroll dismissal.
// Callers own the contents and their roving focus.

import { isPhone } from "./breakpoints";
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
    // Inside the page's <main> where there is one, so a menu is never content
    // outside every landmark; it is `position: fixed`, so where it sits in
    // the tree doesn't move it.
    (document.querySelector("main") ?? document.body).appendChild(portalRoot);
  }
  return portalRoot;
}

/**
 * Position an open, portaled pop below the trigger, right-aligned; flips to
 * left-align or upward when it would leave the viewport. On a phone it is a
 * sheet at the bottom of the screen instead (`data-sheet`, 23-phone.css),
 * where a thumb reaches it.
 */
export function placePop(trigger: HTMLElement, pop: HTMLElement): void {
  if (isPhone()) {
    pop.dataset["sheet"] = "";
    pop.style.left = "";
    pop.style.top = "";
    return;
  }
  delete pop.dataset["sheet"];
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
  /** The pop itself, when `placePop` placed it: a sheet (`data-sheet`) is
   *  not tied to its trigger, so scrolling and resizing leave it open. */
  pop?: HTMLElement;
}

let current: OpenPopover | null = null;
let listenersInstalled = false;

/** Close any open popover; call before replacing the DOM its trigger lives in. */
export function closeOpenPopover(): void {
  current?.close();
}

/** Close the open popover only if its trigger is inside `root`: a repaint
 *  of `root` must not close a menu that belongs elsewhere (a bar's ⋯). */
export function closePopoverWithin(root: Element): void {
  if (current && root.contains(current.trigger)) current.close();
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
  // resize rather than strand it beside a moved trigger. Not a sheet along
  // the bottom (a phone's menus), which no trigger holds, and not a scroll
  // of the pop's own rows.
  const anchored = () => current !== null && current.pop?.hasAttribute("data-sheet") !== true;
  window.addEventListener(
    "scroll",
    (e) => {
      if (!anchored()) return;
      if (e.target instanceof Node && current?.pop?.contains(e.target)) return;
      current?.close();
    },
    true,
  );
  window.addEventListener("resize", () => {
    if (anchored()) current?.close();
  });
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
