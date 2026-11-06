import type { Page, Locator } from "@playwright/test";
import { mockApi } from "./mockApi";

// The library runs on the in-memory fake `Api`, so only the boot guard's `/me` needs mocking.
export async function signedIn(page: Page): Promise<void> {
  await mockApi(page, {
    "user/me": { json: { success: true, email: "ana@household.lan", isAdmin: false, mustChangePassword: false } },
  });
}

/**
 * Parse a computed colour into 0-255 channels. Chromium returns `color(srgb r g b)`
 * with 0–1 components for `color-mix()` results, so those are scaled up.
 */
function parseRgb(value: string): [number, number, number] {
  const nums = value.match(/[\d.]+/g);
  if (!nums || nums.length < 3) throw new Error(`not a parseable colour: ${value}`);
  const scale = /^color\(\s*srgb\b/i.test(value.trim()) ? 255 : 1;
  return [Number(nums[0]) * scale, Number(nums[1]) * scale, Number(nums[2]) * scale];
}

/** WCAG relative luminance. */
function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio (1 = identical, 21 = black on white) of two computed colours. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(parseRgb(a));
  const lb = luminance(parseRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Computed foreground plus the first opaque ancestor background, since a
 * transparent `rgba(0, 0, 0, 0)` would read as black.
 */
export async function paintedColours(
  locator: Locator,
): Promise<{ color: string; background: string; stroke: string | null }> {
  // Retried: a node detached mid-read reports empty computed styles.
  for (let attempt = 0; ; attempt++) {
    const read = await readPaintedColours(locator);
    if (read !== null) return read;
    if (attempt >= 20) throw new Error("paintedColours: element kept detaching (20 attempts)");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function readPaintedColours(
  locator: Locator,
): Promise<{ color: string; background: string; stroke: string | null } | null> {
  return locator.evaluate((el: HTMLElement) => {
    const transparent = (c: string) => !c || c === "transparent" || /,\s*0\s*\)$/.test(c);
    let node: Element | null = el;
    let background = "rgb(255, 255, 255)"; // canvas fallback if nothing opaque is found
    while (node) {
      const c = getComputedStyle(node).backgroundColor;
      if (!transparent(c)) {
        background = c;
        break;
      }
      node = node.parentElement;
    }
    const cs = getComputedStyle(el);
    if (!cs.color) return null;
    const svg = el.querySelector("svg");
    return {
      color: cs.color,
      background,
      stroke: svg ? getComputedStyle(svg).stroke : null,
    };
  });
}

/**
 * Fraction of pixels whose luminance deviates strongly from the top-left paper colour.
 * Theme-agnostic; ignores faint ruled lines. Returns 0 for an unsized canvas.
 */
export async function inkFraction(canvas: Locator): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    const v = await readInkFraction(canvas);
    if (v !== null) return v;
    if (attempt >= 20) throw new Error("inkFraction: canvas kept detaching (20 attempts)");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function readInkFraction(canvas: Locator): Promise<number | null> {
  return canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext("2d");
    // A detached canvas reports 0×0: unreadable, not blank.
    if (!el.isConnected || el.width === 0 || el.height === 0) return null;
    if (!ctx) return null;
    const { data } = ctx.getImageData(0, 0, el.width, el.height);
    const lum = (i: number) => 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    const bg = lum(0); // corner = paper
    let marks = 0;
    const pixels = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3]! > 10 && Math.abs(lum(i) - bg) > 90) marks++;
    }
    return marks / pixels;
  });
}

/** {@link inkFraction} for an `<img>`, via an offscreen canvas (blob URLs do not taint). */
export async function imgInkFraction(img: Locator): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    const v = await readImgInkFraction(img);
    if (v !== null) return v;
    if (attempt >= 25) throw new Error("imgInkFraction: image never painted/decoded (25 attempts)");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function readImgInkFraction(img: Locator): Promise<number | null> {
  return img.evaluate(async (el: HTMLImageElement) => {
    // No src yet, or mid-decode: unreadable, so the caller retries.
    if (!el.isConnected || !el.src) return null;
    if (!el.complete || el.naturalWidth === 0) {
      try {
        await el.decode();
      } catch {
        return null;
      }
    }
    const w = el.naturalWidth;
    const h = el.naturalHeight;
    if (w === 0 || h === 0) return null;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(el, 0, 0);
    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(0, 0, w, h).data;
    } catch {
      return null; // tainted (should not happen for a same-origin blob)
    }
    const lum = (i: number) => 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    const bg = lum(0); // corner = paper
    let marks = 0;
    const pixels = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3]! > 10 && Math.abs(lum(i) - bg) > 90) marks++;
    }
    return marks / pixels;
  });
}

/** Whether the lazy engine has swapped an object URL into a gallery `<img>`. */
export async function imgPainted(img: Locator): Promise<boolean> {
  return img.evaluate((el: HTMLImageElement) => el.src.startsWith("blob:"));
}

