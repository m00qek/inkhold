// The gallery's CARD FACTORY — every tile the gallery paints, extracted from the
// library shell so the controller (library.ts) owns lifecycle/state and this
// owns "what a card looks like". Three public builders — `folderCard`,
// `noteCard`, `resultCard` — plus the thumbnail/aspect/marks machinery they
// share. Everything these touch arrives through the {@link GalleryCardsCtx} the
// controller constructs (its engine, its lazy image observer, the live `view`
// and search state as getters, the rail's `labelFor`, the masonry re-span, and
// the overflow menu from `cardActions.ts`) or through an imported pure helper —
// there is no hidden coupling back into the shell.

import { el } from "../ui/dom";
import { learnsAspect, pinAspect, provisionalAspect } from "../ui/tileAspect";
import { ICONS, svg, type IconName } from "../ui/icons";
import { fileKind, rawFileUrl } from "../core/fileKind";
import { getDims } from "../cache/dimsMemo";
import { go, folderHref, noteHref, notePageHref } from "../router";
import { pageSummary, deepLinkQuery, type HitPage, type SearchState } from "./noteSearch";
import type { Entry, Folder, Hash, Id, NoteSummary } from "../core/types";
import type { Category } from "./rail";
import type { LazyEngine } from "../render/lazy";

/**
 * Non-note, non-image types that get a REAL preview through the thumbnail facade
 * (painted into an engine-managed `<img>`) rather than a static glyph tile:
 * `.spd` (its extracted embedded thumbnail), `.txt` (a rasterised snippet) and
 * `.pdf` (page 0 rendered client-side through the MuPDF wasm). Images stay a
 * native `<img>`; everything else (epub, doc, unknown) keeps the honest
 * no-preview glyph.
 *
 * REGISTRATION POINT 5 OF NINE (ARCHITECTURE.md), AND IT MUST AGREE WITH
 * `strategyFor` (registration point 4). Nothing type-checks the pair: a real
 * strategy with the type missing here is a glyph tile and no indication why, and
 * that has now been the hazard for two file types running. `thumbnails.test.ts`
 * asserts the two agree for every type in the app's vocabulary, so a third
 * cannot land it silently.
 *
 * EXPORTED for that test and for `pages/bin.ts`, whose row tiles take the same
 * decision. The bin used to keep its own inline copy of a set like this and it
 * drifted the day the PDF viewer shipped (see `hasDedicatedViewer`); one set,
 * two readers, no drift.
 */
export const FACADE_THUMB_TYPES: ReadonlySet<string> = new Set(["spd", "txt", "pdf"]);

/**
 * The `.txt` snippet's shape — a CLIENT-SIDE constant, deliberately not served:
 * the facade rasterises the snippet itself at the note sheet's 3:4 (see
 * `thumbnails.ts`), so the tile can fix the shape without asking anyone.
 */
const TXT_ASPECT = 3 / 4;

/** Accessible name for the gallery's recognized-text marker (see `cardMarks`). */
const OCR_LABEL = "Has recognised text";

function fmtDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * One note that matched, however it matched.
 *
 * `note` is null when the transcript index knows of a file the shell's cached
 * tree does not (the walk has not reached it, or a sync added it since). The
 * row still renders — the hit is real and the deep link works — it simply has
 * no thumbnail, no date and no path to show, which is honest about what is
 * known rather than a guess dressed up as a fact.
 */
export interface SearchResult {
  noteId: Id;
  /** PLAIN TEXT, device-authored. */
  noteName: string;
  note: NoteSummary | null;
  /** The note's folder, `Note / Projects`-style, or null if unknown. */
  folderPath: string | null;
  /** The query appears in the NAME — which is what marks the title. */
  nameMatched: boolean;
  /** Matching pages, best-ranked first. Empty for a name-only match. */
  pages: HitPage[];
  /**
   * What {@link pages}'s indexes count — 0 (a `.note`'s PAGES) or 1 (a
   * `.txt`'s PARAGRAPHS). Only the summary wording turns on it; ROUTING is by
   * the file's real `fileType` (`viewerFor`), so a `.txt` opens the `.txt`
   * viewer whether or not this shell knew its kind.
   */
  kind: number;
}

/**
 * The state and callbacks the card factory needs from the shell. The controller
 * keeps owning all of it — this module reads the live bits through getters so a
 * card built now reflects the view/search state at build time, exactly as the
 * inline closures did.
 */
