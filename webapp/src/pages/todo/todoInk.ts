// A lassoed task's handwriting: the strip of its notebook page where the words
// it came from are written. Cut in the browser, not on the server: the page's
// bytes come once (the reader's own `GET /note/{id}/page/{n}`), are rendered
// by the same decoder, and only the strokes are kept: the paper and the
// template's lines turn transparent, so the strip is a mask the theme colours.
// It lives in the persistent thumbnail store (IndexedDB) under the note page's
// version, so a changed page is cut again and an unchanged one is never
// fetched twice. The words are found in the page's recognized text; no match,
// no strip. Shown as a chip at the row's edge, which also opens the note.

import { el } from "../../ui/dom";
import { ICONS, svg } from "../../ui/icons";
import type { Api } from "../../api/types";
import type { TodoTask } from "../../api/todoTypes";
import type { Id, NoteMeta, WordBox } from "../../core/types";
import type { DecodedPage, NoteRenderer } from "../../render/types";
import type { PersistentThumbStore } from "../../cache/idb";

/** A box in millimetres, the recognized words' own unit. */
export interface MmBox {
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
}

/** Lowercase, without accents or punctuation: how recognized words are compared. */
function norm(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Where `text` is written on a page: the first run of recognized words that
 * spells it, word for word (case, accents and punctuation aside), as one box
 * around them. Null when the page doesn't have those words in that order.
 */
export function findWords(words: readonly WordBox[], text: string): MmBox | null {
  const want = norm(text).split(" ").filter(Boolean);
  if (want.length === 0) return null;
  // A recognized "word" can hold more than one token ("page-range" is two).
  const tokens: { t: string; w: WordBox }[] = words.flatMap((w) => norm(w.text).split(" ").filter(Boolean).map((t) => ({ t, w })));
  for (let i = 0; i + want.length <= tokens.length; i++) {
    if (!want.every((t, k) => tokens[i + k]!.t === t)) continue;
    const hit = [...new Set(tokens.slice(i, i + want.length).map((x) => x.w))];
    const x0 = Math.min(...hit.map((w) => w.xMm));
    const y0 = Math.min(...hit.map((w) => w.yMm));
    const x1 = Math.max(...hit.map((w) => w.xMm + w.wMm));
    const y1 = Math.max(...hit.map((w) => w.yMm + w.hMm));
    return { xMm: x0, yMm: y0, wMm: x1 - x0, hMm: y1 - y0 };
  }
  return null;
}

/** The box widened by a little air around the words: a quarter line each side, so a neighbouring line's strokes stay out. */
export function withMargin(b: MmBox): MmBox {
  const pad = b.hMm * 0.25;
  return { xMm: b.xMm - pad, yMm: b.yMm - pad, wMm: b.wMm + 2 * pad, hMm: b.hMm + 2 * pad };
}

/**
 * How opaque a page pixel is as ink, from its darkness (0 white, 255 black):
 * the paper and a template's light lines are gone, black and dark grey pens
 * stay. Light grey ink is lost with the template; there is no telling them apart.
 */
export function inkAlpha(darkness: number): number {
  const LO = 70;
  const HI = 170;
  return darkness <= LO ? 0 : darkness >= HI ? 255 : Math.round(((darkness - LO) * 255) / (HI - LO));
}

/** The smallest box around the pixels with any alpha; null when there are none. */
export function inkBounds(alpha: (x: number, y: number) => number, w: number, h: number): { x: number; y: number; w: number; h: number } | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (alpha(x, y) > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Widest strip kept, in px: several times the width it is shown at. */
const MAX_W = 480;
/** How long a rendered page stays for the other tasks lassoed on it. */
const PAGE_KEEP_MS = 15_000;

export interface TodoInkDeps {
  api: Pick<Api, "getNoteMeta" | "getPageText" | "getPageBytes">;
  renderer: NoteRenderer;
  /** The persistent thumbnail store; null keeps strips for this visit only. */
  store: PersistentThumbStore | null;
}

/** A cut strip: the strokes as black on transparent, and its size in px. */
export interface Strip {
  url: string;
  width: number;
  height: number;
}

export interface TodoInk {
  /** The task's handwriting, or null when there is none to show. */
  strip(task: TodoTask): Promise<Strip | null>;
  /**
   * The chip at a task's edge: its handwriting, filled in as it scrolls into
   * view. With `open` it is the button to the note, and shows the page number
   * until (or unless) the strip is found; without, it is only the picture and
   * appears only once there is one. Null for a task not from a note.
   */
  chip(task: TodoTask, open?: () => void): HTMLElement | null;
}

export function createTodoInk(d: TodoInkDeps): TodoInk {
  /** One metadata read per note per visit. */
  const metas = new Map<Id, Promise<NoteMeta>>();
  /** One answer per strip key per visit (and one page fetch for its tasks). */
  const strips = new Map<string, Promise<Strip | null>>();

  /** A page rendered once for every task lassoed on it, then let go. */
  const pages = new Map<string, Promise<DecodedPage>>();

  function rendered(noteId: Id, m: NoteMeta, index: number): Promise<DecodedPage> {
    const page = m.pages[index]!;
    const key = `${noteId}:${page.hash}`;
    let p = pages.get(key);
    if (!p) {
      // Always the light rendering: dark ink on white is what the cut reads.
      p = d.api.getPageBytes(noteId, page).then((bytes) => d.renderer.render({ bytes, noteId, page, size: "full", theme: "light" }));
      pages.set(key, p);
      const drop = () => {
        pages.delete(key);
        void p!.then((out) => out.bitmap.close()).catch(() => {});
      };
      p.then(() => setTimeout(drop, PAGE_KEEP_MS), drop);
    }
    return p;
  }

  const meta = (id: Id) => {
    let m = metas.get(id);
    if (!m) {
      m = d.api.getNoteMeta(id);
      m.catch(() => metas.delete(id)); // a failure is retried next time
      metas.set(id, m);
    }
    return m;
  };

  async function fromBlob(blob: Blob): Promise<Strip> {
    const b = await createImageBitmap(blob);
    const s = { url: URL.createObjectURL(blob), width: b.width, height: b.height };
    b.close();
    return s;
  }

  async function cut(noteId: Id, m: NoteMeta, index: number, text: string, key: string): Promise<Strip | null> {
    const page = m.pages[index];
    // Millimetres to page pixels needs the hardware's scale; unverified, no strip.
    if (!page || m.pxPerMm === null) return null;
    const cached = await d.store?.get(key).catch(() => undefined);
    if (cached) return fromBlob(cached);
    const words = await d.api.getPageText(noteId, page);
    const box = findWords(words.words, text);
    if (!box) return null;
    const out = await rendered(noteId, m, index);
    // Rendered pixels per mm: the device's scale, times the render's downscale.
    const k = m.pxPerMm * (out.width / page.width);
    const b = withMargin(box);
    const sx = Math.max(0, Math.floor(b.xMm * k));
    const sy = Math.max(0, Math.floor(b.yMm * k));
    const sw = Math.min(out.width - sx, Math.ceil(b.wMm * k));
    const sh = Math.min(out.height - sy, Math.ceil(b.hMm * k));
    if (sw <= 0 || sh <= 0) return null;

    // The strokes alone: black, with the page's darkness as their opacity.
    const work = new OffscreenCanvas(sw, sh);
    const wc = work.getContext("2d", { willReadFrequently: true })!;
    wc.drawImage(out.bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    const img = wc.getImageData(0, 0, sw, sh);
    const px = img.data;
    for (let i = 0; i < px.length; i += 4) {
      const dark = 255 - (0.3 * px[i]! + 0.59 * px[i + 1]! + 0.11 * px[i + 2]!);
      px[i] = px[i + 1] = px[i + 2] = 0;
      px[i + 3] = inkAlpha(dark);
    }
    const ink = inkBounds((x, y) => px[(y * sw + x) * 4 + 3]!, sw, sh);
    if (!ink) return null;
    wc.putImageData(img, 0, 0);

    // Trimmed to the strokes, with an even rim of air.
    const rim = Math.max(2, Math.round(ink.h * 0.08));
    const scale = Math.min(1, MAX_W / (ink.w + 2 * rim));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round((ink.w + 2 * rim) * scale)), Math.max(1, Math.round((ink.h + 2 * rim) * scale)));
    canvas.getContext("2d")!.drawImage(work, ink.x, ink.y, ink.w, ink.h, rim * scale, rim * scale, ink.w * scale, ink.h * scale);
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.9 });
    void d.store?.put(key, blob).catch(() => {});
    return { url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height };
  }

  async function strip(task: TodoTask): Promise<Strip | null> {
    const link = task.link;
    if (!link?.text) return null;
    try {
      const m = await meta(link.noteId);
      const page = m.pages[link.page - 1];
      if (!page) return null;
      // The page's version in the key: an edit to the page cuts anew.
      const key = `todo-ink2:${link.noteId}:${page.hash}:${link.text}`;
      let s = strips.get(key);
      if (!s) {
        s = cut(link.noteId, m, link.page - 1, link.text, key);
        s.catch(() => strips.delete(key));
        strips.set(key, s);
      }
      return await s;
    } catch {
      return null;
    }
  }

  /** The strokes, coloured by the theme: the strip is the mask, the ink colour the paint. */
  function inkOf(s: Strip): HTMLElement {
    const i = el("span", { class: "todo-ink" });
    i.style.setProperty("--ink-src", `url("${s.url}")`);
    i.style.setProperty("--ink-ar", String(s.width / s.height));
    return i;
  }

  // Strips load as their chips come into view, not all at once.
  const waiting = new Map<Element, TodoTask>();
  const seen = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const task = waiting.get(e.target);
      waiting.delete(e.target);
      seen!.unobserve(e.target);
      if (task) void fill(e.target as HTMLElement, task);
    }
  }, { rootMargin: "200px" });

  async function fill(chip: HTMLElement, task: TodoTask): Promise<void> {
    const s = await strip(task);
    if (!s || !chip.isConnected) return;
    chip.replaceChildren(inkOf(s));
    chip.classList.add("has-ink");
  }

  return {
    strip,
    chip(task, open) {
      const link = task.link;
      if (!link) return null;
      if (!open && !link.text) return null;
      const where = `${link.name}, page ${link.page}`;
      let chip: HTMLElement;
      if (open) {
        // Until the strip is in (or when there is none), the page it points to.
        chip = el(
          "button",
          { class: "todo-chip", type: "button", title: `Open ${where}`, "aria-label": `Open ${where}` },
          el("span", { class: "todo-chip__page", "aria-hidden": "true" }, el("span", { html: svg(ICONS.note) }), el("span", { text: String(link.page) })),
        );
        chip.addEventListener("click", (e) => {
          e.stopPropagation();
          open();
        });
      } else {
        // Only a picture: whatever holds it (a card, a search result) is the link.
        chip = el("span", { class: "todo-chip todo-chip--still", "aria-hidden": "true" });
      }
      // An empty chip is still in view, so it is the chip that is watched.
      if (seen) {
        waiting.set(chip, task);
        seen.observe(chip);
      } else {
        void fill(chip, task);
      }
      return chip;
    },
  };
}
