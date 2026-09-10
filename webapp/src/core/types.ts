// The shared domain vocabulary for the file browser + reader. These types are
// the contract every workstream agrees on: the web-backend produces them, the
// UI consumes them, the renderer and cache key off them. Keep this file small
// and free of behavior — it is data, not logic.

/** A file/folder identifier. Opaque to the client; the server assigns it. */
export type Id = string;

/**
 * A content hash (md5 hex). Two flavours appear in the protocol (see the device
 * `SummaryInfoVO`): a whole-file hash and a per-page
 * CONTENT hash. Page/render caching keys off the *content* hash so an edit
 * elsewhere in a note doesn't invalidate an unchanged page.
 */
export type Hash = string;

/** Colour world the note is painted in — dark = inverted e-ink. */
export type Theme = "light" | "dark";

/**
 * Output resolution tier for a rendered page. Keeps the render cache from mixing
 * a gallery thumbnail with a full reader page under the same key.
 *
 * `native` is the page's own pixel size — nothing is ever upscaled. It exists for
 * EXPORT, not for display: a downscaled export would quietly redefine "export" as
 * "export, smaller". It is deliberately never cached, so full-resolution bitmaps
 * stay out of the render cache's budget.
 */
export type RenderSize = "thumb" | "full" | "native";

/**
 * One recognized word and where it sits on the page, for the searchable-PDF
 * text layer. **`*Mm` are MILLIMETRES, not pixels** — the device's own numbers
 * out of the `.note` RECOGNTEXT block, origin top-left. The names carry the unit
 * because the server deliberately does not convert: see {@link NoteMeta.pxPerMm}.
 */
export interface WordBox {
  text: string;
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
}

/**
 * A page's recognition: the flat transcript the OCR panel shows, plus the same
 * words positioned. `words` is empty whenever the page has no positioned words —
 * including every page with no recognition at all.
 */
export interface PageText {
  text: string;
  words: WordBox[];
}

/**
 * One link on a page — TWO PRODUCERS, ONE TYPE. It arrives from the server for
 * a `.note`'s links (`PageLinks`, `api/types.ts`) and from the wasm decoder for
 * a `.pdf`'s (`render/pdfWire.ts`, `ink_page_links`), and the layer, the
 * allowlist and the exporter are written once because those are the same
 * record. That is why it lives here and not with the decoder.
 *
 * `x,y,w,h` are the box in the page's own DISPLAY space — top-left origin, y
 * down. The UNIT differs by producer (see `Api.getPageLinks`); the shape does
 * not.
 *
 * `page` is the resolved 0-based target of an INTERNAL link, or -1 for an
 * external one. For a `.pdf` the resolving happens in the decoder, where the
 * document is.
 */
export interface PdfLink {
  x: number;
  y: number;
  w: number;
  h: number;
  page: number;
  uri: string;
}

/**
 * A layer's identity on the wire — the SNPG record's slot byte, spelled out.
 * Five fixed slots is the `.note` format's own vocabulary (`MAINLAYER`,
 * `LAYER1..3`, `BGLAYER`); the server pairs every payload record with exactly
 * one of these, so the client never matches layers by array position.
 */
export type LayerSlot = "main" | "layer1" | "layer2" | "layer3" | "background";

/**
 * The five slots in wire order — the array index is the slot's wire id
 * (0 = main … 4 = background), the `.note` format's own fixed numbering. The
 * decoder hands a record's slot back by this id; this is the one place the
 * client turns that id into a `LayerSlot`.
 */
export const LAYER_SLOTS: readonly LayerSlot[] = ["main", "layer1", "layer2", "layer3", "background"];

