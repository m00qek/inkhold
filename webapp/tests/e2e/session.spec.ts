import { test, expect } from "@playwright/test";
import { mockApi } from "./helpers/mockApi";

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

  // `?real` swaps in the HTTP client: the fake `Api` cannot express an expired cookie.
  test("a session that expires while the library is open routes back to login", async ({ page }) => {
    await mockApi(page, {
      "user/me": { json: { success: true, email: "ana@household.lan", isAdmin: false, mustChangePassword: false } },
      "controlplane/tree": { status: 401, json: { success: false } },
    });

    await page.goto("/?real");

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

    // `exact`: "Sign out everywhere" also matches as a substring.
    await page.getByRole("button", { name: "Your account" }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });
});
