// The thumbnail facade. ONE content-addressed
// entry point every library surface calls to get a small preview for any file —
// a `.note` page, an `.spd` drawing, an image, a `.txt` — without the caller
// learning whether the pixels came from a client render, an extracted embedded
// thumbnail, or a static glyph.
//
//   getThumbnail(source, fileType) -> Promise<Blob>   // always a displayable WebP
//
// It ALWAYS resolves to a displayable WebP blob. The worst case is a generic
// glyph, never `null`, so callers do `img.src = URL.createObjectURL(blob)`
// unconditionally — there is no empty-state branch to get wrong. `fileType` is a
// DISPLAY HINT that selects the strategy and the placeholder; it is not
// authoritative, because the real thumbnail's correctness comes from what the
// fetch actually returns (a `.spd` claiming to be one that ships no embedded
// thumbnail simply 404s and falls back to the glyph).
//
// WHAT IT HIDES: the cache tiers, the network, and the render step. WHAT IT DOES
// NOT OWN: *scheduling* (a `LazyEngine` decides WHEN to paint on scroll-into-view
// and merely CALLS this to answer WHAT) and *the reader* (the full-size viewer
// keeps its own canvas path). This is the thumbnail case only.
//
// Built like `noteSearch`/`rail`: a factory over injected seams — the network
// (`net`), the pixel work (`painter`), the note render pipeline (`renderNote`) —
// so the orchestration (dispatch, cache keys, 404-fallback) is exercisable on
// plain Node with all three faked, while the real canvas/`fetch` code lives in
// the seam implementations at the bottom of this file.

import type { Hash, Id, PageRef, Theme } from "../core/types";
import { PREVIEWABLE_IMAGE_TYPES, rawFileUrl } from "../core/fileKind";
import { densityBucket, thumbTargetWidth } from "./types";
import { setDims as memoSetDims, type ImageDims } from "../cache/dimsMemo";
// The persistent negative-thumbnail memo: a content hash's 404 is a permanent
// fact (new cover => new hash), so it is remembered ACROSS sessions — the
// recurring hard-reload 404s this retires were the session-scoped version.
import { hasNoCover, setNoCover, noteTransientMiss, type CoverMemo } from "../cache/coverMemo";
import type { PersistentThumbStore } from "../cache/idb";

/**
 * Everything a strategy might need to LOCATE a file's bytes. `fileHash` is the
 * content-address spine — the cache key for real thumbnails and the `?v=` of the
 * raw-file/thumbnail endpoints — and is `null` for a folder, which has no blob.
 * The note-page strategy additionally needs the note id and its page 0 ref,
 * because page bytes are fetched by `(noteId, page)`, not by a bare hash.
 */
export interface ThumbSource {
  /** Content hash. Null = no blob (a folder) → the generic glyph, no network. */
  fileHash: Hash | null;
  /** The file's id, for the raw-file endpoint (image + text strategies). */
  fileId?: Id;
  /** The note whose page 0 the `note-page` strategy renders. */
  noteId?: Id;
  page?: PageRef;
  /**
   * The file is TRASHED, so the strategies that fetch the RAW FILE (`image-doc`,
   * `text`) must mint the bin-scoped route: the live `/file/{id}` goes through
   * `Files.get`, which hardcodes `deleted = 0`, and 404s for anything in the
   * recycle bin (see `rawFileUrl` in core/fileKind.ts). `/thumbnail/{hash}` is
   * content-addressed and serves trashed blobs too, so the cover/`.spd` probes
   * need no flag — and cache entries stay keyed by hash alone, because the
   * bytes are the same bytes whichever route carried them.
   */
  bin?: boolean;
  /**
   * The file's TRUE canvas aspect (server `thumbAspect`, from the `.spd` surface
   * dims), when the tile's strategy is the `image` one and the embedded preview
   * needs de-letterboxing. A `.spd` ships a FIXED 600×800 PORTRAIT thumbnail that
   * letterboxes the real (often landscape) drawing in white bands; passing the
   * corrected aspect lets the transcode CROP those bands at cache time, so the
   * cached WebP is already borderless and every consumer displays it with plain
   * `contain`. Absent (folder, `.txt`, an exact-3:4 sketch, an unknown aspect) →
   * no crop, the preview is transcoded whole exactly as before.
   */
  aspect?: { w: number; h: number };
}

/**
 * The closed strategy set. Deliberately NOT the file type — a new type is a new
 * ENTRY in {@link strategyFor}, never a new arm reached from outside — so the
 * branch set the facade dispatches on stays small and closed.
 *
 * `image` and `image-doc` differ in WHERE the bytes are and WHAT we learn:
 * `image` is a server-extracted preview (`.spd`'s embedded thumbnail, served
 * at `/thumbnail/{hash}`), while `image-doc` is a plain raster document
 * (png/jpeg/webp/gif) whose ONLY pixels are the raw file itself — fetched
 * once, downscaled locally to the tier, and whose true source dims feed the
 * masonry aspect memo.
 *
 * `pdf-page` is `note-page` MINUS the cover probe: a PDF has no embedded
 * thumbnail worth looking for and neither does its `.mark` sibling (both real
 * captures put `COVER_0` at address 0 —),
 * so there is nothing to try before the render.
 */
export type ThumbStrategy = "glyph" | "image" | "image-doc" | "note-page" | "pdf-page" | "text";

export interface Thumbnails {
  /**
   * Resolve a displayable WebP for a file. Always fulfils — the generic glyph is
   * the floor. `fileType` selects the strategy; `source` says where the bytes
   * live. Theme is read from the injected `getTheme`, never passed here, exactly
   * as `LazyEngine`/`RenderCache` take it.
   */
  getThumbnail(source: ThumbSource, fileType: string): Promise<Blob>;
  /**
   * The type's generic glyph, on its own — the facade's floor, made reachable.
   *
   * `getThumbnail` already falls back to this whenever a strategy has nothing to
   * show. Exposing it lets a caller paint the floor FIRST and upgrade when the
   * real thumbnail lands, which matters for a strategy that cannot answer
   * quickly: a `.pdf` tile has to fetch 1.5 MB of MuPDF, compile it, open the
   * document and render page 0 before it has a single pixel, and on 3G that is
   * upwards of ten seconds during which the tile is BLANK.
   *
   * Drawn client-side in microseconds and memoised per `kind:theme:bucket`, so
   * asking for it costs nothing after the first tile of a given type.
   */
  getGlyph(fileType: string): Promise<Blob>;
  /** Drop cached blobs for a theme (the caller repaints the other theme fresh). */
  evictTheme(theme: Theme): void;
}

