import { test, expect } from "@playwright/test";
import { signedIn, freezeMotion } from "./helpers/app";

// The MULTI-VIEWER seam. A file's type decides which viewer opens it: `.note`,
// images and every unrecognised kind stay in the reader (files.spec.ts owns those
// outcomes); a `.spd` and a `.txt` route to their own viewer modules. Those
// modules are STUBS today — a placeholder plus the shared toolbar — so what is
// proved here is the SEAM, not the render: the dispatch reaches the right module,
// only one viewer is ever visible, the topbar hides, and the universal toolbar
// actions (Back, Move to bin) work in a non-reader viewer before any tiles land.
//
// The `Files` fixture folder carries one of each: `n-files-sketch` is a `.spd`,
// `n-files-readme` a `.txt`. Only the `.spd` STUB is exercised here now — the
// `.txt` viewer is REAL (it fetches and lays out text), so its render, font-size
// control and universal actions live in `txtViewer.spec.ts`.

const CASES = [
  { kind: ".spd", id: "n-files-sketch", region: "Sketch viewer", cls: ".viewer--spd", mark: "SPD", name: "Kitchen sketch" },
] as const;

for (const c of CASES) {
  test.describe(`${c.kind} viewer (stub)`, () => {
    test("routes to its own viewer, shows the placeholder, and hides the topbar", async ({ page }) => {
      await signedIn(page);
      await page.goto(`/#/note/${c.id}`);
      await freezeMotion(page);

      const region = page.getByRole("region", { name: c.region });
      await expect(region).toBeVisible();
      // The placeholder — where the real render lands — names the file and the type.
      const placeholder = region.locator(".viewer__placeholder");
      await expect(placeholder).toContainText(c.name);
      await expect(placeholder.locator(".viewer__mark")).toHaveText(c.mark);

      // Reading is a mode: the library topbar (its search box) leaves, exactly as
      // for the reader.
      await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeHidden();
      // …and the reader is NOT the thing on screen.
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
      // QUIET, NEVER RED — trashing is recoverable.
      await expect(moveBin).not.toHaveClass(/is-danger/);

      await moveBin.click();

      // The SAME undo toast the reader and the library card raise — one trash path,
      // not a second: "Moved …", the U6 device line, and an Undo control.
      const toast = page.locator(".bin-toast");
      await expect(toast).toContainText("Moved");
      await expect(toast).toContainText("Also comes off your Supernote at the next sync.");
      await expect(toast.locator(".bin-toast__action")).toHaveText("Undo");

      // The file now lives in the bin, so the viewer leaves and the library is back.
      await expect(page.getByRole("region", { name: c.region })).toBeHidden();
      await expect(page.locator(".gallery")).toBeVisible();
    });
  });
}

test("switching viewers (note → .spd → note) hides the prior each time", async ({ page }) => {
  await signedIn(page);

  // A real .note: the reader.
  await page.goto("/#/note/n-doc-attn");
  await expect(page.locator(".reader.is-open")).toBeVisible();

  // In-app hash change (no reload), so this exercises the shell's `activate` — not
  // a fresh boot. The .spd viewer comes up and the reader is gone: not two overlays.
  await page.evaluate(() => {
    window.location.hash = "#/note/n-files-sketch";
  });
  await expect(page.locator(".viewer--spd")).toBeVisible();
  await expect(page.locator(".reader.is-open")).toBeHidden();

  // Back to a note: the reader returns and the .spd viewer is hidden again.
  await page.evaluate(() => {
    window.location.hash = "#/note/n-doc-attn";
  });
  await expect(page.locator(".reader.is-open")).toBeVisible();
  await expect(page.locator(".viewer--spd")).toBeHidden();
});
