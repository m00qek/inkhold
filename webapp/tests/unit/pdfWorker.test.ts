// The worker's JSPI CALL TABLE — which exports get a `WebAssembly.promising`
// wrapper, and which must not.
//
// This is the one thing about the worker that no other test can reach, and the
// failure it guards is invisible from everywhere else. `ink.host_read` is a
// `WebAssembly.Suspending` import on the JSPI path, so ANY export that can reach
// it must be called through `WebAssembly.promising` or the instance TRAPS on its
// first suspension rather than waiting. Forget one wrapper and:
//
//   - the unit suite stays green (it drives the sync path, where nothing
//     suspends),
//   - the whole-file path stays correct (its bytes are already in memory),
//   - and only a RANGE-SERVED document, in a real browser, on a real link,
//     breaks — which is the configuration this app is actually built for.
//
// The hazard is not hypothetical: `exportPage` shipped with `PdfCalls.exportPage`
// OPTIONAL in the type, so the compiler was happy either way, and the wrapper
// was added by hand in two places that had to agree. The whole-document export
// then added two more entry points with the same property.

import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import type { PdfDecoderExports } from "../../src/render/pdfDecode";

// The module IS a worker: at import it registers a `message` listener on its
// global scope. Node has no such scope, so one is supplied before the dynamic
// import below — the listener is never fired here, and nothing else in the
// module runs on load.
type CallsFor = (x: PdfDecoderExports, useJspi?: boolean) => Record<string, unknown>;
let callsFor: CallsFor;

beforeAll(async () => {
  (globalThis as unknown as { addEventListener?: unknown }).addEventListener ??= () => {};
  (globalThis as unknown as { postMessage?: unknown }).postMessage ??= () => {};
  callsFor = (await import("../../src/render/pdfWorker")).callsFor as unknown as CallsFor;
});

/**
 * Every export the table may touch, each a distinct spy so the assertions can
 * tell which one a wrapper was built over.
 */
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

/**
 * Stand in for `WebAssembly.promising`, which the engine running these tests
 * need not have. It TAGS what it wraps, so a wrapper is detectable by identity
 * rather than by hoping a call behaves differently.
 */
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
  /**
   * Everything that can re-enter `ink.host_read`, and therefore must suspend.
   *
   * `pageCount` walks the page tree and `pageSize` loads a page — both read
   * bytes on a document that is still mostly unfetched, which is why the list is
   * longer than the obvious two. `exportIncremental` reads the ENTIRE original
   * back through the host to write its delta. `pageLinks` loads the page AND
   * resolves each internal destination, which is a second walk of the xref.
   * `pageWords` is the strongest case of all: it RUNS the page through a
   * structured-text device, so it touches every font, image and content stream
   * the page names.
   */
  const MUST_SUSPEND: [string, string][] = [
    ["openStream", "ink_open_stream"],
    ["pageCount", "ink_page_count"],
    ["pageSize", "ink_page_size"],
    ["pageLinks", "ink_page_links"],
    ["pageWords", "ink_page_words"],
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
    // The whole-file path hands the module a buffer it has already filled, so
    // `ink_open` cannot reach the host and a promise here would be a lie about
    // what it does — and would make `AsyncPdfDocument` await a value.
    stubPromising();
    const calls = callsFor(fakeExports(), true);
    expect(wrappedOver(calls.openWhole)).toBeUndefined();
  });

  it("wraps NOTHING on the non-JSPI path, where nothing can suspend", () => {
    // Without JSPI the host-read import is the honest -1 stub and a streamed
    // document is never opened, so every call is a plain synchronous one.
    stubPromising();
    const calls = callsFor(fakeExports(), false);
    for (const [key] of MUST_SUSPEND) expect(wrappedOver(calls[key])).toBeUndefined();
  });

  it("leaves no suspending export unwrapped, whatever gets added next", () => {
    // The list above is maintained by hand, so this is the guard on the guard:
    // every member of the table that is a function must either be in
    // MUST_SUSPEND or be one of the deliberate exceptions. A new entry point
    // added without a decision shows up here rather than in a browser.
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
