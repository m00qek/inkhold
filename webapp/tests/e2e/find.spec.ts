import { test, expect, type Locator, type Page } from "@playwright/test";
import { signedIn, freezeMotion, contrastRatio, paintedColours } from "./helpers/app";
import { mockDocText, noteTextRecord, type TextRecord } from "./helpers/docText";
import { fakeFileHash } from "../../src/api/fake";

// Fixture: `141` has 14 recognised pages (all but index 2, 5, 8…), each with "budget"
// twice (28 total). "witches" is on recognised odd indices only (1, 3, 7, 9, 13, 15, 19),
// so never on page 1. Both come from `helpers/docText.ts` and the fake's word boxes.

const NOTE = "/#/note/141";

/**
 * Keyed by `fakeFileHash`. `102`, `103` and `143` are absent on purpose: find is refused
 * for them, and a fetch would surface as an error via the 404.
 */
const TEXT: Record<string, TextRecord> = {
  [fakeFileHash("141")]: noteTextRecord("Attention Is All You Need", 20),
  // Recognised from index 1, so only indices 1 and 3.
  [fakeFileHash("181")]: noteTextRecord("Recognised from page two", 4, 1),
  [fakeFileHash("144")]: noteTextRecord("Field notes — unknown device", 3),
  [fakeFileHash("101")]: noteTextRecord("Weekly review", 3),
};

const findBar = (page: Page): Locator => page.locator(".findbar");
const findField = (page: Page): Locator => page.getByRole("textbox", { name: "Find in this note" });
const findToggle = (page: Page): Locator => page.getByRole("button", { name: "Find in this note" });
const counter = (page: Page): Locator => page.locator(".findbar__count");
const ovals = (page: Page): Locator => page.locator(".page .findbox");
const badges = (page: Page): Locator => page.locator(".filmstrip__hits");

/** Generous: a cold 16 MB wasm instantiate under `fullyParallel` load can take seconds. */
async function settles(page: Page, text: string | RegExp): Promise<void> {
  await expect(counter(page)).toHaveText(text, { timeout: 20_000 });
}

