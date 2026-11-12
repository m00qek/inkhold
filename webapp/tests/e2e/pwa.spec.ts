import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { note } from "./slowLink.shared";

// The installable app: it can be installed, opens, browses and searches with
// no network, never keeps a file, forgets the listings on sign-out, and offers
// a new version instead of swapping it in. Run with playwright.pwa.config.ts.

const folder = (id: string, name: string, itemCount: number) => ({ kind: "folder", id, name, itemCount });
const ME = { success: true, email: "ana@household.lan", isAdmin: false, mustChangePassword: false };
const ROOT = { folderId: null, path: [], entries: [folder("dir-note", "NOTE", 1)], syncVersion: 1 };
const NOTE_DIR = {
  folderId: "dir-note",
  path: [folder("dir-note", "NOTE", 1)],
  entries: [folder("note", "Note", 1)],
  syncVersion: 1,
};
const NOTES = {
  folderId: "note",
  path: [folder("dir-note", "NOTE", 1), folder("note", "Note", 1)],
  entries: [note("n1", "Weekly review.note")],
  syncVersion: 1,
};

const TODO = {
  enabled: true,
  lists: [],
  tasks: [{ id: "t1", title: "Comprar pão", done: false, sort: 0, sortTime: 0 }],
  waiting: false,
};

/** The backend, at the context so the worker's fetches are answered too. */
async function backend(context: BrowserContext, me: { status: number; json: unknown } = { status: 200, json: ME }): Promise<void> {
  await context.unroute("**/*").catch(() => {});
  await context.route(
    (u) => /^\/(api|note|file|thumbnail)\//.test(u.pathname),
    (route) => {
      const url = new URL(route.request().url());
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (url.pathname === "/api/user/me") return json(me.json, me.status);
      if (url.pathname === "/api/controlplane/tree") {
        const parent = url.searchParams.get("parent");
        return json(parent === "dir-note" ? NOTE_DIR : parent === "note" ? NOTES : ROOT);
      }
      if (url.pathname === "/api/controlplane/todo") return json(TODO);
      if (url.pathname === "/api/controlplane/file/metadata/n1") {
        return json({ id: "n1", name: "Weekly review.note", pages: [], fileType: "note", size: 10 });
      }
      return json({ success: true });
    },
  );
}

async function controlled(page: Page): Promise<void> {
  await page.waitForFunction(async () => {
    await navigator.serviceWorker.ready;
    return navigator.serviceWorker.controller !== null;
  });
}

const listingsKept = (page: Page) => page.evaluate(() => caches.has("inkhold-listings"));
const keptUrls = (page: Page) =>
  page.evaluate(async () => {
    const out: string[] = [];
    for (const name of await caches.keys()) {
      for (const req of await (await caches.open(name)).keys()) out.push(`${name} ${new URL(req.url).pathname}${new URL(req.url).search}`);
    }
    return out;
  });

test.beforeEach(async ({ context }) => {
  await backend(context);
});