/**
 * One layer of one page, as `NoteMetaVO.pages[].layers` carries it — the layer
 * PANEL's model (`LayerVO`). Entries
 * are in SNPG record order (bottom-to-top) and pair with the page payload's
 * records BY SLOT, never by position.
 *
 * `name` is the device's `LAYERINFO` display name (`""` when the device wrote
 * none — the UI derives a slot default). `visible` is DEVICE-AUTHORED state: a
 * hidden layer's record still ships on the wire (flagged `hidden`), so the
 * panel can toggle it on. `isCurrent` marks the layer selected on the device.
 * All read-only — layer tuning is view-only everywhere, always.
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
   * The page's OWN number in its container, 1-based — where {@link index} is
   * where its bytes live, this is which page it IS.
   *
   * `null` for every `.note`, where it is always `index + 1` and the server
   * omits it rather than shipping a derivable field. It is present for a
   * `.mark`: a mark holds only the pages of a PDF that were ANNOTATED and names
   * them by the PDF page they belong to, so a real three-page capture is pages
   * 2, 5 and 6 (`parsers/note/note-format.md` §13.2). Compositing a mark onto
   * its PDF is exactly the question "which page of the PDF is this?", and this
   * is the only field that answers it.
   */
  sourcePage: number | null;
  /** Per-page content hash — the cache key and the `?v=` URL version. */
  hash: Hash;
  /** Native page dimensions in device pixels, for sizing the canvas. */
  width: number;
  height: number;
  /**
   * Content hash of this page's handwriting-recognition text (the `.note`
   * container's RECOGNTEXT block — see parsers/note/src/recognition.zig), or `null` when
   * the device never recognized this page (RECOGNSTATUS != 1). Recognition only
   * exists where the user ran it ON the device, so MOST pages are `null`.
   *
   * `textHash !== null` IS the "has recognized text" signal. It is one field
   * rather than a boolean plus a hash precisely so the two can never disagree,
   * and it is carried on the page list so the reader can render the "Recognized
   * text" toggle in its correct enabled/disabled state the moment a note opens,
   * WITHOUT a speculative per-page fetch. The text itself stays lazy — see
   * `Api.getPageText`.
   *
   * WHY NOT reuse {@link hash}: the page content hash covers only the layer
   * bitmap blocks, NOT RECOGNTEXT. Running recognition on the device adds a
   * transcript while leaving the strokes — and therefore `hash` — untouched, so
   * keying the transcript by `hash` would let a year-long `immutable` cache entry
   * pin the pre-recognition empty response forever, with the toggle advertising
   * text the panel could never show. This hash changes exactly when the
   * recognition changes, and only then.
   *
   * Nullable in the domain, optional on the wire: the server omits null
   * optionals, so the HTTP client normalizes `undefined` → `null` at the seam.
   */
  textHash: Hash | null;
  /**
   * Content hash of this page's `EXTERNALLINKINFO` block — the links a PDF used
   * as this page's template brought with it (`parsers/note/note-format.md` §14,
   * decoded by parsers/note/src/links.zig) — or `null` when the page has no such
   * block, which is every page of every note that was not built on an imported
   * PDF.
   *
   * The same arrangement as {@link textHash}, and for the same two reasons.
   * `linksHash !== null` IS the "this page has links" signal, so the reader
   * fetches for the page in front of it and asks nothing at all about the rest —
   * which matters here more than it does for text: the capture that established
   * the format carries 51,256 records over 1702 pages, so a per-page fetch is
   * the only shape that can serve it. And it is a SEPARATE hash from
   * {@link hash}, because `hash` covers the layer bitmaps only: re-importing a
   * template can change a page's links while leaving every stroke alone.
   *
   * Nullable in the domain, optional on the wire — the server omits null
   * optionals, so the HTTP client normalizes `undefined` → `null` at the seam.
   */
  linksHash: Hash | null;
  /**
   * The page's layers for the reader's layers panel, or `null`/absent when the
   * server sent none — in which case there is NO panel and the page renders as
   * the single device-authored composite, exactly as before layers existed.
   *
   * Carried on `NoteMetaVO.pages` AND on a listing/bin entry's `firstPage`, in
   * the same shape, with the same all-or-nothing semantics. The listing half is
   * not layer-awareness leaking outward: THE READER OPENS FROM A SUMMARY. It
   * paints a skeleton `NoteMeta` off the listing entry while `getNoteMeta` is
   * still in flight, so without layers on `firstPage` every listing-originated
   * open painted the composite, disabled the Layers toggle (a claim about a page
   * whose real metadata had not arrived), then re-fetched the very same page
   * bytes and swapped the stack in — a second visible content swap plus a
   * duplicate request, on every layered note, every time.
   *
   * ABSENT MEANS NONE, on both routes: the server omits the field exactly when
   * the page has no layers, never sending `null` or `[]`. So a page ref that
   * came off real data (a meta page list, or a summary's `firstPage`) answers
   * the question definitively; only a page the reader's own skeleton INVENTED
   * (index > 0, before the meta lands) is genuinely unknown, and the reader
   * tracks that separately. Still optional in the type because most `PageRef`
   * producers (caches, fixtures, synthesized refs) state nothing about layers.
   */
  layers?: PageLayer[] | null;
  /**
   * Whether anything is DRAWN on this page — `true` when some non-background
   * layer carries a mark, `false` when the page is empty, and `undefined` when
   * the server has not looked yet.
   *
   * THREE STATES, AND THE THIRD IS NOT `false`. The server computes this at
   * ingest and back-fills pages indexed before the fact existed, so a page can
   * legitimately be unknown for a while. `undefined` must render as NO CLAIM —
   * the same as an inked page minus its mark — because painting it as empty
   * tells someone their notebook is blank while the worker is still catching up.
   * The wire says so by OMITTING the field, exactly as it omits
   * {@link sourcePage}, so `undefined` here is the server's own silence and not
   * a not-yet-shipped stub.
   *
   * A FLAG, NOT A COUNT, deliberately: the indicator is yes/no, and the scan
   * that answers it stops at the first stroke rather than walking a whole layer
   * to produce a number nothing displays.
   *
   * For a `.mark` this is what separates an annotated PDF page from one whose
   * annotations were erased back to nothing: {@link sourcePage} says which PDF
   * page a mark page belongs to, and this says whether it still has anything on
   * it.
   */
  hasInk?: boolean;
}