/** The pixel work, injected so the facade orchestration is testable without a
 *  canvas. The real implementation is {@link createCanvasThumbPainter}. */
export interface ThumbPainter {
  /** Draw the generic glyph for a preview-less type and encode it to WebP. */
  glyph(kind: string, theme: Theme): Promise<Blob>;
  /** Transcode already-fetched image bytes (any format the browser decodes) to
   *  a thumbnail-sized WebP. `cropAspect` (when given and non-degenerate) crops
   *  the decoded image to a CENTERED cover-rect of that aspect BEFORE downscaling
   *  — de-letterboxing a `.spd`'s fixed-portrait embedded preview to its true
   *  canvas shape. The output is still sized to the density-bucket tier target
   *  (never upscaled past the cropped band), exactly like the uncropped path. */
  fromImageBytes(bytes: Blob, theme: Theme, cropAspect?: { w: number; h: number }): Promise<Blob>;
  /** Encode a rendered note-page bitmap to WebP. */
  fromBitmap(bitmap: ImageBitmap): Promise<Blob>;
  /** Rasterise the first few lines of a text file into a small WebP snippet. */
  textSnippet(content: string, theme: Theme): Promise<Blob>;
  /**
   * Decode a plain image DOCUMENT's raw bytes into a tier-sized WebP tile, and
   * report the SOURCE's true pixel dims alongside — the one moment the client
   * ever holds them, which is what feeds the masonry aspect memo. Same
   * downscale rules as every producer (never upscale, high-quality reduction).
   */
  imageTile(bytes: Blob): Promise<ImageTileResult>;
}

/** `ThumbPainter.imageTile`'s answer: the encoded tile plus the source truth. */
export interface ImageTileResult {
  blob: Blob;
  /** The DECODED SOURCE's dims — not the tier raster's. */
  sourceW: number;
  sourceH: number;
}

/**
 * {@link ThumbnailsDeps.renderPdfPage}'s answer: page 0's pixels, plus the page's
 * own box so the tile can state its true shape.
 *
 * The bitmap is the CALLER'S to close — unlike `renderNote`'s, which belongs to
 * the render cache. Nothing else holds a reference, so the `pdf-page` arm frees
 * it the moment the encode has copied it.
 */
export interface PdfPageThumb {
  bitmap: ImageBitmap;
  /**
   * Page 0's CROPPED, ROTATED box, in PDF points (`fz_bound_page` — so a
   * `/Rotate 90` page reports its visual, swapped dimensions). Only the RATIO
   * is consumed, by the masonry aspect memo; the numbers are the page's own.
   */
  pageW: number;
  pageH: number;
}

/** The network, injected so tests drive 404s without a server. A miss (404 or a
 *  transport failure) is `null`, NOT a throw: the facade turns it into a glyph. */
export interface ThumbNet {
  /** GET raw bytes for a URL; null on 404 / any non-OK / transport failure. */
  bytes(url: string): Promise<Blob | null>;
  /** Like `bytes`, but a DEFINITIVE 404 is distinguished from everything else:
   *  the content-addressed thumbnail endpoint's 404 is a permanent fact worth
   *  persisting (cache/coverMemo.ts), while a transport failure or 5xx answers
   *  nothing and must only be suppressed for the session. */
  probe(url: string): Promise<Blob | "not-found" | null>;
  /** GET a text file's head (UTF-8 decoded); null on any failure. */
  text(url: string): Promise<string | null>;
}

export interface ThumbnailsDeps {
  /** The negative-thumbnail memo. Injectable for tests; production defaults
   *  to the shared persistent instance (cache/coverMemo.ts). */
  coverMemo?: CoverMemo;
  getTheme(): Theme;
  net: ThumbNet;
  painter: ThumbPainter;
  /**
   * Render one note page to a bitmap through the existing pipeline. Wired in
   * production to `render/lazy.ts`'s `renderPage` (cache.get → getPageBytes →
   * renderer.render → cache.put) at the "thumb" tier — the exact pipeline that
   * used to be inlined in the lazy engine, now lifted behind this seam.
   */
  renderNote(noteId: Id, page: PageRef, theme: Theme): Promise<ImageBitmap>;
  /**
   * Render a PDF's page 0 to a bitmap at the tier target. Wired in production to
   * `render/pdfThumb.ts`, which drives the EXISTING `createPdfSession` one
   * document at a time (open → size → render → close) — see that module for why
   * the queue is serial and why the session is released when it drains.
   *
   * OPTIONAL, and its absence is a real state rather than a wiring slip: a
   * browser without wasm exceptions cannot run the decoder at all, and a build
   * that never wires it (a unit test, a surface with no PDF support) must still
   * resolve a tile. Absent → the `pdf-page` arm falls to the glyph, exactly as a
   * failed render does. No theme argument: MuPDF draws ink on white paper, and
   * these pixels are the same in both themes (see the arm's theme-free key).
   */
  renderPdfPage?(fileId: Id, hash: Hash, opts?: { bin?: boolean }): Promise<PdfPageThumb>;
  /**
   * Record an image document's true dims on first decode (the masonry aspect
   * memo — cache/dimsMemo.ts). Injectable for tests; defaults to the module's
   * persistent memo. Fire-and-forget at the call site: dims are advisory.
   */
  setDims?(hash: string, dims: ImageDims): Promise<void>;
  /**
   * The PERSISTENT thumbnail tier — the SAME `sn-thumbs` store the render cache
   * uses (wired in main.ts, shared so it is opened once). Gives the facade path
   * the render path's structure: `[hot in-memory memo] → sn-thumbs → produce`, so
   * every facade thumbnail (`.spd` crop, `.txt` snippet, cover, image tile)
   * survives reloads in the one store, under the one byte budget, exactly like a
   * note-page render. Fail-open and fire-and-forget at the `memo` choke point:
   * persistence must NEVER sink a produced blob. Null/absent → memory-only
   * (tests, no IDB), byte-for-byte the pre-existing behaviour.
   */
  persistent?: PersistentThumbStore | null;
}

