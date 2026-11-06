// The gallery's card factory: `folderCard`, `noteCard`, `resultCard` and the
// thumbnail/aspect/marks helpers they share. Shell state arrives through
// `GalleryCardsCtx`.

import { onPlainClick } from "../ui/link";
import type { SearchExcerpts } from "./searchExcerpts";
import { insideQuery, nameMarks, nameQuery } from "../search/match";
import { el } from "../ui/dom";
import { learnsAspect, pinAspect, provisionalAspect } from "../ui/tileAspect";
import { ICONS, svg, type IconName } from "../ui/icons";
import { fileKind, rawFileUrl } from "../core/fileKind";
import { getDims } from "../cache/dimsMemo";
import { go, folderHref, noteHref, notePageHref } from "../router";
import { pageSummary, deepLinkQuery } from "./noteSearch";
import type { Expansion } from "../search/localSearch";
import type { Entry, Folder, Hash, Id, NoteSummary } from "../core/types";
import type { Category } from "./rail";
import type { LazyEngine } from "../render/lazy";

/**
* Types previewed through the thumbnail facade (`.spd` embedded thumb, `.txt`
* snippet, `.pdf` page 0 via MuPDF) instead of a glyph tile. Must agree with
* `strategyFor`; `thumbnails.test.ts` checks the pair. Also read by `bin.ts`.
*/
export const FACADE_THUMB_TYPES: ReadonlySet<string> = new Set(["spd", "txt", "pdf"]);

/** Client-side: the facade rasterises `.txt` snippets at 3:4 itself. */
const TXT_ASPECT = 3 / 4;

const OCR_LABEL = "Has recognised text";

function fmtDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** `note` is the listing's own record, never null: unnamed hits are dropped. */
export interface SearchResult {
  noteId: Id;
  note: NoteSummary;
  folderPath: string | null;
  nameMatched: boolean;
  /** Every matching ordinal, ascending; empty for a name-only match. */
  pages: readonly number[];
  /** 0 = `.note` pages, 1 = `.txt` paragraphs. Wording only; routing uses `fileType`. */
  kind: number;
  /** The document's content hash, for its excerpt; null for a name-only match. */
  md5: string | null;
  /** Something the person wrote (a note), or unknown; false: a PDF or `.txt`, marked or not. */
  written: boolean;
}

/** Read through getters so a card reflects view state at build time. */
export interface GalleryCardsCtx {
  galleryEngine: LazyEngine;
  imgLazy: IntersectionObserver | null;
  getView: () => "grid" | "list";
  labelFor: (folder: Folder) => string;
  /** Resolved by identity in the rail, not by name. */
  categoryIconFor: (folder: Folder) => IconName | null;
  /** A stand-in for an anchor the device hasn't created: no folder behind it. */
  pendingCategoryOf: (folder: Folder) => Category | null;
  onSelectCategory: (cat: Category) => void;
  scheduleSpan: () => void;
  cardMenu: (entry: Entry) => HTMLElement;
  /** The excerpt line under a result with content hits (`searchExcerpts.ts`); absent: none. */
  excerpts?: SearchExcerpts;
}

/**
 * A run of cards as a list: `display: contents`, so each card stays a cell of
 * the gallery's grid (the masonry pass looks inside it, `masonry.ts`).
 */
export function cardList(...cards: HTMLElement[]): HTMLElement {
  return el("ul", { class: "cards", role: "list" }, ...cards);
}

export interface GalleryCards {
  folderCard: (folder: Folder) => HTMLElement;
  noteCard: (note: NoteSummary, i: number) => HTMLElement;
  /** `expansions` is used for the deep link only. */
  resultCard: (result: SearchResult, i: number, q: string, expansions?: readonly Expansion[]) => HTMLElement;
}

/**
* An `<img>` the lazy engine paints with an object URL over the facade's WebP.
* Not a canvas: the browser then owns decode and eviction, which is kinder to
* phone memory.
*/
function engineThumbImg(name: string): HTMLImageElement {
  return el("img", { class: "thumb__img", loading: "lazy", decoding: "async", alt: name }) as HTMLImageElement;
}

/** Aspect from synchronous sources; `null` leaves the CSS 3:4 fallback. */
function knownAspect(note: NoteSummary): number | null {
  const a = note.thumbAspect;
  if (a) return a.w / a.h;
  if (note.fileType.trim().toLowerCase() === "txt") return TXT_ASPECT;
  return null;
}

