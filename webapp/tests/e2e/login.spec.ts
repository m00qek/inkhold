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

    // Step 3 — connect the device. The sync-wait never resolves under the fake
    // live channel, so "Open the library" stays disabled and the way on is the
    // always-available skip.
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
    // Still on the login page (no navigation happened).
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
    // The button re-enables so the user can retry.
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  // The phone's situation. Playwright drives Chromium on localhost, which *is* a
  // secure context, so an ordinary login here can never reproduce the bug — we
  // have to take `crypto.subtle` away to emulate `http://<lan-ip>:8090`.
  //
  // Asserting only "login succeeds" would be too weak: the mock accepts any
  // body. So we also pin the challenge the client puts on the wire against an
  // independently computed `sha256_hex(md5_hex(pw) + randomCode)`.
  test("logs in over an insecure context, with crypto.subtle unavailable", async ({ page }) => {
    // Emulate an insecure context: `crypto` exists, but `subtle` does not.
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
