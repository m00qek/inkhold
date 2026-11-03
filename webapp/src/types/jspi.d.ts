// JSPI (WebAssembly JS Promise Integration, Chromium 137+), not yet in
// `lib.dom`. Lets MuPDF's `fz_stream` callback await a `fetch`; needs no secure
// context or COOP/COEP, unlike `SharedArrayBuffer`. Declaring them doesn't make
// them exist: feature-detect at runtime.

declare namespace WebAssembly {
  /** Wraps an import so a wasm call to it suspends the wasm stack on a promise. */
  class Suspending<T extends (...args: never[]) => unknown = (...args: never[]) => unknown> {
    constructor(fn: T);
  }

  /**
   * Wraps a wasm export to return a promise. Any export that can reach a
   * `Suspending` import must go through this, or the suspension traps.
   */
  function promising<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => Promise<R>;
}