/** The folder-silhouette tile, reserved for the six pinned categories. */
function categoryTileHtml(icon: IconName): string {
  return (
    '<svg class="cat__shape" viewBox="0 0 100 82" aria-hidden="true">' +
    '<path d="M10 22 a6 6 0 0 1 6 -6 h22 l7 7 h39 a6 6 0 0 1 6 6 v41 a6 6 0 0 1 -6 6 H16 a6 6 0 0 1 -6 -6 Z"/>' +
    "</svg>" +
    `<span class="cat__glyph">${svg(ICONS[icon], 1.35)}</span>`
  );
}

/**
* "Items" (folders hold more than notes), "Empty" for zero, and null for an
* uncounted folder so the row claims nothing.
*/
function itemCountLabel(folder: Folder): string | null {
  const n = folder.itemCount;
  if (typeof n !== "number") return null;
  if (n === 0) return "Empty";
  return `${n} ${n === 1 ? "item" : "items"}`;
}

/**
* Type badge and recognized-text marker as one group: over the thumbnail in
* the grid, the first line in list view. Built once, not rendered twice and
* hidden, so the marker's name isn't read twice.
*/
function cardMarks(note: NoteSummary): HTMLElement {
  return el(
    "div",
    { class: "card__marks" },
    // The file's actual type, from the server.
    el("span", { class: "card__badge", text: note.fileType }),
    // `role="img"` + `aria-label`: it carries meaning (text-searchable).
    note.hasRecognizedText &&
      el("span", {
        class: "card__ocr",
        role: "img",
        "aria-label": OCR_LABEL,
        title: OCR_LABEL,
        html: svg(ICONS.ocr, 1.6),
      }),
  );
}

/**
* Marks the query's words as text nodes and `<mark>`, never markup: names are
* raw device text. A marked title is how a name match shows itself. The words
* are the ones `search/match.ts` matched on, accents and order aside.
*/
function markedText(text: string, q: string): Node[] {
  const out: Node[] = [];
  let from = 0;
  // The word rule's marks, or the fallback's when the name matched only that way.
  const strict = nameMarks(text, nameQuery(q));
  for (const [start, end] of strict.length > 0 ? strict : nameMarks(text, insideQuery(q))) {
    if (start > from) out.push(document.createTextNode(text.slice(from, start)));
    out.push(el("mark", { text: text.slice(start, end) }));
    from = end;
  }
  if (from < text.length) out.push(document.createTextNode(text.slice(from)));
  return out;
}

