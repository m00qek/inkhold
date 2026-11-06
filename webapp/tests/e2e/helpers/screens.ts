import type { Page } from "@playwright/test";

// The screens and sizes the semantic guard (`semantics.spec.ts`) and the
// pixel comparison (`visual.spec.ts`) both visit.

export interface Screen {
  name: string;
  /** Its own title; the library's root may say just "Inkhold". */
  ownTitle: boolean;
  open(page: Page): Promise<void>;
}

/**
 * Waits until the folder walk is done and the page stops changing: the number
 * of elements holds for a second (data arriving adds rows). At most 10 s
 * for the quiet part.
 */
export async function settle(page: Page): Promise<void> {
  // The folder walk adds rail rows with pauses longer than the quiet window:
  // the rail says when it is done.
  const folders = page.locator('[aria-label="Folders"][aria-busy="false"]');
  if ((await page.locator('[aria-label="Folders"]').count()) > 0) await folders.waitFor({ state: "attached", timeout: 15_000 });
  // To-Do joins the rail when its first read lands, apart from the walk.
  if ((await page.locator(".rail").count()) > 0) await page.locator(".rail .nav__item", { hasText: "To-Do" }).first().waitFor({ state: "attached", timeout: 15_000 });
  let last = -1;
  let still = 0;
  for (let i = 0; i < 100 && still < 10; i++) {
    await page.waitForTimeout(100);
    const n = await page.evaluate(() => document.getElementsByTagName("*").length);
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
      await p.locator(".rail").getByText("Files", { exact: true }).click();
    },
  },
  {
    name: "search",
    ownTitle: true,
    open: async (p) => {
      await p.goto("/");
      await p.getByRole("searchbox").first().fill("budget");
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
      await p.getByRole("button", { name: "New list" }).click();
    },
  },
  {
    name: "card-menu",
    ownTitle: true,
    open: async (p) => {
      await p.goto("/");
      await p.locator(".rail").getByText("Files", { exact: true }).click();
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
  { name: "desktop-light", width: 1280, height: 900, dark: false, minTarget: 24 },
  { name: "desktop-dark", width: 1280, height: 900, dark: true, minTarget: 24 },
  { name: "phone", width: 390, height: 844, dark: false, minTarget: 44 },
] as const;
