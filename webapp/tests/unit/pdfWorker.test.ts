// The JSPI call table: any export that can reach the `ink.host_read` Suspending
// import must be wrapped in `WebAssembly.promising`, or a range-served document traps
// in a real browser while every other test stays green.

import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import type { PdfDecoderExports } from "../../src/render/pdfLoader";

// The module registers a `message` listener at import; Node needs a global scope for it.
type CallsFor = (x: PdfDecoderExports, useJspi?: boolean) => Record<string, unknown>;
let callsFor: CallsFor;

beforeAll(async () => {
  (globalThis as unknown as { addEventListener?: unknown }).addEventListener ??= () => {};
  (globalThis as unknown as { postMessage?: unknown }).postMessage ??= () => {};
  callsFor = (await import("../../src/render/pdfWorker")).callsFor as unknown as CallsFor;
});

function fakeExports(): PdfDecoderExports {
  const fn = (name: string) => Object.assign(vi.fn(), { __ink: name });
  return {
    ink_alloc: fn("ink_alloc"),
    ink_free: fn("ink_free"),
    ink_open: fn("ink_open"),
    ink_open_stream: fn("ink_open_stream"),
    ink_page_count: fn("ink_page_count"),
    ink_page_size: fn("ink_page_size"),
    ink_page_links: fn("ink_page_links"),
    ink_links_free: fn("ink_links_free"),
    ink_page_words: fn("ink_page_words"),
    ink_words_free: fn("ink_words_free"),
    ink_load_outline: fn("ink_load_outline"),
    ink_outline_free: fn("ink_outline_free"),
    ink_render: fn("ink_render"),
    ink_close: fn("ink_close"),
    ink_export_page: fn("ink_export_page"),
    ink_export_free: fn("ink_export_free"),
    ink_annotate_page: fn("ink_annotate_page"),
    ink_export_incremental: fn("ink_export_incremental"),
    ink_error_ptr: fn("ink_error_ptr"),
    ink_error_len: fn("ink_error_len"),
    memory: { buffer: new ArrayBuffer(8) },
  } as unknown as PdfDecoderExports;
}

/** Stands in for `WebAssembly.promising`, tagging what it wraps. */
const WRAPPED = Symbol("promising");
type Tagged = { [WRAPPED]?: string };

function stubPromising(): void {
  (WebAssembly as unknown as { promising: unknown }).promising = (f: unknown) => {
    const wrapper = (...args: unknown[]) => (f as (...a: unknown[]) => unknown)(...args);
    (wrapper as Tagged)[WRAPPED] = (f as { __ink?: string }).__ink ?? "?";
    return wrapper;
  };
}

const wrappedOver = (v: unknown): string | undefined => (v as Tagged)?.[WRAPPED];

afterEach(() => {
  delete (WebAssembly as unknown as { promising?: unknown }).promising;
  vi.restoreAllMocks();
});

describe("the JSPI call table", () => {
  /** Every export that can re-enter `ink.host_read` and so must suspend. */
  const MUST_SUSPEND: [string, string][] = [
    ["openStream", "ink_open_stream"],
    ["pageCount", "ink_page_count"],
    ["pageSize", "ink_page_size"],
    ["pageLinks", "ink_page_links"],
    ["pageWords", "ink_page_words"],
    ["loadOutline", "ink_load_outline"],
    ["render", "ink_render"],
    ["exportPage", "ink_export_page"],
    ["annotatePage", "ink_annotate_page"],
    ["exportIncremental", "ink_export_incremental"],
  ];

  it.each(MUST_SUSPEND)("wraps %s, over %s", (key, expo) => {
    stubPromising();
    const calls = callsFor(fakeExports(), true);
    expect(wrappedOver(calls[key])).toBe(expo);
  });

  it("does NOT wrap openWhole — its bytes are already in memory", () => {
    // The whole-file path's buffer is already filled; `ink_open` cannot reach the host.
    stubPromising();
    const calls = callsFor(fakeExports(), true);
    expect(wrappedOver(calls.openWhole)).toBeUndefined();
  });

  it("wraps NOTHING on the non-JSPI path, where nothing can suspend", () => {
    stubPromising();
    const calls = callsFor(fakeExports(), false);
    for (const [key] of MUST_SUSPEND) expect(wrappedOver(calls[key])).toBeUndefined();
  });

  it("leaves no suspending export unwrapped, whatever gets added next", () => {
    // Guard on the hand-kept list: every table function is listed or a known exception.
    stubPromising();
    const calls = callsFor(fakeExports(), true);
    const named = new Set<string>(MUST_SUSPEND.map(([k]) => String(k)));
    const deliberatelyPlain = new Set(["openWhole"]);
    for (const [key, value] of Object.entries(calls)) {
      if (typeof value !== "function") continue;
      if (deliberatelyPlain.has(key)) continue;
      expect(named.has(key), `${key} is in the JSPI table but not in MUST_SUSPEND`).toBe(true);
    }
  });
});
