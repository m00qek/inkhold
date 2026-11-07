// The reader's note stage on a slow link.

import { test, expect, type Page } from "@playwright/test";
import { mockApi } from "./helpers/mockApi";
import { recordText } from "./helpers/recordText";
// The real layered SNPG payload; its layer descriptors pair with the records by slot.
import { layeredPageLayers, layeredPagePayload } from "../../src/api/layeredFixture";

// What is on screen while a request is in flight: loading and known-empty are different
// states. Uses `?real` with a mocked control plane, the only way to hold a response.
// Use `recordText` for "must never have said X"; retrying matchers cannot catch it.
import { ME, note } from "./slowLink.shared";

const LAY = "n-lay";

const PAGE_HASHES = ["a1".repeat(16), "b2".repeat(16), "c3".repeat(16)];

/**
 * Layers are omitted where a page has none (never `null` or `[]`), as on the wire.
 * `recognised` (non-null `textHash`) is what `findInNote` gates on; defaults to false.
 */
function wirePage(index: number, layered: boolean, recognised = false) {
  return {
    index,
    hash: PAGE_HASHES[index] ?? `${index}`.repeat(32).slice(0, 32),
    width: 1404,
    height: 1872,
    textHash: recognised ? `t${index}`.repeat(16).slice(0, 32) : null,
    ...(layered ? { layers: layeredPageLayers(0) } : {}),
  };
}

/** The layered note as a LISTING entry — the shape the reader opens from. */
function layeredEntry(opts: { firstPageLayered: boolean; pageCount: number }) {
  return {
    kind: "note",
    id: LAY,
    name: "Layered field sketch",
    pageCount: opts.pageCount,
    fileType: "note",
    fileHash: "0".repeat(32),
    updatedAt: 1_700_000_000_000,
    hasRecognizedText: false,
    firstPage: wirePage(0, opts.firstPageLayered),
  };
}

/** …and as `getNoteMeta` answers it. `layered` lists which page indices carry
 *  layers; `recognised`, which carry a transcript. */
function layeredMeta(pageCount: number, layered: number[], recognised: number[] = []) {
  return {
    id: LAY,
    name: "Layered field sketch",
    fileType: "note",
    fileHash: "0".repeat(32),
    size: 1_048_576,
    pxPerMm: null,
    pages: Array.from({ length: pageCount }, (_, i) => wirePage(i, layered.includes(i), recognised.includes(i))),
  };
}

/** Serve `GET /note/{id}/page/{n}` with the fixture payload, optionally holding one index. */
async function serveLayeredPages(page: Page, hold?: { index: number; ms: number }): Promise<void> {
  const payload = Buffer.from(layeredPagePayload(0)!);
  await page.route(
    (url) => url.pathname.startsWith(`/note/${LAY}/page/`),
    async (route) => {
      const n = Number(new URL(route.request().url()).pathname.split("/page/")[1]);
      if (hold && n === hold.index) await new Promise((r) => setTimeout(r, hold.ms));
      await route.fulfill({ status: 200, contentType: "application/octet-stream", body: payload });
    },
  );
}

/** One snapshot in a single evaluate, never a retrying assertion. */
async function stageSnapshot(page: Page) {
  return page.evaluate(() => {
    const stack = document.querySelector(".note-stack") as HTMLElement | null;
    const canvas = document.querySelector(".page > canvas") as HTMLCanvasElement | null;
    const toggle = document.querySelector('[aria-controls="note-layers-panel"]') as HTMLButtonElement | null;
    const panel = document.querySelector(".note-layers") as HTMLElement | null;
    // A cleared canvas is transparent (0); the ruled-sheet placeholder fills it (255).
    let centreAlpha = -1;
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      const ctx = canvas.getContext("2d");
      if (ctx) centreAlpha = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data[3]!;
    }
    return {
      // The readout is an input, so the count is its `value`.
      pager: (document.querySelector(".pager__count") as HTMLInputElement | null)?.value ?? "",
      stackHidden: stack === null || stack.hidden,
      stackCanvases: stack ? stack.querySelectorAll("canvas").length : 0,
      canvasHidden: canvas === null || canvas.hidden,
      canvasWidth: canvas?.width ?? 0,
      centreAlpha,
      layersDisabled: toggle?.disabled ?? null,
      layersTitle: toggle?.getAttribute("title") ?? "",
      panelHidden: panel === null || panel.hidden,
      panelText: panel?.textContent ?? "",
      findCount: document.querySelector(".findbar__count")?.textContent ?? "",
    };
  });
}

