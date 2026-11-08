import { test, type Page } from "@playwright/test";
import { signedIn, freezeMotion } from "../e2e/helpers/app";
import { mockApi } from "../e2e/helpers/mockApi";
import { settle } from "../e2e/helpers/screens";
import { servePdf } from "../e2e/pdfViewer.shared";
import { readFileSync } from "node:fs";
import { foldTerms, mockSearchIndex, type FixtureManifestRow } from "../e2e/helpers/searchIndex";
import { mockDocText, type TextRecord } from "../e2e/helpers/docText";

// Every screenshot the docs and the home page show, in both themes. Each is a
// path the e2e suite already walks, on the same fake household.

const OUT = "../docs/static/screenshots";

// Search runs over the real recognised text of the demo's Ozymandias (src/api/demoNotes.ts).
const OZ = JSON.parse(readFileSync("demo/notes/ozymandias/meta.json", "utf8")) as { fileHash: string; pages: { index: number }[] };
const OZ_PAGES = OZ.pages.map((p) => (JSON.parse(readFileSync(`demo/notes/ozymandias/page-${p.index}.text.json`, "utf8")) as { text: string }).text);
const ROWS: FixtureManifestRow[] = [{ md5: OZ.fileHash, fileId: 192, tier: "note", updatedAt: 1_752_700_000, indexVersion: 1, derivation: "derived" }];
const DOCS = { [OZ.fileHash]: { md5: OZ.fileHash, indexVersion: 1, pageCount: OZ_PAGES.length, pages: OZ_PAGES.map((t, p) => ({ p, t: foldTerms(t) })) } };
const TEXT: Record<string, TextRecord> = { [OZ.fileHash]: { n: OZ_PAGES.length, segments: OZ_PAGES.map((t, p) => ({ p, t })) } };

interface Shot {
  name: string;
  /** The part that tells the story: the app beside its rail (14.5rem = 232 px), this tall. Absent: the whole window. */
  crop?: number;
  /** Or just this element. */
  element?: string;
  phone?: boolean;
  admin?: boolean;
  open(page: Page): Promise<void>;
}