/**
 * The type → strategy map — the ONE place a file type becomes a plan. A `.spd`
 * goes to `image` (its server-extracted embedded thumbnail); a raster image
 * (png/jpeg/webp/gif — `PREVIEWABLE_IMAGE_TYPES`, the existing kind detection)
 * goes to `image-doc` (local-only: raw bytes fetched once, downscaled here,
 * true dims memoised); a `.txt` gets `text` so it stays a rich snippet rather
 * than collapsing to a static "TXT" glyph; a `.note` prefers its
 * server-extracted cover and falls back to rendering its page 0 (the try-then-
 * fallback lives inside the strategy); a `.pdf` gets `pdf-page`, its page 0
 * rendered through the same MuPDF wasm the viewer uses; everything else —
 * folder, doc, epub, unknown — is preview-less and gets `glyph`.
 *
 * WHATEVER THIS RETURNS, `FACADE_THUMB_TYPES` (pages/galleryCards.ts) MUST
 * AGREE: a real strategy here with the type missing there is a glyph tile with
 * nothing to say why, and nothing type-checks the pair. `thumbnails.test.ts`
 * asserts the two agree for every type in the app's vocabulary.
 */
export function strategyFor(fileType: string): ThumbStrategy {
  const t = (fileType || "").trim().toLowerCase();
  if (t === "note") return "note-page";
  if (t === "spd") return "image";
  if (PREVIEWABLE_IMAGE_TYPES.includes(t)) return "image-doc";
  if (t === "txt") return "text";
  if (t === "pdf") return "pdf-page";
  return "glyph";
}

/**
 * The glyph cache key's type component — the letter the glyph is drawn with.
 * Distinct preview-less types deserve a distinct glyph (a `.pdf` is not a
 * folder), so it caches once per `kind:theme`, shared by every file of that kind.
 * Driven by the type, NOT the hash: a hashless `.spd` still reads as `SPD`, not a
 * folder. An empty/`folder` type is the generic folder; a long or `file` type
 * that names nothing useful degrades to `FILE`.
 */
function glyphKind(fileType: string): string {
  const t = (fileType || "").trim().toLowerCase();
  if (!t || t === "folder") return "folder";
  if (t === "file") return "FILE";
  return t.length > 4 ? "FILE" : t.toUpperCase();
}

/**
 * Cache-key generation token. Folded into EVERY facade cache key (below), so a
 * bump supersedes rather than serves stale entries whenever the PIXELS a key
 * maps to change meaning — as they did when `.spd` previews began being cropped
 * to their true canvas aspect (the old entries were the letterboxed ones). The
 * facade cache is per-session (in-memory), so within a code deploy this is
 * self-healing on the first load; the token guards any longer-lived layer that
 * ever keys off these strings and documents WHY the key shape carries a version.
 */
const THUMB_CACHE_VERSION = 2;