test("the app can be installed: a manifest with a name, a start and real icons", async ({ page }) => {
  await page.goto("/?real");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBeTruthy();
  const res = await page.request.get(new URL(href!, page.url()).href);
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m).toMatchObject({ name: "Inkhold", display: "standalone", start_url: "./" });
  const sizes = m.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes} ${i.purpose}`);
  expect(sizes).toEqual(expect.arrayContaining(["192x192 any", "512x512 any", "512x512 maskable"]));
  for (const icon of m.icons) {
    const r = await page.request.get(new URL(icon.src, res.url()).href);
    expect(r.ok(), icon.src).toBe(true);
  }
});

test("with no network the app opens and the folders it has seen can be browsed", async ({ page, context }) => {
  await page.goto("/?real");
  await controlled(page);
  // Seen once while online: the root and the Note category.
  await page.goto("/?real#/folder/note");
  await expect(page.locator("#gallery").getByText("Weekly review")).toBeVisible();

  await context.setOffline(true);
  await page.goto("/#/");
  await expect(page.locator("#gallery .card--category").first()).toBeVisible();
  await page.goto("/#/folder/note");
  await expect(page.locator("#gallery").getByText("Weekly review")).toBeVisible();
  await context.setOffline(false);
});

test("with no network, search still finds the names and to-dos last seen", async ({ page, context }) => {
  await page.goto("/?real");
  await controlled(page);
  await page.goto("/?real#/folder/note");
  await expect(page.locator("#gallery").getByText("Weekly review")).toBeVisible();
  // The to-dos search keeps, in this browser.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<boolean>((resolve) => {
            const open = indexedDB.open("sn-search-items");
            open.onsuccess = () => {
              const db = open.result;
              if (!db.objectStoreNames.contains("items")) return resolve(false);
              const req = db.transaction("items").objectStore("items").getKey("todo");
              req.onsuccess = () => {
                db.close();
                resolve(req.result !== undefined);
              };
            };
          }),
      ),
    )
    .toBe(true);

  await context.setOffline(true);
  await page.goto("/#/");
  const box = page.getByRole("searchbox", { name: "Search notes, to-dos and digests" });
  await box.fill("pão");
  await expect(page.locator(".todo-hits .todo-hit__title")).toHaveText(["Comprar pão"]);
  await box.fill("weekly");
  await expect(page.locator("#gallery .card__title")).toHaveText(["Weekly review.note"]);
  await context.setOffline(false);
});

test("the device keeps the app and the listings, never a file", async ({ page }) => {
  await page.goto("/?real");
  await controlled(page);
  await page.goto("/?real#/folder/note");
  await expect(page.locator("#gallery").getByText("Weekly review")).toBeVisible();
  const urls = await keptUrls(page);
  expect(urls.some((u) => u.startsWith("inkhold-shell-") && u.endsWith(" /"))).toBe(true);
  expect(urls).toContain("inkhold-listings /api/controlplane/tree?parent=note");
  for (const u of urls.filter((x) => x.startsWith("inkhold-listings "))) {
    expect(u).toMatch(/ \/api\/(user\/me|controlplane\/(tree|bin|usage))(\?|$)/);
  }
  expect(urls.filter((u) => / \/(note|file|thumbnail)\//.test(u))).toEqual([]);
  // Of the wasm, only search's: the readers' decoders come from the server.
  expect(urls.filter((u) => /\.wasm$/.test(u)).map((u) => u.slice(u.lastIndexOf("/") + 1))).toEqual(["sqlite-core.wasm"]);
});

test("signing out leaves no listing behind", async ({ page, context }) => {
  await page.goto("/?real");
  await controlled(page);
  await page.goto("/?real#/folder/note");
  await expect(page.locator("#gallery").getByText("Weekly review")).toBeVisible();
  expect(await listingsKept(page)).toBe(true);
  await page.goto("/#/account");
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  // From here the server no longer knows the session, as after a real sign-out.
  await backend(context, { status: 401, json: { success: false } });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/#\/login/);
  await expect.poll(() => listingsKept(page)).toBe(false);
});

test("a session the server refuses takes the listings with it", async ({ page, context }) => {
  await page.goto("/?real");
  await controlled(page);
  await page.goto("/?real#/folder/note");
  await expect(page.locator("#gallery").getByText("Weekly review")).toBeVisible();
  await backend(context, { status: 401, json: { success: false } });
  await page.reload();
  await expect(page).toHaveURL(/#\/login/);
  await expect.poll(() => listingsKept(page)).toBe(false);
});

test("a new version waits until the person reloads", async ({ page }) => {
  await page.goto("/?real");
  await controlled(page);
  const before = await page.evaluate(() => caches.keys());
  // The next build, as far as the browser can tell: a different worker script.
  const file = new URL("../../dist-e2e/sw.js", import.meta.url);
  const original = readFileSync(file, "utf8");
  writeFileSync(file, original.replace(/const VERSION = "[^"]+"/, 'const VERSION = "next"'));
  try {
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
    const offer = page.getByRole("status").filter({ hasText: "A new version of Inkhold is ready." });
    await expect(offer).toBeVisible();
    // Installed beside the old one, not in charge yet.
    expect(await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r!.waiting !== null))).toBe(true);
    await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Reload" }).click()]);

    await expect.poll(() => page.evaluate(() => caches.keys())).toContain("inkhold-shell-next");
    // The old build's files are gone with it.
    const old = before.find((k) => k.startsWith("inkhold-shell-"))!;
    await expect.poll(() => page.evaluate(() => caches.keys())).not.toContain(old);
  } finally {
    writeFileSync(file, original);
  }
});

test("with no network, opening a note says it needs a connection and stays in the folder", async ({ page, context }) => {
  await page.goto("/?real");
  await controlled(page);
  await page.goto("/?real#/folder/note");
  await expect(page.locator("#gallery").getByText("Weekly review")).toBeVisible();
  await context.setOffline(true);
  await page.locator("#gallery").getByText("Weekly review").click();
  await expect(page.getByRole("status").filter({ hasText: "You're offline. Opening files, To-Do or Digest needs a connection." })).toBeVisible();
  await expect(page).toHaveURL(/#\/folder\/note$/);
  await expect(page.locator(".reader.is-open")).toHaveCount(0);
  await context.setOffline(false);
});
