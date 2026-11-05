// Fetches the large WebAssembly modules in the background once someone is
// signed in, so the first search and the first PDF open do not wait on them.
// Only after sign-in: the login page is public, and a stranger loading it must
// not cost the server two megabytes. Only when idle, one module at a time, and
// never on a connection that asks to save data.
//
// The bytes land in the browser's HTTP cache. These files sit outside the
// hashed `/assets/` and are `no-cache`, so the real load later revalidates
// with the server's ETag and gets a 304, not the body again.

/**
 * Smallest first: search is wanted sooner and costs less. The owners of these
 * URLs are `search/indexEngine.ts` and `render/pdfLoader.ts`; a unit test
 * keeps the two lists equal without pulling those modules into the shell.
 */
export const WARM_WASM_URLS: readonly string[] = ["/sqlite-core.wasm", "/pdf-decode.wasm"];

/** How long after sign-in the warm-up waits at least: the gallery goes first. */
export const WARM_DELAY_MS = 5_000;

export interface WarmDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Calls `fn` when the browser is idle (or soon, where it cannot say). */
  whenIdle: (fn: () => void) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  /** The Network Information API's hints, when the browser has them. */
  connection?: { saveData?: boolean; effectiveType?: string };
}

/** True when the connection asks not to spend data on things nobody requested. */
export function shouldSkip(connection: WarmDeps["connection"]): boolean {
  if (!connection) return false;
  if (connection.saveData === true) return true;
  return connection.effectiveType === "slow-2g" || connection.effectiveType === "2g";
}

/**
 * Starts the warm-up and returns a cancel for sign-out. Failures are ignored:
 * this only saves time later, and the real load reports its own errors.
 */
export function warmWasm(deps: WarmDeps = browserDeps()): () => void {
  const abort = new AbortController();
  if (shouldSkip(deps.connection)) return () => abort.abort();

  deps.setTimeout(() => {
    if (abort.signal.aborted) return;
    deps.whenIdle(() => void fetchInTurn(deps, abort.signal));
  }, WARM_DELAY_MS);
  return () => abort.abort();
}

async function fetchInTurn(deps: WarmDeps, signal: AbortSignal): Promise<void> {
  for (const url of WARM_WASM_URLS) {
    if (signal.aborted) return;
    try {
      const res = await deps.fetch(url, { signal, priority: "low" } as RequestInit);
      // Read to the end: a body left unread is not stored in the cache.
      await res.arrayBuffer();
    } catch {
      return; // aborted, offline or refused: the real load will try again
    }
  }
}

function browserDeps(): WarmDeps {
  const nav = navigator as Navigator & { connection?: WarmDeps["connection"] };
  return {
    fetch: (url, init) => fetch(url, init),
    whenIdle:
      typeof requestIdleCallback !== "undefined"
        ? (fn) => void requestIdleCallback(fn, { timeout: 10_000 })
        : (fn) => void setTimeout(fn, 0),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    connection: nav.connection,
  };
}