export function createThumbnails(deps: ThumbnailsDeps): Thumbnails {
  const { getTheme, net, painter, renderNote } = deps;
  const renderPdfPage = deps.renderPdfPage;
  const coverMemo: CoverMemo = deps.coverMemo ?? { hasNoCover, setNoCover, noteTransientMiss };
  const recordDims = deps.setDims ?? memoSetDims;
  const persistent: PersistentThumbStore | null = deps.persistent ?? null;

  // A single blob cache across all strategies. The pristine-tier key is
  // `(hash, theme, bucket)` — `<hash>:<theme>:b<bucket>` (formerly
  // `<hash>:<theme>`): a tile's PIXELS depend on the density bucket its tier
  // target was computed for, so two buckets are two entries and a DPR change
  // re-produces rather than serving a wrong-density raster. The bucket is read
  // per render call. Theme-free tiles key `<hash>:img:b<bucket>` (an image
  // document) and `<hash>:pdf:b<bucket>` (a PDF's page 0); generic glyphs
  // `glyph:<kind>:<theme>:b<bucket>`.
  // `Promise<Blob>` rather than `Blob` so concurrent requests for the same tile
  // (a scroll that reveals a card twice, a theme bump mid-flight) share one
  // fetch/render/encode instead of racing.
  const cache = new Map<string, Promise<Blob>>();


  /** Serve from cache or run `produce` once and memoise it. A produce that
   *  REJECTS is not cached — the slot re-lazies on the next intersection rather
   *  than pinning a failure forever (the render cache is never a source of
   *  truth, and neither is this).
   *
   *  The tiers are `[hot in-memory memo] → sn-thumbs (persistent) → produce`,
   *  structurally identical to the render path. On an in-memory miss the injected
   *  `persistent` store is consulted (read-through); on a persistent miss `produce`
   *  runs and its blob is written back fire-and-forget (write-through). Both the
   *  read and the write are FAIL-OPEN: any store error is swallowed so persistence
   *  can never sink a produced thumbnail. `persist:false` opts a key out — glyphs
   *  regenerate instantly and are not worth a byte of the shared budget, and only
   *  SUCCESSFUL produces reach the write (a thrown `NoThumbnail` rejects before it,
   *  so a fallback is never persisted as if it were a real thumbnail). */
  function memo(
    key: string,
    produce: () => Promise<Blob>,
    opts: { persist?: boolean } = {},
  ): Promise<Blob> {
    // Version-prefix every key at the single choke point, so a THUMB_CACHE_VERSION
    // bump retires the old generation's entries wholesale. The `:<theme>:b` infix
    // evictTheme matches is unaffected (the prefix only leads the key).
    const vkey = `v${THUMB_CACHE_VERSION}:${key}`;
    const hit = cache.get(vkey);
    if (hit) return hit;
    // The persistent tier is the render cache's `sn-thumbs`, SHARED. The facade
    // key is NAMESPACED with a `facade:` discriminator over the already-versioned
    // in-memory key: a render-cache id is `hash:thumb:theme[:bN]` — it begins with
    // a hex hash and can NEVER begin with `facade:` — so a `.spd` crop is never
    // served where a note page-0 render is expected, or vice-versa, in the one
    // store. The `v{VERSION}` token rides along, so a crop/encode change
    // invalidates stale PERSISTED blobs across sessions, not just in-session.
    const usePersist = opts.persist !== false && persistent != null;
    const pkey = `facade:${vkey}`;
    const p = (async (): Promise<Blob> => {
      if (usePersist) {
        try {
          const stored = await persistent!.get(pkey);
          if (stored) return stored; // persistent hit → populates the in-memory memo
        } catch {
          // Fail-open: a broken store must never block producing the thumbnail.
        }
      }
      const blob = await produce();
      // Write-through, fire-and-forget: swallow every store error so persistence
      // can never sink the produced blob (exactly the discipline in idb.ts).
      if (usePersist) void persistent!.put(pkey, blob).catch(() => {});
      return blob;
    })().catch((e) => {
      cache.delete(vkey);
      throw e;
    });
    cache.set(vkey, p);
    return p;
  }

  /** The generic glyph — drawn client-side, cached by kind:theme:bucket, NEVER
   *  fetched. This is the facade's floor: every strategy falls back here. */
  function glyph(fileType: string, theme: Theme, bucket: number): Promise<Blob> {
    const kind = glyphKind(fileType);
    // `persist:false`: a glyph is drawn client-side in microseconds and is the
    // fallback floor, so it never earns a byte of the shared persistent budget —
    // and this is what keeps a glyph from being written as if it were a thumbnail.
    return memo(`glyph:${kind}:${theme}:b${bucket}`, () => painter.glyph(kind, theme), { persist: false });
  }

  async function getThumbnail(source: ThumbSource, fileType: string): Promise<Blob> {
    const theme = getTheme();
    // The density bucket, read fresh PER CALL (a monitor hop / zoom change must
    // land in its new bucket's key, not reuse a stale one) — see render/types.ts.
    const bucket = densityBucket();
    // The strategy is the type's, NOT gated on the hash: a `.note` has a
    // whole-file hash yet renders its page, so glyph-fallback is decided per
    // strategy (a folder has no type that maps anywhere but `glyph`; an `image`
    // or `text` with no blob to fetch falls back below).
    const strategy = strategyFor(fileType);

    switch (strategy) {
      case "glyph":
        return glyph(fileType, theme, bucket);

      case "note-page": {
        // Cover first, render second. A curated `.note` carries a
        // device-rendered COVER the server extracts at ingest and serves at
        // `/thumbnail/{hash}` — the page the USER chose, at full device
        // resolution — so try that before spending a client render. Most notes
        // have none (covers are user-set, never auto-generated): the 404 falls
        // through to today's WASM page render, and is remembered per session
        // (`noCover`) so a coverless library pays it once per md5, not per
        // repaint. Cover blobs key by the WHOLE-FILE hash — the cover's real
        // content address, which also turns over when the note is edited.
        if (source.fileHash !== null && !(await coverMemo.hasNoCover(source.fileHash))) {
          const hash = source.fileHash;
          const cover = await memo(`${hash}:${theme}:b${bucket}`, async () => {
            const got = await net.probe(`/thumbnail/${encodeURIComponent(hash)}`);
            if (got === "not-found") {
              // Definitive: this content has no cover, and content-addressing
              // means it never will UNDER THIS HASH — persist, so the question
              // is asked once per md5 EVER, not once per session.
              void coverMemo.setNoCover(hash);
              throw new NoThumbnail(); // → caught below, falls back to the render
            }
            if (!got) {
              // Transport/server failure: answers nothing about the content.
              // Suppress for this session only; a fresh session probes again.
              coverMemo.noteTransientMiss(hash);
              throw new NoThumbnail();
            }
            return painter.fromImageBytes(got, theme);
          }).catch(() => null);
          if (cover) return cover;
        }

        // The note-specific pipeline, lifted out of lazy.ts. `renderNote` runs
        // cache.get → getPageBytes → render → cache.put; we encode its bitmap to
        // WebP. Keyed by the PAGE hash (what actually determines the pixels), not
        // the whole-file hash, matching the render cache's own key.
        if (!source.noteId || !source.page) return glyph(fileType, theme, bucket);
        const page = source.page;
        const noteId = source.noteId;
        return memo(`${page.hash}:${theme}:b${bucket}`, async () =>
          painter.fromBitmap(await renderNote(noteId, page, theme)),
        );
      }

      case "pdf-page": {
        // `note-page` MINUS THE COVER PROBE. A `.note` is worth asking
        // `/thumbnail/{hash}` first because the user may have set one; a `.pdf`
        // never has one to find — not in the file (the spec's `/Thumb` key is
        // vanishingly rare in practice) and not in its `.mark` sibling, whose
        // `COVER_0` is address 0 in both real captures. So there is nothing to
        // try before the render, and this arm is straight to it.
        //
        // The pixels come from the SAME MuPDF wasm the viewer uses, through the
        // injected seam — which opens ONE document at a time and closes it after
        // (render/pdfThumb.ts). None of that runs on a revisit: a persistent
        // `sn-thumbs` hit returns the stored WebP inside `memo` before `produce`
        // is called, so the 5.3 MB module is fetched once per device, on the
        // first PDF tile that is both visible and uncached, and never again.
        if (source.fileHash === null || !source.fileId || !renderPdfPage) {
          return glyph(fileType, theme, bucket);
        }
        const hash = source.fileHash;
        const fileId = source.fileId;
        const bin = source.bin;
        // Keyed THEME-FREE (`hash:pdf:bucket`), like an image document and for
        // the same reason: MuPDF draws ink on white paper, so the raster is
        // identical in both themes and a theme toggle must not re-open the
        // document and re-render it — by far the most expensive produce in the
        // facade. That also (deliberately) exempts these entries from
        // evictTheme. Keyed by the FILE md5: unlike a `.note` there is no
        // server-supplied page hash, and the file hash is what determines the
        // pixels. It cannot collide with the page strip's own page-0 raster,
        // which lives under the render tier's `<md5>:p0:thumb:…` shape.
        return memo(`${hash}:pdf:b${bucket}`, async () => {
          const frame = await renderPdfPage(fileId, hash, { bin });
          try {
            // The masonry aspect, from page 0's own cropped/rotated box — the
            // one moment the client holds it, exactly as `image-doc` records an
            // image's true dims on first decode. Fire-and-forget: a layout hint
            // must never sink a produced tile.
            if (frame.pageW > 0 && frame.pageH > 0) {
              void recordDims(hash, { w: frame.pageW, h: frame.pageH }).catch(() => {});
            }
            return await painter.fromBitmap(frame.bitmap);
          } finally {
            // OURS to free, unlike `renderNote`'s (which the render cache owns):
            // the worker transferred it to us and nothing else holds it.
            frame.bitmap.close();
          }
        }).catch(() => glyph(fileType, theme, bucket));
      }

      case "image": {
        // `.spd` ships an embedded thumbnail the server extracts at ingest and
        // serves at `/thumbnail/{hash}`. Fetch, transcode, cache. A 404 (an
        // `.spd` with no embedded thumbnail, a hashless file) means there is
        // nothing to show, so it falls back to the glyph — which is why the
        // return is never null.
        if (source.fileHash === null) return glyph(fileType, theme, bucket);
        const hash = source.fileHash;
        if (await coverMemo.hasNoCover(hash)) return glyph(fileType, theme, bucket);
        const url = `/thumbnail/${encodeURIComponent(hash)}`;
        return memo(`${hash}:${theme}:b${bucket}`, async () => {
          const got = await net.probe(url);
          if (got === "not-found") {
            void coverMemo.setNoCover(hash); // permanent under this hash — same argument as covers
            throw new NoThumbnail(); // → caught below, becomes a glyph
          }
          if (!got) {
            coverMemo.noteTransientMiss(hash);
            throw new NoThumbnail();
          }
          // The true canvas aspect (when the listing stated one) de-letterboxes
          // the fixed-portrait embedded preview at transcode: the cached WebP is
          // borderless, so display is plain `contain`. Absent → transcoded whole.
          return painter.fromImageBytes(got, theme, source.aspect);
        }).catch(() => glyph(fileType, theme, bucket));
      }

      case "image-doc": {
        // A plain raster document (png/jpeg/webp/gif) — LOCAL-ONLY thumbnail
        // The raw bytes (a multi-MB photo
        // for a ~245px tile, before this branch existed re-decoded per paint)
        // are fetched ONCE per hash per session, decoded at the pristine-tier
        // size, and the WebP tile is what every later paint serves. The decode
        // is also the one moment the client holds the image's TRUE dims, so
        // they are recorded into the persistent memo — that is what makes an
        // image tile lay out reflow-free on every later paint and session.
        //
        // Keyed THEME-FREE (`hash:img:bucket`): a photo's pixels are its own in
        // both themes, so a theme toggle must not refetch megabytes. That also
        // (deliberately) exempts these entries from evictTheme.
        if (source.fileHash === null) return glyph(fileType, theme, bucket);
        const hash = source.fileHash;
        const url = source.fileId ? rawFileUrl(source.fileId, hash, { bin: source.bin }) : null;
        if (!url) return glyph(fileType, theme, bucket);
        return memo(`${hash}:img:b${bucket}`, async () => {
          const bytes = await net.bytes(url);
          if (!bytes) throw new NoThumbnail(); // → caught below, becomes a glyph
          const tile = await painter.imageTile(bytes);
          // First successful decode → memoise the SOURCE's true dims (not the
          // tier raster's). Fire-and-forget: dims are advisory layout hints and
          // must never sink a successfully produced tile.
          void recordDims(hash, { w: tile.sourceW, h: tile.sourceH }).catch(() => {});
          return tile.blob;
        }).catch(() => glyph(fileType, theme, bucket));
      }

      case "text": {
        // Keep `.txt` rich: fetch the file's head, rasterise the first lines into
        // a small snippet rather than a static badge. Falls back to the glyph if
        // the file cannot be read.
        if (source.fileHash === null) return glyph(fileType, theme, bucket);
        const hash = source.fileHash;
        const url = source.fileId ? rawFileUrl(source.fileId, hash, { bin: source.bin }) : null;
        if (!url) return glyph(fileType, theme, bucket);
        return memo(`${hash}:${theme}:b${bucket}`, async () => {
          const content = await net.text(url);
          if (content === null) throw new NoThumbnail();
          return painter.textSnippet(content, theme);
        }).catch(() => glyph(fileType, theme, bucket));
      }
    }
  }

  return {
    getThumbnail,
    getGlyph(fileType: string): Promise<Blob> {
      // Theme and bucket read per call, exactly as `getThumbnail` reads them:
      // the glyph is themed, and a monitor hop must land in its own bucket.
      return glyph(fileType, getTheme(), densityBucket());
    },
    evictTheme(theme: Theme): void {
      // Themed keys carry `:<theme>:b<bucket>` (content and glyph alike); the
      // theme-free keys never match and survive — an image document's (`:img:`)
      // and a PDF page's (`:pdf:`) pixels are correct in both themes, and
      // re-fetching a photo or re-opening a document per toggle is exactly what
      // the theme-free key exists to avoid.
      const infix = `:${theme}:b`;
      for (const key of [...cache.keys()]) if (key.includes(infix)) cache.delete(key);
    },
  };
}