/** A subfolder in a listing. */
export interface Folder {
  kind: "folder";
  id: Id;
  name: string;
  /**
   * How many live children this folder holds DIRECTLY, of every kind — notes,
   * PDFs, images and subfolders alike.
   *
   * "Items", not "notes": the tree is not all `.note` (the device syncs PDFs into
   * `DOCUMENT/` and PNGs into `SCREENSHOT/`), so a number labelled "notes" would
   * be wrong for most folders. Trashed children are excluded, so this can never
   * disagree with the listing rendered beside it.
   *
   * Server-supplied (`FolderVO.itemCount`) and omitted on BREADCRUMB folders,
   * which are a path rather than rows to render — hence optional. `0` is a real
   * answer and means the folder is empty; `undefined` means "not counted here".
   */
  itemCount?: number;
}

/**
 * A note as it appears in a folder listing — deliberately cheap. Carries only
 * the *first* page (the gallery thumbnail source + its cache key), never the
 * whole page list, so a folder of hundreds of notes stays a small payload. The
 * full page list arrives lazily via {@link NoteMeta} when the reader opens.
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
   * What this file actually IS — `"note"`, `"pdf"`, `"txt"`, … — lowercase, no
   * dot. The gallery badge renders it verbatim.
   *
   * The tree is not all `.note`: the device syncs whatever the user drops in
   * (`EXPORT/` in particular), and the backend has a `fallbackFirst` path for
   * precisely that case. The badge used to be the hardcoded string `"note"`,
   * which made a PDF render as a "note" with a blank thumbnail and no
   * explanation — this field exists so the card stops lying.
   *
   * VERIFIED where possible: the server sniffs the blob, so something that
   * genuinely parses as a `.note` is `"note"` whatever its filename claims, and
   * only an unparseable/unknown blob falls back to its extension.
   *
   * Optional on the wire until the backend ships it — the HTTP client derives it
   * from the name at the seam (see `fileTypeFromName`).
   */
  fileType: string;
  /**
   * The whole-file content hash (md5 hex), or `null` when the server did not send
   * one. It is the `?v=` of the raw-bytes URL `/file/{id}?v={fileHash}`, which is
   * how a non-`.note` file is previewed or downloaded — see `core/fileKind.ts`.
   *
   * A SEPARATE field from `firstPage.hash` on purpose. For an unparseable blob
   * the two happen to be equal today (the server's placeholder page hash is the
   * file md5), and building the URL out of that coincidence would break silently
   * the day the placeholder changes.
   */
  fileHash: Hash | null;
  /**
   * The note carries on-device handwriting-recognition text on at least one page
   * — i.e. at least one `PageRef.textHash` is non-null.
   *
   * This matches the search filter EXACTLY: icon shown ⟺ this note can turn up
   * in a text search. It is a per-note rollup rather than a per-page fact
   * because the listing only ever carries `firstPage`, and "page 1 happens to be
   * unrecognized" is not the question the gallery is answering.
   *
   * Optional on the wire until the backend ships it; the client defaults it to
   * `false`, so the marker is absent rather than wrong.
   */
  hasRecognizedText: boolean;
  /**
   * The pixel dimensions of the tile this entry will preview as — what lets the
   * gallery lay a tile out at its FINAL shape before any image bytes arrive
   * Integers, from the server's own index:
   *
   *  - `.note` → its cover's dims when a cover exists, else PAGE 1's effective
   *    dims (a landscape note honestly reads 1872×1404);
   *  - `.spd` → its embedded thumbnail's dims;
   *  - images / `.txt` / anything else → ABSENT. A `.txt` snippet's shape is a
   *    client-side constant (we rasterise it, we fix it), and an image's dims
   *    come from the local dims memo (`cache/dimsMemo.ts`) after its first view.
   *
   * ABSENT means "unknown", never "square" or "zero": the layout falls back to
   * the portrait 3:4 default and — for images only — corrects once on first
   * decode. Only the RATIO is consumed; the numbers are the source's own pixels.
   */
  thumbAspect?: { w: number; h: number };
  /**
   * The id of the live `.mark` that annotates this file, or `null` — the LISTING
   * half of {@link NoteMeta.annotationsId}, with exactly the same shape and
   * meaning.
   *
   * It exists because a paired `.mark` has no card of its own: the server folds
   * it out of every listing (a mark is a LAYER of the document, not a document),
   * so the only place its retained versions can be reached from is the
   * DOCUMENT's row. Without this field the card would have to fetch the meta of
   * every entry to find out whether to offer the row at all.
   *
   * Only a `.pdf` ever has one, and most do not. Omitted on the wire when there
   * is none; the seam normalizes absent-or-unusable to `null`.
   */
  annotationsId: Id | null;
}

