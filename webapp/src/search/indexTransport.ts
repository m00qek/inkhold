// The two HTTP calls sync makes, behind one interface for tests. Not in
// `api/client.ts`: the manifest's 304 and the stream's 412 are control flow,
// not errors. `stream()` returns decoded chunks, never the `Response`, to keep
// parsing progressive.

import { bytesBudget } from "../api/client";
import { textChunks } from "./termsStream";

const MANIFEST_URL = "/api/controlplane/search-index/manifest";
const STREAM_URL = "/api/controlplane/search-index/stream";

export interface ManifestAnswer {
  readonly status: number;
  /** The bare hex validator (what `m=` carries); also sent on a 304. */
  readonly etag: string | null;
  readonly body: Uint8Array | null;
}

export interface StreamAnswer {
  readonly status: number;
  readonly chunks: AsyncIterable<string> | null;
}

export interface IndexTransport {
  manifest(ifNoneMatch: string | null, signal?: AbortSignal): Promise<ManifestAnswer>;
  stream(m: string, want: string, signal?: AbortSignal): Promise<StreamAnswer>;
}

/**
 * `W/"abc"` and `"abc"` both give `abc`. The server compares `if-none-match`
 * byte for byte, so it must be re-quoted there, while `m=` takes the bare hex.
 * Mixing them up is a silent permanent 412 loop.
 */
export function entityTagValue(header: string | null): string | null {
  if (!header) return null;
  const trimmed = header.startsWith("W/") ? header.slice(2) : header;
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed.length > 0 ? trimmed : null;
}

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
      const params = new URLSearchParams({ m, want });
      const budget = bytesBudget(signal);
      // Not in a `finally`: the budget covers the whole download; `chunks` closes it.
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