/** Sentinel a strategy throws to route to the glyph without logging a real
 *  failure. Never escapes the facade. */
class NoThumbnail extends Error {}

// --- the real seam implementations (browser: canvas + fetch) -----------------
//
// Below the facade, and separately importable, so a Node unit test never loads
// canvas/`fetch` code and the browser wiring never re-implements the dispatch.

// Thumbnail output width comes from the shared pristine-tier target
// `thumbTargetWidth()` (imported above; TILE_W × bucket × leeway) — the render
// cache's "thumb" tier — so this facade's downscale target matches the `.note`
// renderer's exactly, bucket for bucket.

/**
 * How to get a source down to the tier target. Pure, so the decision is
 * unit-testable without a canvas:
 *
 *   - `none`   — source is at or under the target: KEEP ITS OWN SIZE. Never
 *                upscale (the `.spd` 600-wide embedded thumb cannot honestly
 *                fill bucket 3; fake sharpness is worse than CSS scaling).
 *   - `direct` — a mild reduction (≤2×): plain `drawImage` bilinear is fine.
 *   - `high`   — a >2× reduction: bilinear skips source pixels and aliases the
 *                thin e-ink strokes; use `createImageBitmap`'s
 *                `resizeQuality:"high"` (fallback: stepped halving).
 */
