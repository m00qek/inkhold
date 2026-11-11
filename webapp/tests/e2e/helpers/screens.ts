import type { Page } from "@playwright/test";

// The screens and sizes the semantic guard (`semantics.spec.ts`) and the
// pixel comparison (`visual.spec.ts`) both visit.

/** On a phone the rail is a drawer, the bar's tools open from ⋯, search from the tab bar. */
async function phoneOpens(page: Page, button: string): Promise<void> {
  if ((page.viewportSize()?.width ?? 1280) >= 700) return;
  await page.locator(`.topbar__phone[aria-label="${button}"]`).click();
}
async function railLink(page: Page, name: string) {
  await phoneOpens(page, "Places");
  await page.locator(".rail").getByText(name, { exact: true }).click();
}
async function searchFor(page: Page, q: string) {
  if ((page.viewportSize()?.width ?? 1280) < 700) {
    await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Search" }).click();
  }
  await page.getByRole("searchbox").first().fill(q);
}
/** A bar tool; on a phone it is a row of the ⋯ menu. */
async function barButton(page: Page, name: string) {
  if ((page.viewportSize()?.width ?? 1280) < 700) {
    await phoneOpens(page, "More");
    await page.getByRole("menu").getByRole("menuitem", { name }).click();
    return;
  }
  await page.getByRole("button", { name }).click();
}

export interface Screen {
  name: string;
  /** Its own title; the library's root may say just "Inkhold". */
  ownTitle: boolean;
  open(page: Page): Promise<void>;
}

/**
 * Waits until the folder walk is done and the page stops changing: the number
 * of elements and the page's text hold for a second (data arriving adds rows
 * and changes counts). At most 10 s for the quiet part.
 */
export async function settle(page: Page): Promise<void> {
  // Every screen here is inside the app: wait for the rail to be drawn first,
  // or the checks below see no rail and skip their waits (a deep link can
  // take a moment to draw it).
  await page.locator(".rail").waitFor({ state: "attached", timeout: 15_000 });
  // The folder walk adds rail rows with pauses longer than the quiet window:
  // the rail says when it is done.
  const folders = page.locator('[aria-label="Folders"][aria-busy="false"]');
  if ((await page.locator('[aria-label="Folders"]').count()) > 0) await folders.waitFor({ state: "attached", timeout: 15_000 });
  // The walk can start late on a deep link (admin, a note): wait for a folder
  // the test data has, which only the finished walk lists.
  if ((await page.locator(".rail").count()) > 0) await page.locator(".rail .nav__item", { hasText: "Files" }).first().waitFor({ state: "attached", timeout: 15_000 });
  // To-Do joins the rail when its first read lands, apart from the walk.
  if ((await page.locator(".rail").count()) > 0) await page.locator(".rail .nav__item", { hasText: "To-Do" }).first().waitFor({ state: "attached", timeout: 15_000 });
  // A preview learns its shape when its image loads, moving the card's text:
  // measure after every image is in.
  await page.waitForFunction(() => [...document.images].every((i) => i.complete), undefined, { timeout: 15_000 }).catch(() => {});
  let last = "";
  let still = 0;
  for (let i = 0; i < 100 && still < 10; i++) {
    await page.waitForTimeout(100);
    // Elements and text: a count arriving changes "0" to "5", not the tree.
    const n = await page.evaluate(() => `${document.getElementsByTagName("*").length}:${document.body.innerText}`);
    still = n === last ? still + 1 : 0;
    last = n;
  }
}

export const SCREENS: Screen[] = [
  { name: "library", ownTitle: false, open: async (p) => { await p.goto("/"); } },
  {
    name: "folder",
    ownTitle: true,
    open: async (p) => {
      await p.goto("/");
      await railLink(p, "Files");
    },
  },
  {
    name: "search",
    ownTitle: true,
    open: async (p) => {
      await p.goto("/");
      await searchFor(p, "budget");
      await settle(p);
      await p.locator(".coverage summary").click();
    },
  },
  { name: "reader", ownTitle: true, open: async (p) => { await p.goto("/#/note/101"); } },
  { name: "pdf", ownTitle: true, open: async (p) => { await p.goto("/#/note/178"); } },
  { name: "txt", ownTitle: true, open: async (p) => { await p.goto("/#/note/177"); } },
  { name: "spd", ownTitle: true, open: async (p) => { await p.goto("/#/note/174"); } },
  { name: "todo-overview", ownTitle: true, open: async (p) => { await p.goto("/#/todo"); } },
  { name: "todo-list", ownTitle: true, open: async (p) => { await p.goto("/#/todo/list/" + "1".padStart(32, "0")); } },
  {
    name: "todo-task-menu",
    ownTitle: true,
    open: async (p) => {
      await p.goto("/#/todo/list/" + "1".padStart(32, "0"));
      await p.getByRole("button", { name: /^Actions for / }).first().click();
    },
  },
  {
    name: "todo-new-list-dialog",
    ownTitle: true,
    open: async (p) => {
      await p.goto("/#/todo");
      await barButton(p, "New list");
    },
  },
  { name: "digest", ownTitle: true, open: async (p) => { await p.goto("/#/digest"); } },
  { name: "digest-open", ownTitle: true, open: async (p) => { await p.goto("/#/digest/category/c0ffee00000000000000000000000001/d/1"); } },
  { name: "digest-sources", ownTitle: true, open: async (p) => { await p.goto("/#/digest/sources"); } },
  {
    name: "reader-digests",
    ownTitle: true,
    open: async (p) => {
      await p.goto("/#/note/121");
      // A phone keeps it under ⋯, which lists it once the note's digests are in.
      if ((p.viewportSize()?.width ?? 1280) < 700) {
        await p.locator('[aria-controls="note-digests-panel"]:not([disabled])').waitFor({ state: "attached" });
        await p.locator(".reader__bar").getByRole("button", { name: "More" }).click();
        await p.locator(".menu__pop--float.is-open").getByRole("menuitemcheckbox", { name: "Digests" }).click();
        return;
      }
      await p.getByRole("button", { name: "Digests", exact: true }).click();
    },
  },
  {
    name: "digest-comment",
    ownTitle: true,
    open: async (p) => {
      await p.goto("/#/digest/d/1");
      await p.getByRole("button", { name: "Edit" }).click();
    },
  },
  {
    name: "card-menu",
    ownTitle: true,
    open: async (p) => {
      await p.goto("/");
      await railLink(p, "Files");
      const card = p.locator(".card", { hasText: "Meeting notes" });
      await card.hover();
      await card.locator(".card__more").click();
    },
  },
  { name: "bin", ownTitle: true, open: async (p) => { await p.goto("/#/bin"); } },
  { name: "admin", ownTitle: true, open: async (p) => { await p.goto("/#/admin"); } },
  { name: "account", ownTitle: true, open: async (p) => { await p.goto("/#/account"); } },
];


export const VARIANTS = [
  { name: "desktop-light", width: 1280, height: 900, dark: false, touch: false, minTarget: 24 },
  { name: "desktop-dark", width: 1280, height: 900, dark: true, touch: false, minTarget: 24 },
  { name: "phone", width: 390, height: 844, dark: false, touch: true, minTarget: 44 },
  { name: "tablet", width: 820, height: 1180, dark: false, touch: true, minTarget: 44 },
  // A desktop-wide layout under a finger: the full rail, touch-sized targets.
  { name: "tablet-landscape", width: 1180, height: 820, dark: false, touch: true, minTarget: 44 },
] as const;
