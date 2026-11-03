// Helpers shared by the httpApi tests.

import { it, vi } from "vitest";
import type { Listing, NoteMeta, PageRef } from "../../src/core/types";

// The browse `Api` with a stubbed `fetch`: raw JSON, binary pages, `ApiError`.

export function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch stub that records the URLs it was called with. */
export function recordingFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
