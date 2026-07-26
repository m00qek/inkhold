// A synthetic NoteRenderer for dev + e2e. It ignores the page bytes and paints a
// deterministic ruled sheet with pseudo-handwriting seeded by the page hash, in
// the requested theme (dark = inverted e-ink). This is what makes the whole UI
// exercisable — and pixel-probeable in Playwright — before the real WASM decoder
// (P5) exists. Unit tests that don't need real pixels should inject their own
// trivial NoteRenderer stub rather than this (canvas is a browser API).

import type { DecodedPage, NoteRenderer, RenderRequest } from "./types";
import { thumbTargetWidth } from "./types";
import type { RenderSize, Theme } from "../core/types";

// Target output width per tier. `native` is a ceiling, not a size: like the real
// renderer, nothing is ever upscaled, so it resolves to the page's own width.
// `thumb` is the shared pristine-tier target (bucket-dependent, read per render
// call) so the fake matches every producer.
function outputWidth(size: RenderSize): number {
  if (size === "thumb") return thumbTargetWidth();
  return size === "full" ? 1024 : 4096;
}

interface Palette {
  paper: string;
  rule: string;
  margin: string;
  ink: string;
}

function palette(theme: Theme): Palette {
  return theme === "dark"
    ? { paper: "#1a1a1a", rule: "#2c2c2c", margin: "#5a2d2d", ink: "#e8e8e8" }
    : { paper: "#fbfbf8", rule: "#dfe4ea", margin: "#e8b0b0", ink: "#2b2b2b" };
}

/** A tiny deterministic PRNG so a given page hash always paints the same ink. */
function seeded(hash: string): () => number {
  let s = 0;
  for (let i = 0; i < hash.length; i++) s = (Math.imul(s, 31) + hash.charCodeAt(i)) >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

function makeCanvas(w: number, h: number): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    return { canvas, ctx };
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  return { canvas, ctx };
}

export function createFakeRenderer(): NoteRenderer {
  return {
    async render(req: RenderRequest): Promise<DecodedPage> {
      const { page, size, theme } = req;
      const w = Math.min(outputWidth(size), page.width);
      const h = Math.round((w * page.height) / page.width);
      const p = palette(theme);
      const { canvas, ctx } = makeCanvas(w, h);

      // Paper.
      ctx.fillStyle = p.paper;
      ctx.fillRect(0, 0, w, h);

      // Horizontal rules.
      const gap = h / 22;
      ctx.strokeStyle = p.rule;
      ctx.lineWidth = 1;
      for (let y = gap; y < h; y += gap) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Red margin line.
      ctx.strokeStyle = p.margin;
      ctx.beginPath();
      ctx.moveTo(w * 0.12, 0);
      ctx.lineTo(w * 0.12, h);
      ctx.stroke();

      // Pseudo-handwriting: a few wobbly ink strokes seeded by the page hash, so
      // the ink pattern is stable per page and probeable by tests.
      const rand = seeded(page.hash);
      ctx.strokeStyle = p.ink;
      ctx.lineWidth = Math.max(1, w / 240);
      ctx.lineCap = "round";
      const lines = 4 + Math.floor(rand() * 8);
      for (let i = 0; i < lines; i++) {
        const y = gap * (2 + i * 1.6);
        ctx.beginPath();
        ctx.moveTo(w * 0.16, y);
        let x = w * 0.16;
        while (x < w * (0.4 + rand() * 0.5)) {
          x += w * 0.03;
          ctx.lineTo(x, y + (rand() - 0.5) * gap * 0.6);
        }
        ctx.stroke();
      }

      const bitmap = await createImageBitmap(canvas as CanvasImageSource);
      return { bitmap, width: w, height: h };
    },
  };
}