test.describe("the reader's note stage, mid-fetch", () => {
  // Regression: `.note-stack` covers the canvas, and page N's ink stayed sharp through
  // the turn to N+1. Blurring was rejected: a blurred stack is just a blurry wrong page.
  test("the previous page's layer stack does not stay sharp through a page turn", async ({ page }) => {
    await mockApi(page, {
      "controlplane/file/metadata": { json: layeredMeta(2, [0, 1]) },
      "controlplane/tree": {
        json: { folderId: null, path: [], entries: [layeredEntry({ firstPageLayered: true, pageCount: 2 })], syncVersion: 1 },
      },
      "user/me": { json: ME },
    });
    await serveLayeredPages(page, { index: 1, ms: 6000 });
    await page.goto("/?real");
    await page.locator(".card__open", { hasText: "Layered field sketch" }).click();

    await expect(page.locator(".note-stack canvas")).toHaveCount(4);
    await page.getByRole("button", { name: "Layers" }).click();
    await expect(page.locator(".note-layers")).toContainText("Layer Renamed");

    await page.getByRole("button", { name: "Next page" }).click();
    // Read once: everything before `showPage`'s first await has run.
    const s = await stageSnapshot(page);

    expect(s.pager).toBe("2 / 2");
    expect(s.stackHidden).toBe(true);
    // Hidden, not released, so `isPresented` and the `gen` token survive a zoom or relayout.
    expect(s.stackCanvases).toBe(4);
    expect(s.canvasHidden).toBe(false);
    expect(s.centreAlpha).toBe(255);

    expect(s.panelHidden).toBe(false);
    expect(s.panelText).toContain("Loading this page's layers…");
    expect(s.panelText).not.toContain("Layer Renamed");
  });

  // Regression: the export menu read the mounted stack, so it would have saved page N's
  // layers named for N+1. `stackIsCurrent` is the single definition.
  test("the export menu never offers the current view while it belongs to the page you left", async ({
    page,
  }) => {
    await mockApi(page, {
      "controlplane/file/metadata": { json: layeredMeta(2, [0, 1]) },
      "controlplane/tree": {
        json: { folderId: null, path: [], entries: [layeredEntry({ firstPageLayered: true, pageCount: 2 })], syncVersion: 1 },
      },
      "user/me": { json: ME },
    });
    await serveLayeredPages(page, { index: 1, ms: 6000 });
    await page.goto("/?real");
    await page.locator(".card__open", { hasText: "Layered field sketch" }).click();
    await expect(page.locator(".note-stack canvas")).toHaveCount(4);

    // The bar also carries the bin-mode "…" pop; only the export menu has group headings.
    const reader = page.getByRole("region", { name: "Reader" });
    const exportMenu = page.locator(".reader__bar .menu__pop", { has: page.locator(".menu__head") });
    const oraRow = exportMenu.getByRole("menuitem", { name: "Layered image" });

    await reader.getByRole("button", { name: "Download" }).click();
    await expect(oraRow).toHaveCount(1);
    await page.keyboard.press("Escape");

    await reader.getByRole("button", { name: "Next page" }).click();
    await reader.getByRole("button", { name: "Download" }).click();
    await expect(oraRow).toHaveCount(0);
  });

  // Regression: `refreshLayersUi` ran only after the decode, describing the previous page.
  test("the Layers toggle is right the instant the page turns, not when it decodes", async ({ page }) => {
    await mockApi(page, {
      // Plain then layered: the other direction was accidentally correct.
      "controlplane/file/metadata": { json: layeredMeta(2, [1]) },
      "controlplane/tree": {
        json: { folderId: null, path: [], entries: [layeredEntry({ firstPageLayered: false, pageCount: 2 })], syncVersion: 1 },
      },
      "user/me": { json: ME },
    });
    await serveLayeredPages(page, { index: 1, ms: 6000 });
    await page.goto("/?real");
    await page.locator(".card__open", { hasText: "Layered field sketch" }).click();
    await expect(page.locator(".pager__count")).toHaveValue("1 / 2");
    expect((await stageSnapshot(page)).layersTitle).toBe("This page has no layers");

    await page.getByRole("button", { name: "Next page" }).click();
    const s = await stageSnapshot(page);

    expect(s.pager).toBe("2 / 2");
    expect(s.layersDisabled).toBe(false);
    expect(s.layersTitle).toBe("Layers");
  });

  // A skeleton-invented page gets neutral wording, not "This page has no layers".
  test("a page the skeleton invented never claims to have no layers", async ({ page }) => {
    await mockApi(page, {
      "controlplane/file/metadata": { delayMs: 6000, json: layeredMeta(3, [0, 1, 2]) },
      "controlplane/tree": {
        json: { folderId: null, path: [], entries: [layeredEntry({ firstPageLayered: true, pageCount: 3 })], syncVersion: 1 },
      },
      "user/me": { json: ME },
    });
    await serveLayeredPages(page);
    await page.goto("/?real");
    await expect(page.locator("#gallery")).toContainText("Layered field sketch");
    await page.evaluate(() => {
      window.location.hash = "#/note/n-lay/page/2";
    });
    await expect(page.locator(".pager__count")).toHaveValue("2 / 3");

    const s = await stageSnapshot(page);
    expect(s.layersDisabled).toBe(true);
    expect(s.layersTitle).not.toBe("This page has no layers");
    expect(s.layersTitle).toContain("Layers");
  });

  // Regression: the virtualized filmstrip had no thumbnail to blur up from, so the canvas
  // was cleared to a blank white rectangle.
  test("a jump past the filmstrip's window paints the ruled sheet, not a blank", async ({ page }) => {
    const PAGES = 60;
    const meta = {
      id: LAY,
      name: "Long notebook",
      fileType: "note",
      fileHash: "0".repeat(32),
      size: 1_048_576,
      pxPerMm: null,
      pages: Array.from({ length: PAGES }, (_, i) => ({
        index: i,
        hash: `${i}`.padStart(32, "d"),
        width: 1404,
        height: 1872,
        textHash: null,
      })),
    };
    await mockApi(page, {
      "controlplane/file/metadata": { json: meta },
      "controlplane/tree": {
        json: {
          folderId: null,
          path: [],
          entries: [{ ...layeredEntry({ firstPageLayered: false, pageCount: PAGES }), name: "Long notebook" }],
          syncVersion: 1,
        },
      },
      "user/me": { json: ME },
    });
    await page.route(
      (url) => url.pathname.startsWith(`/note/${LAY}/page/`),
      async (route) => {
        if (new URL(route.request().url()).pathname.endsWith("/page/40")) {
          await new Promise((r) => setTimeout(r, 15_000));
        }
        await route.fulfill({ status: 200, contentType: "application/octet-stream", body: Buffer.from([]) });
      },
    );
    // Straight to the deep link: only the first `showPage` for a distant page lacks a thumbnail.
    await page.goto(`/?real#/note/${LAY}/page/41`);

    // The placeholder is painted in the same synchronous block that issues this request.
    await page.waitForRequest((r) => r.url().includes(`/note/${LAY}/page/40`));
    const s = await stageSnapshot(page);

    expect(s.pager).toBe("41 / 60");
    expect(s.canvasWidth).toBeGreaterThan(0);
    expect(s.centreAlpha).toBe(255);
  });

  // Regression: `?q=` primed find against the skeleton (`textHash: null`) and claimed
  // "Not recognised on the device". Observed, since phase 1 overwrites the claim.
  test("find never claims Not recognised while the note's metadata is in flight", async ({ page }) => {
    const counter = await recordText(page, ".findbar__count");
    await mockApi(page, {
      "controlplane/file/metadata": { delayMs: 6000, json: layeredMeta(3, []) },
      // Held, so phase 2 (the index over `text/<md5>`) cannot settle the counter.
      "controlplane/text/": { delayMs: 6000, json: {} },
      "controlplane/tree": {
        json: {
          folderId: null,
          path: [],
          entries: [
            { ...layeredEntry({ firstPageLayered: false, pageCount: 3 }), hasRecognizedText: true },
          ],
          syncVersion: 1,
        },
      },
      "user/me": { json: ME },
    });
    await serveLayeredPages(page);
    await page.goto("/?real");
    await expect(page.locator("#gallery")).toContainText("Layered field sketch");
    await page.evaluate(() => {
      window.location.hash = "#/note/n-lay?q=zebra";
    });
    await expect(page.locator(".findbar")).toBeVisible();
    await expect(page.locator(".findbar__count")).toHaveText("Searching…");

    expect(await counter.everShowed("Not recognised")).toBe(false);
    expect(await counter.everShowed("No matches")).toBe(false);
  });

  // `cancelPending` must abort a superseded `text/<md5>` fetch (up to ~3 MB) so it frees
  // one of the ~6 connections per origin; an abort shows as `net::ERR_ABORTED`.
  test("a superseded find gives its connection back rather than running to completion", async ({ page }) => {
    await mockApi(page, {
      // Recognised throughout, or Find stays disabled and the fetch is never issued.
      "controlplane/file/metadata": { json: layeredMeta(3, [0, 1, 2], [0, 1, 2]) },
      // Held, so the first query's fetch is still on the wire when superseded.
      "controlplane/text/": { delayMs: 6000, json: {} },
      "controlplane/tree": {
        json: {
          folderId: null,
          path: [],
          entries: [
            { ...layeredEntry({ firstPageLayered: false, pageCount: 3 }), hasRecognizedText: true },
          ],
          syncVersion: 1,
        },
      },
      "user/me": { json: ME },
    });
    await serveLayeredPages(page);
    await page.goto(`/?real#/note/${LAY}`);
    await expect(page.locator(".reader.is-open")).toBeVisible();

    await page.getByRole("button", { name: "Find in this note" }).click();
    const field = page.getByRole("textbox", { name: "Find in this note" });

    await field.fill("zebra");
    await page.waitForRequest((r) => r.url().includes("controlplane/text/"));

    const dropped = page.waitForEvent("requestfailed", (r) => r.url().includes("controlplane/text/"));
    await field.fill("zebras");
    expect((await dropped).failure()?.errorText ?? "").toContain("ABORTED");
  });

  // With layers on the listing's `firstPage`, the stack is up before `getNoteMeta` lands.
  test("a listing-originated open paints the stack before the metadata lands", async ({ page }) => {
    await mockApi(page, {
      "controlplane/file/metadata": { delayMs: 6000, json: layeredMeta(2, [0]) },
      "controlplane/tree": {
        json: { folderId: null, path: [], entries: [layeredEntry({ firstPageLayered: true, pageCount: 2 })], syncVersion: 1 },
      },
      "user/me": { json: ME },
    });
    await serveLayeredPages(page);
    await page.goto("/?real");
    await page.locator(".card__open", { hasText: "Layered field sketch" }).click();

    await expect(page.locator(".note-stack canvas")).toHaveCount(4);
    const s = await stageSnapshot(page);
    expect(s.stackHidden).toBe(false);
    expect(s.canvasHidden).toBe(true);
    expect(s.layersDisabled).toBe(false);
    expect(s.layersTitle).toBe("Layers");
  });
});
