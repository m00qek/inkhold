// The thumbnail facade: one content-addressed entry point for a small preview
// of any file, `getThumbnail(source, fileType) -> Promise<Blob>`. It always
// resolves to a displayable WebP (worst case a glyph, never null). `fileType`
// is a display hint selecting the strategy. Scheduling belongs to `LazyEngine`.
// Built over injected seams (`net`, `painter`, `renderNote`) so orchestration
// runs in Node; the real canvas/fetch seams are at the bottom.

import type { Hash, Id, PageRef, Theme } from "../core/types";
import { PREVIEWABLE_IMAGE_TYPES, rawFileUrl } from "../core/fileKind";
import { densityBucket } from "./types";
import { setDims as memoSetDims, type ImageDims } from "../cache/dimsMemo";
// A content hash's thumbnail 404 is permanent (new cover => new hash), so it is
// remembered across sessions.
import { hasNoCover, setNoCover, noteTransientMiss, type CoverMemo } from "../cache/coverMemo";
import type { PersistentThumbStore } from "../cache/idb";
export { downscalePlan, coverCropRect, boxDownscaleRgba, downscaleToBox, drawDownscaledInto, createCanvasThumbPainter, createFetchThumbNet } from "./thumbSeams";
export type { DownscalePlan, CropRect, DownscaleSource } from "./thumbSeams";

/**
 * Where a file's bytes live. `fileHash` is the content-address (cache key and
 * `?v=`), null for a folder; note pages are fetched by `(noteId, page)`.
 */
export interface ThumbSource {
  /** Content hash. Null = no blob (a folder) → the generic glyph, no network. */
  fileHash: Hash | null;
  fileId?: Id;
  noteId?: Id;
  page?: PageRef;
  /** A PDF's page other than its cover, 0-based (a digest's source page). */
  pdfPage?: number;
  /**
   * Trashed file: raw-file strategies must use the bin-scoped route (live
   * `/file/{id}` 404s for deleted files). `/thumbnail/{hash}` serves trashed
   * blobs too, so cache keys stay hash-only.
   */
  bin?: boolean;
  /**
   * The true canvas aspect (server `thumbAspect`). A `.spd` embeds a fixed
   * 600×800 portrait preview that letterboxes the drawing; this lets the
   * transcode crop the bands at cache time. Absent: no crop.
   */
  aspect?: { w: number; h: number };
}

/**
 * The closed strategy set. `image` is a server-extracted preview (`.spd`
 * embedded thumbnail); `image-doc` is a raster file downscaled locally whose
 * true dims feed the aspect memo; `pdf-page` is `note-page` without the cover
 * probe (PDFs and their `.mark` siblings have no usable cover).
 */
export type ThumbStrategy = "glyph" | "image" | "image-doc" | "note-page" | "pdf-page" | "text";

export interface Thumbnails {
  /** Resolve a displayable WebP; always fulfils. Theme comes from `getTheme`. */
  getThumbnail(source: ThumbSource, fileType: string): Promise<Blob>;
  /**
   * The type's glyph alone, so a caller can paint it first and upgrade when a
   * slow strategy (a `.pdf`) lands. Memoised per `kind:theme:bucket`.
   */
  getGlyph(fileType: string): Promise<Blob>;
  evictTheme(theme: Theme): void;
}

/** The pixel work, injected so the orchestration is testable without a canvas. */
export interface ThumbPainter {
  glyph(kind: string, theme: Theme): Promise<Blob>;
  /**
   * Transcode fetched image bytes to a tier-sized WebP. `cropAspect`
   * centre-crops to that aspect before downscaling (de-letterboxing a `.spd`
   * preview); never upscales past the band.
   */
  fromImageBytes(bytes: Blob, theme: Theme, cropAspect?: { w: number; h: number }): Promise<Blob>;
  fromBitmap(bitmap: ImageBitmap): Promise<Blob>;
  textSnippet(content: string, theme: Theme): Promise<Blob>;
  /** Decode an image document to a tier-sized WebP, reporting the source's true dims. */
  imageTile(bytes: Blob): Promise<ImageTileResult>;
}