export interface DownscalePlan {
  w: number;
  h: number;
  method: "none" | "direct" | "high";
}

export function downscalePlan(srcW: number, srcH: number, targetW: number): DownscalePlan {
  if (srcW <= targetW) return { w: srcW, h: srcH, method: "none" };
  const w = Math.max(1, Math.round(targetW));
  const h = Math.max(1, Math.round((srcH * w) / srcW));
  return { w, h, method: srcW / w > 2 ? "high" : "direct" };
}

/** The sub-rect of a `srcW×srcH` image to KEEP so it fills `aspect` (w:h) with no
 *  distortion — a CENTERED cover crop, PURE so the geometry is unit-testable
 *  without a canvas. This is what de-letterboxes a `.spd`'s fixed-portrait
 *  embedded preview: the returned band has `sw/sh === aspect.w/aspect.h`. */
export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Compute the centered cover-crop rect for a target aspect. GUARDS a
 * missing/degenerate aspect (≤0 or non-finite either dimension, or a
 * non-positive source) by returning the FULL frame — the caller then transcodes
 * the whole image exactly as before. An aspect that already matches the source
 * also yields the full frame (both crop branches collapse to it), so an
 * exact-3:4 sketch is a no-op.
 *
 *   target A = aspect.w / aspect.h; source A = srcW / srcH
 *   - A > srcA (target wider → crop TOP/BOTTOM): sw=srcW, sh=srcW/A, sy centered
 *   - else       (crop LEFT/RIGHT):              sh=srcH, sw=srcH*A, sx centered
 */
export function coverCropRect(srcW: number, srcH: number, aspect?: { w: number; h: number }): CropRect {
  const full: CropRect = { sx: 0, sy: 0, sw: srcW, sh: srcH };
  if (!aspect) return full;
  const { w: aw, h: ah } = aspect;
  if (!Number.isFinite(aw) || !Number.isFinite(ah) || aw <= 0 || ah <= 0) return full;
  if (!(srcW > 0) || !(srcH > 0)) return full;
  const targetA = aw / ah;
  const srcA = srcW / srcH;
  if (targetA > srcA) {
    const sh = srcW / targetA;
    return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh };
  }
  const sw = srcH * targetA;
  return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH };
}

/** True only for an aspect that would actually crop (finite, positive both ways).
 *  A degenerate/missing one must behave exactly as the no-crop path. */
function usableAspect(a?: { w: number; h: number }): a is { w: number; h: number } {
  return !!a && Number.isFinite(a.w) && Number.isFinite(a.h) && a.w > 0 && a.h > 0;
}

function makeCanvas(w: number, h: number): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    return { canvas, ctx };
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  return { canvas, ctx };
}

const WEBP_TYPE = "image/webp";
const WEBP_QUALITY = 0.9;

function encodeWebp(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) return canvas.convertToBlob({ type: WEBP_TYPE, quality: WEBP_QUALITY });
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), WEBP_TYPE, WEBP_QUALITY),
  );
}

interface Palette {
  paper: string;
  ink: string;
  margin: string;
  rule: string;
}

/** The design-system paper for a glyph/snippet tile, read from the LIVE CSS
 *  tokens so a placeholder is the SAME paper (and reserved-red margin) as every
 *  other surface, and tracks light/dark. The theme-matched fallbacks ARE the
 *  token values, for the DOM-less path. */
function palette(theme: Theme): Palette {
  const fallback: Palette =
    theme === "dark"
      ? { paper: "#17171a", ink: "#e9e6dd", margin: "#cd6a60", rule: "rgba(233,230,221,0.12)" }
      : { paper: "#fcfbf7", ink: "#1c1b17", margin: "#bf5248", rule: "rgba(28,27,23,0.11)" };
  if (typeof document === "undefined") return fallback;
  const s = getComputedStyle(document.documentElement);
  const tok = (name: string, fb: string): string => s.getPropertyValue(name).trim() || fb;
  return {
    paper: tok("--sheet", fallback.paper),
    ink: tok("--ink", fallback.ink),
    margin: tok("--margin", fallback.margin),
    rule: tok("--paper-rule", fallback.rule),
  };
}

/** Ensure the brand DATA face is loaded before a canvas draw names it: `ctx.font`
 *  silently falls back to a system mono if the face isn't ready, and a tile
 *  painted in the wrong font is exactly the drift this removes.
 *
 *  Memoised to ONE load, not one per tile: the first glyph/snippet awaits the
 *  face; every later render awaits an already-resolved promise (a microtask), so
 *  the guard never adds real latency to the render path. A no-op where the Font
 *  Loading API is absent; a load failure is not a render failure. */
let monoFontReady: Promise<void> | null = null;
function ensureMonoFont(): Promise<void> {
  if (monoFontReady) return monoFontReady;
  monoFontReady = (async () => {
    if (typeof document === "undefined" || !document.fonts) return;
    try {
      await Promise.all([
        document.fonts.load('400 16px "Space Mono"'),
        document.fonts.load('700 16px "Space Mono"'),
      ]);
    } catch {
      // fall back silently
    }
  })();
  return monoFontReady;
}

/** The reserved-red margin rule shared by every placeholder tile (see
 *  render/lazy.ts's ruled-sheet). Draws it in the left gutter at a low alpha so a
 *  glyph/snippet reads as a page in the same notebook. */
function drawMarginRule(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  w: number,
  h: number,
  color: string,
): number {
  const marginX = w * 0.12;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = Math.max(1, w / 150);
  ctx.beginPath();
  ctx.moveTo(marginX, h * 0.06);
  ctx.lineTo(marginX, h * 0.94);
  ctx.stroke();
  ctx.restore();
  return marginX;
}

