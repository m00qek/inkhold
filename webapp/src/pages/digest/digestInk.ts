// A digest's handwritten note: a one-page `.mark` the size of the tablet's
// screen, mostly empty. Its page comes once (`GET /api/controlplane/digests/
// {id}/note/{md5}`), is rendered by the notes' own decoder and cut down to its
// strokes (`render/inkMask.ts`), so it shows as a small picture the theme
// colours. Kept in the persistent thumbnail store under the note's md5: a
// replaced note is a new md5, an unchanged one is never fetched twice.

import { el } from "../../ui/dom";
import type { Api } from "../../api/types";
import type { Digest } from "../../api/digestTypes";
import type { NoteRenderer } from "../../render/types";
import type { PersistentThumbStore } from "../../cache/idb";
import { cutStrokes } from "../../render/inkMask";

/** The Nomad's panel, which a digest's note covers. */
const PANEL = { width: 1404, height: 1872 };
/** Widest picture kept, in px: sharp at the side panel's width on a dense screen. */
const MAX_W = 720;

export interface DigestInkDeps {
  api: Pick<Api, "digestNoteBytes">;
  renderer: NoteRenderer;
  /** The persistent thumbnail store; null keeps pictures for this visit only. */
  store: PersistentThumbStore | null;
}

/** The note's strokes as a mask, and its size in px. */
export interface NotePicture {
  url: string;
  width: number;
  height: number;
}

export interface DigestInk {
  /** The digest's handwritten note, or null when it has none (or it could not be drawn). */
  picture(d: Digest): Promise<NotePicture | null>;
  /**
   * An element that shows the note once it is drawn, filled in as it scrolls
   * into view; empty until then, and if there is nothing to show. Null for a
   * digest without a note.
   */
  holder(d: Digest, className: string): HTMLElement | null;
}

export function createDigestInk(dep: DigestInkDeps): DigestInk {
  /** One answer per note per visit. */
  const pictures = new Map<string, Promise<NotePicture | null>>();
  /** The answers in, so a repaint shows a drawn note at once instead of blinking. */
  const drawn = new Map<string, NotePicture>();

  async function draw(d: Digest, md5: string): Promise<NotePicture | null> {
    const key = `digest-note1:${md5}`;
    const cached = await dep.store?.get(key).catch(() => undefined);
    if (cached) {
      const b = await createImageBitmap(cached);
      const p = { url: URL.createObjectURL(cached), width: b.width, height: b.height };
      b.close();
      return p;
    }
    const bytes = await dep.api.digestNoteBytes(d.id, md5);
    const page = { index: 0, sourcePage: 1, hash: md5, textHash: null, linksHash: null, ...PANEL };
    // Always the light rendering: dark ink on white is what the cut reads.
    const out = await dep.renderer.render({ bytes, noteId: d.id, page, size: "full", theme: "light" });
    try {
      const cut = await cutStrokes(out.bitmap, { x: 0, y: 0, w: out.width, h: out.height }, MAX_W);
      if (!cut) return null;
      void dep.store?.put(key, cut.blob).catch(() => {});
      return { url: URL.createObjectURL(cut.blob), width: cut.width, height: cut.height };
    } finally {
      out.bitmap.close();
    }
  }

  function picture(d: Digest): Promise<NotePicture | null> {
    const md5 = d.note;
    if (md5 === null) return Promise.resolve(null);
    let p = pictures.get(md5);
    if (!p) {
      p = draw(d, md5).then(
        (pic) => {
          if (pic) drawn.set(md5, pic);
          return pic;
        },
        () => {
          pictures.delete(md5); // a failure is retried next time
          return null;
        },
      );
      pictures.set(md5, p);
    }
    return p;
  }

  async function fill(holder: HTMLElement, d: Digest): Promise<void> {
    const p = await picture(d);
    if (p && holder.isConnected) show(holder, p);
  }

  /** The strokes, coloured by the theme: the picture is the mask, the ink colour the paint. */
  function show(holder: HTMLElement, p: NotePicture): void {
    const ink = el("span", { class: "digest-ink" });
    ink.style.setProperty("--ink-src", `url("${p.url}")`);
    ink.style.setProperty("--ink-ar", String(p.width / p.height));
    holder.replaceChildren(ink);
    holder.classList.add("has-ink");
  }

  // Pictures load as their holders come into view, not all at once.
  const waiting = new Map<Element, Digest>();
  const seen = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const d = waiting.get(e.target);
      waiting.delete(e.target);
      seen!.unobserve(e.target);
      if (d) void fill(e.target as HTMLElement, d);
    }
  }, { rootMargin: "200px" });

  return {
    picture,
    holder(d, className) {
      if (d.note === null) return null;
      const h = el("span", { class: className });
      const known = drawn.get(d.note);
      if (known) {
        show(h, known);
      } else if (seen) {
        waiting.set(h, d);
        seen.observe(h);
      } else {
        void fill(h, d);
      }
      return h;
    },
  };
}
