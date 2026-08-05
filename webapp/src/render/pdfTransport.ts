// The PDF worker's TRANSPORT — the network, and nothing else.
//
// Split out of `pdfWorker.ts` for the same reason `pdfBlocks.ts` was: no DOM, no
// wasm, no worker scope, so it can be unit-tested against a real server and a
// real `fetch`. That is not a tidiness argument. The budget below guarded only
// the header exchange for as long as it lived in the worker, where nothing could
// reach it to test it, and a stalled body read — the failure it exists to catch —
// went unnoticed the whole time.

import type { RangeFetcher } from "./pdfBlocks";

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** A fetch that failed with a status the main thread may want to act on. */
export class HttpError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? "pdf fetch failed" : `pdf fetch failed: HTTP ${status}`);
  }
}

/**
 * How long ONE transfer may take before it is abandoned.
 *
 * Per request, not per document, which is the difference ranges make: the old
 * whole-file path had a single 300 s budget because a 64 MB file on a slow link
 * legitimately takes minutes, where a 512 KB block that has not arrived in two
 * is not slow, it is stuck. A stalled transfer has to end in the load error
 * rather than leaving "Opening…" on screen forever.
 */
export const BLOCK_TIMEOUT_MS = 120_000;
export const WHOLE_TIMEOUT_MS = 300_000;

/** The caller's signal plus a deadline. `done()` on every path, or the timer leaks. */
export function budget(signal: AbortSignal, ms: number): { signal: AbortSignal; done: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const onAbort = () => ac.abort();
  if (signal.aborted) ac.abort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return {
    signal: ac.signal,
    done: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

/** `content-range: bytes a-b/N` → N. Null for `*` or a malformed header. */
export function totalFromContentRange(header: string | null): number | null {
  if (!header) return null;
  const slash = header.lastIndexOf("/");
  if (slash < 0) return null;
  const n = Number(header.slice(slash + 1).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * One byte range, `[start, end]` inclusive.
 *
 * A `200` is NOT an error: it means the server ignored `Range` and sent the
 * whole file, so the window is sliced out of it and the cache counts it — a
 * deployment where every block costs a full download is worth being able to
 * see, rather than something to fail on. `206` is the expected answer;
 * `d464895` taught the raw route to give it.
 */
/**
 * THE BUDGET COVERS THE WHOLE TRANSFER, HEADERS AND BODY.
 *
 * `fetch` resolves the moment the response HEADERS land — the body is still
 * streaming. So releasing the budget in a `finally` around the `fetch` alone,
 * which is what this did, left the body read with no deadline and no way for
 * `release()` to cancel it: `done()` clears the timer AND drops the caller's
 * abort listener. A server that sends headers and then stalls mid-body — the
 * likeliest stall on the slow link this whole design targets — hung on
 * "Opening this PDF…" forever, the exact state {@link BLOCK_TIMEOUT_MS} exists
 * to prevent. Measured before the fix: a 1.5 s budget never fired, an abort at
 * 2.5 s did nothing, and the read was still hanging at 5 s.
 *
 * Hence `done()` in a `finally` around EVERYTHING, and the body read wrapped
 * too — a transfer cut short by the deadline is the same "transport failed" the
 * header path reports, not a raw `AbortError` for the viewer to print.
 */
export function rangeFetcher(url: string, signal: AbortSignal): RangeFetcher {
  return async (start, end) => {
    const b = budget(signal, BLOCK_TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { Range: `bytes=${start}-${end}` },
          credentials: "same-origin",
          signal: b.signal,
        });
      } catch {
        throw new HttpError(null);
      }
      if (!res.ok) throw new HttpError(res.status);
      let body: Uint8Array;
      try {
        body = new Uint8Array(await res.arrayBuffer());
      } catch {
        throw new HttpError(null);
      }
      if (res.status === 200) {
        return { bytes: body.subarray(start, end + 1), total: body.length, whole: true };
      }
      return {
        bytes: body,
        total: totalFromContentRange(res.headers.get("content-range")),
        whole: false,
      };
    } finally {
      b.done();
    }
  };
}

/** Same budget discipline as {@link rangeFetcher}: headers AND body. */
export async function fetchWhole(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const b = budget(signal, WHOLE_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(url, { credentials: "same-origin", signal: b.signal });
    } catch {
      throw new HttpError(null);
    }
    if (!res.ok) throw new HttpError(res.status);
    try {
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      throw new HttpError(null);
    }
  } finally {
    b.done();
  }
}
