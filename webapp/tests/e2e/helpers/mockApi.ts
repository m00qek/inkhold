import type { Page } from "@playwright/test";

// Scenario-scoped backend mock. Each test declares only the responses for the
// state it drives. Because the real session lives in an HttpOnly cookie we can't
// touch from a mock, "who is logged in" is expressed purely by what the scenario
// returns — most importantly the `/api/user/me` response the shell reads on boot.

export interface MockResponse {
  /** HTTP status. Defaults to 200. */
  status?: number;
  /** JSON body. Defaults to `{ success: true }`. */
  json?: unknown;
  /** Extra response headers, e.g. `{ "Retry-After": "30" }`. */
  headers?: Record<string, string>;
  /** Simulate a network failure instead of responding. */
  abort?: boolean;
}

/** Keyed by a URL substring (e.g. "login/new", "user/me"); first match wins. */
export type Scenario = Record<string, MockResponse>;

/** A fixed challenge code so the client's hashing is deterministic under test. */
export const RANDOM_CODE = "0011aabb2233ccdd";

export const okRandomCode: MockResponse = {
  json: { success: true, randomCode: RANDOM_CODE, timestamp: 1_700_000_000_000 },
};

/**
 * Installs route handlers for backend calls from a scenario map. Matches only
 * requests whose path starts at the root `/api/` — a glob like `**​/api/**` would
 * also swallow the app's own ES modules under `/src/api/` (client.ts, md5.ts…)
 * and break module loading, so we match on the URL pathname instead.
 */
export async function mockApi(page: Page, scenario: Scenario): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const url = route.request().url();
      for (const [fragment, spec] of Object.entries(scenario)) {
        if (!url.includes(fragment)) continue;
        if (spec.abort) {
          await route.abort("failed");
          return;
        }
        await route.fulfill({
          status: spec.status ?? 200,
          contentType: "application/json",
          headers: spec.headers,
          body: JSON.stringify(spec.json ?? { success: true }),
        });
        return;
      }
      // Unmatched /api call: succeed blandly so a stray request never hangs a
      // test — but LOG it, so a scenario missing a mock shows up in test output
      // instead of being silently masked by this bland 200 (Bug #9).
      console.warn(`[mockApi] unmatched ${route.request().method()} ${url}`);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    },
  );
}
