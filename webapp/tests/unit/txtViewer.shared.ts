// @vitest-environment happy-dom
// Helpers shared by the txtViewer tests.

import { vi } from "vitest";
import { createTxtViewer, type TxtSeam } from "../../src/pages/txt/txtViewer";
import type { ViewerDeps, ReaderOrigin } from "../../src/pages/viewer/viewer";
import type { NoteMeta } from "../../src/core/types";
import type { DocSearch } from "../../src/search/docSearch";

/** An engine that answers nothing — the default for the tests that never search. */
export const noDocSearch: DocSearch = {
  search: async (md5, query) => ({ query, md5, segments: [], usedFuzzy: false, expansions: [] }),
  drop: () => {},
};

export function deps(over: Partial<ViewerDeps> = {}): ViewerDeps {
  return {
    api: {} as ViewerDeps["api"],
    docSearch: noDocSearch,
    renderer: {} as ViewerDeps["renderer"],
    cache: {} as ViewerDeps["cache"],
    getTheme: () => "light",
    onBack: vi.fn(),
    toast: vi.fn(),
    onSessionExpired: vi.fn(),
    onMoveToBin: vi.fn(),
    onPosition: vi.fn(),
    ...over,
  };
}

export function meta(over: Partial<NoteMeta> = {}): NoteMeta {
  return {
    id: "n-1",
    name: "notes",
    pages: [],
    fileType: "txt",
    fileHash: "a".repeat(32),
    size: 2048,
    pxPerMm: null,
    ...over,
  };
}

export const FOLDER: ReaderOrigin = { kind: "folder", folderPath: "Note / Files" };

export const HISTORY_VERSION = { md5: "e".repeat(32), createdAt: 1_752_000_000_000 };

export const HISTORY: ReaderOrigin = { kind: "history", folderPath: "Note / Files", version: HISTORY_VERSION };

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush microtasks + a macrotask, so the viewer's `.then`/`.catch` has run. */
export const flush = () => new Promise((r) => setTimeout(r, 0));

/** A seam whose `fetchText` is a controllable deferred, with in-memory size and zoom stores. */
export function fakeSeam(initialFont: number | null = null, initialZoom: number | null = null) {
  const calls: { url: string; signal: AbortSignal; d: Deferred<string> }[] = [];
  let store = initialFont;
  const saves: number[] = [];
  let zoomStore = initialZoom;
  const zoomSaves: number[] = [];
  const seam: TxtSeam = {
    fetchText: (url, signal) => {
      const d = deferred<string>();
      calls.push({ url, signal, d });
      return d.promise;
    },
    loadFontSize: () => store,
    saveFontSize: (px) => {
      store = px;
      saves.push(px);
    },
    loadZoom: () => zoomStore,
    saveZoom: (idx) => {
      zoomStore = idx;
      zoomSaves.push(idx);
    },
  };
  return { seam, calls, saves, zoomSaves, currentStore: () => store, currentZoom: () => zoomStore };
}

export function mount(v: ReturnType<typeof createTxtViewer>) {
  document.body.append(v.el);
  return v;
}

export const q = (v: ReturnType<typeof createTxtViewer>, sel: string) => v.el.querySelector(sel);
