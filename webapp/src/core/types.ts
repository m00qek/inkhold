// The shared domain vocabulary for the file browser and reader. Data, no logic.

/** A file/folder identifier. Opaque to the client; the server assigns it. */
export type Id = string;

/**
 * A content hash (md5 hex). Page/render caching keys off the per-page content
 * hash so an edit elsewhere in a note doesn't invalidate an unchanged page.
 */
export type Hash = string;

/** Colour world the note is painted in — dark = inverted e-ink. */
export type Theme = "light" | "dark";

/**
 * Output resolution tier for a rendered page. `native` is the page's own pixel
 * size, for export only, and is never cached.
 */
export type RenderSize = "thumb" | "full" | "native";

/**
 * One recognized word, for the searchable-PDF text layer. `*Mm` are
 * millimetres (device RECOGNTEXT values, origin top-left), not pixels; see
 * {@link NoteMeta.pxPerMm}.
 */
export interface WordBox {
  text: string;
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
}

/** A page's recognition: the flat transcript plus the same words positioned. */
export interface PageText {
  text: string;
  words: WordBox[];
}

/**
 * One link on a page, from the server for a `.note` and from the wasm decoder
 * for a `.pdf`. `x,y,w,h` are in the page's display space (top-left, y down);
 * the unit differs by producer (see `Api.getPageLinks`). `page` is the 0-based
 * target of an internal link, or -1 for an external one.
 */
export interface PdfLink {
  x: number;
  y: number;
  w: number;
  h: number;
  page: number;
  uri: string;
}

/** A layer's identity on the wire: the `.note` format's five fixed slots. */
export type LayerSlot = "main" | "layer1" | "layer2" | "layer3" | "background";

/** The five slots in wire order; the array index is the slot's wire id. */
export const LAYER_SLOTS: readonly LayerSlot[] = ["main", "layer1", "layer2", "layer3", "background"];

/**
 * One layer of one page (`LayerVO`). Entries are in SNPG record order
 * (bottom-to-top) and pair with the payload's records by slot, never by
 * position. `name` is `""` when the device wrote none. `visible` is
 * device-authored; a hidden layer's record still ships, flagged `hidden`.
 */
export interface PageLayer {
  slot: LayerSlot;
  name: string;
  visible: boolean;
  isCurrent: boolean;
}

/** One page of a note: where it is in the note and how to cache/size it. */
export interface PageRef {
  /** 0-based position within the note. */
  index: number;
  /**
   * The page's own 1-based number in its container. `null` for a `.note`
   * (always `index + 1`). A `.mark` holds only the annotated pages of its PDF
   * and names them by PDF page, e.g. 2, 5, 6 (`note-format.md` §13.2).
   */
  sourcePage: number | null;
  /** Per-page content hash — the cache key and the `?v=` URL version. */
  hash: Hash;
  /** Native page dimensions in device pixels, for sizing the canvas. */
  width: number;
  height: number;
  /**
   * Hash of this page's RECOGNTEXT block, or `null` when the device never
   * recognized it; non-null is the "has recognized text" signal. Separate from
   * {@link hash}, which covers only layer bitmaps: running recognition leaves
   * `hash` unchanged, so keying text by it would pin a stale empty response in
   * the immutable cache. Optional on the wire, normalized to `null`.
   */
  textHash: Hash | null;
  /**
   * Hash of this page's `EXTERNALLINKINFO` block (links from a PDF template,
   * `note-format.md` §14), or `null` when absent. Same arrangement as
   * {@link textHash}: re-importing a template can change links without
   * changing strokes.
   */
  linksHash: Hash | null;
  /**
   * The page's layers for the layers panel; absent means the page has none and
   * renders as the single composite. The server omits the field rather than
   * sending `null` or `[]`. Also carried on a listing entry's `firstPage`,
   * because the reader paints a skeleton from the summary before meta arrives.
   */
  layers?: PageLayer[] | null;
  /**
   * Whether any non-background layer carries a mark. `undefined` means the
   * server has not looked yet (back-fill in progress) and must render as no
   * claim, not as empty.
   */
  hasInk?: boolean;
}

