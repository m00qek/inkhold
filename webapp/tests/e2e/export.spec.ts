import { test, expect, type Page, type Download } from "@playwright/test";
import { signedIn } from "./helpers/app";
import { readFile } from "node:fs/promises";

// The reader's Download menu — THREE GROUPS: THIS PAGE — CURRENT VIEW, THIS PAGE
// — ORIGINAL VIEW (hidden until a layer is toggled — see noteLayers.spec.ts) and
// WHOLE NOTEBOOK. On a page with no layer stack the per-page rows fall back to the
// composite (Flattened image / PDF document) and the layered-only rows fold away; the
// whole notebook offers its PDF plus the raw `.note`. These tests drive the
// no-layer note (n-doc-attn); the layered matrix is proved in noteLayers.spec.ts.

const NOTE = "/#/note/n-doc-attn"; // 20 pages, recognized, known hardware
const UNSCALED = "/#/note/n-doc-unscaled"; // recognized, but no verified mm scale

// The reader's export trigger is labelled "Download" now (the verb
// a user knows), though it still opens the same export menu.
const exportBtn = (page: Page) => page.locator(".reader__bar").getByRole("button", { name: "Download" });
// Scoped to the reader's bar AND to the EXPORT pop specifically: the bar now
// holds a second `.menu__pop` too — the bin-mode cluster's "…" menu (Restore /
// Delete permanently) shares the class — so the export pop is disambiguated by
// its `.menu__head` group headings, which only it carries.
const menu = (page: Page) => page.locator(".reader__bar .menu__pop", { has: page.locator(".menu__head") });
const item = (page: Page, name: string) => menu(page).getByRole("menuitem", { name });
// "PDF document" now appears under both a per-page group and Whole notebook, so
// ambiguous names are scoped to their group by its header (substring-matched).
const groupItem = (page: Page, head: string, name: string) =>
  menu(page)
    .locator("> div")
    .filter({ has: page.locator(".menu__head", { hasText: head }) })
    .getByRole("menuitem", { name });

/**
 * Open a note and wait until it is REALLY open.
 *
 * Waiting for the page count to reach `pages` matters: the reader paints a
 * "1 / 1" placeholder before the note metadata lands, and `open()` closes the
 * Export menu when it finally does. A test that opened the menu during that
 * window would watch it shut by itself.
 */
async function openReader(page: Page, route = NOTE, pages = 20): Promise<void> {
  await signedIn(page);
  await page.goto(route);
  await expect(page.locator(".pager__count")).toHaveText(`1 / ${pages}`);
}

/** Read a completed download into memory. */
async function bytesOf(download: Download): Promise<Buffer> {
  const path = await download.path();
  if (!path) throw new Error("download produced no file");
  return readFile(path);
}

