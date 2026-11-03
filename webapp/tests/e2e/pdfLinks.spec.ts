// PDF links and the outline panel.

import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signedIn, freezeMotion } from "./helpers/app";

// Drives the real MuPDF wasm in a browser. The raw-file fetch is a real request, so
// routes serve fixture bytes as the server would.
import { servePdf, inkFraction } from "./pdfViewer.shared";

/**
 * Six pages, outline three levels deep: Part One (p0) / Chapter A (p1) / Chapter B (p2) /
 * Part Two (p3) / Chapter C (p4) / Section C.1 (p5). `two-page.pdf` is the no-outline case.
 */
const OUTLINED_PDF_BYTES = readFileSync(
  fileURLToPath(new URL("../../wasm/tests/fixtures/outlined-six-page.pdf", import.meta.url)),
);

/**
 * Same page sizes as `two-page.pdf`, so the paired `.mark` placement is unchanged. ASCII
 * only, so string offsets are byte offsets.
 */
function linkedPdfBytes(): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    // Page 1: external, internal (to page 2) and a `javascript:` link that must not render.
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R" +
      " /Resources << >> /Annots [7 0 R 8 0 R 9 0 R] >>",
    "<< /Length 26 >>\nstream\n0 0 0 rg\n10 10 40 30 re f\nendstream",
    // Page 2, 300x150 pt, where the `.mark` writes.
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Contents 6 0 R" +
      " /Resources << >> /Annots [10 0 R] >>",
    "<< /Length 27 >>\nstream\n0 0 0 rg\n10 10 60 40 re f\nendstream",
    "<< /Type /Annot /Subtype /Link /Rect [20 20 80 60] /Border [0 0 0]" +
      " /A << /S /URI /URI (https://example.invalid/a) >> >>",
    "<< /Type /Annot /Subtype /Link /Rect [100 20 160 60] /Border [0 0 0]" +
      " /A << /S /GoTo /D [5 0 R /XYZ 0 150 0] >> >>",
    "<< /Type /Annot /Subtype /Link /Rect [20 70 80 90] /Border [0 0 0]" +
      " /A << /S /URI /URI (javascript:alert\\(1\\)) >> >>",
    "<< /Type /Annot /Subtype /Link /Rect [50 50 150 100] /Border [0 0 0]" +
      " /A << /S /URI /URI (https://example.invalid/two) >> >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, body] of objs.entries()) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const startxref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function openLinkedPdf(page: Page): Promise<Locator> {
  await signedIn(page);
  await servePdf(page, linkedPdfBytes());
  await page.goto("/#/note/178");
  await freezeMotion(page);
  const region = page.getByRole("region", { name: "PDF viewer" });
  await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
  return region;
}