/** A subfolder in a listing. */
export interface Folder {
  kind: "folder";
  id: Id;
  name: string;
  /**
   * Live direct children of every kind, trash excluded. Omitted on breadcrumb
   * folders; `undefined` means "not counted here", `0` means empty.
   */
  itemCount?: number;
}

/**
 * A note as it appears in a folder listing. Carries only the first page so a
 * large folder stays a small payload; the full page list comes via
 * {@link NoteMeta}.
 */
export interface NoteSummary {
  kind: "note";
  id: Id;
  name: string;
  pageCount: number;
  firstPage: PageRef;
  /** Epoch ms of the last change — for stable ordering and SWR reconciliation. */
  updatedAt: number;
  /**
   * What the file is (`"note"`, `"pdf"`, `"txt"`, …), lowercase, no dot. The
   * server sniffs the blob and falls back to the extension only when it can't
   * parse it. Derived from the name at the seam when absent.
   */
  fileType: string;
  /**
   * Whole-file md5, the `?v=` of `/file/{id}`, or `null`. Kept separate from
   * `firstPage.hash` even though they coincide for unparseable blobs today.
   */
  fileHash: Hash | null;
  /**
   * At least one page has a non-null `textHash`; matches the search filter
   * exactly. Defaults to `false` when absent.
   */
  hasRecognizedText: boolean;
  /**
   * Pixel dims of the tile this entry previews as, so the gallery can lay it
   * out before bytes arrive: a `.note`'s cover or page 1, a `.spd`'s thumbnail.
   * Absent (images, `.txt`, others) means unknown; only the ratio is used.
   */
  thumbAspect?: { w: number; h: number };
  /**
   * The live `.mark` annotating this file, or `null`. The server folds paired
   * marks out of listings, so this is the only way to reach them from a card.
   */
  annotationsId: Id | null;
}

/** A single row in a folder listing: either a subfolder or a note. */
export type Entry = Folder | NoteSummary;

/**
 * The contents of one folder. `syncVersion` is a per-user counter bumped
 * whenever a device upload changes the user's files.
 */
export interface Listing {
  /** The folder these entries belong to; null = root. */
  folderId: Id | null;
  /** Ancestor folders from root → here, for breadcrumbs. */
  path: Folder[];
  entries: Entry[];
  syncVersion: number;
}

/**
 * Everything the reader needs about one file. Carries file type, hash and size
 * because `#/note/:id` must be answerable from the id alone after a reload.
 */
export interface NoteMeta {
  id: Id;
  name: string;
  pages: PageRef[];
  /** Same server-verified vocabulary as {@link NoteSummary.fileType}. */
  fileType: string;
  /** The raw-bytes URL's `?v=`; see {@link NoteSummary.fileHash}. */
  fileHash: Hash | null;
  /** Size of the stored file in bytes — shown in the "no preview" state. */
  size: number;
  /**
  /**
   * The `.mark` annotating this `.pdf` (`foo.pdf.mark`, same folder), or
   * `null`. Resolved by the server since deep links have no listing. Always
   * `null` in the bin: trashing a PDF does not trash its mark.
   */
  annotationsId: Id | null;
  /**
   * Device px per mm for the hardware that wrote this note, or `null` when the
   * server has not verified that hardware. `null` means raster-only PDF export:
   * a guessed scale would yield invisible text that is silently misplaced.
   */
  pxPerMm: number | null;
}

/**
 * One version of a file. `md5` addresses the immutable blob and its
 * `/thumbnail/{md5}`. `createdAt` is epoch ms.
 */
export interface FileVersion {
  md5: Hash;
  /** Stored size of this version's blob, in bytes. */
  size: number;
  /** Epoch ms this version became current (the live one: the file's last change). */
  createdAt: number;
  current: boolean;
  /**
   * Pages in this version's blob, or `0` when not countable (falls back to
   * showing {@link size}).
   */
  pageCount: number;
}

/** A file's version list, newest-first, with the current blob flagged. */
export interface FileHistory {
  id: Id;
  versions: FileVersion[];
}

/** The new current version after a restore. */
export interface RestoredVersion {
  md5: Hash;
  size: number;
  createdAt: number;
  current: true;
}
