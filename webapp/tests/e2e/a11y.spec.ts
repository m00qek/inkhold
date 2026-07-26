import { test, expect } from "@playwright/test";
import { mockApi, okRandomCode } from "./helpers/mockApi";
import { signedIn } from "./helpers/app";

// Light accessibility assertions with plain locators (no axe). Covers focus
// management and that the status region is a live region screen readers announce.
test.describe("accessibility", () => {
  test("focus lands on the account field on load", async ({ page }) => {
    await mockApi(page, { "query/random/code": okRandomCode });
    await page.goto("/#/login");

    await expect(page.getByLabel("Account")).toBeFocused();
  });

  test("the status region is an aria-live region", async ({ page }) => {
    await mockApi(page, { "query/random/code": okRandomCode });
    await page.goto("/#/login");

    const status = page.getByRole("status");
    await expect(status).toHaveAttribute("aria-live");
  });

  test("on a failed login the error is announced and focus returns to the password", async ({ page }) => {
    await mockApi(page, {
      "query/random/code": okRandomCode,
      "account/login/new": { json: { success: false, errorCode: "INVALID_CREDENTIALS", errorMsg: "bad" } },
    });

    await page.goto("/#/login");
    await page.getByLabel("Account").fill("ana@household.lan");
    const password = page.getByLabel("Password", { exact: true });
    await password.fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    // The live region carries the error, and focus moves to the field to fix.
    await expect(page.getByRole("status")).toHaveText(/don't match/);
    await expect(password).toBeFocused();
  });

  test("each field has an associated label", async ({ page }) => {
    await mockApi(page, { "query/random/code": okRandomCode });
    await page.goto("/#/login");

    // getByLabel only resolves when the label is correctly associated.
    await expect(page.getByLabel("Account")).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  });
});

test.describe("accessibility — library & reader", () => {
  test("the library's landmarks and controls carry accessible names", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");

    await expect(page.getByRole("navigation", { name: "Folders" })).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Toggle light or dark" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  test("the reader exposes a named region and labelled pager controls", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/n-doc-attn");

    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Previous page" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Next page" })).toBeVisible();
    // The Back control returns focus into the app on open (keyboard entry point).
    await expect(page.getByRole("button", { name: "Library" })).toBeFocused();
  });
});
