// Helpers shared by the library tests.

import { type Locator, type Page } from "@playwright/test";
import { railSettled } from "./helpers/app";

/**
 * Waits for the tree walk first: an early click is supported but causes a delayed
 * repaint that detaches measured nodes. The sparse-tree suite drives that path explicitly.
 */
export async function openCategory(page: Page, name: string): Promise<void> {
  await railSettled(page);
  await navItem(page, name).click();
}

/** A rail anchor/subfolder located by its exact visible name (ignoring count). */
export function navItem(page: Page, name: string): Locator {
  return page
    .getByRole("navigation", { name: "Library" })
    .locator(".nav__item", { has: page.locator(".nav__name", { hasText: new RegExp(`^${name}$`) }) });
}
