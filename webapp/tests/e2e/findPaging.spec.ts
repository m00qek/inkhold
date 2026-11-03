// Find in note: paging and repaint.

import { test, expect, type Page } from "@playwright/test";
import { freezeMotion, contrastRatio, paintedColours } from "./helpers/app";
import { fakeFileHash } from "../../src/api/fake";

// Fixture: `141` has 14 recognised pages (all but index 2, 5, 8…), each with "budget"
// twice (28 total). "witches" is on recognised odd indices only (1, 3, 7, 9, 13, 15, 19),
// so never on page 1. Both come from `helpers/docText.ts` and the fake's word boxes.
import { findBar, findField, findToggle, counter, ovals, badges, settles, openNote } from "./find.shared";

test.describe("find in note", () => {
  // The badge inverts, so check both schemes.
  for (const scheme of ["light", "dark"] as const) {
    test(`the counter and the filmstrip badges stay legible in ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openNote(page);
      await findToggle(page).click();
      await findField(page).fill("budget");
      await settles(page, "1 of 28");
      await freezeMotion(page);

      const count = await paintedColours(counter(page));
      expect(contrastRatio(count.color, count.background)).toBeGreaterThan(4.5);

      const badge = await paintedColours(badges(page).first());
      expect(contrastRatio(badge.color, badge.background)).toBeGreaterThan(4.5);

      const stroke = await ovals(page)
        .first()
        .locator("path")
        .evaluate((el) => getComputedStyle(el).stroke);
      const sheet = await page.locator(".page").evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(contrastRatio(stroke, sheet)).toBeGreaterThan(3);
    });
  }

  test("paging by hand repaints the ovals for the page you land on", async ({ page }) => {
    await openNote(page);
    await findToggle(page).click();
    await findField(page).fill("budget");
    await settles(page, "1 of 28");
    await expect(ovals(page)).toHaveCount(2);

    await page.getByRole("button", { name: "Page 3" }).click();
    await expect(page.locator(".pager__count")).toHaveValue("3 / 20");
    await expect(ovals(page)).toHaveCount(0);
    await settles(page, /of 28$/);

    await page.getByRole("button", { name: "Page 4" }).click();
    await expect(ovals(page)).toHaveCount(2);
  });

  test("opening a different note does not carry the query or its marks across", async ({ page }) => {
    await openNote(page);
    await findToggle(page).click();
    await findField(page).fill("budget");
    await settles(page, "1 of 28");
    await expect(badges(page).first()).toBeVisible();

    await page.goto("/#/note/101");
    await expect(page.locator(".pager__count")).toHaveValue("1 / 3");
    await expect(findBar(page)).toBeHidden();
    await expect(badges(page)).toHaveCount(0);
    await expect(ovals(page)).toHaveCount(0);

    await findToggle(page).click();
    await expect(findField(page)).toHaveValue("");
    await settles(page, "");
  });

  test("find is not offered over a file that has no recognition to search", async ({ page }) => {
    // An `.epub`: no viewer and nothing for find to answer.
    await openNote(page, "/#/note/143");
    await expect(findToggle(page)).toBeHidden();
    await page.keyboard.press("ControlOrMeta+f");
    await expect(findBar(page)).toBeHidden();
  });

  // ---- the search is addressable ----
  // Find writes the URL with `replaceState`.
  test.describe("the URL carries the search", () => {
    test("a query reaches the URL, and clearing it takes it away again", async ({ page }) => {
      await openNote(page);
      await findToggle(page).click();
      await expect(page).toHaveURL(/#\/note\/141$/);

      await findField(page).fill("budget");
      await settles(page, "1 of 28");
      await expect(page).toHaveURL(/#\/note\/141\?q=budget$/);

      await findField(page).fill("");
      await expect(page).toHaveURL(/#\/note\/141$/);
    });

    test("closing find stops the URL claiming a search", async ({ page }) => {
      await openNote(page);
      await findToggle(page).click();
      await findField(page).fill("budget");
      await expect(page).toHaveURL(/\?q=budget$/);

      await page.keyboard.press("Escape");
      await expect(findBar(page)).toBeHidden();
      await expect(page).toHaveURL(/#\/note\/141$/);
    });

    // Page 4 (index 3) holds a "witches" match, so settling has no reason to move off it.
    test("a reload of a page-and-query URL restores both", async ({ page }) => {
      await openNote(page, "/#/note/141/page/4?q=witches");

      await expect(page.locator(".pager__count")).toHaveValue("4 / 20");
      await expect(findBar(page)).toBeVisible();
      await expect(findField(page)).toHaveValue("witches");
      await settles(page, "2 of 7");
      await expect(page.locator(".findbox.is-current")).toHaveCount(1);

      await page.reload();

      await expect(page.locator(".pager__count")).toHaveValue("4 / 20");
      await expect(findField(page)).toHaveValue("witches");
      await settles(page, "2 of 7");
      await expect(page.locator(".findbox.is-current")).toHaveCount(1);
    });

    // An unencoded `#` truncates the hash route; `+` encoding would mangle the space.
    test("a query with a space, a # and an accent survives the round trip", async ({ page }) => {
      const hostile = 'café #2 "R&D" budget';
      await openNote(page);
      await findToggle(page).click();
      await findField(page).fill(hostile);

      await expect(page).toHaveURL(/#\/note\/141\?q=/);
      await expect(page).not.toHaveURL(/q=caf%C3%A9 /);
      const hash = await page.evaluate(() => location.hash);
      expect(hash).not.toContain("#2");

      await page.reload();
      await expect(findBar(page)).toBeVisible();
      await expect(findField(page)).toHaveValue(hostile);
      await expect(page.locator(".reader.is-open")).toBeVisible();
    });

    test("turning the page keeps the query in the URL", async ({ page }) => {
      await openNote(page, "/#/note/141?q=witches");
      await expect(findField(page)).toHaveValue("witches");

      await page.getByRole("button", { name: "Next match" }).click();
      await expect(page).toHaveURL(/\/page\/\d+\?q=witches$/);
    });
  });
});
