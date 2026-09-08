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
 * One full-text search result. A hit is a PAGE, not a note: the transcript index
 * is per-page, and the whole value of the excerpt is that it points at the page
 * the words are actually on. That is why {@link SearchHit.pageIndex} exists and
 * why the UI deep-links to it rather than to the note's first page.
 */
export interface SearchHit {
  /** The FILE id — open it with the reader, same as a gallery card. */
  noteId: Id;
  /** The note's name, for the result row's heading. PLAIN TEXT — see below. */
  noteName: string;
  /** 0-based page the match is on. The reader is opened at exactly this page. */
  pageIndex: number;
  /**
   * ⚠️ **PRE-ESCAPED HTML.** The excerpt around the match, with `<mark>…</mark>`
   * around the matched terms and *everything else HTML-escaped by the server*
   * (`note_search.escapeSnippet` — the raw transcript is device-authored text
   * that may itself contain `<`, `&` or a whole `<script>`, so the escaping has
   * to happen on the side that splices the markers in).
   *
   * Therefore, and ONLY for this field:
   *   - render it with `innerHTML`, or the highlighting shows as literal
   *     `&lt;mark&gt;`;
   *   - do NOT escape it again, for the same reason;
   *   - and do NOT extend that treatment to any sibling field. `noteName` is raw
   *     device text with no escaping pass behind it and goes through
   *     `textContent`, exactly as the reader's transcript does.
   */
  snippet: string;
  /**
   * What {@link pageIndex} COUNTS — the segment kind. Absent (or 0) is a
   * `.note` PAGE, exactly as it always was: the server omits null optionals, so
   * a note-page hit's wire shape is byte-identical to before other kinds
   * existed. `1` is a `.txt` PARAGRAPH, whose `pageIndex` is the paragraph
   * ordinal and whose hit opens the `.txt` VIEWER (not the reader) at that
   * paragraph. Tolerant by contract — the client reads anything that is not
   * exactly `1` as a note page, so a future kind it does not know degrades to
   * the reader rather than to a blank.
   */
  kind?: number;
}

/**
 * One matching `.txt` paragraph of ONE file — find-in-txt's prev/next jumps and
 * its exact count. The `.txt` analog of {@link PageMatch}, plus the paragraph's
 * BYTE RANGE, which is what the viewer maps back to a position in the
 * already-loaded text (there are no word rectangles for plain text).
 */
export interface TxtMatch {
  /** The paragraph's segment ordinal. Equal to a library {@link SearchHit.pageIndex}
   *  for the same paragraph, so a deep link opens the viewer straight at it. */
  segment: number;
  /** The paragraph's byte offset in the blob, and its length. */
  offset: number;
  length: number;
  /**
   * How many word instances in this paragraph match — the viewer sums these
   * for "N matches". Never 0: the row exists because the index matched it.
   */
  matches: number;
  /**
   * WHICH terms this paragraph matched, folded as the index holds them
   * (lowercase, diacritics stripped). The viewer marks exactly these — the same
   * one-way authority {@link PageMatch.terms} carries: the count is the index's
   * answer, the terms are how the marks are pointed at it.
   */
  terms: string[];
}

/**
 * The `.txt`-scoped search response: EVERY matching paragraph of one file, in
 * ordinal order, with per-paragraph counts and byte ranges. Complete and
 * unranked by construction — so the viewer's "N matches in M paragraphs" is
 * exact, unlike library search's floors (single-document scope, the in-note
 * counter precedent).
 */
export interface TxtSearchResults {
  /** Echoed, so a late response is discardable — find searches per keystroke. */
  query: string;
  segments: TxtMatch[];
  /** Whether the typo-tolerant fallback ran — read strictly, as {@link NoteSearchResults}. */
  usedFuzzy: boolean;
}

/**
 * One progress step of a STREAMING in-note search — the streaming twin of
 * {@link NoteSearchResults}.
 *
 * The drain API ({@link Api.searchInNote}) hides the keyset behind one await and
 * hands back only the final, complete result. The streaming API
 * ({@link Api.searchInNoteStream}) surfaces every batch as it lands so the viewer
 * can show first matches immediately and a progressive counter: a **floor** ("N+")
 * while `done` is false, settling to the EXACT count the moment `done` is true — a
 * finite document always reaches exact, so the "+" is only ever the in-progress
 * display.
 *
 * `pages` is the CUMULATIVE set so far, already in page order (rowid ASC == page
 * order by construction, plus a stable sort at the seam), so a consumer replaces
 * rather than concatenates. `usedFuzzy` is the FIRST batch's reading, carried on
 * every batch — the fuzzy fallback is a one-shot, complete, no-cursor result, so
 * a fuzzy stream is a single `done` batch.
 */
export interface NoteSearchBatch {
  query: string;
  pages: PageMatch[];
  usedFuzzy: boolean;
  /** True once the keyset is exhausted (the server sent no cursor) — the count is
   *  now the exact "N in M", not a floor. */
  done: boolean;
}

/** The `.txt` twin of {@link NoteSearchBatch}: cumulative paragraphs so far, in
 *  ordinal (= byte) order, with the same floor-then-exact `done` contract. */
export interface TxtSearchBatch {
  query: string;
  segments: TxtMatch[];
  usedFuzzy: boolean;
  done: boolean;
}

/**
 * How much of the library is searchable AT ALL — the numbers behind "only notes
 * recognised on the device are searchable".
 *
 * Present ONLY on a zero-hit response, because that is the only state that
 * renders it: `12 of your 40 notes have no recognised text` is the difference
 * between "it is not there" and "it might be there and I cannot see it", and
 * paying for the aggregate on every keystroke of a search that IS finding things
 * would be waste.
 */
