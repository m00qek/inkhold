import { test, expect } from "@playwright/test";
import { signedIn, freezeMotion } from "./helpers/app";

// Proves the type-to-viewer dispatch seam using the `.spd` stub (`174`); the `.txt`
// viewer has its own spec.

const CASES = [
  { kind: ".spd", id: "174", region: "Sketch viewer", cls: ".viewer--spd", mark: "SPD", name: "Kitchen sketch" },
] as const;

for (const c of CASES) {
  test.describe(`${c.kind} viewer (stub)`, () => {
    test("routes to its own viewer, shows the placeholder, and hides the topbar", async ({ page }) => {
      await signedIn(page);
      await page.goto(`/#/note/${c.id}`);
      await freezeMotion(page);

      const region = page.getByRole("region", { name: c.region });
      await expect(region).toBeVisible();
      const placeholder = region.locator(".viewer__placeholder");
      await expect(placeholder).toContainText(c.name);
      await expect(placeholder.locator(".viewer__mark")).toHaveText(c.mark);

      await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeHidden();
      await expect(page.locator(".reader.is-open")).toBeHidden();
    });

    test("Back returns to the library", async ({ page }) => {
      await signedIn(page);
      await page.goto(`/#/note/${c.id}`);
      await freezeMotion(page);
      await expect(page.getByRole("region", { name: c.region })).toBeVisible();

      await page.locator(c.cls).getByRole("button", { name: "Library" }).click();

      await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
      await expect(page.getByRole("region", { name: c.region })).toBeHidden();
    });

    test("Move to bin trashes the file, offers the undo with the device line, and leaves", async ({ page }) => {
      await signedIn(page);
      await page.goto(`/#/note/${c.id}`);
      await freezeMotion(page);

      const moveBin = page.locator(c.cls).getByRole("button", { name: "Move to bin" });
      await expect(moveBin).toBeVisible();
      await expect(moveBin).not.toHaveClass(/is-danger/);

      await moveBin.click();

      const toast = page.locator(".bin-toast");
      await expect(toast).toContainText("Moved");
      await expect(toast).toContainText("Also comes off your Supernote at the next sync.");
      await expect(toast.locator(".bin-toast__action")).toHaveText("Undo");

      await expect(page.getByRole("region", { name: c.region })).toBeHidden();
      await expect(page.locator(".gallery")).toBeVisible();
    });
  });
}

test("switching viewers (note → .spd → note) hides the prior each time", async ({ page }) => {
  await signedIn(page);

  await page.goto("/#/note/141");
  await expect(page.locator(".reader.is-open")).toBeVisible();

  // In-app hash change (no reload), so this exercises the shell's `activate`.
  await page.evaluate(() => {
    window.location.hash = "#/note/174";
  });
  await expect(page.locator(".viewer--spd")).toBeVisible();
  await expect(page.locator(".reader.is-open")).toBeHidden();

  await page.evaluate(() => {
    window.location.hash = "#/note/141";
  });
  await expect(page.locator(".reader.is-open")).toBeVisible();
  await expect(page.locator(".viewer--spd")).toBeHidden();
});
