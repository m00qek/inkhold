// The request budgets and the JSON/byte fetch every API call goes through.

import { ApiError, RateLimitError } from "./errors";

export interface Envelope {
  success: boolean;
  errorCode?: string;
  errorMsg?: string;
}

/** A failed API call. `code` is the server's `errorCode` (or a synthetic one). */

// --- request budgets ---------------------------------------------------------
// These guard against a stall, not slowness: a stalled connection never rejects,
// but a 200 MB PDF to a Pi may take minutes. Hence tiers. The SSE stream is
// exempt; it has its own heartbeats.

/** A control-plane GET: small responses. Past this, it is not coming. */
const CONTROL_TIMEOUT_MS = 15_000;

/** A mutation may have applied before its answer was lost: never auto-retry, never claim it failed. */
const MUTATION_TIMEOUT_MS = 30_000;

/**
 * Bytes: payloads, raw files, thumbnails. Only a backstop against the infinite
 * case; a total cap cannot tell a stall from a slow success.
 */
const BYTES_TIMEOUT_MS = 300_000;

/** An upload is bounded by silence (no `upload.onprogress` bytes), never by total time. */
export const UPLOAD_STALL_MS = 30_000;

/** After the last byte, progress stops while the server hashes, so switch to a cap on the answer. */
export const UPLOAD_RESPONSE_MS = 60_000;

const TIMEOUT_MESSAGE = "The server is taking too long to answer. Check your connection and try again.";
/** A mutation that timed out MAY HAVE APPLIED. Never say it failed. */
export const TIMEOUT_AMBIGUOUS =
  "The server didn't answer in time, so we don't know whether that finished. Reload to see where things stand.";

/**
 * Aborts when `caller` does or `ms` elapses; run `done()` in a `finally`. Not
 * `AbortSignal.timeout`: the timer must be clearable (hundreds of thumbnail
 * fetches), and `timedOut` must be readable since `fetch` rejects identically.
 */
function withTimeout(caller: AbortSignal | undefined, ms: number) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, ms);
  const onCallerAbort = (): void => ctl.abort();
  caller?.addEventListener("abort", onCallerAbort);
  if (caller?.aborted) ctl.abort();
  return {
    signal: ctl.signal,
    /** True only when WE aborted it, so a caller's own cancel is not a timeout. */
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    },
  };
}

/** The bytes budget for whole-blob readers that own their `fetch`. Run `done()` in a `finally`. */
export function bytesBudget(caller?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const b = withTimeout(caller, BYTES_TIMEOUT_MS);
  return { signal: b.signal, done: b.done };
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

/**
 * `signal` goes straight to `fetch`, the only way a superseded request frees
 * one of the browser's ~6 connections per origin. An abort lands as `NETWORK`,
 * which the aborting caller never sees.
 */
export async function request<T = unknown>(
  method: Method,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T & Envelope> {
  // A GET is cheap to lose and safe to repeat; a mutation gets room and an honest message.
  const mutating = method !== "GET";
  const budget = withTimeout(signal, mutating ? MUTATION_TIMEOUT_MS : CONTROL_TIMEOUT_MS);
  // `done()` on every path: an armed timer per request leaks on busy surfaces.
  try {
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: budget.signal,
      });
    } catch {
      if (budget.timedOut()) {
        throw new ApiError("TIMEOUT", mutating ? TIMEOUT_AMBIGUOUS : TIMEOUT_MESSAGE, 0);
      }
      throw new ApiError("NETWORK", "Can't reach the server. Check your connection and try again.", 0);
    }

    if (res.status === 429) {
      const header = res.headers.get("Retry-After");
      const secs = header ? Number.parseInt(header, 10) : NaN;
      throw new RateLimitError(Number.isFinite(secs) ? secs : null);
    }

    // Before 401/403: the session is valid, just not recently elevated. Treated as
    // UNAUTHORIZED it would sign the user out instead of showing the gate.
    if (res.status === 428) {
      throw new ApiError("ELEVATION_REQUIRED", "Confirm your password to continue.", 428);
    }

    if (res.status === 401 || res.status === 403) {
      throw new ApiError("UNAUTHORIZED", "Your session has ended. Sign in again.", res.status);
    }

    let data: (T & Envelope) | null = null;
    try {
      data = (await res.json()) as T & Envelope;
    } catch {
      // Some endpoints (/api/version) return non-JSON.
      if (!res.ok) throw new ApiError("SERVER", "The server returned an unexpected response.", res.status);
      return {} as T & Envelope;
    }

    if (data && data.success === false) {
      throw new ApiError(data.errorCode ?? "ERROR", data.errorMsg ?? "Something went wrong.", res.status);
    }
    if (!res.ok) {
      throw new ApiError("SERVER", "The server returned an unexpected response.", res.status);
    }
    return data;
  } finally {
    budget.done();
  }
}


export function statusError(status: number): ApiError | null {
  if (status === 428) {
    return new ApiError("ELEVATION_REQUIRED", "Confirm your password to continue.", 428);
  }
  if (status === 401 || status === 403) {
    return new ApiError("UNAUTHORIZED", "Your session has ended. Sign in again.", status);
  }
  if (status === 429) return new RateLimitError(null);
  if (status === 404) {
    // A stale `?v=`: the caller should refetch the note metadata for new page hashes.
    return new ApiError("STALE_PAGE", "This page is out of date. Reopening…", 404);
  }
  if (status >= 400) return new ApiError("SERVER", "The server returned an unexpected response.", status);
  return null;
}

/** Fetch for non-JSON bodies with `request()`'s error taxonomy; returns an `ok` Response. */
export async function rawFetch(url: string, signal?: AbortSignal): Promise<Response> {
  // The bytes budget: large payloads must not die for being large.
  const budget = withTimeout(signal, BYTES_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin", signal: budget.signal });
  } catch {
    if (budget.timedOut()) throw new ApiError("TIMEOUT", TIMEOUT_MESSAGE, 0);
    throw new ApiError("NETWORK", "Can't reach the server. Check your connection and try again.", 0);
  } finally {
    // Cleared once the response lands; the caller reads the body itself.
    budget.done();
  }
  const err = statusError(res.status);
  if (err) throw err;
  if (!res.ok) throw new ApiError("SERVER", "The server returned an unexpected response.", res.status);
  return res;
}
