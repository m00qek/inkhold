// Helpers shared by the history tests.

import { type Page, type Locator } from "@playwright/test";
import { fakeFileHash } from "../../src/api/fake";

// Fixture: `141` is a 20-page note recognised except at indices 2, 5, 8…; the fake
// gives every `.note` three versions, newest-first.

// A popover portaled into `.menu-portal`, not a `<dialog>`; a row click previews.
export const menu = (page: Page): Locator => page.locator(".vh");

export const rows = (page: Page): Locator => page.locator(".vh-row");
