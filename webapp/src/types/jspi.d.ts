// JSPI — JavaScript Promise Integration (WebAssembly stage 4, shipped in
// Chromium 137+). TypeScript's `lib.dom` does not declare it yet, so the two
// entry points are declared here rather than cast away at every use site.
//
// `docs/scratch/pdf-ranges.md` §2.2: this is what lets MuPDF's `fz_stream`
// callback await a `fetch` while the C code believes it made an ordinary
// synchronous call. It needs neither a secure context nor COOP/COEP, which is
// why it — and not `SharedArrayBuffer` — is the transport this app can deploy.
//
// BOTH MUST BE FEATURE-DETECTED AT RUNTIME. Declaring them does not make them
// exist; the worker checks `typeof WebAssembly.Suspending` before using either
// and falls back to the whole-file path when they are absent.

declare namespace WebAssembly {
  /**
   * Wraps a JS function so that a wasm call to it SUSPENDS the calling wasm
   * stack when the function returns a promise, resuming when it settles. Only
   * meaningful as an import value; the wasm side sees a plain synchronous call.
   */
  class Suspending<T extends (...args: never[]) => unknown = (...args: never[]) => unknown> {
    constructor(fn: T);
  }

  /**
   * Wraps a wasm EXPORT so that calling it returns a promise and its stack is
   * allowed to suspend. Any export that can transitively reach a `Suspending`
   * import must go through this, or the suspension traps.
   */
  function promising<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => Promise<R>;
}
