import { test, expect } from "@playwright/test";
import { mockApi } from "./helpers/mockApi";
import { recordText } from "./helpers/recordText";

// "No session" (`me()` null) must reach login; "no server" (`me()` throws) must
// reach the failure state, never a login form. `recordText` proves the other
// screen never appeared during boot.

const ME = { success: true, email: "ana@household.lan", isAdmin: false, mustChangePassword: false };

const UNREACHABLE = "Can't reach the server";

test.describe("cold boot with the backend unreachable", () => {
  test("shows the failure state — not a blank page, and not the login form", async ({ page }) => {
    await mockApi(page, { "user/me": { abort: true } });
    const painted = await recordText(page, "#app");

    await page.goto("/");

    await expect(page.getByRole("heading", { name: UNREACHABLE })).toBeVisible();
    await expect(page.getByText(/isn't answering/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled();

    // Recorded rather than sampled, so a login form that flashed still fails this.
    expect(await painted.everShowed("Sign in")).toBe(false);
    await expect(page).not.toHaveURL(/#\/login/);
  });

  test("Try again re-runs the route and recovers once the server is back", async ({ page }) => {
    let serverUp = false;
    let meHits = 0;

    // Playwright matches routes newest-first, so this one wins on `/api/user/me`.
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

    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
    await expect(page.getByRole("heading", { name: UNREACHABLE })).toHaveCount(0);
    expect(meHits).toBeGreaterThanOrEqual(2);
  });

  // The tests above also pass via the `unhandledrejection` backstop in main.ts; this
  // one cannot, because login is already on screen, so only the route seam answers.
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
    await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
  });

  test("a failed retry keeps the page up and says so", async ({ page }) => {
    await mockApi(page, { "user/me": { abort: true } });

    await page.goto("/");
    await expect(page.getByRole("heading", { name: UNREACHABLE })).toBeVisible();

    await page.getByRole("button", { name: "Try again" }).click();

    await expect(page.getByRole("status")).toContainText("Still can't reach the server.");
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
    expect(await painted.everShowed(UNREACHABLE)).toBe(false);
  });
});
