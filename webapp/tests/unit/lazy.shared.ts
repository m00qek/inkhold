// Helpers shared by the lazy tests.

import { vi } from "vitest";
import { type ObserverLike } from "../../src/render/lazy";
import type { Api } from "../../src/api/types";
import type { NoteRenderer } from "../../src/render/types";
import type { RenderCache } from "../../src/cache/types";
import type { PageRef } from "../../src/core/types";

// No DOM: canvases are identity objects; observer, blit and placeholder are injected.

export const flush = () => new Promise((r) => setTimeout(r, 0));

export function page(hash: string): PageRef {
  return { index: 0, hash, width: 1404, height: 1872, textHash: null };
}

/** A fake observer that records the engine's visibility handler so a test can
 * drive intersections manually. */
export function fakeObserver() {
  let handler: ((target: Element, isIntersecting: boolean) => void) | null = null;
  const observed = new Set<Element>();
  const factory = (onVisibility: (target: Element, isIntersecting: boolean) => void): ObserverLike => {
    handler = onVisibility;
    return {
      observe: (t) => void observed.add(t),
      unobserve: (t) => void observed.delete(t),
      disconnect: () => observed.clear(),
    };
  };
  return {
    factory,
    observed,
    intersect: (target: Element, isIntersecting: boolean) => handler?.(target, isIntersecting),
  };
}

export function stubs() {
  const getPageBytes = vi.fn(async () => new ArrayBuffer(8));
  const api = { listFolder: vi.fn(), getNoteMeta: vi.fn(), getPageBytes } as unknown as Api;
  const render = vi.fn(async () => ({ bitmap: { width: 240, height: 320, close() {} } as unknown as ImageBitmap, width: 240, height: 320 }));
  const renderer = { render } as unknown as NoteRenderer;
  const cache = {
    get: vi.fn(async () => undefined),
    put: vi.fn(async () => {}),
  } as unknown as RenderCache;
  return { api, renderer, cache, getPageBytes, render };
}

export const canvas = () => ({}) as unknown as HTMLCanvasElement;
