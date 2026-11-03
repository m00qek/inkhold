import type { Page, Route } from "@playwright/test";

// Scenario-scoped backend mock; "who is logged in" is whatever `/api/user/me` returns.
// It catches every backend path, not just `/api/`: Vite proxies `^/note/` to a real
// server on :8089, and its SPA fallback answers `/file/` and `/thumbnail/` with index.html.

export interface MockResponse {
  /** HTTP status. Defaults to 200. */
  status?: number;
  /** JSON body. Defaults to `{ success: true }`. */
  json?: unknown;
  /** A raw body for byte routes; wins over `json` and defaults to octet-stream. */
  body?: string | Buffer;
  /** Response content type. Defaults per body kind — see `body`. */
  contentType?: string;
  /** Extra response headers, e.g. `{ "Retry-After": "30" }`. */
  headers?: Record<string, string>;
  /** Simulate a network failure instead of responding. */
  abort?: boolean;
  /** Hold the response this many ms, to observe in-flight loading states. */
  delayMs?: number;
}

/**
 * Keyed by URL substring; first match wins. An optional verb prefix
 * (`"DELETE controlplane/bin"`) matches the method too, for routes that share a URL.
 */
export type Scenario = Record<string, MockResponse>;

const VERB_KEY = /^(GET|POST|PUT|PATCH|DELETE) (.+)$/;

/** A fixed challenge code so the client's hashing is deterministic under test. */
export const RANDOM_CODE = "0011aabb2233ccdd";

export const okRandomCode: MockResponse = {
  json: { success: true, randomCode: RANDOM_CODE, timestamp: 1_700_000_000_000 },
};

/**
 * Matched on `pathname`, not a glob, so `/src/api/` modules still load. The trailing
 * slash on `/note/` keeps `/note-decode.wasm` reaching Vite.
 */
function isBackendPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/note/") ||
    pathname.startsWith("/file/") ||
    pathname.startsWith("/thumbnail/")
  );
}

/**
 * Byte routes get their own unmatched default: a JSON body would fail far away in a decoder.
 * The `/page/{n}/text` and `file/metadata/` siblings are JSON, hence the anchors.
 */
const BYTE_ROUTES: readonly RegExp[] = [
  /^\/file\//,
  /^\/thumbnail\//,
  /^\/api\/controlplane\/(?:bin\/)?file\/(?!metadata\/)/,
  /\/page\/\d+$/,
  /\/template\/[^/]+$/,
  /\/history\/[^/]+\/raw$/,
];

function isByteRoute(pathname: string): boolean {
  return BYTE_ROUTES.some((re) => re.test(pathname));
}

async function fulfillFrom(route: Route, spec: MockResponse): Promise<void> {
  if (spec.abort) {
    await route.abort("failed");
    return;
  }
  if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
  if (spec.body !== undefined) {
    await route.fulfill({
      status: spec.status ?? 200,
      contentType: spec.contentType ?? "application/octet-stream",
      headers: spec.headers,
      body: spec.body,
    });
    return;
  }
  await route.fulfill({
    status: spec.status ?? 200,
    contentType: spec.contentType ?? "application/json",
    headers: spec.headers,
    body: JSON.stringify(spec.json ?? { success: true }),
  });
}

/**
 * Playwright matches newest-first, and specs call this before their narrower
 * `page.route`s, so this is the floor they override.
 */
export async function mockApi(page: Page, scenario: Scenario): Promise<void> {
  await page.route(
    (url) => isBackendPath(url.pathname),
    async (route) => {
      const url = route.request().url();
      const method = route.request().method();
      for (const [pattern, spec] of Object.entries(scenario)) {
        const verb = VERB_KEY.exec(pattern);
        const fragment = verb ? verb[2]! : pattern;
        if (verb && method !== verb[1]) continue;
        if (!url.includes(fragment)) continue;
        await fulfillFrom(route, spec);
        return;
      }

      const pathname = new URL(url).pathname;
      if (isByteRoute(pathname)) {
        // Fail an unmocked byte route loudly rather than hand a decoder JSON.
        console.warn(`[mockApi] NO MOCK for byte route ${method} ${pathname} — answering 404`);
        await route.fulfill({
          status: 404,
          contentType: "text/plain",
          body: `[mockApi] no mock registered for ${pathname}`,
        });
        return;
      }

      // Unmatched /api call: succeed so it never hangs, but log it.
      console.warn(`[mockApi] unmatched ${method} ${url}`);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    },
  );
}
