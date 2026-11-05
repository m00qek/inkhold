// A lassoed task's handwriting: the strip of its notebook page where the words
// it came from are written. Cut in the browser, not on the server: the page's
// bytes come once (the reader's own `GET /note/{id}/page/{n}`), are rendered
// by the same decoder, and only the crop is kept, in the persistent thumbnail
// store (IndexedDB) under the note page's version, so a changed page is cut
// again and an unchanged one is never fetched twice. The words are found in
// the page's recognized text; no match, no strip (the row keeps its link).

import { el } from "../../ui/dom";
import type { Api } from "../../api/types";
import type { TodoTask } from "../../api/todoTypes";
import type { Id, NoteMeta, Theme, WordBox } from "../../core/types";
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

/** The box widened by a little air around the ink, half a line each side. */
export function withMargin(b: MmBox): MmBox {
  const pad = b.hMm * 0.5;
  return { xMm: b.xMm - pad, yMm: b.yMm - pad, wMm: b.wMm + 2 * pad, hMm: b.hMm + 2 * pad };
}

/** Widest strip kept, in px: about twice the width it is shown at. */
const MAX_W = 720;
/** How long a rendered page stays for the other tasks lassoed on it. */
const PAGE_KEEP_MS = 15_000;

export interface TodoInkDeps {
  api: Pick<Api, "getNoteMeta" | "getPageText" | "getPageBytes">;
  renderer: NoteRenderer;
  /** The persistent thumbnail store; null keeps strips for this visit only. */
  store: PersistentThumbStore | null;
  theme(): Theme;
}

export interface TodoInk {
  /** An image URL for the task's handwriting, or null when there is none to show. */
  strip(task: TodoTask): Promise<string | null>;
  /**
   * A place for the task's handwriting in a row: hidden until it scrolls into
   * view and its strip is found. Null for a task with nothing to look for.
   */
  slot(task: TodoTask): HTMLElement | null;
}

export function createTodoInk(d: TodoInkDeps): TodoInk {
  /** One metadata read per note per visit. */
  const metas = new Map<Id, Promise<NoteMeta>>();
  /** One answer per strip key per visit (and one page fetch for its tasks). */
  const strips = new Map<string, Promise<string | null>>();

  /** A page rendered once for every task lassoed on it, then let go. */
  const pages = new Map<string, Promise<DecodedPage>>();

  function rendered(noteId: Id, m: NoteMeta, index: number): Promise<DecodedPage> {
    const page = m.pages[index]!;
    const key = `${noteId}:${page.hash}`;
    let p = pages.get(key);
    if (!p) {
      p = d.api.getPageBytes(noteId, page).then((bytes) => d.renderer.render({ bytes, noteId, page, size: "full", theme: d.theme() }));
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

  async function cut(noteId: Id, m: NoteMeta, index: number, text: string, key: string): Promise<string | null> {
    const page = m.pages[index];
    // Millimetres to page pixels needs the hardware's scale; unverified, no strip.
    if (!page || m.pxPerMm === null) return null;
    const cached = await d.store?.get(key).catch(() => undefined);
    if (cached) return URL.createObjectURL(cached);
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
    const scale = Math.min(1, MAX_W / sw);
    const canvas = new OffscreenCanvas(Math.round(sw * scale), Math.round(sh * scale));
    canvas.getContext("2d")!.drawImage(out.bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.85 });
    void d.store?.put(key, blob).catch(() => {});
    return URL.createObjectURL(blob);
  }

  // Strips load as their rows come into view, not all at once.
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

  async function fill(slot: HTMLElement, task: TodoTask): Promise<void> {
    const url = await strip(task);
    if (!url || !slot.isConnected) return;
    // The title is already text beside it: the image adds nothing to read out.
    slot.append(el("img", { class: "todo-ink", alt: "", src: url, decoding: "async" }));
  }

  async function strip(task: TodoTask): Promise<string | null> {
    const link = task.link;
    if (!link?.text) return null;
    try {
      const m = await meta(link.noteId);
      const page = m.pages[link.page - 1];
      if (!page) return null;
      // The page's version and the theme in the key: an edit or a theme switch cuts anew.
      const key = `todo-ink:${link.noteId}:${page.hash}:${d.theme()}:${link.text}`;
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

  return {
    strip,
    slot(task) {
      if (!task.link?.text) return null;
      // An empty slot until the strip is found: a hidden image would never
      // count as in view, so the slot is what is watched.
      const slot = el("span", { class: "todo-ink-slot" });
      if (seen) {
        waiting.set(slot, task);
        seen.observe(slot);
      } else {
        void fill(slot, task);
      }
      return slot;
    },
  };
}