/** A real 2x2 PNG, so `naturalWidth > 0` means the preview really decoded. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DAwMDAwMTAwMAAAA8EAQFa0S3fAAAAAElFTkSuQmCC";

/** Serve `GET /file/:id`: PNG bytes for images, `attachment` for the rest, as the server does. */
export async function mockRawFiles(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith("/file/"),
    async (route) => {
      const download = route.request().url().includes("download=1");
      await route.fulfill({
        status: 200,
        contentType: download ? "application/octet-stream" : "image/png",
        headers: {
          "content-disposition": download ? 'attachment; filename="preview.bin"' : "inline",
          "x-content-type-options": "nosniff",
        },
        body: Buffer.from(TINY_PNG_BASE64, "base64"),
      });
    },
  );
}

/**
 * 120×160 PNG, ~36% black band. Must be a PNG: the facade decodes via
 * `createImageBitmap`, which cannot decode SVG, so an SVG would hit the fallback path.
 */
const THUMB_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAHgAAACgCAAAAADiYvdMAAAAZElEQVR42u3aAQ0AMAgEsfdvmqkAktEzUAOXWipgMBgMBoPBR+E0" +
  "BwaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAyegS03YDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAZ/Cz+nJdLCphXs6QAAAABJ" +
  "RU5ErkJggg==";

const TEXT_BODY =
  "Reading list\n\n- The Left Hand of Darkness\n- Piranesi\n- A Canticle for Leibowitz\n\nReturn the library books on Friday.";

export interface ThumbnailBackendHits {
  /** `/thumbnail/{hash}` requests — all of them, or only those for `hash`. */
  thumbnailHits(hash?: string): number;
  /** Live `/file/:id` requests — all of them, or only those for `id`. */
  fileHits(id?: string): number;
  /** Bin-scoped `/api/controlplane/bin/file/:id` requests — all, or per `id`. */
  binFileHits(id?: string): number;
}

/**
 * Serve the endpoints the thumbnail facade fetches: `/thumbnail/{hash}` (404 for
 * `coverless` hashes; use `fakeFileHash`), plus `/file/:id` and its bin twin, which
 * serve `text/plain` for `textIds` and PNG otherwise. Returns per-route hit tallies.
 */
export async function mockThumbnailBackend(
  page: Page,
  opts: { textIds?: string[]; coverless?: string[]; delayMs?: number } = {},
): Promise<ThumbnailBackendHits> {
  const textIds = new Set(opts.textIds ?? []);
  const coverless = new Set(opts.coverless ?? []);
  // Delays `/thumbnail/` only, so a tile is provably unpainted for a while.
  const delay = opts.delayMs ?? 0;

  const thumbHits: string[] = [];
  const fileHits: string[] = [];
  const binHits: string[] = [];
  const tally = (log: string[]) => (key?: string) => (key === undefined ? log.length : log.filter((k) => k === key).length);

  await page.route(
    (url) => url.pathname.startsWith("/thumbnail/"),
    async (route) => {
      const hash = decodeURIComponent(new URL(route.request().url()).pathname.slice("/thumbnail/".length));
      thumbHits.push(hash);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      if (coverless.has(hash)) {
        await route.fulfill({ status: 404, body: "" });
        return;
      }
      await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(THUMB_PNG_BASE64, "base64") });
    },
  );

  const serveRawFile = async (route: Parameters<Parameters<Page["route"]>[1]>[0], id: string): Promise<void> => {
    if (textIds.has(id)) {
      await route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: TEXT_BODY });
      return;
    }
    const download = route.request().url().includes("download=1");
    await route.fulfill({
      status: 200,
      contentType: download ? "application/octet-stream" : "image/png",
      headers: {
        "content-disposition": download ? 'attachment; filename="preview.bin"' : "inline",
        "x-content-type-options": "nosniff",
      },
      body: Buffer.from(TINY_PNG_BASE64, "base64"),
    });
  };

  await page.route(
    (url) => url.pathname.startsWith("/file/"),
    async (route) => {
      const id = decodeURIComponent(route.request().url().split("/file/")[1]!.split("?")[0]!);
      fileHits.push(id);
      await serveRawFile(route, id);
    },
  );

  // Registered after any catch-all: Playwright matches routes newest-first.
  await page.route(
    (url) => url.pathname.startsWith("/api/controlplane/bin/file/"),
    async (route) => {
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/bin/file/")[1] ?? "");
      binHits.push(id);
      await serveRawFile(route, id);
    },
  );

  return { thumbnailHits: tally(thumbHits), fileHits: tally(fileHits), binFileHits: tally(binHits) };
}

/** A card's opening button. A bare name regex also matches the "Actions for X" trigger. */
export function cardButton(page: Page, name: string | RegExp): Locator {
  return page.getByRole("button", { name }).and(page.locator(".card__open"));
}

/**
 * Wait for the rail's tree walk; until then a category click triggers a delayed second
 * gallery repaint. Use before clicking a category in a test that measures.
 */
export async function railSettled(page: Page): Promise<void> {
  await page.getByRole("group", { name: "Folders" }).and(page.locator('[aria-busy="false"]')).waitFor();
}

/**
 * Kill transitions and animations, then wait a frame. Automated tabs are
 * `visibilityState: hidden`, which freezes transitions mid-flight; measure only after this.
 */
export async function freezeMotion(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `*, *::before, *::after {
      transition: none !important;
      animation: none !important;
    }`,
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
}