export interface GalleryCardsCtx {
  /** The gallery's lazy render engine — cards register their `<img>`/canvas here. */
  galleryEngine: LazyEngine;
  /** The native-image IntersectionObserver, or null (headless/SSR). */
  imgLazy: IntersectionObserver | null;
  /** The live grid/list toggle. */
  getView: () => "grid" | "list";
  /** The live universal-search state (a result row reads `usedFuzzy` off it). */
  getSearchState: () => SearchState;
  /** The rail's category-aware folder label (never `folder.name` directly). */
  labelFor: (folder: Folder) => string;
  /**
   * The rail's category glyph for a folder that IS one of the six pinned
   * categories, else null — what makes `folderCard` paint the folder-silhouette
   * treatment for exactly those folders. Resolved by identity in the rail, so a
   * user folder merely named like a category is not caught (see `categoryIconFor`).
   */
  categoryIconFor: (folder: Folder) => IconName | null;
  /**
   * The category behind a root-gallery stand-in for an anchor the device has not
   * created yet, else null. Such a card has NO folder behind it: it must not
   * navigate to its id and has nothing to act on (see `folderCard`).
   */
  pendingCategoryOf: (folder: Folder) => Category | null;
  /** Select a not-yet-created anchor — the gallery paints its `pending` line. */
  onSelectCategory: (cat: Category) => void;
  /** Re-run the masonry span pass after an async aspect correction. */
  scheduleSpan: () => void;
  /** The per-card overflow "…" menu (DOWNLOAD + ACTIONS) — see `cardActions.ts`. */
  cardMenu: (entry: Entry) => HTMLElement;
}

export interface GalleryCards {
  folderCard: (folder: Folder) => HTMLElement;
  noteCard: (note: NoteSummary, i: number) => HTMLElement;
  resultCard: (result: SearchResult, i: number, q: string) => HTMLElement;
}

/**
 * A facade-driven gallery thumbnail: an `<img>` the lazy engine paints by
 * swapping `src` to an object URL over the facade's WebP blob when the tile
 * scrolls into view.
 *
 * THE GALLERY NO LONGER USES AN ON-SCREEN `<canvas>` (the reader's filmstrip and
 * viewer still do). An `<img>` lets the BROWSER own decode and eviction — it
 * drops off-screen decoded pixels and re-decodes from the ~10-20 KB blob — which
 * is better memory behaviour on a phone than the hand-rolled `ImageBitmap` LRU
 * this deletes, and it trades the bitmap `.close()` dance for object-URL
 * revocation, which the engine centralises (see `paintImg`/`releaseSlot`).
 *
 * The `alt` names the note: a gallery of unnamed images is opaque to assistive
 * tech, so the tile carries the file name the way the canvas tile's card does.
 */
function engineThumbImg(name: string): HTMLImageElement {
  return el("img", { class: "thumb__img", loading: "lazy", decoding: "async", alt: name }) as HTMLImageElement;
}

/**
 * A tile's aspect from the sources that answer SYNCHRONOUSLY, in priority
 * order: the listing's `thumbAspect` fact, then the
 * `.txt` client constant. `null` means "not known yet" — an image waiting on
 * the memo, or a glyph tile with no shape of its own — and the CSS 3:4
 * fallback stands.
 */
function knownAspect(note: NoteSummary): number | null {
  const a = note.thumbAspect;
  if (a) return a.w / a.h;
  if (note.fileType.trim().toLowerCase() === "txt") return TXT_ASPECT;
  return null;
}

/**
 * The folder-silhouette tile for a PINNED CATEGORY — the device's own folder
 * shape drawn in our language (thin `--line` stroke, faint ink-tint fill), with
 * the category's own glyph centred inside it. Reserved for the six pinned
 * categories so they read as special; an ordinary folder keeps the plain tile.
 *
 * Ported from the approved mockup's `.cat__folder`: the `100 x 82` folder path
 * as the `.cat__shape`, and the 24x24 category glyph inside `.cat__glyph`
 * (see `04-library-gallery.css` for the fills/strokes and the hover green-ink).
 */
function categoryTileHtml(icon: IconName): string {
  return (
    '<svg class="cat__shape" viewBox="0 0 100 82" aria-hidden="true">' +
    '<path d="M10 22 a6 6 0 0 1 6 -6 h22 l7 7 h39 a6 6 0 0 1 6 6 v41 a6 6 0 0 1 -6 6 H16 a6 6 0 0 1 -6 -6 Z"/>' +
    "</svg>" +
    `<span class="cat__glyph">${svg(ICONS[icon], 1.35)}</span>`
  );
}