export interface ImageTileResult {
  blob: Blob;
  /** The decoded source's dims, not the tier raster's. */
  sourceW: number;
  sourceH: number;
}

/** Page 0's pixels plus its box. The bitmap is the caller's to close. */
export interface PdfPageThumb {
  bitmap: ImageBitmap;
  /** Page 0's cropped, rotated box in points; only the ratio is used. */
  pageW: number;
  pageH: number;
}

/** The network, injected. A miss (404 or transport failure) is `null`, not a throw. */
export interface ThumbNet {
  bytes(url: string): Promise<Blob | null>;
  /**
   * Like `bytes`, but a definitive 404 is `"not-found"` (persisted in the cover
   * memo) while transport failures and 5xx are only suppressed per session.
   */
  probe(url: string): Promise<Blob | "not-found" | null>;
  /** The file's first `maxBytes` as text, never the whole file (`textHead`). */
  text(url: string, maxBytes: number): Promise<string | null>;
}

/**
 * A `.txt` card draws nine lines, so it reads only the file's head: a 2 MB book
 * is 4 KB from the server, not 2 MB.
 */
export const TEXT_THUMB_BYTES = 4096;

export interface ThumbnailsDeps {
  /** The negative-thumbnail memo; defaults to the shared persistent one. */
  coverMemo?: CoverMemo;
  getTheme(): Theme;
  net: ThumbNet;
  painter: ThumbPainter;
  /** Render one note page through `render/lazy.ts`'s `renderPage` at the "thumb" tier. */
  renderNote(noteId: Id, page: PageRef, theme: Theme): Promise<ImageBitmap>;
  /**
   * Render a PDF's page 0 (`render/pdfThumb.ts`). Optional: without wasm
   * exceptions or wiring, the `pdf-page` arm falls back to the glyph. No theme:
   * MuPDF's pixels are the same in both.
   */
  renderPdfPage?(fileId: Id, hash: Hash, opts?: { bin?: boolean; page?: number }): Promise<PdfPageThumb>;
  /** Record an image document's true dims (cache/dimsMemo.ts); advisory. */
  setDims?(hash: string, dims: ImageDims): Promise<void>;
  /**
   * The shared persistent `sn-thumbs` tier, so facade thumbnails survive reloads
   * under the render cache's byte budget. Fail-open; absent means memory-only.
   */
  persistent?: PersistentThumbStore | null;
}

/**
 * The type → strategy map. `FACADE_THUMB_TYPES` (pages/galleryCards.ts) must
 * agree with it; `thumbnails.test.ts` asserts the pair.
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
 * The glyph's kind label, driven by type not hash (a hashless `.spd` still
 * reads `SPD`); empty is folder, unhelpful types degrade to `FILE`.
 */
function glyphKind(fileType: string): string {
  const t = (fileType || "").trim().toLowerCase();
  if (!t || t === "folder") return "folder";
  if (t === "file") return "FILE";
  return t.length > 4 ? "FILE" : t.toUpperCase();
}

/**
 * Cache-key generation, prefixed to every facade key (in memory and persisted).
 * Bump when the pixels a key maps to change meaning.
 */
// 3: the painter read the page's theme, not the one asked for, and stored
// wrong-theme `.txt` cards and glyphs; every stored one is drawn again.
const THUMB_CACHE_VERSION = 3;

