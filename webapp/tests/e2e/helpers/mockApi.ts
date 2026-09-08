import type { Page, Route } from "@playwright/test";

// Scenario-scoped backend mock. Each test declares only the responses for the
// state it drives. Because the real session lives in an HttpOnly cookie we can't
// touch from a mock, "who is logged in" is expressed purely by what the scenario
// returns — most importantly the `/api/user/me` response the shell reads on boot.
//
// HERMETIC BY CONSTRUCTION. This installs the LAST-RESORT handler for EVERY path
// the backend owns, not just `/api/` — see `isBackendPath`. That is not tidiness:
// `vite.config.ts` proxies `^/note/` to a real server on :8089, so before this
// widening every `GET /note/{id}/page/{n}?v=` escaped the mock and was answered
// by whatever backend a developer happened to have running, against a completely
// different database. A test's outcome must not depend on that. (Measured: with
// a server up, five `slowLink` tests failed even at `--workers=1` — its 401s
// reached the app as UNAUTHORIZED; with :8089 down the same suite was green.)
//
// The non-proxied byte routes were worse, not better. `/file/{id}` and
// `/thumbnail/{hash}` are not in the proxy table, so they fell through to Vite's
// SPA fallback, which happily answered **200 text/html — index.html, 1341 bytes**
// to a decoder expecting PNG or `.note` bytes. Verified against the dev server.
// Both are now intercepted here too.

export interface MockResponse {
  /** HTTP status. Defaults to 200. */
  status?: number;
  /** JSON body. Defaults to `{ success: true }`. */
  json?: unknown;
  /**
   * A RAW body, for the byte routes (page payloads, raw files, thumbnails).
   * Takes precedence over `json`, and flips the default content type to
   * `application/octet-stream` — override with `contentType`. Most byte-route
   * specs still prefer their own `page.route` (they need per-id branching or a
   * hit tally); this is for the one-liner cases.
   */
  body?: string | Buffer;
  /** Response content type. Defaults per body kind — see `body`. */
  contentType?: string;
  /** Extra response headers, e.g. `{ "Retry-After": "30" }`. */
  headers?: Record<string, string>;
  /** Simulate a network failure instead of responding. */
  abort?: boolean;
  /**
   * Hold the response for this many ms before fulfilling. For asserting what the
   * UI paints WHILE a request is still in flight — the loading states that are
   * invisible on a fast link and obvious on a throttled one.
   */
  delayMs?: number;
}

/**
 * Keyed by a URL substring (e.g. "login/new", "user/me"); first match wins.
 *
 * A key may be PREFIXED WITH AN HTTP VERB — `"DELETE controlplane/bin"` — to
 * match on the method as well. That is not decoration: the recycle bin lists
 * itself with `GET /api/controlplane/bin` and empties itself with `DELETE` on
 * the very same URL, so a scenario that wants to hold the destructive call
 * cannot express itself by substring alone.
 */
export type Scenario = Record<string, MockResponse>;

/** Splits an optional `VERB ` prefix off a scenario key. */
const VERB_KEY = /^(GET|POST|PUT|PATCH|DELETE) (.+)$/;

/** A fixed challenge code so the client's hashing is deterministic under test. */
export const RANDOM_CODE = "0011aabb2233ccdd";

export const okRandomCode: MockResponse = {
  json: { success: true, randomCode: RANDOM_CODE, timestamp: 1_700_000_000_000 },
};

/**
 * Every path prefix the BACKEND owns — the complete escape-proof surface.
 *
 * Deliberately matched on the parsed `pathname` rather than a `**​/api/**` glob:
 * a glob would also swallow the app's own ES modules under `/src/api/`
 * (client.ts, md5.ts…) and break module loading.
 *
 * What is NOT here is exactly as load-bearing, because it must keep reaching
 * Vite: `/note-decode.wasm` and `/sqlite-core.wasm` (real modules the `.note` and
 * `.spd` decoders instantiate — `noteLayers.spec.ts` and `spdViewer.spec.ts` run
 * the genuine wasm), `/fonts/*.woff2` (self-hosted @font-face), `/src/**`,
 * `/@vite/**`, `/node_modules/**`, `/index.html` and `/` itself. Note the
 * TRAILING SLASH on `/note/`: that is what keeps `/note-decode.wasm` out — the
 * same distinction `vite.config.ts`'s `^/note/` proxy key makes.
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
 * The subset of backend paths that carry BYTES rather than JSON.
 *
 * These need their own unmatched default. Handing a decoder the JSON catch-all's
 * bland `{"success":true}` is the same class of bug as Vite handing it
 * index.html: it "succeeds", then fails somewhere far away with a message about
 * a bad SNPG header or an undecodable image. The full set, from `src/api/client.ts`:
 *
 *   `/note/{id}/page/{n}?v=`                                    page payload
 *   `/note/{id}/template/{hash}`                                custom template blob
 *   `/file/{id}?v=`                                             raw file bytes
 *   `/thumbnail/{hash}`                                         embedded preview / cover
 *   `/api/controlplane/bin/file/{id}?v=`                        the trashed raw twin
 *   `/api/controlplane/bin/note/{id}/page/{n}?v=`               trashed page payload
 *   `/api/controlplane/{bin/}note/{id}/history/{md5}/raw`       a retained version's blob
 *   `/api/controlplane/{bin/}note/{id}/history/{md5}/page/{n}`  a retained version's page
 *
 * The `/page/{n}/text` siblings are JSON (a `{ text, words }` VO) and stay on the
 * JSON default, as does `/api/controlplane/{bin/}file/metadata/{id}` — hence the
 * `\d+$` anchor and the `metadata/` lookahead.
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

/** Fulfils (or aborts, or holds) one route from a scenario entry. */
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
 * Installs the catch-all backend handler for a scenario map.
 *
 * ORDERING — and it matters. Playwright matches routes NEWEST-FIRST, and every
 * spec calls `mockApi` (usually via `signedIn`) BEFORE its own narrower
 * `page.route`s. That ordering is what lets this widen safely: `serveLayeredPages`
 * (slowLink), `mockRawFiles`/`mockThumbnailBackend` (helpers/app), `serveSpd`,
 * `mockTextFile`, `serveRawBytes` (bin) and `serveHistoryRaw` (history) all still
 * win over this handler on the paths they claim. This is the FLOOR, not a
 * ceiling. Verified across all 25 specs: there is no site where `mockApi` is
 * registered after a byte-route helper.
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
        // A BYTE route with no mock. Answering 200 + `{"success":true}` here
        // would hand a decoder a JSON body — the confusing failure this default
        // exists to prevent, and the same one Vite's SPA fallback used to cause
        // by answering index.html. So: fail honestly, and name the path loudly
        // enough that "this scenario is missing a mock" is the obvious reading.
        console.warn(`[mockApi] NO MOCK for byte route ${method} ${pathname} — answering 404`);
        await route.fulfill({
          status: 404,
          contentType: "text/plain",
          body: `[mockApi] no mock registered for ${pathname}`,
        });
        return;
      }

      // Unmatched /api call: succeed blandly so a stray request never hangs a
      // test — but LOG it, so a scenario missing a mock shows up in test output
      // instead of being silently masked by this bland 200 (Bug #9).
      console.warn(`[mockApi] unmatched ${method} ${url}`);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    },
  );
}
