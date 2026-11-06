import type { Page } from "@playwright/test";

// The screens and sizes the semantic guard (`semantics.spec.ts`) and the
// pixel comparison (`visual.spec.ts`) both visit.

export interface Screen {
  name: string;
  /** Its own title; the library's root may say just "Inkhold". */
  ownTitle: boolean;
  open(page: Page): Promise<void>;
}

export const settle = (page: Page) => page.waitForTimeout(700);

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