test.describe("export menu", () => {
  test("opens from the toolbar and tracks aria-expanded", async ({ page }) => {
    await openReader(page);

    await expect(menu(page)).toBeHidden();
    await expect(exportBtn(page)).toHaveAttribute("aria-expanded", "false");

    await exportBtn(page).click();
    await expect(menu(page)).toBeVisible();
    await expect(exportBtn(page)).toHaveAttribute("aria-expanded", "true");

    // A click anywhere else dismisses it.
    await page.locator(".stage").click({ position: { x: 5, y: 5 } });
    await expect(menu(page)).toBeHidden();
    await expect(exportBtn(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("Escape closes the menu without closing the whole reader", async ({ page }) => {
    await openReader(page);
    await exportBtn(page).click();
    await expect(menu(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(menu(page)).toBeHidden();
    // Still in the reader — the first Escape belonged to the dropdown.
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("region", { name: "Reader" })).toBeHidden();
  });

  test("shows the two groups a no-layer note gets, and their items", async ({ page }) => {
    await openReader(page);
    await exportBtn(page).click();

    // VISIBLE heads only: the ORIGINAL-view group rides in the menu's DOM but
    // stays hidden until a layer is toggled (this page has no layer stack at all),
    // so a no-layer note shows exactly Current view + Whole notebook.
    await expect(menu(page).locator(".menu__head:visible")).toHaveText([
      "This page — Current view",
      "Whole notebook",
    ]);
    // CURRENT view: Flattened image + PDF document (the layered-only ORA row folds away
    // with no stack). WHOLE notebook: PDF document + Supernote. Four in all.
    await expect(menu(page).locator(".menu__item:visible")).toHaveCount(4);
    await expect(groupItem(page, "Current view", "Flattened image")).toBeVisible();
    await expect(groupItem(page, "Current view", "PDF document")).toBeVisible();
    await expect(groupItem(page, "Whole notebook", "PDF document")).toBeVisible();
    await expect(groupItem(page, "Whole notebook", "Supernote")).toBeVisible();
    // The layered-only ORA is not offered without a stack, and there is no SVG
    // entry in the structure at all.
    await expect(menu(page).getByRole("menuitem", { name: "Layered image" })).toBeHidden();
    await expect(menu(page).getByRole("menuitem", { name: "SVG" })).toHaveCount(0);
  });

  test("the raw Supernote file downloads unchanged from Whole notebook", async ({ page }) => {
    await openReader(page);
    await exportBtn(page).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      groupItem(page, "Whole notebook", "Supernote").click(),
    ]);
    // The server names the attachment; the reader only navigates to the versioned
    // raw-file URL, so the download simply arrives.
    expect(download.url()).toContain("/file/");
  });

  test("Flattened image downloads a real PNG named after the note and page", async ({ page }) => {
    await openReader(page);
    await page.getByRole("button", { name: "Page 3" }).click();
    await expect(page.locator(".pager__count")).toHaveText("3 / 20");

    await exportBtn(page).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      groupItem(page, "Current view", "Flattened image").click(),
    ]);

    expect(download.suggestedFilename()).toBe("Attention Is All You Need-p3.png");

    const bytes = await bytesOf(download);
    // The PNG signature, then a real IHDR — not an empty or truncated blob.
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.subarray(12, 16).toString("latin1")).toBe("IHDR");
    expect(bytes.length).toBeGreaterThan(2000);

    // Exported at the page's NATIVE width, not the downscaled display tier.
    expect(bytes.readUInt32BE(16)).toBe(1404);
  });

  test("PDF downloads one A4-aspect page with a selectable text layer", async ({ page }) => {
    await openReader(page);

    await exportBtn(page).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      groupItem(page, "Current view", "PDF document").click(),
    ]);

    expect(download.suggestedFilename()).toBe("Attention Is All You Need-p1.pdf");

    const pdf = (await bytesOf(download)).toString("latin1");
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pdf).toContain("/Count 1"); // this page only, not the notebook
    expect(pdf).toContain("/ColorSpace /DeviceGray");

    // Aspect preserved from the 1404x1872 page.
    const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf);
    expect(box).not.toBeNull();
    expect(Number(box![2]) / Number(box![1])).toBeCloseTo(1872 / 1404, 2);

    // The whole point: invisible (3 Tr) text over the raster.
    expect(pdf).toContain("3 Tr");
    expect(pdf).toContain("/BaseFont /Helvetica");
    expect(pdf).toContain(" Tj");

    // And the toolbar says which of the two kinds it produced.
    await expect(page.locator(".toast")).toContainText("can be selected and searched");
  });

  // THE ASYMMETRY THIS DESIGN IS BUILT AROUND. This note's device has no verified
  // millimetre scale, so its PDF must be raster-only — a PDF with no text is
  // obviously text-free, whereas one whose invisible text is 10% out looks
  // perfect until someone copies the wrong words out of it.
  test("a note from unverified hardware exports a raster-only PDF, and says so", async ({ page }) => {
    await openReader(page, UNSCALED, 3);

    await exportBtn(page).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      groupItem(page, "Current view", "PDF document").click(),
    ]);

    const pdf = (await bytesOf(download)).toString("latin1");
    // Still a valid PDF of the page...
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf).toContain("/ColorSpace /DeviceGray");
    // ...with no text layer at all.
    expect(pdf).not.toContain("3 Tr");
    expect(pdf).not.toContain(" Tj");

    // And it does not pretend otherwise — in the terms the reader asked in.
    await expect(page.locator(".toast")).toContainText("cannot be selected or searched");
  });

  // THE WHOLE NOTEBOOK, written page by page. The memory invariant that makes
  // this safe is unit-tested (`pdf.test.ts` — the writer pulls one page at a
  // time); what a real browser adds is that the decode → canvas → deflate loop
  // actually survives twenty round-trips and still produces a file a reader
  // will open, with a cross-reference table pointing at the right places.
  test("PDF document exports every page of the notebook as one file", async ({ page }) => {
    test.setTimeout(120_000); // 20 pages, each decoded and compressed in-browser
    await openReader(page);

    await exportBtn(page).click();
    const clicked = groupItem(page, "Whole notebook", "PDF document").click();

    // Progress that says which page it is on. It claims nothing about time —
    // per-page cost varies with the ink, and the compression step is not
    // something the reader can see inside.
    await expect(page.locator(".toast")).toContainText(/page \d+ of 20/);

    const [download] = await Promise.all([page.waitForEvent("download"), clicked]);
    // No `-p1`: the file is the notebook, so it is named after the notebook.
    expect(download.suggestedFilename()).toBe("Attention Is All You Need.pdf");

    const pdf = (await bytesOf(download)).toString("latin1");
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pdf).toContain("/Count 20");
    expect((pdf.match(/\/Type \/Page\b/g) ?? []).length).toBe(20);

    // A real reader opens it only if every xref offset lands on its object.
    const count = 4 + 3 * 20;
    expect(/\/Size (\d+)/.exec(pdf)?.[1]).toBe(String(count));
    const startxref = Number(/startxref\n(\d+)/.exec(pdf)?.[1]);
    expect(pdf.slice(startxref, startxref + 4)).toBe("xref");
    const rows = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(rows).toHaveLength(count - 1);
    rows.forEach((offset, i) => {
      expect(pdf.slice(offset)).toMatch(new RegExp(`^${i + 1} 0 obj`));
    });

    // PER-PAGE text layers. This fixture recognised two pages in every three, so
    // the document must carry both kinds: pages with invisible words over them,
    // and six raster-only pages whose content stream is the image and nothing
    // else. Dropping the layer for the multi-page path would pass a "valid PDF"
    // check and quietly lose the reason the export exists.
    expect(pdf).toContain("3 Tr");
    expect((pdf.match(/Do Q\nendstream/g) ?? []).length).toBe(6);

    await expect(page.locator(".toast")).toContainText("20 pages");
    await expect(page.locator(".toast")).toContainText("can be selected and searched");
  });

  // The same asymmetry as the single page, applied to a whole document: an
  // unverified device disables the text layer for EVERY page of it rather than
  // for the ones that happen to fail a bounds check.
  test("a whole-document export from unverified hardware is raster-only", async ({ page }) => {
    await openReader(page, UNSCALED, 3);

    await exportBtn(page).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      groupItem(page, "Whole notebook", "PDF document").click(),
    ]);

    expect(download.suggestedFilename()).toBe("Field notes — unknown device.pdf");

    const pdf = (await bytesOf(download)).toString("latin1");
    expect(pdf).toContain("/Count 3");
    expect(pdf).toContain("/ColorSpace /DeviceGray");
    expect(pdf).not.toContain("3 Tr");
    expect(pdf).not.toContain(" Tj");

    await expect(page.locator(".toast")).toContainText("3 pages");
    await expect(page.locator(".toast")).toContainText("cannot be selected or searched");
  });

  test("the menu is not offered for files that are not notes", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/n-doc-epub"); // an .epub: no viewer, so the reader
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();

    // A page exporter over a file with no pages would be chrome that does
    // nothing — the same species of lie as a blank canvas.
    await expect(exportBtn(page)).toBeHidden();
    // The toolbar's plain Download link stands in for it (the "no preview" body
    // offers a second one, hence scoping to the bar).
    await expect(page.locator(".reader__bar").getByRole("link", { name: "Download" })).toBeVisible();
  });
});
