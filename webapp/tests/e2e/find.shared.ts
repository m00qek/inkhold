// Helpers shared by the find tests.

import { expect, type Locator, type Page } from "@playwright/test";
import { signedIn, freezeMotion } from "./helpers/app";
import { mockDocText, noteTextRecord, type TextRecord } from "./helpers/docText";
import { fakeFileHash } from "../../src/api/fake";

// Fixture: `141` has 14 recognised pages (all but index 2, 5, 8…), each with "budget"
// twice (28 total). "witches" is on recognised odd indices only (1, 3, 7, 9, 13, 15, 19),
// so never on page 1. Both come from `helpers/docText.ts` and the fake's word boxes.

export const NOTE = "/#/note/141";

/**
 * Keyed by `fakeFileHash`. `102`, `103` and `143` are absent on purpose: find is refused
 * for them, and a fetch would surface as an error via the 404.
 */
export const TEXT: Record<string, TextRecord> = {
  [fakeFileHash("141")]: noteTextRecord("Attention Is All You Need", 20),
  // Recognised from index 1, so only indices 1 and 3.
  [fakeFileHash("181")]: noteTextRecord("Recognised from page two", 4, 1),
  [fakeFileHash("144")]: noteTextRecord("Field notes — unknown device", 3),
  [fakeFileHash("101")]: noteTextRecord("Weekly review", 3),
};

export const findBar = (page: Page): Locator => page.locator(".findbar");

export const findField = (page: Page): Locator => page.getByRole("textbox", { name: "Find in this note" });

export const findToggle = (page: Page): Locator => page.getByRole("button", { name: "Find in this note" });

export const counter = (page: Page): Locator => page.locator(".findbar__count");

export const ovals = (page: Page): Locator => page.locator(".page .findbox");

export const badges = (page: Page): Locator => page.locator(".filmstrip__hits");

/** Generous: a cold 16 MB wasm instantiate under `fullyParallel` load can take seconds. */
export async function settles(page: Page, text: string | RegExp): Promise<void> {
  await expect(counter(page)).toHaveText(text, { timeout: 20_000 });
}

export async function openNote(
  page: Page,
  route = NOTE,
  opts: { textDelayMs?: number } = {},
): Promise<{ count(md5?: string): number }> {
  await signedIn(page);
  // After `signedIn`, so it wins over `mockApi`'s catch-all; text is fetched on first find only.
  const hits = await mockDocText(page, TEXT, { delayMs: opts.textDelayMs });
  await page.goto(route);
  await expect(page.locator(".reader.is-open")).toBeVisible();
  await freezeMotion(page);
  return hits;
}
