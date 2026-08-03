import { test, expect } from "@playwright/test";
import { mockApi } from "./helpers/mockApi";
import { recordText } from "./helpers/recordText";

// WHAT THE APP LOOKS LIKE WHEN IT CANNOT START.
//
// The boot guard asks `/api/user/me` before anything is mounted, so its failure
// is the one failure that has no screen to fall back to. It used to have no
// screen at all: the arm's promise was discarded at the `onRoute` seam, the
// rejection went unhandled, and `#app` stayed empty forever.
//
// Two failures arrive at that same call and MUST NOT land on the same screen:
//
//   no session      → `me()` answers null → `#/login`          (unchanged)
//   no server       → `me()` throws NETWORK → the failure state (new)
//
// Sending the second case to a login form would ask someone to type a password
// into a page that cannot check it. So every test here asserts BOTH: the screen
// that should be up, and — through `recordText`, not a sampled `toHaveCount(0)`
// — that the other one was never on screen at any point during boot.
//
// ── DOES THIS TEST HAVE TEETH? ───────────────────────────────────────────────
// Each was verified by breaking its fix and watching it fail:
//
//   blank page instead of a failure state  ← the try/catch in `onRoute`
//   Try again does not re-render the route ← `onRetry: () => renderRoute(route)`
//   an expired session lands on the sheet  ← `dispatchApiFailure` in `showRouteFailure`

const ME = { success: true, email: "ana@household.lan", isAdmin: false, mustChangePassword: false };

const UNREACHABLE = "Can't reach the server";

test.describe("cold boot with the backend unreachable", () => {
  test("shows the failure state — not a blank page, and not the login form", async ({ page }) => {
    await mockApi(page, { "user/me": { abort: true } });
    const painted = await recordText(page, "#app");

    await page.goto("/");

    // The blank page is what this replaces: something explains the situation…
    await expect(page.getByRole("heading", { name: UNREACHABLE })).toBeVisible();
    await expect(page.getByText(/isn't answering/)).toBeVisible();
    // …and offers the way forward.
    await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled();

    // NOT the login screen — recorded rather than sampled, so a login form that
    // flashed and was replaced still fails this.
    expect(await painted.everShowed("Sign in")).toBe(false);
    await expect(page).not.toHaveURL(/#\/login/);
  });

  test("Try again re-runs the route and recovers once the server is back", async ({ page }) => {
    let serverUp = false;
    let meHits = 0;

    // The catch-all first, then the narrower stateful route — Playwright matches
    // newest-first, so this one wins on `/api/user/me`.
    await mockApi(page, {});
    await page.route("**/api/user/me", async (route) => {
      meHits++;
      if (!serverUp) {
        await route.abort("failed");
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ME) });
    });

    await page.goto("/");
    await expect(page.getByRole("heading", { name: UNREACHABLE })).toBeVisible();
    expect(meHits).toBe(1);

    serverUp = true;
    await page.getByRole("button", { name: "Try again" }).click();

    // The DURABLE fact: the library is up. (A retry that did nothing would leave
    // the sheet on screen and this never resolves.)
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
    await expect(page.getByRole("heading", { name: UNREACHABLE })).toHaveCount(0);
    // And it recovered by ASKING AGAIN, not by some cached answer.
    expect(meHits).toBeGreaterThanOrEqual(2);
  });

  // THE SEAM, NOT THE BACKSTOP. The three tests above are also satisfied by the
  // `unhandledrejection` backstop in main.ts, which only acts on an EMPTY `#app`
  // — measured: with the `onRoute` catch removed they still pass. This one
  // cannot be: the login page is already on screen, so the backstop steps aside
  // by design and only the route seam can answer. Broken, it fails the way the
  // bug's whole family fails — the last screen stays up, saying something that
  // is no longer true, while the URL says somewhere else.
  test("navigating INTO the app with the server down explains itself, instead of leaving the last screen up", async ({
    page,
  }) => {
    await mockApi(page, { "user/me": { abort: true } });

    await page.goto("/#/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    await page.evaluate(() => {
      window.location.hash = "/";
    });

    await expect(page.getByRole("heading", { name: UNREACHABLE })).toBeVisible();
    // The login form is GONE: leaving it up would invite a password the server
    // could not check, on a screen whose URL no longer means login.
    await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
  });

  test("a failed retry keeps the page up and says so", async ({ page }) => {
    await mockApi(page, { "user/me": { abort: true } });

    await page.goto("/");
    await expect(page.getByRole("heading", { name: UNREACHABLE })).toBeVisible();

    await page.getByRole("button", { name: "Try again" }).click();

    await expect(page.getByRole("status")).toContainText("Still can't reach the server.");
    // Still the same screen, and still retryable — a failed retry is not a
    // dead end and does not replay the whole sheet to say the same thing.
    await expect(page.getByRole("heading", { name: UNREACHABLE })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled();
  });
});

test.describe("an expired session is a different failure", () => {
  test("a 401 from /me still goes to login, never to the unreachable state", async ({ page }) => {
    await mockApi(page, { "user/me": { status: 401, json: { success: false } } });
    const painted = await recordText(page, "#app");

    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page).toHaveURL(/#\/login$/);
    // The regression this guards: a boot failure handler that cannot tell "no
    // session" from "no server" would put the sheet here instead.
    expect(await painted.everShowed(UNREACHABLE)).toBe(false);
  });
});
