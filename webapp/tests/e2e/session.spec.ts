import { test, expect } from "@playwright/test";
import { mockApi } from "./helpers/mockApi";

// On boot the shell can't read the HttpOnly cookie, so it asks `/api/user/me`
// whether there's a session. These drive that boot guard by scripting `/me`.
test.describe("session restore on load", () => {
  test("a valid /me profile lands on home (not login)", async ({ page }) => {
    await mockApi(page, {
      "user/me": { json: { success: true, email: "ana@household.lan", isAdmin: false, mustChangePassword: false } },
    });

    await page.goto("/");

    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
  });

  test("a pending /me profile lands on change-password", async ({ page }) => {
    await mockApi(page, {
      "user/me": { json: { success: true, email: "ana@household.lan", isAdmin: false, mustChangePassword: true } },
    });

    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Choose your password" })).toBeVisible();
  });

  test("a 401 from /me falls back to login", async ({ page }) => {
    await mockApi(page, { "user/me": { status: 401, json: { success: false } } });

    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  // The other specs run the library against the in-memory fake `Api`, which can't
  // express an expired cookie. `?real` swaps in the HTTP client so the control-plane
  // call actually goes over the wire and can be 401'd — this is the only way to
  // exercise the main.ts wiring (shell -> onSessionExpired -> clear + route).
  test("a session that expires while the library is open routes back to login", async ({ page }) => {
    await mockApi(page, {
      "user/me": { json: { success: true, email: "ana@household.lan", isAdmin: false, mustChangePassword: false } },
      "controlplane/tree": { status: 401, json: { success: false } },
    });

    await page.goto("/?real");

    // Not merely "the gallery is empty" — the shell is gone and login is up.
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page).toHaveURL(/#\/login$/);
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toHaveCount(0);
  });

  test("sign out from home returns to login", async ({ page }) => {
    await mockApi(page, {
      "user/me": { json: { success: true, email: "ana@household.lan", isAdmin: false, mustChangePassword: false } },
      "user/logout": { json: { success: true } },
    });

    await page.goto("/");
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();

    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });
});
