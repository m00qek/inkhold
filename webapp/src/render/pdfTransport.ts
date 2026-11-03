// The PDF worker's network transport (no DOM, wasm or worker scope).

import type { RangeFetcher } from "./pdfBlocks";

export class HttpError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? "pdf fetch failed" : `pdf fetch failed: HTTP ${status}`);
  }
}

/**
 * Per-request transfer deadline: a stalled block must end in a load error, not
 * "Opening…" forever.
 */
export const BLOCK_TIMEOUT_MS = 120_000;
export const WHOLE_TIMEOUT_MS = 300_000;

/** The caller's signal plus a deadline. Call `done()` on every path, or the timer leaks. */
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

export function totalFromContentRange(header: string | null): number | null {
  if (!header) return null;
  const slash = header.lastIndexOf("/");
  if (slash < 0) return null;
  const n = Number(header.slice(slash + 1).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * One inclusive byte range. A `200` (server ignored `Range`) is sliced, not an
 * error. The budget covers headers and body: `fetch` resolves at headers, so
 * `done()` sits in a `finally` around the body read too, else the read hangs
 * with no deadline.
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

/** Same budget discipline as {@link rangeFetcher}: headers and body. */
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
