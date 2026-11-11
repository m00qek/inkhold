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
import { opensAtPage } from "./digestModel";

export interface DigestThumbsDeps {
  api: Pick<Api, "getNoteMeta">;
  thumbnails: Pick<Thumbnails, "getThumbnail">;
}

export interface DigestThumbs {
  /**
   * The digest's source page, filled in once drawn (and left empty when that
   * page is gone); null when there is no page to show: a file not in the
   * library, or one no viewer opens at a page.
   */
  holder(d: Digest, className: string): HTMLElement | null;
  /**
   * The digests changed, and a file may have with them: its metadata is read
   * again. A page whose file is the same keeps its picture, shown at once; a
   * changed file's page is drawn again.
   */
  refresh(): void;
}

/** Pages whose pictures are kept, for going back and forth between digests. */
const KEPT = 12;

export function createDigestThumbs(deps: DigestThumbsDeps): DigestThumbs {
  /** One metadata read per file until `refresh`; a failure is asked again next time. */
  const metas = new Map<string, Promise<NoteMeta>>();
  /** One picture per page of a file's version, and theme. */
  const pictures = new Map<string, Promise<string | null>>();
  /** The pictures in, by the same key. */
  const drawn = new Map<string, string>();
  /**
   * A page's last picture shown (its versioned key), so a repaint shows it at
   * once instead of blinking; the oldest go past {@link KEPT}, oldest first.
   */
  const shown = new Map<string, string>();
  /** Each page's latest fill: an older one answering late changes nothing. */
  const fills = new Map<string, number>();
  let fillCount = 0;

  /** `map`'s entry for `key`, dropped if it is still `p`: a newer one stays. */
  const dropIfSame = <T>(map: Map<string, T>, key: string, p: T) => void (map.get(key) === p && map.delete(key));

  const meta = (id: string): Promise<NoteMeta> => {
    let m = metas.get(id);
    if (!m) {
      const mine = deps.api.getNoteMeta(id);
      mine.catch(() => dropIfSame(metas, id, mine));
      metas.set(id, mine);
      m = mine;
    }
    return m;
  };

  async function draw(m: NoteMeta, fileId: string, page: number): Promise<string | null> {
    // A page the file no longer has: no picture, never another page's.
    if (m.pages.length > 0 && page >= m.pages.length) return null;
    const notePage = m.pages[page];
    if (m.fileType === "note" && !notePage) return null;
    const blob =
      m.fileType === "note" && notePage
        ? // Not the cover: the page the digest is on.
          await deps.thumbnails.getThumbnail({ fileHash: null, noteId: fileId, page: notePage }, "note")
        : m.fileType === "pdf"
          ? await deps.thumbnails.getThumbnail({ fileHash: m.fileHash, fileId, pdfPage: page }, "pdf")
          : null;
    return blob ? URL.createObjectURL(blob) : null;
  }

  function picture(m: NoteMeta, fileId: string, page: number, key: string): Promise<string | null> {
    let p = pictures.get(key);
    if (!p) {
      const mine: Promise<string | null> = draw(m, fileId, page).then(
        (url) => {
          if (url) drawn.set(key, url);
          return url;
        },
        () => {
          dropIfSame(pictures, key, mine);
          return null;
        },
      );
      pictures.set(key, mine);
      p = mine;
    }
    return p;
  }

  function show(holder: HTMLElement, url: string | null): void {
    holder.replaceChildren(...(url ? [el("img", { src: url, alt: "" })] : []));
    holder.classList.toggle("has-thumb", url !== null);
  }

  /** Lets a page's pictures go, its URLs and entries, but for the version `keep`. */
  function letGo(place: string, keep: string | null = null): void {
    for (const key of [...pictures.keys()]) {
      if (!key.startsWith(`${place}:`) || key === keep) continue;
      const url = drawn.get(key);
      if (url) URL.revokeObjectURL(url);
      drawn.delete(key);
      pictures.delete(key);
    }
  }

  /** The page's picture for the file as it is now; the one it replaces is let go. */
  async function fill(holder: HTMLElement, fileId: string, page: number, place: string): Promise<void> {
    const mine = ++fillCount;
    fills.set(place, mine);
    const m = await meta(fileId);
    const key = `${place}:${m.fileHash ?? ""}`;
    if (shown.get(place) === key && drawn.has(key)) return;
    const url = await picture(m, fileId, page, key);
    // A newer fill took over: it lets go of what it doesn't show.
    if (fills.get(place) !== mine) return;
    letGo(place, key);
    shown.delete(place);
    shown.set(place, key);
    for (const oldest of shown.keys()) {
      if (shown.size <= KEPT) break;
      shown.delete(oldest);
      fills.delete(oldest);
      letGo(oldest);
    }
    if (holder.isConnected) show(holder, url);
  }

  return {
    holder(d, className) {
      const fileId = d.source.fileId;
      if (fileId === null || !opensAtPage(d)) return null;
      const page = Math.max(0, (d.source.page ?? 1) - 1);
      const place = `${fileId}:${page}:${currentTheme()}`;
      const h = el("span", { class: className, "aria-hidden": "true" });
      const last = shown.get(place);
      const known = last === undefined ? undefined : drawn.get(last);
      if (known) show(h, known);
      void fill(h, fileId, page, place).catch(() => {});
      return h;
    },
    refresh() {
      metas.clear();
    },
  };
}
