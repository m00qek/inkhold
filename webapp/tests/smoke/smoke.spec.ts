import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { cardButton, inkFraction } from "../e2e/helpers/app";

// The shipped pieces, together and unmocked: the server signs the first admin
// in, the browser app uploads a real notebook, and the wasm decoder paints it.
test.describe.configure({ mode: "serial" });

const NOTEBOOK = readFileSync(new URL("../../../parsers/note/tests/fixtures/sample.note", import.meta.url));
const PASSWORD = "smoke-test-password";

test("first sign-in: the temporary password, then one's own", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Account").fill("admin@home.lan");
  await page.getByLabel(/password/i).fill(process.env.SMOKE_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "Choose your password" })).toBeVisible();
  await page.getByLabel("New password").fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Save and continue" }).click();

  // The first run's last step: the address to type on the tablet.
  await expect(page.getByRole("heading", { name: "Connect your Supernote" })).toBeVisible();
  await page.getByRole("button", { name: "I'll connect it later" }).click();
  await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
});

test("upload a notebook and read its page", async ({ page }) => {
  await signIn(page);
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Upload a file to this folder" }).click(),
  ]);
  await chooser.setFiles([{ name: "Smoke.note", mimeType: "application/octet-stream", buffer: NOTEBOOK }]);
  await expect(cardButton(page, "Smoke.note")).toBeVisible();

  await cardButton(page, "Smoke.note").click();
  await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
  // A layered page is a stack of canvases, one per layer: the ink is on one.
  const canvases = page.locator(".page canvas:visible");
  const mostInked = async () => Math.max(0, ...(await Promise.all((await canvases.all()).map(inkFraction))));
  await expect.poll(mostInked, { timeout: 15_000 }).toBeGreaterThan(0.001);
});

test("sign out", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Your account" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Account").fill("admin@home.lan");
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
}
