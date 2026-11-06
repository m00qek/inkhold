// The `.spd` viewer's zoom: the stepper's ladder (Fit, 100%, 150%), a pinch's
// factor of Fit, and the size they give the sketch. Zoom only resizes the
// layer canvases' wrap; the canvases are drawn once at base resolution.

import { contentBox } from "../../ui/dom";
import { attachPinch, isFit, pinchLabel } from "../../ui/pinchZoom";
import { createZoomStepper, FIT_PAGE, type ZoomStepper } from "../viewer/viewerControls";

const ZOOMS = [FIT_PAGE, "100%", "150%"] as const;

export interface SpdZoomDeps {
  /** The scrolling stage, padded clear of a phone's layers sheet. */
  stage: HTMLElement;
  /** What grows: the wrap of layer canvases. */
  surface: HTMLElement;
  /** The sketch's base size in px, or null while none is open. */
  dims: () => { w: number; h: number } | null;
}

export interface SpdZoom {
  stepper: ZoomStepper<number>;
  /** Size the sketch for the zoom now (after a stage resize, a panel, a new sketch). */
  apply(): void;
  /** Back to Fit, for a new sketch. */
  reset(): void;
  destroy(): void;
}

export function createSpdZoom(deps: SpdZoomDeps): SpdZoom {
  let rung = 0;
  /** A pinch's size as a factor of Fit; set, it stands in for `rung`. */
  let pinch: number | null = null;

  // Own readout class: a shared `.zoom` would match several mounted viewers.
  const stepper = createZoomStepper({
    readoutClass: "spd-zoom",
    initial: 0,
    format: (i: number) => ZOOMS[i]!,
    onStep: (dir) => {
      // A step leaves a pinch for the ladder, from the rung it was on.
      pinch = null;
      rung = Math.max(0, Math.min(ZOOMS.length - 1, rung + dir));
      apply();
      return rung;
    },
  });

  /** Whole in the stage's content box, never enlarged past 100%. */
  function fitScale(): number {
    const d = deps.dims();
    if (!d) return 1;
    const box = contentBox(deps.stage);
    return Math.min(1, Math.max(box.w, 64) / d.w, Math.max(box.h, 64) / d.h) || 1;
  }

  function scale(): number {
    if (pinch !== null) return fitScale() * pinch;
    const z = ZOOMS[rung]!;
    return z === FIT_PAGE ? fitScale() : Number.parseInt(z, 10) / 100;
  }

  function apply(): void {
    const d = deps.dims();
    if (!d) return;
    const s = scale();
    deps.surface.style.width = `${Math.max(1, Math.round(d.w * s))}px`;
    deps.surface.style.height = `${Math.max(1, Math.round(d.h * s))}px`;
  }

  function reset(): void {
    rung = 0;
    pinch = null;
    stepper.set(0);
  }

  // Fit follows the window; a set size stays.
  const onResize = (): void => {
    if (rung === 0) apply();
  };
  window.addEventListener("resize", onResize);

  // Pinch and double tap on the sketch.
  attachPinch({
    scroller: deps.stage,
    surface: () => (deps.dims() ? deps.surface : null),
    scale: () => scale() / (fitScale() || 1),
    setScale: (k) => {
      if (isFit(k)) reset();
      else {
        pinch = k;
        stepper.show(pinchLabel(k));
      }
      apply();
    },
  });

  return { stepper, apply, reset, destroy: () => window.removeEventListener("resize", onResize) };
}
