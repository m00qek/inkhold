// The two HTTP calls sync makes, behind one interface so everything above
// them is testable without a network.
//
// Not in `api/client.ts` because every wrapper there returns a parsed answer
// and throws on non-2xx, and both statuses that MATTER here — the manifest's
// 304 and the stream's 412 — are control flow. What is reused is
// `bytesBudget`: a total-duration cap cannot tell a stall at 5% from a slow
// success, and the whole library over 3G is a slow success.
//
// What this must not break:
//   * `stream()` hands back DECODED TEXT CHUNKS, never the `Response` — the
//     progressive property (first document usable at 8 ms of a 193 ms stream,
//     §3.2) dies the moment `await res.text()` is the obvious next line.
//   * `Content-Encoding: gzip` is inflated by the browser; nothing here
//     decompresses.
//   * The ETag is QUOTED on `if-none-match` and BARE in `m=` — see
//     `entityTagValue`.

import { bytesBudget } from "../api/client";
import { textChunks } from "./termsStream";

const MANIFEST_URL = "/api/controlplane/search-index/manifest";
const STREAM_URL = "/api/controlplane/search-index/stream";

/** A manifest fetch. 200 carries a body; 304 says the one you hold is current. */
export interface ManifestAnswer {
  readonly status: number;
  /** The BARE hex validator, unquoted — what `m=` carries. The server sends it
   *  on the 304 as well as the 200: a validator the client is not re-told is
   *  one it may drop. */
  readonly etag: string | null;
  readonly body: Uint8Array | null;
}

/** A stream fetch. 200 carries chunks; 412 means the manifest moved. */
export interface StreamAnswer {
  readonly status: number;
  readonly chunks: AsyncIterable<string> | null;
}

export interface IndexTransport {
  manifest(ifNoneMatch: string | null, signal?: AbortSignal): Promise<ManifestAnswer>;
  stream(m: string, want: string, signal?: AbortSignal): Promise<StreamAnswer>;
}

/**
 * The bare value inside an entity tag: `W/"abc"` and `"abc"` both give `abc`.
 *
 * The server mints one spelling — a quoted 32-hex string — and compares
 * `if-none-match` for BYTE equality, so the quotes must survive on that
 * header; `m=` on the stream request takes the bare hex. Getting this
 * backwards is a permanent 412 loop with no other symptom.
 */
export function entityTagValue(header: string | null): string | null {
  if (!header) return null;
  const trimmed = header.startsWith("W/") ? header.slice(2) : header;
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed.length > 0 ? trimmed : null;
}

/** The real transport. Cookie-authenticated like every other control-plane call. */
export function httpTransport(): IndexTransport {
  return {
    async manifest(ifNoneMatch, signal) {
      const budget = bytesBudget(signal);
      try {
        const res = await fetch(MANIFEST_URL, {
          credentials: "same-origin",
          headers: ifNoneMatch ? { "if-none-match": `"${ifNoneMatch}"` } : undefined,
          signal: budget.signal,
        });
        const etag = entityTagValue(res.headers.get("etag"));
        if (res.status !== 200) return { status: res.status, etag, body: null };
        return { status: 200, etag, body: new Uint8Array(await res.arrayBuffer()) };
      } finally {
        budget.done();
      }
    },

    async stream(m, want, signal) {
      // `want` is base64url already, but the ETag is the server's to choose, so
      // both go through `URLSearchParams`.
      const params = new URLSearchParams({ m, want });
      const budget = bytesBudget(signal);
      // NOT in a `finally`: the budget covers the whole DOWNLOAD, which is the
      // part that can stall. `chunks` closes it.
      let res: Response;
      try {
        res = await fetch(`${STREAM_URL}?${params.toString()}`, {
          credentials: "same-origin",
          signal: budget.signal,
        });
      } catch (err) {
        budget.done();
        throw err;
      }
      if (res.status !== 200 || !res.body) {
        budget.done();
        return { status: res.status, chunks: null };
      }
      const body = res.body;
      return {
        status: 200,
        chunks: (async function* () {
          try {
            yield* textChunks(body);
          } finally {
            budget.done();
          }
        })(),
      };
    },
  };
}
