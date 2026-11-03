// Helpers shared by the thumbnails tests.

import { vi } from "vitest";
import { createThumbnails, type ThumbNet, type ThumbPainter, type ThumbSource } from "../../src/render/thumbnails";
import type { PersistentThumbStore } from "../../src/cache/idb";
import type { Id, PageRef, Theme } from "../../src/core/types";

// The facade's orchestration with every pixel/network seam faked; the real seams are e2e's.

/** A tagged fake blob, so a test can tell WHICH strategy produced a result. */
export const tagged = (tag: string): Blob => new Blob([tag], { type: "image/webp" });

export const tagOf = async (b: Blob): Promise<string> => b.text();

export function page(hash: string): PageRef {
  return { index: 0, hash, width: 1404, height: 1872, textHash: null };
}

export function fakePainter() {
  const glyph = vi.fn(async (kind: string, theme: Theme) => tagged(`glyph:${kind}:${theme}`));
  const fromImageBytes = vi.fn(
    async (_b: Blob, theme: Theme, _cropAspect?: { w: number; h: number }) => tagged(`image:${theme}`),
  );
  const fromBitmap = vi.fn(async (_bm: ImageBitmap) => tagged("note"));
  const textSnippet = vi.fn(async (content: string, theme: Theme) => tagged(`text:${content.slice(0, 3)}:${theme}`));
  // A fixed 3000×2000 source, so the dims memo can be checked for source truth.
  const imageTile = vi.fn(async (_b: Blob) => ({ blob: tagged("imgdoc"), sourceW: 3000, sourceH: 2000 }));
  return { glyph, fromImageBytes, fromBitmap, textSnippet, imageTile } satisfies ThumbPainter;
}

export function fakeNet(over: Partial<ThumbNet> = {}) {
  return {
    bytes: vi.fn(async () => tagged("bytes")),
    text: vi.fn(async () => "hello\nworld\nthird line"),
    ...over,
  } as ThumbNet & { bytes: ReturnType<typeof vi.fn>; text: ReturnType<typeof vi.fn> };
}

/** Without a test `probe`, delegate to `bytes` and read null as a definitive 404. */
export function withProbe(net: ReturnType<typeof fakeNet>): ReturnType<typeof fakeNet> {
  if (!("probe" in net) || net.probe === undefined) {
    (net as { probe?: ThumbNet["probe"] }).probe = vi.fn(async (url: string) => {
      const b = await net.bytes(url);
      return b ?? "not-found";
    });
  }
  return net;
}

/** A fresh cover memo per test; the module-level instance must not leak state. */
export function fakeCoverMemo() {
  const persisted = new Set<string>();
  const session = new Set<string>();
  return {
    persisted,
    session,
    async hasNoCover(hash: string) {
      return persisted.has(hash) || session.has(hash);
    },
    async setNoCover(hash: string) {
      persisted.add(hash);
    },
    noteTransientMiss(hash: string) {
      session.add(hash);
    },
  };
}

export function build(
  opts: {
    theme?: () => Theme;
    net?: ThumbNet;
    coverMemo?: ReturnType<typeof fakeCoverMemo>;
    persistent?: PersistentThumbStore | null;
    pdf?: false;
  } = {},
) {
  const painter = fakePainter();
  const net = withProbe((opts.net ?? fakeNet()) as ReturnType<typeof fakeNet>);
  const coverMemo = opts.coverMemo ?? fakeCoverMemo();
  const renderNote = vi.fn(async () => ({ width: 240, height: 320, close() {} }) as unknown as ImageBitmap);
  // The PDF bitmap is the facade's to close (renderNote's belongs to the render cache).
  const pdfBitmaps: Array<{ closed: boolean }> = [];
  const renderPdfPage = vi.fn(async (_id: Id, _hash: string, _o?: { bin?: boolean }) => {
    const bitmap = { width: 230, height: 345, closed: false, close(): void { bitmap.closed = true; } };
    pdfBitmaps.push(bitmap);
    return { bitmap: bitmap as unknown as ImageBitmap, pageW: 400, pageH: 600 };
  });
  // Injected dims sink, so tests never touch the module-level persistent memo.
  const setDims = vi.fn(async (_hash: string, _dims: { w: number; h: number }) => {});
  const thumbs = createThumbnails({
    coverMemo,
    getTheme: opts.theme ?? (() => "light"),
    net,
    painter,
    renderNote,
    // `pdf: false`: a browser that cannot run the decoder; the glyph floor must survive.
    renderPdfPage: opts.pdf === false ? undefined : renderPdfPage,
    setDims,
    persistent: opts.persistent,
  });
  return {
    coverMemo,
    thumbs,
    painter,
    net: net as ReturnType<typeof fakeNet>,
    renderNote,
    renderPdfPage,
    pdfBitmaps,
    setDims,
  };
}

export const noteSrc = (fileHash = "notehash"): ThumbSource => ({ fileHash, fileId: "n1", noteId: "n1", page: page("pageh") });

export const fileSrc = (hash: string | null): ThumbSource => ({ fileHash: hash, fileId: "f1" });