test.describe("PDF links", () => {
  test("lands each anchor on its own rect, labelled, and drops `javascript:`", async ({ page }) => {
    await openLinkedPdf(page);
    const layer = page.locator(".pdf-links");
    await expect(layer.locator("a")).toHaveCount(2, { timeout: 20_000 });

    // The `javascript:` annot produces no element at all.
    const hrefs = await layer.locator("a").evaluateAll((as) =>
      as.map((a) => (a as HTMLAnchorElement).getAttribute("href")),
    );
    expect(hrefs.some((h) => h?.startsWith("javascript:"))).toBe(false);

    const ext = layer.locator('a[href="https://example.invalid/a"]');
    await expect(ext).toHaveAttribute("target", "_blank");
    await expect(ext).toHaveAttribute("rel", "noopener noreferrer");
    await expect(ext).toHaveAttribute("aria-label", "https://example.invalid/a");

    const internal = layer.locator('a[href="#/note/178/page/2"]');
    await expect(internal).toHaveCount(1);
    await expect(internal).toHaveAttribute("aria-label", "Go to page 2");
    await expect(internal).not.toHaveAttribute("target", "_blank");

    // PDF (20,20)-(80,60) on a 100pt-tall page: x 20..80, y 40..80, as canvas fractions.
    const geo = await page.evaluate(() => {
      const c = (document.querySelector(".pdf-page") as HTMLElement).getBoundingClientRect();
      const a = (
        document.querySelector('.pdf-links a[href="https://example.invalid/a"]') as HTMLElement
      ).getBoundingClientRect();
      return {
        left: (a.left - c.left) / c.width,
        top: (a.top - c.top) / c.height,
        width: a.width / c.width,
        height: a.height / c.height,
      };
    });
    expect(geo.left).toBeCloseTo(20 / 200, 2);
    expect(geo.top).toBeCloseTo(40 / 100, 2);
    expect(geo.width).toBeCloseTo(60 / 200, 2);
    expect(geo.height).toBeCloseTo(40 / 100, 2);
  });

  test("following an internal link is a real navigation to that page", async ({ page }) => {
    const region = await openLinkedPdf(page);
    await expect(region.locator(".pdf-pager__count")).toHaveValue("1 / 2");
    await page.locator('.pdf-links a[href="#/note/178/page/2"]').click();
    await expect(region.locator(".pdf-pager__count")).toHaveValue("2 / 2", { timeout: 20_000 });
    expect(page.url()).toContain("#/note/178/page/2");
    // A link that moved the counter over a stale canvas would pass the rest.
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await expect(page.locator(".pdf-links a")).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator('.pdf-links a[href="https://example.invalid/two"]')).toHaveCount(1);
  });

  test("the layer follows the raster through a zoom, and through a panel", async ({ page }) => {
    // Placement is computed from the canvas's real size after the raster lands.
    const region = await openLinkedPdf(page);
    const anchor = page.locator('.pdf-links a[href="https://example.invalid/a"]');
    await expect(anchor).toBeVisible({ timeout: 20_000 });

    // Null while the layer is down: each repaint removes old anchors first.
    const measure = async (): Promise<{ canvas: number; left: number; width: number } | null> =>
      page.evaluate(() => {
        const canvas = document.querySelector(".pdf-page") as HTMLElement | null;
        const a = document.querySelector(
          '.pdf-links a[href="https://example.invalid/a"]',
        ) as HTMLElement | null;
        if (!canvas || !a) return null;
        const c = canvas.getBoundingClientRect();
        const r = a.getBoundingClientRect();
        return { canvas: c.width, left: (r.left - c.left) / c.width, width: r.width / c.width };
      });
    const settled = async () => {
      let seen: { canvas: number; left: number; width: number } | null = null;
      await expect.poll(async () => (seen = await measure()) !== null).toBe(true);
      return seen!;
    };

    const fit = await settled();
    // Two steps: `Fit ⇔` sits between Fit and 150%.
    await region.getByRole("button", { name: "Zoom in" }).click();
    await region.getByRole("button", { name: "Zoom in" }).click();
    await expect(region.locator(".pdf-zoom", { hasText: "150%" })).toBeVisible();
    await expect.poll(async () => (await measure())?.canvas ?? 0).toBeGreaterThan(fit.canvas * 1.2);
    const zoomed = await settled();
    expect(zoomed.left).toBeCloseTo(fit.left, 2);
    expect(zoomed.width).toBeCloseTo(fit.width, 2);
    expect(zoomed.width * zoomed.canvas).toBeGreaterThan(fit.width * fit.canvas * 1.2);

    await region.getByRole("button", { name: "Zoom out" }).click();
    await region.getByRole("button", { name: "Zoom out" }).click();
    await region.getByRole("button", { name: "Pages" }).click();
    await expect(page.locator("#pdf-pages-panel")).toBeVisible();
    await expect.poll(async () => (await measure())?.canvas ?? 0).toBeLessThan(fit.canvas);
    const narrowed = await settled();
    expect(narrowed.left).toBeCloseTo(fit.left, 2);
    expect(narrowed.width).toBeCloseTo(fit.width, 2);
  });

  test("a link UNDER a scribble is still the thing you click", async ({ page }) => {
    // `.pdf-mark` is `pointer-events: none`, and the DOM order also puts links above ink.
    await signedIn(page);
    await servePdf(page, linkedPdfBytes());
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
    await region.getByRole("button", { name: "Next page" }).click();
    await expect(region.locator(".pdf-pager__count")).toHaveValue("2 / 2");
    await expect(page.locator(".pdf-mark canvas").first()).toBeAttached({ timeout: 20_000 });
    const anchor = page.locator('.pdf-links a[href="https://example.invalid/two"]');
    await expect(anchor).toBeVisible({ timeout: 20_000 });

    const stacked = await page.evaluate(() => {
      const stage = document.querySelector(".pdf-stage") as HTMLElement;
      const kids = Array.from(stage.children).map((k) => k.className.split(" ")[0]);
      const a = document.querySelector(
        '.pdf-links a[href="https://example.invalid/two"]',
      ) as HTMLElement;
      const box = a.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      const mark = document.querySelector(".pdf-mark") as HTMLElement;
      const m = mark.getBoundingClientRect();
      return {
        kids,
        hitIsTheLink: hit === a,
        // Without the ink over the link, the hit test proves nothing about stacking.
        markCoversIt:
          !mark.hidden &&
          m.left <= box.left &&
          m.top <= box.top &&
          m.right >= box.right &&
          m.bottom >= box.bottom,
      };
    });
    expect(stacked.markCoversIt).toBe(true);
    // Bottom to top: page; find highlights and the text selection (under the ink, which is
    // the user's own); the `.mark` ink; links last, so they hit-test above any scribble.
    expect(stacked.kids).toEqual([
      "pdf-page",
      "pdf-find-marks",
      "pdf-select",
      "note-stack",
      "pdf-links",
    ]);
    expect(stacked.hitIsTheLink).toBe(true);
  });

  test("leaving the page takes its links with it", async ({ page }) => {
    // Left up, anchors would point into the previous document and stay in the tab order.
    const region = await openLinkedPdf(page);
    await expect(page.locator(".pdf-links a")).toHaveCount(2, { timeout: 20_000 });
    await page.keyboard.press("Escape");
    await expect(region).toBeHidden();
    await expect(page.locator(".pdf-links a")).toHaveCount(0);
  });
});