/** A source the shared downscale can consume: a decoded bitmap or a canvas. */
export type DownscaleSource = ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

/**
 * Area-average (box filter) downscale of an RGBA buffer — PURE, no canvas, so
 * the line-survival property is unit-testable on plain Node. Every destination
 * pixel is the MEAN of the source region it covers, so a 1-px ruled line is
 * averaged IN (darkening its destination row) rather than sampled past and
 * DROPPED — the exact failure a single bilinear `drawImage` step has at high
 * reduction (a ~9× panel thumb skips most source rows, so ruled templates lose
 * lines or moiré against the rule spacing). This is the deterministic fallback
 * inside {@link downscaleToBox} for engines without `createImageBitmap`'s
 * high-quality resize, and the algorithm the regression test pins.
 */
export function boxDownscaleRgba(
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const sx = srcW / dstW;
  const sy = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const y0 = Math.floor(dy * sy);
    const y1 = Math.min(srcH, Math.max(y0 + 1, Math.floor((dy + 1) * sy)));
    for (let dx = 0; dx < dstW; dx++) {
      const x0 = Math.floor(dx * sx);
      const x1 = Math.min(srcW, Math.max(x0 + 1, Math.floor((dx + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * srcW + x) * 4;
          r += src[i]!;
          g += src[i + 1]!;
          b += src[i + 2]!;
          a += src[i + 3]!;
          n++;
        }
      }
      const o = (dy * dstW + dx) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return out;
}

/** Read a source's native pixels via a scratch canvas (the box-filter fallback
 *  needs the RGBA in hand). Browser-only — the fallback is never reached under
 *  a `createImageBitmap` that honours resize options (every shipping engine). */
function readPixels(source: DownscaleSource, w: number, h: number): Uint8ClampedArray {
  const { ctx } = makeCanvas(w, h);
  ctx.drawImage(source, 0, 0);
  return ctx.getImageData(0, 0, w, h).data;
}

/**
 * THE ONE shared quality downscale. Reduce `source` into an exact `dstW×dstH`
 * canvas the way every small preview must — the thumbnail facade's image/note
 * paths AND both layer PANELS (`.spd`/`.note`) route through this, so no surface
 * re-invents the naive single-step `drawImage` that skips source rows.
 *
 *   - ≤2× (or an enlargement we never ask for): one bilinear draw is faithful.
 *   - >2×: an AREA-averaging reduction — `createImageBitmap`'s `resizeQuality:
 *     "high"` first (GPU, area-weighted, in every shipping engine), then the
 *     pure {@link boxDownscaleRgba} as a deterministic fallback.
 */
export async function downscaleToBox(
  source: DownscaleSource,
  dstW: number,
  dstH: number,
): Promise<OffscreenCanvas | HTMLCanvasElement> {
  const w = Math.max(1, Math.round(dstW));
  const h = Math.max(1, Math.round(dstH));
  const srcW = source.width;
  const srcH = source.height;

  if (srcW / w <= 2 && srcH / h <= 2) {
    const { canvas, ctx } = makeCanvas(w, h);
    ctx.drawImage(source, 0, 0, w, h);
    return canvas;
  }

  try {
    const resized = await createImageBitmap(source, {
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: "high",
    });
    const { canvas, ctx } = makeCanvas(w, h);
    ctx.drawImage(resized, 0, 0);
    resized.close();
    return canvas;
  } catch {
    // Fall through to the pure box filter (no high-quality resize available).
  }
  const dst = boxDownscaleRgba(readPixels(source, srcW, srcH), srcW, srcH, w, h);
  const { canvas, ctx } = makeCanvas(w, h);
  const image = ctx.createImageData(w, h);
  image.data.set(dst);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Paint `source` downscaled to a `dw×dh` box at `(dx,dy)` on `ctx`, through the
 * shared {@link downscaleToBox}. The layer PANELS call this to fill a per-layer
 * preview from a full-res layer canvas — replacing the single-step bilinear draw
 * that dropped thin ruled lines. Async (the resample may go through
 * `createImageBitmap`), so the caller has ALREADY painted the box's background:
 * a pending draw shows the plain sheet, never a blank gap, and the panel's box
 * size (its class token) is stable meanwhile. Swallows failure — a soft preview
 * beats a thrown panel.
 */
export async function drawDownscaledInto(
  ctx: CanvasRenderingContext2D,
  source: DownscaleSource,
  dw: number,
  dh: number,
  dx: number,
  dy: number,
): Promise<void> {
  try {
    const scaled = await downscaleToBox(source, dw, dh);
    ctx.drawImage(scaled, dx, dy);
  } catch {
    // Leave the background the caller painted; the preview stays soft, not blank.
  }
}

/** Decode image bytes, downscale to the live tier target, encode WebP; the
 *  shared body of `fromImageBytes` and `imageTile`. */
async function tileFromBytes(bytes: Blob): Promise<ImageTileResult> {
  const bitmap = await createImageBitmap(bytes);
  const sourceW = bitmap.width;
  const sourceH = bitmap.height;
  const plan = downscalePlan(sourceW, sourceH, thumbTargetWidth());
  const canvas = await downscaleToBox(bitmap, plan.w, plan.h);
  bitmap.close();
  return { blob: await encodeWebp(canvas), sourceW, sourceH };
}

/**
 * Decode image bytes, CROP to a centered cover-rect of `aspect` (de-letterboxing
 * a `.spd`'s fixed-portrait embedded preview), then downscale the cropped BAND to
 * the tier target and encode WebP. The crop changes only the SOURCE RECT; the
 * output is sized by the SAME density-bucket path every thumbnail uses
 * (`downscalePlan` → `downscaleToBox`), so `.spd` never becomes the one thumbnail
 * that ignores DPR — and never UPSCALES past the band's own pixels (the embedded
 * thumb is only ~600px wide; a hi-DPR bucket target above that clamps to source).
 */
async function croppedTileFromBytes(bytes: Blob, aspect: { w: number; h: number }): Promise<Blob> {
  const bitmap = await createImageBitmap(bytes);
  const rect = coverCropRect(bitmap.width, bitmap.height, aspect);
  // Extract the content band at its native resolution first — `downscaleToBox`
  // consumes a whole source, so the sub-rect becomes a source of its own.
  const bandW = Math.max(1, Math.round(rect.sw));
  const bandH = Math.max(1, Math.round(rect.sh));
  const { canvas: band, ctx } = makeCanvas(bandW, bandH);
  ctx.drawImage(bitmap, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, bandW, bandH);
  bitmap.close();
  const plan = downscalePlan(bandW, bandH, thumbTargetWidth());
  const canvas = await downscaleToBox(band, plan.w, plan.h);
  return encodeWebp(canvas);
}

/**
 * The production painter: real canvas rasterisation + WebP encode. Kept out of
 * the facade proper so the orchestration stays Node-testable; this half is
 * exercised in the browser (e2e).
 */
export function createCanvasThumbPainter(): ThumbPainter {
  return {
    async fromBitmap(bitmap: ImageBitmap): Promise<Blob> {
      const { canvas, ctx } = makeCanvas(bitmap.width, bitmap.height);
      ctx.drawImage(bitmap, 0, 0);
      return encodeWebp(canvas);
    },

    async fromImageBytes(bytes: Blob, _theme: Theme, cropAspect?: { w: number; h: number }): Promise<Blob> {
      if (usableAspect(cropAspect)) return croppedTileFromBytes(bytes, cropAspect);
      return (await tileFromBytes(bytes)).blob;
    },

    async imageTile(bytes: Blob): Promise<ImageTileResult> {
      return tileFromBytes(bytes);
    },

    async glyph(kind: string, theme: Theme): Promise<Blob> {
      const w = thumbTargetWidth(); // tier target — the facade keys glyphs per bucket
      const h = Math.round(w * (1872 / 1404)); // note the page aspect the grid uses
      await ensureMonoFont();
      const { canvas, ctx } = makeCanvas(w, h);
      const p = palette(theme);
      ctx.fillStyle = p.paper;
      ctx.fillRect(0, 0, w, h);
      drawMarginRule(ctx, w, h, p.margin);

      // A dog-eared document sheet, centred — the same "file with no preview"
      // language the grid glyph tile used, baked into the image so the display
      // path stays a single `<img>`/canvas blit.
      const sheetW = w * 0.42;
      const sheetH = sheetW * 1.3;
      const x = (w - sheetW) / 2;
      const y = (h - sheetH) / 2 - h * 0.02;
      const fold = sheetW * 0.28;
      ctx.strokeStyle = p.ink;
      ctx.lineWidth = Math.max(1.5, w / 120);
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + sheetW - fold, y);
      ctx.lineTo(x + sheetW, y + fold);
      ctx.lineTo(x + sheetW, y + sheetH);
      ctx.lineTo(x, y + sheetH);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + sheetW - fold, y);
      ctx.lineTo(x + sheetW - fold, y + fold);
      ctx.lineTo(x + sheetW, y + fold);
      ctx.stroke();

      // The kind letter under the sheet — "PDF", "SPD", "FILE"; a folder gets no
      // caption (its shape reads on its own and it has no extension to name).
      if (kind !== "folder") {
        ctx.fillStyle = p.ink;
        // A file extension is DATA — set in the brand mono face (Space Mono ships
        // 400/700, no 600), so it reads as a typed label, not a system caption.
        ctx.font = `700 ${Math.round(w * 0.1)}px "Space Mono", ui-monospace, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(kind, w / 2, y + sheetH + h * 0.09);
      }
      return encodeWebp(canvas);
    },

    async textSnippet(content: string, theme: Theme): Promise<Blob> {
      const w = thumbTargetWidth(); // tier target — keyed per bucket by the facade
      const h = Math.round(w * (1872 / 1404));
      await ensureMonoFont();
      const { canvas, ctx } = makeCanvas(w, h);
      const p = palette(theme);
      ctx.fillStyle = p.paper;
      ctx.fillRect(0, 0, w, h);
      const marginX = drawMarginRule(ctx, w, h, p.margin);

      // The first few non-empty lines, clipped — a legible preview of the actual
      // content, which is the whole reason `.txt` is not a static glyph. Set past
      // the margin in the brand mono face, like writing on a ruled page.
      const lines = content
        .split(/\r?\n/)
        .map((l) => l.replace(/\t/g, "  ").trimEnd())
        .filter((l, i, a) => l.length > 0 || (i > 0 && a[i - 1]!.length > 0))
        .slice(0, 9);
      const padX = marginX + w * 0.05;
      const padRight = w * 0.08;
      const fontPx = Math.round(w * 0.062);
      const lineH = fontPx * 1.5;
      let y = h * 0.12;
      ctx.fillStyle = p.ink;
      ctx.font = `${fontPx}px "Space Mono", ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const maxChars = Math.floor((w - padX - padRight) / (fontPx * 0.62));
      for (const line of lines) {
        const clipped = line.length > maxChars ? line.slice(0, maxChars - 1) + "…" : line;
        ctx.fillText(clipped, padX, y);
        y += lineH;
        if (y > h - lineH) break;
      }
      return encodeWebp(canvas);
    },
  };
}

/**
 * The production network seam over `fetch`. A non-OK response or a thrown
 * transport error becomes `null` (the facade's "there is nothing here → glyph"
 * signal), so no caller ever sees a rejection for an ordinary 404.
 */
export function createFetchThumbNet(): ThumbNet {
  return {
    async bytes(url: string): Promise<Blob | null> {
      try {
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) return null;
        return await res.blob();
      } catch {
        return null;
      }
    },
    async probe(url: string): Promise<Blob | "not-found" | null> {
      try {
        const res = await fetch(url, { credentials: "same-origin" });
        if (res.status === 404) return "not-found";
        if (!res.ok) return null;
        return await res.blob();
      } catch {
        return null;
      }
    },
    async text(url: string): Promise<string | null> {
      try {
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) return null;
        return await res.text();
      } catch {
        return null;
      }
    },
  };
}
