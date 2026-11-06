// Pinch and double-tap zoom for a viewer's stage, on a touch screen.
//
// While two fingers move, the page is only scaled by a CSS transform (cheap,
// no re-render). When they lift, the viewer is handed the new size as a
// continuous factor of Fit and re-renders sharp at it; the transform stays
// until the page's own box has changed, then the stage scrolls so what was
// under the fingers is under them again. A double tap goes back to Fit, or
// from Fit zooms in on the tapped spot.
//
// Not the only way to zoom: a multi-finger gesture needs a single-pointer
// alternative (WCAG 2.5.1), which every viewer keeps in its zoom stepper.

export interface PinchTarget {
  /** The scrolling stage the fingers are on. */
  scroller: HTMLElement;
  /** What grows: the page box the viewer sizes. `null` when nothing is shown. */
  surface(): HTMLElement | null;
  /** The page's size now, as a factor of Fit (1 is Fit). */
  scale(): number;
  /** Size the page to `k` × Fit; 1 means Fit itself, the stepper back on it. */
  setScale(k: number): void;
}

const PINCH_MIN = 1;
const PINCH_MAX = 5;
/** Where a double tap from Fit lands. */
const DOUBLE_TAP_SCALE = 2.5;

/** Whether a factor the gesture settled on is Fit itself (the viewer goes back to its Fit rung). */
export const isFit = (k: number): boolean => k <= 1.001;
/** A pinch in the zoom stepper's readout: its factor of Fit. */
export const pinchLabel = (k: number): string => `${k.toFixed(1)}×`;

const TAP_SLOP = 12;
const TAP_MS = 300;
/** Longest wait for the viewer's re-render before the transform is let go anyway. */
const SETTLE_MS = 2000;

const clamp = (k: number): number => Math.min(PINCH_MAX, Math.max(PINCH_MIN, k));

interface Anchor {
  /** The point on screen to hold still. */
  x: number;
  y: number;
  /** The same point as a fraction of the page's box. */
  fx: number;
  fy: number;
}

export function attachPinch(t: PinchTarget): void {
  const s = t.scroller;
  let pinch: { d0: number; k0: number; r: number; el: HTMLElement; at: Anchor } | null = null;
  let tap: { x: number; y: number; t: number; moved: boolean } | null = null;
  let lastTap: { x: number; y: number; t: number } | null = null;
  let settling = 0;

  const anchorOn = (el: HTMLElement, x: number, y: number): Anchor => {
    const r = el.getBoundingClientRect();
    return { x, y, fx: r.width > 0 ? (x - r.left) / r.width : 0.5, fy: r.height > 0 ? (y - r.top) / r.height : 0.5 };
  };

  /** Hold `el` at `scaleBy` until its own box changes size, then let go and re-anchor. */
  function commit(el: HTMLElement, k: number, at: Anchor): void {
    const w0 = el.offsetWidth;
    const h0 = el.offsetHeight;
    const mine = ++settling;
    t.setScale(k);
    const started = performance.now();
    const settle = (): void => {
      if (mine !== settling) return;
      const grown = el.offsetWidth !== w0 || el.offsetHeight !== h0;
      if (!grown && performance.now() - started < SETTLE_MS) {
        requestAnimationFrame(settle);
        return;
      }
      el.style.transform = "";
      el.style.transformOrigin = "";
      const r = el.getBoundingClientRect();
      s.scrollLeft += r.left + at.fx * r.width - at.x;
      s.scrollTop += r.top + at.fy * r.height - at.y;
    };
    requestAnimationFrame(settle);
  }

  s.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length === 1) {
        const p = e.touches[0]!;
        tap = { x: p.clientX, y: p.clientY, t: performance.now(), moved: false };
        return;
      }
      tap = null;
      if (e.touches.length !== 2) return;
      const el = t.surface();
      if (!el) return;
      const [a, b] = [e.touches[0]!, e.touches[1]!];
      const x = (a.clientX + b.clientX) / 2;
      const y = (a.clientY + b.clientY) / 2;
      // A new pinch over one still settling takes the page as it now looks.
      settling++;
      el.style.transform = "";
      const at = anchorOn(el, x, y);
      const box = el.getBoundingClientRect();
      el.style.transformOrigin = `${x - box.left}px ${y - box.top}px`;
      pinch = { d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, k0: t.scale(), r: 1, el, at };
    },
    { passive: true },
  );

  s.addEventListener(
    "touchmove",
    (e) => {
      if (tap && e.touches.length === 1) {
        const p = e.touches[0]!;
        if (Math.hypot(p.clientX - tap.x, p.clientY - tap.y) > TAP_SLOP) tap.moved = true;
      }
      if (!pinch || e.touches.length < 2) return;
      // Ours, not the browser's: no scroll or page zoom under a pinch.
      e.preventDefault();
      const [a, b] = [e.touches[0]!, e.touches[1]!];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      pinch.r = clamp(pinch.k0 * (d / pinch.d0)) / pinch.k0;
      pinch.el.style.transform = `scale(${pinch.r})`;
    },
    { passive: false },
  );

  const end = (e: TouchEvent): void => {
    if (pinch && e.touches.length < 2) {
      const { k0, r, el, at } = pinch;
      pinch = null;
      lastTap = null;
      const k = clamp(k0 * r);
      if (Math.abs(k - k0) < 0.02) {
        el.style.transform = "";
        el.style.transformOrigin = "";
      } else commit(el, k, at);
      return;
    }
    if (!tap || e.touches.length > 0 || e.type === "touchcancel") return;
    const now = performance.now();
    const quick = !tap.moved && now - tap.t < TAP_MS;
    const here = { x: tap.x, y: tap.y, t: now };
    tap = null;
    if (!quick) {
      lastTap = null;
      return;
    }
    if (lastTap && now - lastTap.t < TAP_MS && Math.hypot(here.x - lastTap.x, here.y - lastTap.y) < TAP_SLOP * 2) {
      lastTap = null;
      const el = t.surface();
      if (!el) return;
      e.preventDefault();
      commit(el, t.scale() > 1.02 ? 1 : DOUBLE_TAP_SCALE, anchorOn(el, here.x, here.y));
      return;
    }
    lastTap = here;
  };
  s.addEventListener("touchend", end, { passive: false });
  s.addEventListener("touchcancel", end);
  // Safari's own pinch, which `touch-action` alone may not stop.
  s.addEventListener("gesturestart", (e) => e.preventDefault());
}
