// A one-finger sideways swipe on a viewer's stage turns the page: to the left
// for the next, to the right for the previous, as on a tablet.
//
// Only a swipe that is quick, long enough and mostly sideways counts, so a
// scroll down a tall page or a tap is left alone. A page zoomed wider than the
// stage pans first: the swipe turns only from the edge it was already at.
// A path gesture needs a single-pointer alternative (WCAG 2.5.1): the pager's
// buttons and the arrow keys stay.

export interface SwipeTarget {
  /** The scrolling stage the finger is on. */
  scroller: HTMLElement;
  /** Turn by one page: 1 is the next, -1 the previous. */
  turn(dir: 1 | -1): void;
  /** False while there is nothing to turn (an image, an empty stage). */
  enabled?(): boolean;
}

/** Shortest swipe, in px, or this share of the stage's width when that is more. */
const SWIPE_MIN = 48;
const SWIPE_SHARE = 0.12;
/** Sideways at least this many times more than up or down. */
const SWIPE_SLOPE = 1.8;
const SWIPE_MS = 700;
/** Scroll slack still counted as being at an edge. */
const EDGE = 2;

/** Whether `from`, or anything between it and `stop`, scrolls sideways on its own. */
function insideSideScroller(from: Element, stop: HTMLElement): boolean {
  for (let n: Element | null = from; n && n !== stop; n = n.parentElement) {
    if (n.scrollWidth <= n.clientWidth + EDGE) continue;
    const x = getComputedStyle(n).overflowX;
    if (x === "auto" || x === "scroll") return true;
  }
  return false;
}

export function attachSwipe(t: SwipeTarget): void {
  const s = t.scroller;
  let at: { x: number; y: number; t: number; x1: number; y1: number; left: boolean; right: boolean } | null = null;

  s.addEventListener(
    "touchstart",
    (e) => {
      at = null;
      if (e.touches.length !== 1 || (t.enabled && !t.enabled())) return;
      // Dragging a text selection's handles is not a page turn.
      const sel = document.getSelection();
      if (sel && !sel.isCollapsed) return;
      // Nor is scrolling something inside that scrolls sideways itself (the pages strip).
      if (e.target instanceof Element && insideSideScroller(e.target, s)) return;
      const p = e.touches[0]!;
      at = {
        x: p.clientX,
        y: p.clientY,
        t: performance.now(),
        x1: p.clientX,
        y1: p.clientY,
        left: s.scrollLeft <= EDGE,
        right: s.scrollLeft + s.clientWidth >= s.scrollWidth - EDGE,
      };
    },
    { passive: true },
  );

  s.addEventListener(
    "touchmove",
    (e) => {
      if (!at) return;
      // A second finger makes it a pinch.
      if (e.touches.length !== 1) {
        at = null;
        return;
      }
      const p = e.touches[0]!;
      at.x1 = p.clientX;
      at.y1 = p.clientY;
    },
    { passive: true },
  );

  s.addEventListener("touchend", (e) => {
    const g = at;
    if (!g || e.touches.length > 0) return;
    at = null;
    const dx = g.x1 - g.x;
    const dy = g.y1 - g.y;
    const far = Math.abs(dx) >= Math.max(SWIPE_MIN, s.clientWidth * SWIPE_SHARE);
    const sideways = Math.abs(dx) >= SWIPE_SLOPE * Math.abs(dy);
    if (!far || !sideways || performance.now() - g.t > SWIPE_MS) return;
    if (dx < 0 && g.right) t.turn(1);
    else if (dx > 0 && g.left) t.turn(-1);
  });
  s.addEventListener("touchcancel", () => (at = null));
}
