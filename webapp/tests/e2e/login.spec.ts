import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mockApi, okRandomCode, RANDOM_CODE } from "./helpers/mockApi";

const ACCOUNT = "ana@household.lan";
const PASSWORD = "correct horse";

test.describe("login", () => {
  test("successful login (full session) routes to home", async ({ page }) => {
    await mockApi(page, {
      "query/random/code": okRandomCode,
      "account/login/new": { json: { success: true, mustChangePassword: false } },
    });

    await page.goto("/#/login");
    await page.getByLabel("Account").fill(ACCOUNT);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
  });

  test("first login: change password, then the connect step, then home", async ({ page }) => {
    await mockApi(page, {
      "query/random/code": okRandomCode,
      "account/login/new": { json: { success: true, mustChangePassword: true } },
      "user/password": { json: { success: true } },
    });

    await page.goto("/#/login");
    await page.getByLabel("Account").fill(ACCOUNT);
    await page.getByLabel("Password", { exact: true }).fill("temp-pass-123");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("heading", { name: "Choose your password" })).toBeVisible();

    await page.getByLabel("New password").fill("a-brand-new-password");
    await page.getByLabel("Confirm password").fill("a-brand-new-password");
    await page.getByRole("button", { name: "Save and continue" }).click();

    // The sync-wait never resolves under the fake live channel, so the way on is skip.
    await expect(page.getByRole("heading", { name: "Connect your Supernote" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open the library" })).toBeDisabled();
    await page.getByRole("button", { name: "I'll connect it later" }).click();

    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
  });

  test("wrong password shows an error and clears the password field", async ({ page }) => {
    await mockApi(page, {
      "query/random/code": okRandomCode,
      "account/login/new": { json: { success: false, errorCode: "INVALID_CREDENTIALS", errorMsg: "bad" } },
    });

    await page.goto("/#/login");
    await page.getByLabel("Account").fill(ACCOUNT);
    const password = page.getByLabel("Password", { exact: true });
    await password.fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("status")).toContainText("account and password don't match");
    await expect(password).toHaveValue("");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("rate limit shows a retry message with the wait time", async ({ page }) => {
    await mockApi(page, {
      "query/random/code": okRandomCode,
      "account/login/new": { json: { success: false }, status: 429, headers: { "Retry-After": "30" } },
    });

    await page.goto("/#/login");
    await page.getByLabel("Account").fill(ACCOUNT);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("status")).toContainText("Too many attempts");
    await expect(page.getByRole("status")).toContainText("30s");
  });

  test("network failure shows a graceful error", async ({ page }) => {
    await mockApi(page, { "query/random/code": { abort: true } });

    await page.goto("/#/login");
    await page.getByLabel("Account").fill(ACCOUNT);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("status")).toContainText("Can't reach the server");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  // Localhost is a secure context, so `crypto.subtle` is removed to emulate a LAN
  // http origin; the challenge is pinned because the mock accepts any body.
  test("logs in over an insecure context, with crypto.subtle unavailable", async ({ page }) => {
    await page.addInitScript(() => {
      const insecure = Object.create(Object.getPrototypeOf(window.crypto) as object) as Crypto;
      Object.defineProperty(insecure, "subtle", { value: undefined, configurable: true });
      Object.defineProperty(insecure, "getRandomValues", {
        value: (a: ArrayBufferView) => a,
        configurable: true,
      });
      Object.defineProperty(window, "crypto", { value: insecure, configurable: true });
    });

    await mockApi(page, {
      "query/random/code": okRandomCode,
      "account/login/new": { json: { success: true, mustChangePassword: false } },
    });

    let sentPassword: unknown;
    page.on("request", (req) => {
      if (!req.url().includes("account/login/new")) return;
      sentPassword = (JSON.parse(req.postData() ?? "{}") as { password?: string }).password;
    });

    await page.goto("/#/login");
    // Guard the guard: if `crypto.subtle` survived, this test proves nothing.
    expect(await page.evaluate(() => window.crypto.subtle)).toBeUndefined();

    await page.getByLabel("Account").fill(ACCOUNT);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();

    const expected = createHash("sha256")
      .update(createHash("md5").update(PASSWORD, "utf8").digest("hex") + RANDOM_CODE, "utf8")
      .digest("hex");
    expect(sentPassword).toBe(expected);
  });
});
