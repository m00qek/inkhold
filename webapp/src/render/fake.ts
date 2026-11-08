// A synthetic NoteRenderer for dev and e2e: a deterministic ruled sheet with
// pseudo-handwriting seeded by the page hash, always in the light world like
// the real renderer.

import type { DecodedPage, NoteRenderer, RenderRequest } from "./types";
import { thumbTargetWidth } from "./types";
import { isDemoPage } from "../api/demoNotes";
import type { RenderSize, Theme } from "../core/types";

// `native` is a ceiling, never an upscale; `thumb` is the shared tier target.
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
  // The demo's real notebooks (api/demoNotes.ts) go to the real decoder.
  let real: Promise<NoteRenderer> | null = null;
  return {
    async render(req: RenderRequest): Promise<DecodedPage> {
      if (isDemoPage(req.page.hash)) {
        real ??= import("./wasm").then((m) => m.createWasmRenderer());
        return (await real).render(req);
      }
      const { page, size } = req;
      const w = Math.min(outputWidth(size), page.width);
      const h = Math.round((w * page.height) / page.width);
      const p = palette("light");
      const { canvas, ctx } = makeCanvas(w, h);

      ctx.fillStyle = p.paper;
      ctx.fillRect(0, 0, w, h);

      const gap = h / 22;
      ctx.strokeStyle = p.rule;
      ctx.lineWidth = 1;
      for (let y = gap; y < h; y += gap) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      ctx.strokeStyle = p.margin;
      ctx.beginPath();
      ctx.moveTo(w * 0.12, 0);
      ctx.lineTo(w * 0.12, h);
      ctx.stroke();

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
