// The two HTTP calls sync makes, behind one interface so everything above them
// is testable without a network — and so the one call that must NOT be read
// whole is not accidentally read whole.
//
// ## Why this is not in `api/client.ts`
//
// Every wrapper there returns a parsed answer, which is exactly what these two
// cannot be:
//
//   * `request()` normalizes an envelope, JSON-decodes the body, and turns any
//     non-2xx into a thrown `ApiError`. Both statuses that MATTER here — the
//     manifest's 304 and the stream's 412 — are normal control flow, not
//     failures, and the manifest's body is bytes rather than JSON.
//   * `rawFetch()` is closer (bytes, the right timeout budget) but throws on
//     anything that is not `ok`, so it cannot express either of them, and it
//     hands back a `Response` whose statuses a caller would then re-interpret.
//
// What is reused is the one thing worth reusing: `bytesBudget`, the BYTES
// timeout. Its comment is the reason — a total-duration cap cannot tell a stall
// at 5% from a slow success, and the whole library over a 3G link is a slow
// success. It only rules out the infinite case, which is the case that would
// otherwise leave a sync pending for ever.
//
// ## The stream body is never buffered
//
// `stream()` hands back the DECODED TEXT CHUNKS, not the response — the
// progressive property (§3.2: first document usable at 8 ms of a 193 ms stream)
// is a property of what the consumer is given, and giving it a `Response` would
// make `await res.text()` the obvious thing to do next.
//
// `Content-Encoding: gzip` is inflated by the browser before `response.body`
// yields anything, so nothing here decompresses. `DecompressionStream` belongs
// to §3.2's framed fallback, which is not the shape the server serves.

import { bytesBudget } from "../api/client";
import { textChunks } from "./termsStream";

const MANIFEST_URL = "/api/controlplane/search-index/manifest";
const STREAM_URL = "/api/controlplane/search-index/stream";

/** A manifest fetch. 200 carries a body; 304 says the one you hold is current. */
export interface ManifestAnswer {
  readonly status: number;
  /**
   * The BARE hex validator, unquoted — what `m=` carries on the stream request.
   * The server sends it on the 304 as well as the 200, deliberately: a validator
   * the client is not re-told is one it may drop.
   */
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
 * The server mints exactly one spelling — a quoted 32-hex string — and compares
 * `if-none-match` for BYTE equality, so the quotes have to survive the round
 * trip on that header. `m=`, on the stream request, is the opposite: the bare
 * hex, because a quoted string in a query string needs percent-encoding and buys
 * nothing. Getting this backwards produces a permanent 412 loop and no other
 * symptom, which is why it is one exported function and not two inline slices.
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
      // `want` is already base64url from `encodeWant` — no `+`, `/` or `=` in
      // it — but the ETag is the server's to choose, so both go through
      // `URLSearchParams` rather than being pasted in.
      const params = new URLSearchParams({ m, want });
      const budget = bytesBudget(signal);
      // NOT in a `finally`: the budget covers the whole DOWNLOAD, not just the
      // head, and the download is the part that can stall. `chunks` closes it.
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
