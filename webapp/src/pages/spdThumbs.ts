// The .spd layer panel's thumbnails.

import { el } from "../ui/dom";
import { drawDownscaledInto } from "../render/thumbnails";
import { type LayerView } from "./spdViewer";

// ---- layer thumbnails ----

/** Thumbnail backing height, device px (~2× the CSS box). Width follows the
 *  drawing's aspect, capped at 2.5× so very wide drawings letterbox. */
const THUMB_H = 202;
const THUMB_MAX_ASPECT = 2.5;

function thumbAspect(v: LayerView): number {
  const cw = v.canvas.width;
  const ch = v.canvas.height;
  if (cw <= 0 || ch <= 0) return 3 / 4;
  return Math.min(cw / ch, THUMB_MAX_ASPECT);
}

/** A blank Reference Layer (id 9999, no tiles) gets an empty white box. */
export function buildThumb(v: LayerView, isBlankRef: boolean): HTMLElement {
  const aspect = thumbAspect(v);
  if (isBlankRef) {
    const blank = el("div", { class: "spd-layer__thumb spd-layer__thumb--blank", "aria-hidden": "true" });
    blank.style.aspectRatio = String(aspect);
    return blank;
  }
  const thumb = el("canvas", { class: "spd-layer__thumb", "aria-hidden": "true" }) as HTMLCanvasElement;
  const thumbW = Math.max(1, Math.round(THUMB_H * aspect));
  thumb.width = thumbW;
  thumb.height = THUMB_H;
  const ctx = thumb.getContext("2d"); // null in jsdom/happy-dom — the canvas still exists.
  const cw = v.canvas.width;
  const ch = v.canvas.height;
  if (ctx && cw > 0 && ch > 0) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, thumbW, THUMB_H);
    // The 2.5× cap is the only case that letterboxes. Uses the shared quality
    // downscale, not one bilinear `drawImage`.
    const scale = Math.min(thumbW / cw, THUMB_H / ch);
    const dw = Math.max(1, Math.round(cw * scale));
    const dh = Math.max(1, Math.round(ch * scale));
    const dx = Math.round((thumbW - dw) / 2);
    const dy = Math.round((THUMB_H - dh) / 2);
    void drawDownscaledInto(ctx, v.canvas, dw, dh, dx, dy);
  }
  return thumb;
}