// ---- outline panel ----

test.describe("PDF outline", () => {
  /** Open the outlined fixture and wait for its first page to paint. */
  async function openOutlinedPdf(page: Page): Promise<Locator> {
    await signedIn(page);
    await servePdf(page, OUTLINED_PDF_BYTES);
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect(region).toBeVisible();
    await expect(region.locator(".pdf-pager__count")).toHaveValue("1 / 6", { timeout: 20_000 });
    return region;
  }

  test("lists the document's own headings, and an entry JUMPS to its page", async ({ page }) => {
    const region = await openOutlinedPdf(page);
    const panel = region.locator("#pdf-outline-panel");
    const rows = region.locator(".pdf-outline__row");

    const opener = region.getByRole("button", { name: "Outline", exact: true });
    await expect(opener).toBeEnabled({ timeout: 20_000 });

    await expect(panel).toBeHidden();
    await opener.click();
    await expect(panel).toBeVisible();

    // The wire is 0-based; the panel shows 1-based page numbers.
    await expect(rows).toHaveCount(6);
    await expect(rows.locator(".pdf-outline__t")).toHaveText([
      "Part One",
      "Chapter A",
      "Chapter B",
      "Part Two",
      "Chapter C",
      "Section C.1",
    ]);
    await expect(rows.locator(".pdf-outline__p")).toHaveText(["1", "2", "3", "4", "5", "6"]);
    // Depth is indent and type, never colour, via a custom property.
    const depths = await rows.evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).style.getPropertyValue("--depth")),
    );
    expect(depths).toEqual(["0", "1", "1", "0", "1", "2"]);

    await expect(rows.nth(0)).toHaveAttribute("aria-current", "true");

    await rows.nth(5).click();
    await expect(region.locator(".pdf-pager__count")).toHaveValue("6 / 6");
    await expect(rows.nth(5)).toHaveAttribute("aria-current", "true");
    await expect(rows.nth(0)).toHaveAttribute("aria-current", "false");
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);
  });

  test("the mark tracks PAGING, not only clicking", async ({ page }) => {
    // Pages between two entries belong to the earlier one.
    const region = await openOutlinedPdf(page);
    const rows = region.locator(".pdf-outline__row");
    await region.getByRole("button", { name: "Outline", exact: true }).click();
    await expect(rows).toHaveCount(6, { timeout: 20_000 });
    await expect(rows.nth(0)).toHaveAttribute("aria-current", "true");

    // Focus off the toolbar, or the arrows rove between controls.
    await page.locator(".pdf-page").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("ArrowRight"); // page 2 — Chapter A
    await expect(region.locator(".pdf-pager__count")).toHaveValue("2 / 6");
    await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");

    await page.keyboard.press("ArrowRight"); // page 3 — Chapter B
    await expect(rows.nth(2)).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("ArrowLeft"); // back to page 2
    await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("End"); // page 6 — Section C.1
    await expect(rows.nth(5)).toHaveAttribute("aria-current", "true");
    await expect(region.locator('.pdf-outline__row[aria-current="true"]')).toHaveCount(1);
  });

  test("a document with NO outline keeps the opener, dimmed, and says why", async ({ page }) => {
    // A document with no outline shows the opener dimmed, with the reason in its name.
    await signedIn(page);
    await servePdf(page); // the plain two-page fixture
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    await expect.poll(() => inkFraction(page), { timeout: 20_000 }).toBeGreaterThan(0.002);

    const opener = region.getByRole("button", { name: "Outline — this document has none" });
    // Presence first: `not.toBeEnabled` would pass on a hidden control.
    await expect(opener).toHaveCount(1);
    await expect(opener).toBeVisible();
    await expect(opener).toBeDisabled();
    await expect(opener).toHaveAttribute("title", "Outline — this document has none");
    await expect(region.getByRole("button", { name: "Outline", exact: true })).toHaveCount(0);
  });

  test("Outline and Pages share one dock: opening either shuts the other", async ({ page }) => {
    // Pages and Outline share one dock: they want different track widths.
    const region = await openOutlinedPdf(page);
    const outlineBtn = region.getByRole("button", { name: "Outline", exact: true });
    const pagesBtn = region.getByRole("button", { name: "Pages", exact: true });
    const outlinePanel = region.locator("#pdf-outline-panel");
    const pagesPanel = region.locator("#pdf-pages-panel");
    await expect(outlineBtn).toBeEnabled({ timeout: 20_000 });

    await pagesBtn.click();
    await expect(pagesPanel).toBeVisible();
    await expect(outlinePanel).toBeHidden();

    await outlineBtn.click();
    await expect(outlinePanel).toBeVisible();
    await expect(pagesPanel).toBeHidden();
    await expect(outlineBtn).toHaveAttribute("aria-pressed", "true");
    await expect(pagesBtn).toHaveAttribute("aria-pressed", "false");

    await pagesBtn.click();
    await expect(pagesPanel).toBeVisible();
    await expect(outlinePanel).toBeHidden();
    await expect(outlineBtn).toHaveAttribute("aria-pressed", "false");
    await expect(pagesBtn).toHaveAttribute("aria-pressed", "true");
  });

  test("the page is never squeezed from BOTH sides at once", async ({ page }) => {
    // On a narrow window, opening one side's panel closes the other side's.
    await page.setViewportSize({ width: 900, height: 800 });
    const region = await openOutlinedPdf(page);
    const outlineBtn = region.getByRole("button", { name: "Outline", exact: true });
    const layersBtn = region.getByRole("button", { name: "Annotations", exact: true });
    const outlinePanel = region.locator("#pdf-outline-panel");
    const layersPanel = region.locator("#pdf-layers-panel");
    await expect(outlineBtn).toBeEnabled({ timeout: 20_000 });

    await outlineBtn.click();
    await expect(outlinePanel).toBeVisible();

    await layersBtn.click();
    await expect(layersPanel).toBeVisible();
    await expect(outlinePanel).toBeHidden();

    await outlineBtn.click();
    await expect(outlinePanel).toBeVisible();
    await expect(layersPanel).toBeHidden();

    const box = (await region.locator(".pdf-page").boundingBox())!;
    expect(box.width).toBeGreaterThan(200);
  });

  test("…but on a wide window both docks stay open together", async ({ page }) => {
    // Only a floor: with room for both, both stay open.
    await page.setViewportSize({ width: 1600, height: 900 });
    const region = await openOutlinedPdf(page);
    const outlineBtn = region.getByRole("button", { name: "Outline", exact: true });
    const layersBtn = region.getByRole("button", { name: "Annotations", exact: true });
    await expect(outlineBtn).toBeEnabled({ timeout: 20_000 });

    await outlineBtn.click();
    await layersBtn.click();
    await expect(region.locator("#pdf-layers-panel")).toBeVisible();
    await expect(region.locator("#pdf-outline-panel")).toBeVisible();
  });

  test("the next annotated document opens with the Annotations toggle UN-pressed", async ({
    page,
  }) => {
    // Regression: teardown left `aria-pressed` set over a closed panel.
    await signedIn(page);
    await servePdf(page);
    await page.goto("/#/note/178");
    await freezeMotion(page);
    const region = page.getByRole("region", { name: "PDF viewer" });
    const layersBtn = region.getByRole("button", { name: "Annotations", exact: true });
    const layersPanel = page.locator("#pdf-layers-panel");
    await expect(layersBtn).toBeVisible({ timeout: 20_000 });

    await layersBtn.click();
    await expect(layersPanel).toBeVisible();
    await expect(layersBtn).toHaveAttribute("aria-pressed", "true");

    // `178` is the only fixture with a `.mark`.
    await page.goto("/#/");
    await page.goto("/#/note/178");
    await freezeMotion(page);
    await expect(layersBtn).toBeVisible({ timeout: 20_000 });
    await expect(layersPanel).toBeHidden();
    await expect(layersBtn).toHaveAttribute("aria-pressed", "false");
  });
});

// ---- annotation history ----
// The control offers the paired `.mark`'s versions; nothing may claim the PDF has any.
