// The page a digest was taken from, small: the open digest's way to its page.
// Drawn by the library's thumbnail facade (`render/thumbnails.ts`), which keeps
// it in the persistent store: a notebook page by its page hash, a PDF page by
// the file's md5 and the page. Only the open digest's is drawn, one at a time,
// never a list's worth: a PDF page costs a MuPDF render.

import { el } from "../../ui/dom";
import { currentTheme } from "../../ui/theme";
import type { Api } from "../../api/types";
import type { Digest } from "../../api/digestTypes";
import type { NoteMeta } from "../../core/types";
import type { Thumbnails } from "../../render/thumbnails";

export interface DigestThumbsDeps {
  api: Pick<Api, "getNoteMeta">;
  thumbnails: Pick<Thumbnails, "getThumbnail">;
}

export interface DigestThumbs {
  /** The digest's source page, filled in once drawn; null when its file is not in the library. */
  holder(d: Digest, className: string): HTMLElement | null;
}

export function createDigestThumbs(deps: DigestThumbsDeps): DigestThumbs {
  /** One metadata read per file per visit; a failure is asked again next time. */
  const metas = new Map<string, Promise<NoteMeta>>();
  /** One picture per page and theme per visit. */
  const pictures = new Map<string, Promise<string | null>>();
  /** The pictures in, so a repaint shows one at once instead of blinking. */
  const drawn = new Map<string, string>();

  const meta = (id: string): Promise<NoteMeta> => {
    let m = metas.get(id);
    if (!m) {
      m = deps.api.getNoteMeta(id);
      m.catch(() => metas.delete(id));
      metas.set(id, m);
    }
    return m;
  };

  async function draw(fileId: string, page: number): Promise<string | null> {
    const m = await meta(fileId);
    const blob =
      m.fileType === "note"
        ? // Not the cover: the page the digest is on.
          await deps.thumbnails.getThumbnail({ fileHash: null, noteId: fileId, page: m.pages[page] ?? m.pages[0] }, "note")
        : m.fileType === "pdf"
          ? await deps.thumbnails.getThumbnail({ fileHash: m.fileHash, fileId, pdfPage: page }, "pdf")
          : await deps.thumbnails.getThumbnail({ fileHash: m.fileHash, fileId }, m.fileType);
    return URL.createObjectURL(blob);
  }

  function show(holder: HTMLElement, url: string): void {
    holder.replaceChildren(el("img", { src: url, alt: "" }));
    holder.classList.add("has-thumb");
  }

  return {
    holder(d, className) {
      const fileId = d.source.fileId;
      if (d.source.kind === "manual" || fileId === null) return null;
      const page = Math.max(0, (d.source.page ?? 1) - 1);
      const key = `${fileId}:${page}:${currentTheme()}`;
      const h = el("span", { class: className, "aria-hidden": "true" });
      const known = drawn.get(key);
      if (known) {
        show(h, known);
        return h;
      }
      let p = pictures.get(key);
      if (!p) {
        p = draw(fileId, page).then(
          (url) => {
            if (url) drawn.set(key, url);
            return url;
          },
          () => {
            pictures.delete(key);
            return null;
          },
        );
        pictures.set(key, p);
      }
      void p.then((url) => {
        if (url && h.isConnected) show(h, url);
      });
      return h;
    },
  };
}