async function openNote(
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

// Regression: Find was derived from the skeleton page list (`textHash: null`) and never
// recomputed, so notes recognised from page 2 (`181`) stayed unsearchable.
test.describe("the Find affordance reflects the WHOLE note, not the skeleton", () => {
  test("a note recognised only from page two still offers Find", async ({ page }) => {
    await openNote(page, "/#/note/181");

    const toggle = findToggle(page);
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute("title", "Find in this note");

    await toggle.click();
    await expect(findBar(page)).toBeVisible();
    await findField(page).fill("budget");
    await settles(page, "1 of 4");
    await expect(page.locator(".pager__count")).toHaveValue("2 / 4");
  });

  test("a note with no recognition anywhere keeps Find disabled", async ({ page }) => {
    await openNote(page, "/#/note/103");
    const toggle = findToggle(page);
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute("title", "This note has no recognised text to search");
  });
});

test.describe("find in note", () => {
  test("the bar is revealed by the toolbar control and by Ctrl+F, and costs nothing until used", async ({ page }) => {
    await openNote(page);
    await expect(findBar(page)).toBeHidden();

    // Not a hover reveal: phones never fire `:hover`.
    await expect(findToggle(page)).toBeVisible();
    const box = await findToggle(page).boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(24);
    expect(box!.height).toBeGreaterThanOrEqual(24);

    await findToggle(page).click();
    await expect(findBar(page)).toBeVisible();
    await expect(findField(page)).toBeFocused();
    await expect(findToggle(page)).toHaveAttribute("aria-pressed", "true");
    await settles(page, "");
    await expect(ovals(page)).toHaveCount(0);

    await findToggle(page).click();
    await expect(findBar(page)).toBeHidden();

    await page.keyboard.press("ControlOrMeta+f");
    await expect(findBar(page)).toBeVisible();
    await expect(findField(page)).toBeFocused();
  });

  test("Ctrl+F is claimed ONLY while a note is open", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();

    await page.keyboard.press("ControlOrMeta+f");
    await expect(findBar(page)).toBeHidden();
  });

  test("Esc closes find BEFORE it closes the reader", async ({ page }) => {
    await openNote(page);
    await findToggle(page).click();
    await expect(findBar(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(findBar(page)).toBeHidden();
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await expect(page).toHaveURL(/#\/note\/141$/);

    await page.keyboard.press("Escape");
    await expect(page.locator(".reader.is-open")).toBeHidden();
  });

  test("the field looks like a field: a border, its own ground, and a focus ring", async ({ page }) => {
    await openNote(page);
    await findToggle(page).click();
    await freezeMotion(page);

    // Blur first, or resting and focused reads are the same.
    await findField(page).blur();
    const style = await findField(page).evaluate((el) => {
      const cs = getComputedStyle(el);
      const bar = getComputedStyle(el.closest(".findbar")!);
      return {
        borderWidth: Number.parseFloat(cs.borderTopWidth),
        borderColour: cs.borderTopColor,
        background: cs.backgroundColor,
        barBackground: bar.backgroundColor,
        radius: Number.parseFloat(cs.borderTopLeftRadius),
      };
    });
    expect(style.borderWidth).toBeGreaterThan(0);
    expect(style.radius).toBeGreaterThan(0);
    expect(style.background).not.toBe(style.barBackground);
    expect(style.background).not.toBe("rgba(0, 0, 0, 0)");

    await findField(page).click();
    const focused = await findField(page).evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(focused).not.toBe(style.borderColour);

    await expect(page.locator(".findbar__field svg")).toBeVisible();
  });

  test("typing circles the matched words on the page, as drawn strokes", async ({ page }) => {
    await openNote(page);
    await findToggle(page).click();
    await findField(page).fill("budget");
    // Ovals appear first from word boxes; `is-current` needs the counts.
    await settles(page, "1 of 28");

    await expect(ovals(page)).toHaveCount(2);

    const pageBox = (await page.locator(".page").boundingBox())!;
    for (const oval of await ovals(page).all()) {
      const box = (await oval.boundingBox())!;
      // A millimetre read as a pixel would pile the boxes at the origin.
      expect(box.width).toBeGreaterThan(4);
      expect(box.height).toBeGreaterThan(4);
      expect(box.x).toBeGreaterThanOrEqual(pageBox.x - 2);
      expect(box.y).toBeGreaterThanOrEqual(pageBox.y - 2);
      expect(box.x + box.width).toBeLessThanOrEqual(pageBox.x + pageBox.width + 2);
    }

    const path = ovals(page).first().locator("path");
    const read = () =>
      path.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          fill: cs.fill,
          strokeWidth: cs.strokeWidth,
          vectorEffect: cs.vectorEffect,
          d: el.getAttribute("d") ?? "",
          preserve: el.closest("svg")!.getAttribute("preserveAspectRatio"),
        };
      });
    // Polled: the layer is rebuilt as results settle, and a detached node reads "" styles.
    await expect.poll(async () => (await read()).fill, { timeout: 10_000 }).not.toBe("");
    const drawn = await read();
    expect(drawn.fill).toBe("none");
    expect(drawn.vectorEffect).toBe("non-scaling-stroke");
    expect(drawn.preserve).toBe("none");
    // The loop overshoots rather than closing with `Z`.
    expect(drawn.d.trim().toUpperCase()).not.toMatch(/Z$/);
    expect(drawn.d.length).toBeGreaterThan(60);

    // One `evaluate`, polled: separate reads can straddle a repaint (this flaked under load).
    await expect(page.locator(".findbox.is-current path")).toHaveCount(1);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const cur = document.querySelector(".findbox.is-current path");
          const other = document.querySelector(".findbox:not(.is-current) path");
          if (!cur || !other) return null;
          const w = (el: Element): number => Number.parseFloat(getComputedStyle(el).strokeWidth);
          const c = w(cur);
          const o = w(other);
          return Number.isFinite(c) && Number.isFinite(o) ? c > o : null;
        }),
      )
      .toBe(true);
  });

  // Asserted over the counter's DOM history. There is no "N of M+" floor state; until the
  // index is built, phase 1 claims only the current page. Held so the window is real.
  test("the counter claims no total while it is counting, then settles to the exact one", async ({ page }) => {
    await openNote(page, NOTE, { textDelayMs: 400 });
    await findToggle(page).click();

    await page.evaluate(() => {
      const el = document.querySelector(".findbar__count")!;
      const seen: string[] = [];
      (window as unknown as { __counter: string[] }).__counter = seen;
      new MutationObserver(() => seen.push(el.textContent ?? "")).observe(el, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    });

    await findField(page).fill("budget");
    await settles(page, "1 of 28"); // the exact count

    const history = await page.evaluate(() => (window as unknown as { __counter: string[] }).__counter);

    const firstCount = history.findIndex((t) => /\d+ of \d+/.test(t));
    expect(firstCount).toBeGreaterThan(0);
    for (const text of history.slice(0, firstCount)) {
      expect(text).not.toMatch(/\d+ of \d+/);
    }
    expect(history.slice(0, firstCount).some((t) => /on this page/.test(t))).toBe(true);
    expect(history.slice(0, firstCount).some((t) => /searching 14 pages/.test(t))).toBe(true);

    // NO FLOOR EVER APPEARED. The absence is asserted rather than assumed: a
    // "N of M+" reaching the counter again would mean somebody had reintroduced a
    // provisional total over an answer that is exact by construction.
    expect(history.filter((t) => /\d+ of \d+\+/.test(t))).toEqual([]);

    expect(history[history.length - 1]).toBe("1 of 28");
    for (const text of history.slice(firstCount)) expect(text).toBe("1 of 28");
  });

  // Content-addressed and `immutable`, so fetched once; a regression costs a round trip per keystroke.
  test("the document's text is fetched once, on the first find, and reused after that", async ({ page }) => {
    const text = await openNote(page);
    const md5Requests = () => text.count();

    await findToggle(page).click();
    await expect(findBar(page)).toBeVisible();
    expect(md5Requests()).toBe(0);

    await findField(page).fill("budget");
    await settles(page, "1 of 28");
    expect(md5Requests()).toBe(1);

    await findField(page).fill("witches");
    await settles(page, "1 of 7");
    expect(md5Requests()).toBe(1);
  });

  test("stepping is disabled until the counts land, then crosses page boundaries", async ({ page }) => {
    await openNote(page);
    await findToggle(page).click();

    const next = page.getByRole("button", { name: "Next match" });
    const prev = page.getByRole("button", { name: "Previous match" });
    await expect(next).toBeDisabled();

    await findField(page).fill("budget");
    await settles(page, "1 of 28");
    await expect(next).toBeEnabled();
    await expect(prev).toBeEnabled();

    await next.click();
    await settles(page, "2 of 28");
    await expect(page.locator(".pager__count")).toHaveValue("1 / 20");

    await next.click();
    await settles(page, "3 of 28");
    await expect(page.locator(".pager__count")).toHaveValue("2 / 20");
    await expect(ovals(page)).toHaveCount(2);

    await prev.click();
    await prev.click();
    await prev.click();
    await settles(page, "28 of 28");
    await expect(page.locator(".pager__count")).toHaveValue("20 / 20");
  });

  // Regression: a match off the current page showed `1 of 1` with nothing circled and Next inert.
  test("settling GOES TO the match when it is not on the page in front of you", async ({ page }) => {
    await openNote(page);
    await findToggle(page).click();
    await expect(page.locator(".pager__count")).toHaveValue("1 / 20");

    await findField(page).fill("witches");
    await settles(page, "1 of 7");

    await expect(page.locator(".pager__count")).toHaveValue("2 / 20");
    await expect(ovals(page)).toHaveCount(1);
    await expect(page.locator(".findbox.is-current")).toHaveCount(1);

    const next = page.getByRole("button", { name: "Next match" });
    await next.click();
    await settles(page, "2 of 7");
    await expect(page.locator(".pager__count")).toHaveValue("4 / 20");
    await expect(ovals(page)).toHaveCount(1);

    await page.getByRole("button", { name: "Previous match" }).click();
    await page.getByRole("button", { name: "Previous match" }).click();
    await settles(page, "7 of 7");
    await expect(page.locator(".pager__count")).toHaveValue("20 / 20");
    await expect(ovals(page)).toHaveCount(1);
  });

  // Fuzzy is the wasm's `idx_fuzzy`, which fires only when the exact query matched nothing,
  // and is opt-in via "search similar".
  test("a typo is OPT-IN: 'search similar' reveals the close matches, marked approximate", async ({ page }) => {
    await openNote(page);
    await findToggle(page).click();

    await findField(page).fill("witches");
    await settles(page, "1 of 7");
    await expect(page.locator(".findbar__fuzzy")).toBeHidden();
    const exactPages = await badges(page).count();

    await findField(page).fill("witchez");
    await settles(page, "No matches");
    await expect(page.locator(".findbar__ask")).toBeVisible();
    await expect(page.locator(".findbar__fuzzy")).toBeHidden();
    await expect(badges(page)).toHaveCount(0);
    await expect(ovals(page)).toHaveCount(0);

    // The oval is round "witches", the word counted.
    await page.locator(".findbar__ask").click();
    await settles(page, "1 of 7");
    expect(await badges(page).count()).toBe(exactPages);
    await expect(page.locator(".pager__count")).toHaveValue("2 / 20");
    await expect(page.locator(".findbar__fuzzy")).toBeVisible();
    await expect(page.locator(".findbar__fuzzy")).toHaveCount(1);
    await expect(page.locator(".findbar__ask")).toBeHidden();
    await expect(ovals(page)).toHaveCount(1);
    await expect(badges(page).first()).toHaveText("1");
  });

  // Regression: `.filmstrip__page` was not `position: relative`, so badges stacked in a corner.
  test("filmstrip badges carry per-page counts AND sit on their own thumbnail", async ({ page }) => {
    await openNote(page);
    await findToggle(page).click();
    await findField(page).fill("budget");
    await settles(page, "1 of 28");

    await expect(badges(page).first()).toBeVisible();
    await expect(badges(page).first()).toHaveText("2");

    const first = badges(page).first();
    const badgeBox = (await first.boundingBox())!;
    const ownerBox = (await page.locator(".filmstrip__page").first().boundingBox())!;

    expect(badgeBox.x).toBeGreaterThanOrEqual(ownerBox.x - 1);
    expect(badgeBox.y).toBeGreaterThanOrEqual(ownerBox.y - 1);
    expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(ownerBox.x + ownerBox.width + 1);
    expect(badgeBox.y + badgeBox.height).toBeLessThanOrEqual(ownerBox.y + ownerBox.height + 1);
    expect(badgeBox.width).toBeGreaterThan(8);
    expect(badgeBox.height).toBeGreaterThan(8);

    const third = page.locator(".filmstrip__page").nth(2);
    await expect(third.locator(".filmstrip__hits")).toHaveCount(0);

    await page.getByRole("button", { name: "Close find" }).click();
    await expect(badges(page)).toHaveCount(0);
    await expect(ovals(page)).toHaveCount(0);
  });

  test("an unrecognised note does not offer find at all", async ({ page }) => {
    await openNote(page, "/#/note/102");
    const toggle = findToggle(page);
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute("title", /no recognised text/i);
    await expect(page.locator(".findbar")).toBeHidden();
  });

  test("a recognised note still offers it", async ({ page }) => {
    await openNote(page);
    await expect(findToggle(page)).toBeEnabled();
  });

  test("a recognised note with no match says 'No matches' — a real absence", async ({ page }) => {
    await openNote(page);
    await findToggle(page).click();
    await findField(page).fill("zzzznotawordanywhere");
    await settles(page, "No matches");
    await expect(ovals(page)).toHaveCount(0);
  });

  // `pxPerMm === null`: counts come from the transcript, but ovals cannot be placed.
  test("an unverified device scale draws no ovals and says why", async ({ page }) => {
    await openNote(page, "/#/note/144");
    await findToggle(page).click();
    await findField(page).fill("budget");

    await settles(page, /\d+ of \d+/);
    await expect(ovals(page)).toHaveCount(0);
    await expect(page.locator(".findbar__note")).toBeVisible();
    await expect(badges(page)).not.toHaveCount(0);
  });

  test("the ovals follow the page and survive a zoom re-measure", async ({ page }) => {
    await openNote(page);
    await findToggle(page).click();
    await findField(page).fill("budget");
    await expect(ovals(page)).toHaveCount(2);
    await freezeMotion(page);

    const before = (await ovals(page).first().boundingBox())!;
    const pageBefore = (await page.locator(".page").boundingBox())!;

    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect.poll(async () => (await page.locator(".page").boundingBox())!.width).toBeGreaterThan(
      pageBefore.width,
    );
    await expect(ovals(page)).toHaveCount(2);

    // Waits for the oval, which is cleared and repainted, so it can be absent for a frame;
    // 0 stands in for a null box so the poll retries.
    await expect
      .poll(async () => (await ovals(page).first().boundingBox())?.width ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(before.width);

    const after = (await ovals(page).first().boundingBox())!;
    const pageAfter = (await page.locator(".page").boundingBox())!;
    expect(after.width).toBeGreaterThan(before.width);
    const relBefore = (before.x - pageBefore.x) / pageBefore.width;
    const relAfter = (after.x - pageAfter.x) / pageAfter.width;
    expect(Math.abs(relAfter - relBefore)).toBeLessThan(0.02);
  });

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