/**
 * How many items a folder holds, in words.
 *
 * "Items", not "notes": the tree holds PDFs, screenshots and `.spd` files as
 * well as notebooks, so a count labelled "notes" would be wrong for most
 * folders — and it folds subfolders in without needing a second number.
 *
 * Zero is "Empty", never "0 items": a row that says "0 items" makes the reader
 * parse a number to learn nothing is there. Singular is "1 item", not
 * "1 items". An UNCOUNTED folder (the server omitted the field) returns null
 * and the row renders no meta line at all, rather than claiming it is empty.
 */
function itemCountLabel(folder: Folder): string | null {
  const n = folder.itemCount;
  if (typeof n !== "number") return null;
  if (n === 0) return "Empty";
  return `${n} ${n === 1 ? "item" : "items"}`;
}

/**
 * The two facts a card states about itself, as ONE group: the file's real type
 * and (when present) the recognized-text marker.
 *
 * Grouped rather than pinned to opposite corners, which is what the grid used
 * to do — two marks in opposite corners read as two unrelated marks, together
 * they read as one set. The same element is built for both views and simply
 * lands somewhere different: over the thumbnail in the grid, and as the row's
 * FIRST LINE in list view, where a 64px strip has no room for an overlay and
 * the facts used to be dropped by a `display: none` instead.
 *
 * Built once per render (the gallery repaints on the view toggle) rather than
 * rendered twice and hidden — two copies would say the OCR marker's accessible
 * name twice into the card button's name.
 */