/** A single row in a folder listing: either a subfolder or a note. */
export type Entry = Folder | NoteSummary;

/**
 * The contents of one folder, plus the freshness token. `syncVersion` is a
 * per-user counter the server bumps whenever a device upload changes the user's
 * files; the UI uses it to decide whether a cached listing is stale (see
 * sync/ and [[file-serving-and-cache]] L1).
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
 * Everything the reader needs about one file — fetched when it opens.
 *
 * It carries {@link fileType}/{@link fileHash}/{@link size} as well as the page
 * list because the READER, not the gallery, is what a URL points at: `#/note/:id`
 * survives a reload and can be shared, so the decision "is this a note, an image,
 * or something with no preview" has to be answerable from the id alone. Deriving
 * it from the listing the card came from would work exactly until someone
 * refreshed the page.
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
   * The id of the `.mark` that annotates this file, or `null`.
   *
   * Only a `.pdf` ever has one: the device writes annotations to a separate
   * file named after the PDF's FULL name plus `.mark` (`foo.pdf` →
   * `foo.pdf.mark`, same folder), and most PDFs have none. The server resolves
   * the pairing, because a viewer opened from a deep link, a search result or
   * the bin holds no folder listing to search — and on this app's target link,
   * fetching a folder to discover one name is a round trip that need not exist.
   *
   * Null in the bin, deliberately: trashing a PDF does not trash its mark, so a
   * bin preview that composited annotations would paint a live file's ink onto
   * a deleted document.
   */
  annotationsId: Id | null;
  /**
   * Device pixels per millimetre for the hardware that wrote this note — the
   * scale that turns {@link WordBox} millimetres into page pixels — or `null`
   * when the server has **not verified** that hardware.
   *
   * `null` IS THE COMMON CASE AND IT MEANS "DO NOT PLACE TEXT". The server keeps
   * a millimetre allowlist deliberately separate from its pixel table, which
   * falls back to 1404×1872 for unknown equipment codes; that fallback is fine
   * for pixels and silently wrong for millimetres (an N5/Manta is 1920×2560 at
   * the same aspect). The only consumer is an INVISIBLE PDF text layer, so the
   * two failure modes are not comparable: a raster-only PDF is obviously
   * text-free, while a PDF whose invisible text is 10% out looks perfect and
   * only betrays itself when someone copies the wrong words out of it.
   *
   * So the exporter treats `null` as "raster-only PDF, and say so" rather than
   * as a scale to guess at.
   */
  pxPerMm: number | null;
}

/**
 * One version of a file — a row of its "history of this file" (hot-cache
 * versioning, H3). The CURRENT blob and every retained one share this shape; only
 * {@link current} tells them apart.
 *
 * `md5` is the version's whole-file content address: it pins the immutable blob
 * for preview/search/restore, and it is what the content-addressed thumbnail
 * endpoint (`/thumbnail/{md5}`) is keyed by — so a version's thumbnail is the
 * live library card's thumbnail endpoint with this md5. `createdAt` is epoch
 * MILLISECONDS (the server multiplies its second-resolution stamp by 1000 at the
 * seam), newest-first in {@link FileHistory.versions}.
 */
export interface FileVersion {
  md5: Hash;
  /** Stored size of this version's blob, in bytes. */
  size: number;
  /** Epoch ms this version became current (the live one: the file's last change). */
  createdAt: number;
  /** True on the ONE live version, false on every retained one. */
  current: boolean;
  /**
   * Pages in THIS version's blob — the note's own page count for this version, or
   * `0` when the file has none to count (a non-`.note` kind, or a version whose
   * count the server did not resolve). It drives the row's CONTENT SIGNAL in the
   * version menu: `> 0` renders "17 pages" plus a client-computed delta against the
   * next-older version; `0` falls back to the byte {@link size}. Optional on the
   * wire like the other late H-VO fields — the server omits null optionals, so the
   * client normalizes a missing value to `0` at the seam.
   */
  pageCount: number;
}

/** A file's version list, newest-first, with the current blob flagged. */
export interface FileHistory {
  id: Id;
  versions: FileVersion[];
}

/**
 * The new current version after a restore (H9). Restore re-points the file at a
 * retained blob through the normal supersede path, so what comes back is just the
 * file's freshly-current version — `current` is therefore always true.
 */
export interface RestoredVersion {
  md5: Hash;
  size: number;
  createdAt: number;
  current: true;
}