const SHOTS: Shot[] = [
  { name: "library", open: async (p) => { await p.goto("/#/folder/note"); await settle(p); } },
  { name: "reader", open: async (p) => { await p.goto("/#/note/191"); await settle(p); } },
  {
    // The sketch viewer with its layers open, showing the ink-drop sketch from
    // the first promo page (art/): its file is lost, so the art is drawn into
    // today's viewer over the demo sketch, which has the same four layers.
    name: "sketch-layers",
    crop: 900,
    open: async (p) => {
      const sketch = readFileSync("../parsers/spd/tests/fixtures/layers_hidden.spd");
      await p.route((u) => u.pathname.startsWith("/file/"), (r) => r.fulfill({ status: 200, body: sketch, contentType: "application/octet-stream" }));
      await p.goto("/#/note/174");
      await settle(p);
      const layers = p.locator(".viewer--spd .viewer__bar").getByRole("button", { name: "Layers" });
      if ((await layers.getAttribute("aria-pressed")) !== "true") await layers.click();
      await p.locator(".viewer--spd .spd-layer").nth(3).waitFor();
      // As in the drawing: every layer shown, at full opacity, through the panel's own controls.
      const rows = p.locator(".viewer--spd .spd-layer");
      for (let i = 0; i < 4; i++) {
        const eye = rows.nth(i).locator("button[aria-pressed]");
        if ((await eye.count()) && (await eye.getAttribute("aria-pressed")) === "false") await eye.click();
        // Full opacity, the keyboard's way: End on the slider.
        const bar = rows.nth(i).getByRole("slider", { name: "Opacity" });
        if (await bar.count()) {
          await bar.focus();
          await p.keyboard.press("End");
        }
      }
      await p.mouse.move(0, 0);
      const art = (f: string) => `data:image/png;base64,${readFileSync(`tests/screenshots/art/${f}`).toString("base64")}`;
      await p.evaluate(async (a) => {
        const load = (src: string) => new Promise<HTMLImageElement>((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = src; });
        const [page, l3, l2, l1] = await Promise.all([a.page, a.l3, a.l2, a.l1].map(load));
        // The page: one picture in place of the layer canvases, at the drop's own shape.
        const wrap = document.querySelector<HTMLElement>(".viewer--spd .spd-canvas-wrap")!;
        const h = wrap.getBoundingClientRect().height;
        wrap.style.width = `${Math.round((h * page.naturalWidth) / page.naturalHeight)}px`;
        for (const c of wrap.querySelectorAll("canvas")) (c as HTMLElement).style.display = "none";
        const img = document.createElement("img");
        img.src = page.src;
        img.style.cssText = "display:block;width:100%;height:100%";
        wrap.append(img);
        // Each layer's thumbnail.
        const rows = [...document.querySelectorAll(".viewer--spd .spd-layer")];
        [l3, l2, l1].forEach((t, i) => {
          const c = rows[i]!.querySelector("canvas")!;
          const ctx = c.getContext("2d")!;
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(t, 0, 0, c.width, c.height);
        });
        const title = document.querySelector(".viewer--spd .viewer__title b");
        if (title) title.textContent = "Ink drop";
      }, { page: art("drop-page.png"), l3: art("drop-layer3.png"), l2: art("drop-layer2.png"), l1: art("drop-layer1.png") });
    },
  },
  {
    name: "history",
    crop: 640,
    open: async (p) => {
      await p.goto("/#/note/192");
      await settle(p);
      await p.locator(".reader__bar").locator('[aria-label$="history"]').click();
    },
  },
  {
    name: "search",
    crop: 420,
    open: async (p) => {
      await mockSearchIndex(p, { rows: ROWS, documents: DOCS });
      await mockDocText(p, TEXT);
      await p.goto("/");
      await settle(p);
      await p.getByRole("searchbox", { name: "Search notes" }).fill("desert");
      await p.locator(".card--result").first().waitFor();
    },
  },
  { name: "pdf", open: async (p) => { await servePdf(p); await p.goto("/#/note/178"); await settle(p); } },
  { name: "bin",
    crop: 720, open: async (p) => { await p.goto("/#/bin"); await settle(p); } },
  { name: "todo",
    crop: 700, open: async (p) => { await p.goto("/#/todo/all"); await settle(p); } },
  {
    // The Server panel: memory, disk, the bin's window, the last backup and every backup folder.
    name: "admin-server",
    admin: true,
    element: ".admin-server",
    open: async (p) => {
      await p.goto("/#/admin");
      await settle(p);
      await p.getByLabel("Password").fill("inkhold"); // the fake console's (src/api/fakeAdmin.ts)
      await p.getByRole("button", { name: "Unlock console" }).click();
      await p.locator(".admin-backups").waitFor();
    },
  },
  { name: "phone-library", phone: true, open: async (p) => { await p.goto("/#/folder/note"); await settle(p); } },
  { name: "phone-reader", phone: true, open: async (p) => { await p.goto("/#/note/191"); await settle(p); } },
];

for (const shot of SHOTS) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${shot.name} ${scheme}`, () => {
      test.use(
        shot.phone
          ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme }
          : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: scheme },
      );
      test("shot", async ({ page }) => {
        // The demo's real notebooks (src/api/demoNotes.ts).
        await page.addInitScript(() => localStorage.setItem("sn.demo-notes", "1"));
        if (shot.admin) {
          await mockApi(page, { "user/me": { json: { success: true, email: "ana@household.lan", isAdmin: true, mustChangePassword: false } } });
        } else {
          await signedIn(page);
        }
        await shot.open(page);
        await freezeMotion(page);
        // No focus ring left on whatever was clicked last.
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.waitForTimeout(600);
        const clip = shot.crop ? { x: 232, y: 0, width: 1440 - 232, height: shot.crop } : undefined;
        const path = `${OUT}/${shot.name}-${scheme}.png`;
        if (shot.element) {
          // The element with a margin of the page around it, so nothing touches the edge.
          await page.locator(shot.element).evaluate((e) => e.scrollIntoView({ block: "center" }));
          const box = (await page.locator(shot.element).boundingBox())!;
          await page.screenshot({ path, clip: { x: box.x - 24, y: box.y - 20, width: box.width + 48, height: box.height + 40 } });
        } else await page.screenshot({ path, clip });
      });
    });
  }
}