function cardMarks(note: NoteSummary): HTMLElement {
  return el(
    "div",
    { class: "card__marks" },
    // The badge is the file's ACTUAL type, from the server. It used to be the
    // hardcoded string "note", which mislabelled every PDF/image the device
    // syncs into the tree.
    el("span", { class: "card__badge", text: note.fileType }),
    // A quiet marker, not a control: it means "this note has on-device
    // recognized text", which is exactly the condition for it to be findable
    // by a text search. `role="img"` + `aria-label` give it a real accessible
    // name — it carries meaning, so it must not be a bare decorative glyph.
    // It also folds into the card button's accessible name, which is wanted:
    // a screen-reader user hears the marker too.
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
 * The query's occurrences in a device-authored string, as DOM nodes — text
 * nodes and `<mark>` elements, never markup.
 *
 * The highlight IS the explanation: a marked title means the note matched by
 * name, a marked excerpt means it matched by handwriting, both means both. No
 * "why it matched" badge is needed and none would be as honest.
 *
 * Built as nodes rather than as an HTML string ON PURPOSE. `noteName` is raw
 * device text with no escaping pass behind it — the snippet's `innerHTML` is
 * safe precisely because the SERVER escaped around its own markers, and that
 * reasoning does not transfer to a string this client marks up itself.
 */
function markedText(text: string, q: string): Node[] {
  const needle = q.toLowerCase();
  if (needle === "") return [document.createTextNode(text)];
  const hay = text.toLowerCase();
  const out: Node[] = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    if (at > from) out.push(document.createTextNode(text.slice(from, at)));
    out.push(el("mark", { text: text.slice(at, at + needle.length) }));
    from = at + needle.length;
  }
  if (from < text.length) out.push(document.createTextNode(text.slice(from)));
  return out;
}

export function createGalleryCards(ctx: GalleryCardsCtx): GalleryCards {
  const { galleryEngine, imgLazy } = ctx;

  function thumbMedia(note: NoteSummary): {
    node: HTMLElement;
    /** The engine-managed `<img>` to register — a `.note`, `.spd` or `.txt` tile.
     *  Null for a NATIVE image tile (it loads itself off the raw-file endpoint)
     *  and a glyph tile (nothing to paint); neither is the engine's business. */
    target: HTMLImageElement | null;
    thumbClass: string;
    /** Facade hint for a tile that is NOT a note page (`.spd`/`.txt`). `aspect`
     *  carries the true canvas shape so the facade can crop a `.spd`'s
     *  letterboxed embedded preview at transcode (see `ThumbSource.aspect`). */
    thumb?: { fileType: string; fileHash: Hash | null; aspect?: { w: number; h: number } };
    /** Accessible name the engine sets on `target` when it paints. */
    alt?: string;
  } {
    const kind = fileKind(note.fileType);
    const preview = kind === "image" ? rawFileUrl(note.id, note.fileHash) : null;
    if (preview) {
      // A real image file stays a native `<img>` off the raw-file endpoint —
      // the browser decodes it for free, which beats routing it through the
      // facade's transcode for no gain. Not engine-managed. It carries `data-src`
      // rather than `src`: `imgLazy` (above) promotes it to a real `src` on
      // approach, because the browser's own `loading="lazy"` silently never
      // loads an in-viewport image inserted by an SPA re-render.
      const img = el("img", {
        class: "thumb__img",
        "data-src": preview,
        decoding: "async",
        // The card's own title already names the file; an alt repeating it would
        // be heard twice. The thumbnail is decoration ON a labelled control.
        alt: "",
      }) as HTMLImageElement;
      if (imgLazy) imgLazy.observe(img);
      else img.src = preview; // no IntersectionObserver (tests/SSR): load eagerly
      return { node: img, target: null, thumbClass: "thumb" };
    }
    if (kind !== "note") {
      const t = note.fileType.trim().toLowerCase();
      if (FACADE_THUMB_TYPES.has(t)) {
        // A `.spd` (its embedded thumbnail, extracted server-side), a `.txt` (a
        // rasterised snippet of its first lines) or a `.pdf` (page 0 rendered
        // client-side) gets a REAL preview through the thumbnail facade, painted
        // into an `<img>` by the lazy engine — not the static glyph the type
        // used to collapse to.
        const img = engineThumbImg(note.name);
        // A `.spd`'s embedded preview is a fixed 600x800 PORTRAIT that letterboxes
        // the real (often landscape) drawing. The true canvas aspect (server
        // `thumbAspect` from surface dims) rides along so the facade CROPS the
        // letterbox bands at transcode — the cached WebP is already borderless and
        // correctly shaped, so display is plain `contain` for every consumer (grid,
        // list, bin). `.txt` states no aspect and rasterises its snippet at 3:4.
        // A `.pdf` states none either — nothing indexes a PDF's page box server
        // side — and learns its own from the render (see `applyTileAspect`).
        return {
          node: img,
          target: img,
          thumbClass: "thumb",
          thumb: { fileType: t, fileHash: note.fileHash, aspect: note.thumbAspect },
          alt: note.name,
        };
      }
      // The glyph alone made an `.epub` and an unknown file identical, because
      // one symbol is all "a document that is not a notebook" can say. Lettering
      // the tile with the type distinguishes them without inventing an icon per
      // extension. `.spd`/`.txt`/`.pdf` no longer land here — they have real
      // previews (a PDF that will not render still gets its glyph, but from the
      // FACADE's floor, inside the same `<img>`).
      return {
        node: el("span", { class: "thumb__glyph", html: svg(ICONS.doc, 1.4) }),
        target: null,
        thumbClass: "thumb thumb--file",
      };
    }
    // A `.note` goes through the facade's note-page strategy: its server-
    // extracted COVER when the user set one (fetched by the whole-file hash —
    // which is why `thumb` carries it), else page 0 rendered client-side. The
    // engine paints the resulting WebP blob into this `<img>` either way.
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
   * Give a card's tile its final shape BEFORE any bytes arrive — the whole of
   * the reflow-free contract. Sources in priority order: `thumbAspect` → the
   * `.txt` constant → the dims memo → the decoded tile itself, which is the
   * single corrective reflow a first-ever view is allowed; everything else keeps
   * the CSS 3:4 fallback. The async corrections re-span the masonry; entries
   * with a synchronous answer never move again.
   */
  function applyTileAspect(tile: HTMLElement, note: NoteSummary, media: HTMLElement, row: boolean): void {
    const aspect = knownAspect(note);
    if (aspect !== null) {
      pinAspect(tile, aspect, row);
      return;
    }
    if (!learnsAspect(note.fileType)) return; // glyph tiles have no shape to learn
    // Something to stand on until the pixels answer. Only a `.pdf` takes one —
    // see `provisionalAspect` for why an image deliberately does not — and it is
    // still a GUESS, so the corrective sources below stay wired.
    const provisional = provisionalAspect(note.fileType);
    if (provisional !== null) pinAspect(tile, provisional, row);
    const correct = (w: number, h: number): void => {
      if (!tile.isConnected || !(w > 0) || !(h > 0)) return;
      pinAspect(tile, w / h, row);
      ctx.scheduleSpan();
    };
    // The memo answers for every hash decoded before — often before this frame
    // paints, so in practice only a hash's FIRST-ever view reflows.
    if (note.fileHash) {
      void getDims(note.fileHash).then((dims) => {
        if (dims) correct(dims.w, dims.h);
      });
    }
    // The decoded tile is the truth when the memo has none yet. Idempotent
    // against the memo racing it — both state the same shape. For a `.pdf` this
    // is the facade's WebP, whose raster carries page 0's aspect.
    //
    // EVERY `load`, NOT THE FIRST ONE, and that is the whole of a defect this
    // spent a while being read as e2e flake. The same `<img>` is painted TWICE
    // whenever a tile is slow: `render/lazy.ts` races the produce against
    // `PLACEHOLDER_AFTER_MS` and paints the type's generic glyph if the produce
    // loses, then repaints the element with the real pixels when they land.
    //
    // With `{ once: true }` the glyph's `load` won — it pinned the glyph's 3:4
    // and REMOVED the listener, so the real pixels arrived to nothing and the
    // tile kept a shape it had already been told was a guess. It reproduced only
    // under parallel load, because that is the only time the produce loses a
    // 200 ms race, and passed in isolation for the same reason.
    //
    // The old comment here said the glyph appears "if the render failed". It
    // also appears when the render is merely SLOW, which is the case that bit.
    // Correcting on every load is right in both: the real pixels are always
    // painted last, so the final call is the honest one, and a render that truly
    // failed leaves the glyph's shape — which is what it had anyway.
    if (media instanceof HTMLImageElement) {
      if (media.complete && media.naturalWidth > 0) correct(media.naturalWidth, media.naturalHeight);
      media.addEventListener("load", () => correct(media.naturalWidth, media.naturalHeight));
    }
  }

  /**
   * A folder in the gallery. TWO SHAPES, deliberately:
   *
   * - GRID: the compact chip. It sizes to its own icon + name (`align-self:
   *   start`) rather than stretching to the height of the note thumbnails it
   *   shares a row with — a folder has no page to preview, and a folder-shaped
   *   box as tall as a notebook cover would promise one.
   * - LIST: the same row as a note — 64px lead tile, badge line, name, meta —
   *   because in a list the two ARE the same kind of thing: one line item you
   *   click to go somewhere. Sharing the note row's markup is what makes them
   *   share its alignment system rather than approximate it with a second set of
   *   numbers that drift.
   */
  function folderCard(folder: Folder): HTMLElement {
    const inList = ctx.getView() === "list";
    const meta = itemCountLabel(folder);
    // A PINNED CATEGORY (Note, Document, MyStyle, Export, Screenshot, Inbox) gets
    // the folder-silhouette tile with its own glyph inside; every ordinary folder
    // keeps the plain tinted-glyph tile. The rail decides which is which, by
    // identity — see `categoryIconFor`.
    const catIcon = ctx.categoryIconFor(folder);
    const pendingCat = ctx.pendingCategoryOf(folder);
    const tile = catIcon
      ? el("div", { class: "thumb thumb--category", html: categoryTileHtml(catIcon) })
      : // A folder has no page to preview, so its tile carries a centred glyph on
        // the same stock as a note thumb — same footprint, no false promise of
        // content. Identical in both views: in the grid this is what makes the
        // gallery one uniform set of tiles instead of chips interleaved with
        // cards, and in a list it is the row's 64px lead.
        el("div", { class: "thumb thumb--folder", html: svg(ICONS.folder, 1.4) });
    const open = el(
      "button",
      { class: "card__open", type: "button" },
      tile,
      el(
        "div",
        { class: "card__body" },
        // The badge line is a LIST-view line (in the grid the marks are an
        // overlay on the page image, and a folder tile has no image to overlay).
        inList ? el("div", { class: "card__marks" }, el("span", { class: "card__badge", text: "folder" })) : null,
        el(
          "div",
          { class: "card__main" },
          // Device-authored name → textContent, not interpolated markup.
          // Same label the rail and the breadcrumb use — a folder card for a
          // category anchor must not read `EXPORT` beside a rail row reading
          // `Export`. `rail.labelFor` falls back to the device's own name for
          // every folder that is not an anchor.
          el("div", { class: "card__title", text: ctx.labelFor(folder) }),
          meta === null ? null : el("div", { class: "card__meta" }, el("span", { text: meta })),
        ),
      ),
    );
    // A NOT-YET-CREATED anchor has no folder to open: selecting it paints the
    // category's `pending` line, exactly as the rail's unresolved row does.
    // Routing to its synthetic id would request a listing for a folder that does
    // not exist.
    open.addEventListener("click", () =>
      pendingCat ? ctx.onSelectCategory(pendingCat) : go(folderHref(folder.id)),
    );
    // LIST VIEW ONLY, and now the SAME overflow menu a note row carries (Move to
    // bin — a folder has no pages to Download). In the grid a folder is a compact
    // chip that sizes to its own name, with nowhere for the "…" to sit that would
    // not turn it back into a card; the list row has the room.
    // No menu on a stand-in: every action it offers (Move to bin, Rename) needs a
    // folder that exists. It regains one the moment the walk resolves it.
    return el(
      "div",
      { class: catIcon ? "card card--folder card--category" : "card card--folder" },
      open,
      inList && !pendingCat ? ctx.cardMenu(folder) : null,
    );
  }

  /**
   * A note card. The `.card` is a WRAPPER, not the button.
   *
   * In list view the row carries an action of its own, and a `<button>` cannot
   * contain another `<button>` — so the clickable region is `.card__open` and
   * the action is its sibling. The wrapper is also what `position: relative` and
   * the stagger animation hang off.
   *
   * The action is built only for the view that shows it, rather than rendered
   * always and hidden: the view toggle repaints the gallery, so there is never a
   * stale variant to go out of sync.
   */
  function noteCard(note: NoteSummary, i: number): HTMLElement {
    const { node: media, target, thumbClass, thumb, alt } = thumbMedia(note);
    const inList = ctx.getView() === "list";
    const marks = cardMarks(note);
    // Grid: over the page image. List: the row's first line, above the title.
    const tile = el("div", { class: thumbClass }, inList ? null : marks, media);
    // The tile's final shape, before any bytes arrive — see `applyTileAspect`.
    applyTileAspect(tile, note, media, inList);
    const open = el(
      "button",
      { class: "card__open", type: "button" },
      tile,
      el(
        "div",
        { class: "card__body" },
        inList ? marks : null,
        // Title and date are one fact about the note, so they stay together and
        // the row's slack opens above them instead of between them.
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
    open.addEventListener("click", () => go(noteHref(note.id)));

    const card = el(
      "div",
      { class: "card" },
      open,
      // The SAME sectioned overflow menu in both views now — grid and list offer
      // one identical set (a per-type DOWNLOAD group + ACTIONS). Move to bin is
      // offered for EVERY file (a PDF and a screenshot are as deletable as a
      // notebook); the DOWNLOAD group's contents vary by file kind (see cardMenu).
      ctx.cardMenu(note),
    );
    card.style.animationDelay = `${Math.min(i * 24, 240)}ms`;
    // Only an engine-managed `<img>` is the render engine's business. A native
    // image card loads itself (no target), so it is never registered; a
    // `.note`/`.spd`/`.txt` tile carries a `thumb` hint so the facade
    // renders/fetches/rasterises it into the `<img>` when it scrolls into view.
    if (target) galleryEngine.add({ target, noteId: note.id, page: note.firstPage, size: "thumb", thumb, alt });
    return card;
  }

  /**
   * One result: the library's own list row, asked a question.
   *
   * It reuses the row wholesale — same thumbnail, same badges, same title/meta
   * rhythm — and adds only what the question needs: the folder the note lives in
   * (results are library-wide, so "where is this?" is a real question now), the
   * excerpt that matched, and how far through the note the query reached.
   *
   * THE PAGE CHIPS ARE GONE. A strip of per-page buttons made the row a menu of
   * destinations, and the destination was never the question — "which notebook
   * was that in?" is. Worse, it grew without bound: a note matching on twenty
   * pages was twenty targets to read past. What is left is one quiet line of
   * metadata beside the date (see `pageSummary`), and the row's own link, which
   * now carries the QUERY as well as the best page — so clicking a result opens
   * the note with find already running, and every matching page is one Next away
   * inside the reader rather than one chip away outside it.
   */
  function resultCard(result: SearchResult, i: number, q: string): HTMLElement {
    const searchState = ctx.getSearchState();
    const note = result.note;
    const { node: media, target, thumbClass, thumb, alt } = note
      ? thumbMedia(note)
      : {
          node: el("span", { class: "thumb__glyph", html: svg(ICONS.doc, 1.4) }),
          target: null,
          thumbClass: "thumb thumb--file",
          thumb: undefined,
          alt: undefined,
        };
    const top = result.pages[0];
    // Kind-aware: a `.txt` result counts PARAGRAPHS, a `.note` counts PAGES.
    const matchLine = pageSummary(result.pages.length, result.kind);

    // A result row is a LIST row, so its lead gets the same pre-set aspect the
    // library's rows do — known only where the cached tree knows the note.
    const tile = el("div", { class: thumbClass }, media);
    if (note) applyTileAspect(tile, note, media, true);

    const open = el(
      "button",
      { class: "card__open", type: "button" },
      tile,
      el(
        "div",
        { class: "card__body" },
        note ? cardMarks(note) : null,
        el(
          "div",
          { class: "card__main" },
          // Marked only where the NAME is what matched — see `markedText`.
          el("div", { class: "card__title" }, ...(result.nameMatched ? markedText(result.noteName, q) : [document.createTextNode(result.noteName)])),
          el(
            "div",
            { class: "card__meta" },
            // The path, in the BIN'S treatment (`.bin__path`, `.card__path` —
            // one shared rule). A bin row's home is not where you are standing
            // either; same question, so the same answer looks the same.
            result.folderPath ? el("span", { class: "card__path", text: result.folderPath }) : null,
            result.folderPath && note ? el("span", { class: "dot" }) : null,
            note ? el("span", { text: fmtDate(note.updatedAt) }) : null,
            // How far the query reached, in the meta line rather than in a strip
            // of its own: it describes the row the same way the folder and the
            // date do. Null for a name-only match — see `pageSummary` for why it
            // counts pages and not matches.
            matchLine && (result.folderPath || note) ? el("span", { class: "dot" }) : null,
            matchLine ? el("span", { class: "card__matches", text: matchLine }) : null,
          ),
          // THE ONE innerHTML OF SERVER DATA IN THIS APP, and it is deliberate.
          // `snippet` arrives HTML-escaped by the backend with `<mark>`/`</mark>`
          // spliced in AFTER that escaping (note_search.escapeSnippet), so the
          // markup here is only ever those two tags. Escaping it again would show
          // literal `&lt;mark&gt;`; passing any SIBLING field through here would be
          // a real injection, which is why `noteName` above is textContent.
          top ? el("div", { class: "hit__snippet", html: top.snippet }) : null,
        ),
      ),
    );
    // Whole-row open goes to the best-ranked page, which is the one the visible
    // excerpt came from — clicking the excerpt lands where the excerpt is — AND
    // carries the query, so find is already running when you arrive. That is what
    // replaces the chips: the other matching pages are reachable with Next
    // instead of being enumerated out here.
    //
    // The query travels in the URL rather than in shell state precisely so this
    // is one link: it survives a reload, it can be shared, and the reader is
    // primed by the same route it is opened by.
    // THE DEEP LINK CARRIES THE RESOLVED TERM (in-doc-search Phase 3, route 2).
    // On a fuzzy global search the word actually in the document is the
    // correction, not the typo — and the server already marked it in this hit's
    // excerpt, so the link carries that resolved term. The viewer's find then
    // runs it EXACT on open (the corrected word really is there), skipping the
    // in-doc fuzzy scan. On an exact search, and for a name-only row with no
    // excerpt, this is just the typed query. The query/matching are unchanged;
    // only which term the LINK hands the viewer differs.
    const usedFuzzy = searchState.kind === "results" && searchState.usedFuzzy;
    const linkQ = deepLinkQuery(q, usedFuzzy, top?.snippet);
    open.addEventListener("click", () =>
      go(top ? notePageHref(result.noteId, top.pageIndex, linkQ) : noteHref(result.noteId, linkQ)),
    );

    const card = el("div", { class: "card card--result" }, open);
    card.style.animationDelay = `${Math.min(i * 24, 240)}ms`;
    if (target && note) galleryEngine.add({ target, noteId: note.id, page: note.firstPage, size: "thumb", thumb, alt });
    return card;
  }

  return { folderCard, noteCard, resultCard };
}