export function createGalleryCards(ctx: GalleryCardsCtx): GalleryCards {
  const { galleryEngine, imgLazy } = ctx;

  function thumbMedia(note: NoteSummary): {
    node: HTMLElement;
    /** Null for a native image tile and a glyph tile. */
    target: HTMLImageElement | null;
    thumbClass: string;
    /** `aspect` lets the facade crop a `.spd`'s letterboxed preview at transcode. */
    thumb?: { fileType: string; fileHash: Hash | null; aspect?: { w: number; h: number } };
    alt?: string;
  } {
    const kind = fileKind(note.fileType);
    const preview = kind === "image" ? rawFileUrl(note.id, note.fileHash) : null;
    if (preview) {
      // A real image stays a native `<img>` off the raw endpoint. `data-src`, not
      // `src`: `imgLazy` promotes it, because `loading="lazy"` never loads an
      // in-viewport image inserted by an SPA re-render.
      const img = el("img", {
        class: "thumb__img",
        "data-src": preview,
        decoding: "async",
        // Decoration on a labelled control; the title already names it.
        alt: "",
      }) as HTMLImageElement;
      if (imgLazy) imgLazy.observe(img);
      else img.src = preview; // no IntersectionObserver (tests/SSR): load eagerly
      return { node: img, target: null, thumbClass: "thumb" };
    }
    if (kind !== "note") {
      const t = note.fileType.trim().toLowerCase();
      if (FACADE_THUMB_TYPES.has(t)) {
        const img = engineThumbImg(note.name);
        // A `.spd`'s embedded preview is a 600x800 portrait letterboxing the drawing;
        // the true aspect lets the facade crop it. `.txt` is 3:4; a `.pdf` learns its
        // aspect from the render (`applyTileAspect`).
        return {
          node: img,
          target: img,
          thumbClass: "thumb",
          thumb: { fileType: t, fileHash: note.fileHash, aspect: note.thumbAspect },
          alt: note.name,
        };
      }
      // Lettered with the type so an `.epub` and an unknown file differ.
      return {
        node: el("span", { class: "thumb__glyph", html: svg(ICONS.doc, 1.4) }),
        target: null,
        thumbClass: "thumb thumb--file",
      };
    }
    // The cover (by whole-file hash) when set, else page 0 rendered client-side.
    const img = engineThumbImg(note.name);
    return {
      node: img,
      target: img,
      thumbClass: "thumb",
      thumb: { fileType: "note", fileHash: note.fileHash },
      alt: note.name,
    };
  }

  /**
  * Sets the tile's shape before bytes arrive: `thumbAspect`, then the `.txt`
  * constant, the dims memo, then the decoded tile (the one allowed reflow).
  * Async corrections re-span the masonry.
  */
  function applyTileAspect(tile: HTMLElement, note: NoteSummary, media: HTMLElement, row: boolean): void {
    const aspect = knownAspect(note);
    if (aspect !== null) {
      pinAspect(tile, aspect, row);
      return;
    }
    if (!learnsAspect(note.fileType)) return; // glyph tiles have no shape to learn
    // Only a `.pdf` takes one (see `provisionalAspect`); still a guess.
    const provisional = provisionalAspect(note.fileType);
    if (provisional !== null) pinAspect(tile, provisional, row);
    const correct = (w: number, h: number): void => {
      if (!tile.isConnected || !(w > 0) || !(h > 0)) return;
      pinAspect(tile, w / h, row);
      ctx.scheduleSpan();
    };
    if (note.fileHash) {
      void getDims(note.fileHash).then((dims) => {
        if (dims) correct(dims.w, dims.h);
      });
    }
    // The decoded tile is the truth when the memo has none. Every `load`, not
    // `{ once: true }`: a slow tile is painted first with a placeholder glyph
    // (`PLACEHOLDER_AFTER_MS`) and then with the real pixels, which come last.
    if (media instanceof HTMLImageElement) {
      if (media.complete && media.naturalWidth > 0) correct(media.naturalWidth, media.naturalHeight);
      media.addEventListener("load", () => correct(media.naturalWidth, media.naturalHeight));
    }
  }

  /**
  * Grid: a compact chip sized to its name (no page to preview). List: the same
  * row markup as a note, so both share one alignment system.
  */
  /**
   * A card's open control: a link to `href`, followed by the app on a plain
   * click; a button where there is no address (a category not created yet).
   */
  function openControl(href: string | null, onOpen: () => void, ...kids: (Node | null)[]): HTMLElement {
    if (href === null) {
      const b = el("button", { class: "card__open", type: "button", "data-no-address": "" }, ...kids);
      b.addEventListener("click", onOpen);
      return b;
    }
    const a = el("a", { class: "card__open", href }, ...kids);
    onPlainClick(a, onOpen);
    return a;
  }

  function folderCard(folder: Folder): HTMLElement {
    const inList = ctx.getView() === "list";
    const meta = itemCountLabel(folder);
    const catIcon = ctx.categoryIconFor(folder);
    const pendingCat = ctx.pendingCategoryOf(folder);
    const tile = catIcon
      ? el("div", { class: "thumb thumb--category", html: categoryTileHtml(catIcon) })
      : // A folder has no page to preview, so its tile carries a centred glyph on
        el("div", { class: "thumb thumb--folder", html: svg(ICONS.folder, 1.4) });
    // A stand-in has no folder; routing to its synthetic id would 404.
    const open = openControl(
      pendingCat ? null : folderHref(folder.id),
      () => (pendingCat ? ctx.onSelectCategory(pendingCat) : go(folderHref(folder.id))),
      tile,
      el(
        "div",
        { class: "card__body" },
        // List view only; a folder tile has no image to overlay.
        inList ? el("div", { class: "card__marks" }, el("span", { class: "card__badge", text: "folder" })) : null,
        el(
          "div",
          { class: "card__main" },
          // The rail's label, so an anchor card can't read `EXPORT` beside `Export`.
          el("div", { class: "card__title", text: ctx.labelFor(folder) }),
          meta === null ? null : el("div", { class: "card__meta" }, el("span", { text: meta })),
        ),
      ),
    );
    // List view only: the grid chip has nowhere for "…". None on a stand-in.
    return el(
      "li",
      { class: catIcon ? "card card--folder card--category" : "card card--folder" },
      open,
      inList && !pendingCat ? ctx.cardMenu(folder) : null,
    );
  }

  /**
  * `.card` is a wrapper: in list view the action is a sibling of the
  * `.card__open` button, since buttons can't nest.
  */
  function noteCard(note: NoteSummary, i: number): HTMLElement {
    const { node: media, target, thumbClass, thumb, alt } = thumbMedia(note);
    const inList = ctx.getView() === "list";
    const marks = cardMarks(note);
    const tile = el("div", { class: thumbClass }, inList ? null : marks, media);
    applyTileAspect(tile, note, media, inList);
    const open = openControl(
      noteHref(note.id),
      () => go(noteHref(note.id)),
      tile,
      el(
        "div",
        { class: "card__body" },
        inList ? marks : null,
        el(
          "div",
          { class: "card__main" },
          el("div", { class: "card__title", text: note.name }),
          el(
            "div",
            { class: "card__meta" },
            el("span", { text: fmtDate(note.updatedAt) }),
            el("span", { class: "dot" }),
            el("span", { text: `${note.pageCount} ${note.pageCount === 1 ? "page" : "pages"}` }),
          ),
        ),
      ),
    );

    const card = el(
      "li",
      { class: "card" },
      open,
      ctx.cardMenu(note),
    );
    card.style.animationDelay = `${Math.min(i * 24, 240)}ms`;
    if (target) galleryEngine.add({ target, noteId: note.id, page: note.firstPage, size: "thumb", thumb, alt });
    return card;
  }

  /**
  * The list row plus folder path and a `pageSummary` line. Its link carries the
  * query and first matching page so find runs on arrival. Expansions are not
  * shown per row (see `gallerySearch.ts`).
  */
  function resultCard(result: SearchResult, i: number, q: string, expansions: readonly Expansion[] = []): HTMLElement {
    const note = result.note;
    const { node: media, target, thumbClass, thumb, alt } = thumbMedia(note);
    // The page the result opens on: the first match, then the excerpt's page once shown.
    let top = result.pages[0];
    const matchLine = pageSummary(result.pages.length, result.kind);

    const tile = el("div", { class: thumbClass }, media);
    applyTileAspect(tile, note, media, true);

    // The query rides the URL, so the link survives reload and can be shared.
    // Only rows with transcript hits carry the expansion (`deepLinkQuery`).
    const linkQ = deepLinkQuery(q, result.pages.length > 0 ? expansions : []);
    const opensAt = () => (top === undefined ? noteHref(result.noteId, linkQ) : notePageHref(result.noteId, top, linkQ));
    const open = openControl(
      opensAt(),
      () => go(opensAt()),
      tile,
      el(
        "div",
        { class: "card__body" },
        cardMarks(note),
        el(
          "div",
          { class: "card__main" },
          el("div", { class: "card__title" }, ...(result.nameMatched ? markedText(note.name, q) : [document.createTextNode(note.name)])),
          el(
            "div",
            { class: "card__meta" },
            result.folderPath ? el("span", { class: "card__path", text: result.folderPath }) : null,
            result.folderPath ? el("span", { class: "dot" }) : null,
            el("span", { text: fmtDate(note.updatedAt) }),
            matchLine ? el("span", { class: "dot" }) : null,
            matchLine ? el("span", { class: "card__matches", text: matchLine }) : null,
          ),
          result.md5 && result.pages.length > 0 && ctx.excerpts
            ? ctx.excerpts.slot({ md5: result.md5, pages: result.pages }, q, expansions, result.kind === 1 ? null : "p.", (segment) => {
                top = segment;
                open.setAttribute("href", opensAt());
              })
            : null,
        ),
      ),
    );

    const card = el("li", { class: "card card--result" }, open);
    card.style.animationDelay = `${Math.min(i * 24, 240)}ms`;
    if (target) galleryEngine.add({ target, noteId: note.id, page: note.firstPage, size: "thumb", thumb, alt });
    return card;
  }

  return { folderCard, noteCard, resultCard };
}