export function createThumbnails(deps: ThumbnailsDeps): Thumbnails {
  const { getTheme, net, painter, renderNote } = deps;
  const renderPdfPage = deps.renderPdfPage;
  const coverMemo: CoverMemo = deps.coverMemo ?? { hasNoCover, setNoCover, noteTransientMiss };
  const recordDims = deps.setDims ?? memoSetDims;
  const persistent: PersistentThumbStore | null = deps.persistent ?? null;

  // One blob cache across strategies. Keys: `<hash>:<theme>:b<bucket>` (pixels
  // depend on the density bucket), theme-free `<hash>:img:b<bucket>` and
  // `<hash>:pdf:b<bucket>`, and `glyph:<kind>:<theme>:b<bucket>`. Promises, so
  // concurrent requests share one produce.
  const cache = new Map<string, Promise<Blob>>();

  /**
   * Memory memo → persistent `sn-thumbs` → `produce`. A rejecting produce is not
   * cached. Persistent reads and writes are fail-open; `persist:false` skips the
   * store (glyphs), and only successful produces are written, never a fallback.
   */
  function memo(
    key: string,
    produce: () => Promise<Blob>,
    opts: { persist?: boolean } = {},
  ): Promise<Blob> {
    const vkey = `v${THUMB_CACHE_VERSION}:${key}`;
    const hit = cache.get(vkey);
    if (hit) return hit;
    // Persisted keys get a `facade:` prefix, which a render-cache id (starting
    // with a hex hash) can never have, so the shared store never mixes them.
    const usePersist = opts.persist !== false && persistent != null;
    const pkey = `facade:${vkey}`;
    const p = (async (): Promise<Blob> => {
      if (usePersist) {
        try {
          const stored = await persistent!.get(pkey);
          if (stored) return stored;
        } catch {
          // Fail-open: a broken store must never block producing the thumbnail.
        }
      }
      const blob = await produce();
      if (usePersist) void persistent!.put(pkey, blob).catch(() => {});
      return blob;
    })().catch((e) => {
      cache.delete(vkey);
      throw e;
    });
    cache.set(vkey, p);
    return p;
  }

  /** The generic glyph, drawn client-side, never fetched: every strategy's floor. */
  function glyph(fileType: string, theme: Theme, bucket: number): Promise<Blob> {
    const kind = glyphKind(fileType);
    return memo(`glyph:${kind}:${theme}:b${bucket}`, () => painter.glyph(kind, theme), { persist: false });
  }

  async function getThumbnail(source: ThumbSource, fileType: string): Promise<Blob> {
    const theme = getTheme();
    const bucket = densityBucket();
    // The strategy is the type's, not gated on the hash.
    const strategy = strategyFor(fileType);

    switch (strategy) {
      case "glyph":
        return glyph(fileType, theme, bucket);

      case "note-page": {
        // Cover first: a `.note` may carry a user-set device-rendered cover at
        // `/thumbnail/{hash}` (whole-file hash). Most don't; the 404 falls
        // through to the WASM page-0 render.
        if (source.fileHash !== null && !(await coverMemo.hasNoCover(source.fileHash))) {
          const hash = source.fileHash;
          const cover = await memo(`${hash}:${theme}:b${bucket}`, async () => {
            const got = await net.probe(`/thumbnail/${encodeURIComponent(hash)}`);
            if (got === "not-found") {
              // Definitive: no cover under this hash, ever; persist.
              void coverMemo.setNoCover(hash);
              throw new NoThumbnail(); // falls back to the render
            }
            if (!got) {
              // Transport/server failure: suppress for this session only.
              coverMemo.noteTransientMiss(hash);
              throw new NoThumbnail();
            }
            return painter.fromImageBytes(got, theme);
          }).catch(() => null);
          if (cover) return cover;
        }

        // Keyed by the page hash (what determines the pixels), like the render cache.
        if (!source.noteId || !source.page) return glyph(fileType, theme, bucket);
        const page = source.page;
        const noteId = source.noteId;
        return memo(`${page.hash}:${theme}:b${bucket}`, async () =>
          painter.fromBitmap(await renderNote(noteId, page, theme)),
        );
      }

      case "pdf-page": {
        // Straight to the MuPDF render (one document at a time, pdfThumb.ts).
        // A persistent hit skips `produce`, so the wasm is fetched only for
        // the first uncached visible PDF tile.
        if (source.fileHash === null || !source.fileId || !renderPdfPage) {
          return glyph(fileType, theme, bucket);
        }
        const hash = source.fileHash;
        const fileId = source.fileId;
        const bin = source.bin;
        const page = source.pdfPage ?? 0;
        // Theme-free (MuPDF draws on white; re-rendering per toggle would be the
        // facade's costliest produce) and keyed by file md5; the cover's key
        // has no page, as before pages other than the cover were drawn.
        return memo(page === 0 ? `${hash}:pdf:b${bucket}` : `${hash}:pdf:p${page}:b${bucket}`, async () => {
          const frame = await renderPdfPage(fileId, hash, { bin, page });
          try {
            // Record the cover's aspect for the masonry memo; fire-and-forget.
            if (page === 0 && frame.pageW > 0 && frame.pageH > 0) {
              void recordDims(hash, { w: frame.pageW, h: frame.pageH }).catch(() => {});
            }
            return await painter.fromBitmap(frame.bitmap);
          } finally {
            // Ours to free: the worker transferred it and nothing else holds it.
            frame.bitmap.close();
          }
        }).catch(() => glyph(fileType, theme, bucket));
      }

      case "image": {
        // `.spd`: the server-extracted embedded thumbnail; a 404 means glyph.
        if (source.fileHash === null) return glyph(fileType, theme, bucket);
        const hash = source.fileHash;
        if (await coverMemo.hasNoCover(hash)) return glyph(fileType, theme, bucket);
        const url = `/thumbnail/${encodeURIComponent(hash)}`;
        return memo(`${hash}:${theme}:b${bucket}`, async () => {
          const got = await net.probe(url);
          if (got === "not-found") {
            void coverMemo.setNoCover(hash); // permanent under this hash
            throw new NoThumbnail(); // becomes a glyph
          }
          if (!got) {
            coverMemo.noteTransientMiss(hash);
            throw new NoThumbnail();
          }
          return painter.fromImageBytes(got, theme, source.aspect);
        }).catch(() => glyph(fileType, theme, bucket));
      }

      case "image-doc": {
        // A raster document: raw bytes fetched once per hash, downscaled, and
        // its true dims recorded so the tile lays out reflow-free. Theme-free
        // key, so a toggle never refetches megabytes.
        if (source.fileHash === null) return glyph(fileType, theme, bucket);
        const hash = source.fileHash;
        const url = source.fileId ? rawFileUrl(source.fileId, hash, { bin: source.bin }) : null;
        if (!url) return glyph(fileType, theme, bucket);
        return memo(`${hash}:img:b${bucket}`, async () => {
          const bytes = await net.bytes(url);
          if (!bytes) throw new NoThumbnail(); // becomes a glyph
          const tile = await painter.imageTile(bytes);
          // Record the source's true dims; advisory, fire-and-forget.
          void recordDims(hash, { w: tile.sourceW, h: tile.sourceH }).catch(() => {});
          return tile.blob;
        }).catch(() => glyph(fileType, theme, bucket));
      }

      case "text": {
        // `.txt`: a snippet of the file's first lines; glyph if unreadable.
        if (source.fileHash === null) return glyph(fileType, theme, bucket);
        const hash = source.fileHash;
        const url = source.fileId ? rawFileUrl(source.fileId, hash, { bin: source.bin }) : null;
        if (!url) return glyph(fileType, theme, bucket);
        return memo(`${hash}:${theme}:b${bucket}`, async () => {
          const content = await net.text(url, TEXT_THUMB_BYTES);
          if (content === null) throw new NoThumbnail();
          return painter.textSnippet(content, theme);
        }).catch(() => glyph(fileType, theme, bucket));
      }
    }
  }

  return {
    getThumbnail,
    getGlyph(fileType: string): Promise<Blob> {
      return glyph(fileType, getTheme(), densityBucket());
    },
    evictTheme(theme: Theme): void {
      // Theme-free `:img:` and `:pdf:` keys don't match and survive.
      const infix = `:${theme}:b`;
      for (const key of [...cache.keys()]) if (key.includes(infix)) cache.delete(key);
    },
  };
}

/** Thrown to route to the glyph without logging a failure; never escapes. */
class NoThumbnail extends Error {}