export interface Coverage {
  /** Undeleted files the indexer really parsed a `.note` container out of. */
  notes: number;
  /** How many of those carry no recognized text, and so cannot be found. */
  unsearchable: number;
  /**
   * Documents of yours whose indexing has not finished yet.
   *
   * A DIFFERENT NUMBER FROM {@link Coverage.unsearchable}, and they must never
   * be added together or shown as one sentence. `unsearchable` is permanent —
   * a note the device never recognised carries no text and never will — while
   * this is transient and resolves without anyone doing anything. Telling
   * somebody their half-minute-old upload is permanently unsearchable is both
   * wrong and unactionable.
   *
   * The two sets do not overlap: a `.note` is indexed on upload and so is never
   * pending, and a document still being derived is not counted in `notes`.
   *
   * Absent reads as 0 at the seam, which is the ONE default here that is not a
   * claim: the only thing this drives is a sentence shown when it is above
   * zero, so "the server did not say" and "nothing is pending" produce
   * identical UI. `notes`/`unsearchable` cannot be defaulted that way, because
   * zeroes there would render as a confident "0 of your 0 notes".
   */
  pending: number;
}

/** A full-text search response: the query as searched, plus its ranked hits. */
export interface SearchResults {
  /**
   * The query the server actually ran, echoed back. Not currently used for
   * staleness (the client tracks its own token — see `pages/noteSearch.ts`), but
   * it is what makes a logged response self-describing.
   */
  query: string;
  /** Best match first (bm25). Empty for a blank query — that is a 200, not an error. */
  hits: SearchHit[];
  /**
   * Whether the typo-tolerant fallback actually ran — i.e. whether these hits
   * answer the query as typed or only approximately.
   *
   * NOT optional in the domain, and not optional on the wire either: the server
   * serializes with `emit_null_optional_fields = false`, so an optional `false`
   * would be OMITTED and the client could not tell "the search was exact" from
   * "the server is too old to say" — opposite instructions about whether to say
   * so above the results. The seam therefore defaults a missing value to `false`,
   * which is the reading that claims nothing.
   */
  usedFuzzy: boolean;
  /** See {@link Coverage}. `null` whenever the server did not send it. */
  coverage: Coverage | null;
  /**
   * OPAQUE continuation for the next page of hits, present ONLY when more
   * results MAY exist beyond the ones returned. Pass it back verbatim
   * (`?cursor=`) to fetch the next ≤20 hits — which may carry another cursor,
   * or none when the results are exhausted.
   *
   * `undefined` means "this is everything": the server clamps a page at 20 and
   * a keyset cursor is how the rest is reached, so absence of the cursor is the
   * one honest end-of-results signal there is. NO TOTAL IS EVER SERVED — the
   * early-terminating query stops at the page boundary precisely so it never
   * counts the rest, and the UI must never fabricate a count it was not given
   * The string is not to be parsed,
   * compared or stored beyond handing it straight back: its shape belongs to
   * the server and changes with the index's layout.
   */
  cursor?: string;
}

/**
 * One matching page of ONE note, for find-in-note's counter and its filmstrip
 * badges.
 */
export interface PageMatch {
  /** 0-based page within the note. */
  pageIndex: number;
  /**
   * How many words on that page match. Never 0 — the row exists because the
   * index matched it, so a 0 would be a counting bug reported as an absence.
   */
  matches: number;
  /**
   * WHICH terms this page matched, folded as the index holds them (lowercase,
   * diacritics stripped).
   *
   * The ovals are drawn from these rather than re-derived from the query. The
   * client cannot reconstruct what matched without re-implementing the prefix
   * `*` expansion, the tokenizer's exact folding, and — since the typo fallback
   * runs on this route — which near-miss a token expanded into. It used to try,
   * with a folded substring test, and the two agreed only by luck.
   *
   * THE COUNTER IS NEVER DERIVED FROM THESE. `matches` is the index's answer;
   * the terms are how it is pointed at. Where the word rectangles tokenise
   * differently from the transcript the two can still disagree, and the count
   * wins.
   */
  terms: string[];
}

/**
 * The note-scoped search response: EVERY matching page of one note, in page
 * order, with per-page counts. Unranked and unlimited by construction.
 *
 * This is deliberately not `SearchResults` filtered to a note. That query is
 * ranked across the whole library and clamped, so as a per-note counter it is
 * SILENTLY INCOMPLETE — another note's higher-ranked hits push this one out of
 * the window and the reader shows a total that is simply wrong. A wrong count
 * that looks right is worse than a slow one.
 *
 * ONE REQUEST ANSWERS THE WHOLE NOTEBOOK. That is the point: a 200-page note
 * costs this call plus one `getPageText` per page actually looked at, not 200 of
 * anything. Word rectangles (the ovals) are not here for the same reason.
 */
export interface NoteSearchResults {
  /** Echoed, so a late response is discardable — find searches per keystroke. */
  query: string;
  pages: PageMatch[];
  /**
   * Whether the typo-tolerant fallback ran, exactly as {@link SearchResults}
   * reports it — and read the same strict way at the seam, for the same reason.
   *
   * Find used to be the one search on this app that did NOT tolerate typos,
   * silently: the identical query answered two different ways with nothing on
   * screen to say why. It does now, and says so once.
   */
  usedFuzzy: boolean;
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
