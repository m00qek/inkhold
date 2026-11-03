// Annotation history, opened from the PDF viewer.

import { test, expect, type Locator, type Page } from "@playwright/test";
import { signedIn, freezeMotion } from "./helpers/app";

// Drives the real MuPDF wasm in a browser. The raw-file fetch is a real request, so
// routes serve fixture bytes as the server would.
import { servePdf, inkFraction, openMarkedPdf } from "./pdfViewer.shared";

const vh = (page: Page): Locator => page.locator(".vh");

const vhRows = (page: Page): Locator => page.locator(".vh-row");

test.describe("annotation history, from the PDF viewer", () => {
  test("the control is PRESENT and dimmed on a document with no annotations", async ({ page }) => {
    // 142 has no `.mark`: the control is present and dimmed, with the reason in its name.
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/142");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    const btn = region.getByRole("button", {
      name: "Annotation history — this document has no annotations",
    });
    await expect(btn).toHaveCount(1);
    await expect(btn).toBeVisible();
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveAttribute(
      "title",
      "Annotation history — this document has no annotations",
    );
    await expect(region.getByRole("button", { name: "Annotation history", exact: true })).toHaveCount(0);
  });

  test("the control is enabled on a document that HAS annotations, and lists the mark's versions", async ({
    page,
  }) => {
    const region = await openMarkedPdf(page, false);
    const btn = region.getByRole("button", { name: "Annotation history", exact: true });
    await expect(btn).toBeEnabled({ timeout: 20_000 });

    await btn.click();
    await expect(vh(page)).toBeVisible();

    await expect(vh(page).locator(".vh__eyebrow")).toHaveText("Annotation history", { timeout: 20_000 });
    await expect(vh(page).locator(".vh__caption")).toContainText("only the annotations");

    await expect(vhRows(page)).toHaveCount(3, { timeout: 20_000 });
    await expect(vhRows(page).nth(0).locator(".tag-current")).toHaveText("Current");
    // Headed by the document's name, not `Appliance manual.pdf.mark`.
    await expect(vh(page)).toHaveAttribute("aria-label", /Appliance manual/);
    await expect(vh(page)).toHaveAttribute("aria-label", /^Annotation history/);
  });

  test("previewing a version banners the ANNOTATIONS as old and the document as current", async ({
    page,
  }) => {
    const region = await openMarkedPdf(page, false);
    await region.getByRole("button", { name: "Annotation history", exact: true }).click();
    await expect(vh(page)).toBeVisible();
    await expect(vhRows(page)).toHaveCount(3, { timeout: 20_000 });
    await vhRows(page).nth(1).click();
    await expect(vh(page)).toBeHidden();

    await expect(region).toBeVisible();
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    const banner = region.locator(".version-banner");
    await expect(banner).toBeVisible();
    // The banner's default ends "this is not the current note", false here.
    await expect(banner).toContainText("the annotations from");
    await expect(banner).toContainText("the document itself is current");
    await expect(banner).not.toContainText("not the current note");
    await expect(banner.getByRole("button", { name: "Restore this version" })).toBeVisible();

    await expect(region.getByRole("button", { name: "Move to bin" })).toBeHidden();

    // The popover dismisses on scroll, which late raster and ink placement cause, so the
    // loop reopens it rather than racing a repaint.
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await expect
      .poll(
        async () => {
          if ((await vh(page).count()) === 0) {
            await region.getByRole("button", { name: "Annotation history", exact: true }).click();
          }
          // One atomic read, so a scroll cannot shut the panel between assertions.
          return page.evaluate(() => {
            const all = Array.from(document.querySelectorAll(".vh-row"));
            const at = all.findIndex((r) => r.classList.contains("is-viewing"));
            const marks = document.querySelectorAll(".vh-row.is-viewing .mark-viewing").length;
            return marks === 1 ? at : -1;
          });
        },
        { timeout: 20_000 },
      )
      .toBe(1);
  });

  test("Restore restores the ANNOTATIONS and lands back on the document", async ({ page }) => {
    const region = await openMarkedPdf(page, false);
    await region.getByRole("button", { name: "Annotation history", exact: true }).click();
    await expect(vhRows(page)).toHaveCount(3, { timeout: 20_000 });
    await vhRows(page).nth(1).click();
    const banner = region.locator(".version-banner");
    await expect(banner).toBeVisible();

    await banner.getByRole("button", { name: "Restore this version" }).click();
    const confirm = page.locator("dialog.confirm");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Restore this version" }).click();

    await expect(page.locator(".toast")).toContainText("kept in this file's history");

    // Restores route back to the document, not to the `.mark`.
    await expect(page).toHaveURL(/#\/note\/178/);
    await expect(region).toBeVisible();
    await expect(banner).toBeHidden();
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    await region.getByRole("button", { name: "Annotation history", exact: true }).click();
    await expect(vhRows(page).nth(0).locator(".tag-current")).toHaveText("Current", { timeout: 20_000 });
  });
});
