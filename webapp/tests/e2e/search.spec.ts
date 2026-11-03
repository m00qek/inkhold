import { test, expect, type Locator, type Page } from "@playwright/test";
import { signedIn, contrastRatio, cardButton, freezeMotion, paintedColours, railSettled } from "./helpers/app";
import { mockDocText, noteTextRecord, type TextRecord } from "./helpers/docText";
import { mockSearchIndex, noteTermsDocument, type FixtureManifestRow } from "./helpers/searchIndex";
import { fakeFileHash } from "../../src/api/fake";

// Specs that want the transcript half mock it with `helpers/searchIndex.ts`; the rest
// exercise the name half, since the fake ships no index and answers zero documents.
// Row wording is pinned in `tests/unit/resultRow.test.ts`.

/** A result row: the library's own card, in its search variant. */
function results(page: Page): Locator {
  return page.locator(".card--result");
}

function searchBox(page: Page): Locator {
  return page.getByRole("searchbox", { name: "Search notes" });
}

/** The row's quiet metadata: how many pages of that document the query reached. */
function matchLine(row: Locator): Locator {
  return row.locator(".card__matches");
}

/** "Aurora" is in `121`'s name and opens every recognised page's transcript: four pages. */
const TEXT: Record<string, TextRecord> = {
  [fakeFileHash("121")]: noteTextRecord("Project Aurora — kickoff", 6),
};

// --- index fixture ---
// `updatedAt`s are constants: only their order is read, and the descending rule stays checkable.
const INDEXED = [
  { id: "121", name: "Project Aurora — kickoff", pages: 6, updatedAt: 1_700_000_000 },
  { id: "141", name: "Attention Is All You Need", pages: 20, updatedAt: 1_699_000_000 },
  { id: "161", name: "Unsorted — meeting doodles", pages: 2, updatedAt: 1_698_000_000 },
] as const;

/** Tier-1 rows, so the offline-text prefetch is part of the path under test. */
const INDEX_ROWS: FixtureManifestRow[] = INDEXED.map((d) => ({
  md5: fakeFileHash(d.id),
  fileId: Number(d.id),
  tier: "note",
  updatedAt: d.updatedAt,
  indexVersion: 1,
  derivation: "derived",
}));

/** Folded from the same generator the `text/<md5>` mock serves. */
const INDEX_DOCS = Object.fromEntries(
  INDEXED.map((d) => [fakeFileHash(d.id), noteTermsDocument(fakeFileHash(d.id), d.name, d.pages)]),
);

const INDEX_TEXT: Record<string, TextRecord> = Object.fromEntries(
  INDEXED.map((d) => [fakeFileHash(d.id), noteTextRecord(d.name, d.pages)]),
);

test.describe("universal search", () => {
  test("typing surfaces rows that mark the matched name — and carry no excerpt", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await expect(results(page)).toHaveCount(0);

    await searchBox(page).fill("Aurora");

    const first = results(page).filter({ hasText: "Project Aurora — kickoff" });
    await expect(first).toHaveCount(1);
    await expect(first.locator(".card__title")).toContainText("Project Aurora — kickoff");

    const mark = first.locator(".card__title mark");
    await expect(mark).toBeVisible();
    await expect(mark.first()).toHaveText("Aurora");
    await expect(first.locator(".card__title")).not.toContainText("&lt;");

    const marked = await mark.first().evaluate((el) => getComputedStyle(el).backgroundColor);
    const around = await first.locator(".card__title").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(marked).not.toBe(around);
  });

  test("no excerpt, no continuation control, no notice — over a query that answered", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await searchBox(page).fill("Project");

    expect(await results(page).count()).toBeGreaterThan(0);

    await expect(page.locator(".hit__snippet")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "More results" })).toHaveCount(0);
    await expect(page.locator(".hits__more")).toHaveCount(0);
    // Expansion is a fallback, never a widening, so an answered query has no notice.
    await expect(page.locator(".hits__notice")).toHaveCount(0);
  });

  // Library-wide queries need three characters; in-document find bars are not gated.
  test("a query under three characters shows a hint instead of searching; the 3rd char fires it", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);

    const box = searchBox(page);

    await box.fill("A");
    await expect(results(page)).toHaveCount(0);
    await expect(page.locator(".gallery .empty")).toContainText("at least 3 characters");
    await box.fill("Au");
    await expect(results(page)).toHaveCount(0);
    await expect(page.locator(".gallery .empty")).toContainText("at least 3 characters");

    await box.fill("Aur");
    await expect(results(page).filter({ hasText: "Project Aurora — kickoff" })).toHaveCount(1);
    await expect(page.locator(".gallery .empty")).toHaveCount(0);

    await box.fill("Au");
    await expect(results(page)).toHaveCount(0);
    await expect(page.locator(".gallery .empty")).toContainText("at least 3 characters");
  });

  // Regression: entering the search route is a hash navigation, which reset focus to
  // <body> mid-word and scrambled "Aur".
  test("the search box keeps focus and caret while typing the first characters", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);

    const box = searchBox(page);
    await box.focus();

    const activeId = () => page.evaluate(() => document.activeElement?.id ?? "");

    await box.pressSequentially("A", { delay: 10 });
    expect(await activeId()).toBe("search");
    await expect(box).toHaveValue("A");
    await expect(page.locator(".gallery .empty")).toContainText("at least 3 characters");

    await box.pressSequentially("u", { delay: 10 });
    expect(await activeId()).toBe("search");
    await expect(box).toHaveValue("Au");
    await expect(page.locator(".gallery .empty")).toContainText("at least 3 characters");

    await box.pressSequentially("r", { delay: 10 });
    expect(await activeId()).toBe("search");
    await expect(box).toHaveValue("Aur");
    await expect(results(page).filter({ hasText: "Project Aurora — kickoff" })).toHaveCount(1);
  });

  test("a note NAMED for the query in another folder is found", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await page.getByRole("navigation", { name: "Folders" }).getByText("Document", { exact: true }).click();
    await expect(cardButton(page, /Attention Is All You Need/)).toBeVisible();

    await searchBox(page).fill("Beta");

    const row = results(page).filter({ hasText: "Project Beta" });
    await expect(row).toHaveCount(1);
    await expect(row.locator(".card__title mark")).toHaveText("Beta");
    await expect(row.locator(".hit__snippet")).toHaveCount(0);
    await expect(row.locator(".card__path")).toHaveText("Note / Projects");
  });

  test("the path uses the bin's treatment, not a second one of its own", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await searchBox(page).fill("Beta");
    const path = results(page).filter({ hasText: "Project Beta" }).locator(".card__path");
    await expect(path).toBeVisible();
    await freezeMotion(page);

    // Computed colour, not class presence.
    const { path: pathColour, meta } = await path.evaluate((el) => ({
      path: getComputedStyle(el).color,
      meta: getComputedStyle(el.parentElement!).color,
    }));
    expect(pathColour).not.toBe(meta);
  });

  test("a name-only match says nothing about pages", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await searchBox(page).fill("Beta");
    const row = results(page).filter({ hasText: "Project Beta" });
    await expect(row).toHaveCount(1);
    await expect(matchLine(row)).toHaveCount(0);
  });

  test("a row offers no per-page targets", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await searchBox(page).fill("Aurora");
    const row = results(page).filter({ hasText: "Project Aurora" });
    await expect(row).toHaveCount(1);
    await freezeMotion(page);

    expect(await row.locator("button").count()).toBeLessThanOrEqual(2);
    expect(await row.locator(".pagechip").count()).toBe(0);
  });

  test("the header counts plainly, with no '+' floors", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await searchBox(page).fill("Project");
    await expect(results(page)).not.toHaveCount(0);

    const head = page.locator(".gallery .section-head");
    await expect(head).toHaveText(/^\d+ notes?$/);
    await expect(head).not.toContainText("+");
  });

  test("a result opens the note WITH find already running on the typed query", async ({ page }) => {
    await signedIn(page);
    await mockDocText(page, TEXT);
    await page.goto("/");
    await railSettled(page);
    await searchBox(page).fill("Aurora");
    const row = results(page).filter({ hasText: "Project Aurora — kickoff" });
    await expect(row).toHaveCount(1);
    await row.locator(".card__open").click();

    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
    await expect(page.locator(".reader__title")).toContainText("Project Aurora");
    // `deepLinkQuery` substitutes only where the typo ladder resolved a token.
    await expect(page).toHaveURL(/#\/note\/121(\/page\/\d+)?\?q=Aurora$/);

    await expect(page.locator(".findbar")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Find in this note" })).toHaveValue("Aurora");
    // Generous: the session's first find pays wasm instantiation and the index build.
    await expect(page.locator(".findbar__count")).toHaveText("1 of 4", { timeout: 20_000 });
    await expect(page.locator(".page .findbox.is-current")).toHaveCount(1);
  });

  // Negative half of the sweep, with no index fixture: a revived search route fails only here.
  test("no route with 'search' in its path is reached but the index's own two", async ({ page }) => {
    await signedIn(page);
    // `mockDocText` logs every search-shaped request, even ones the catch-all answers.
    const text = await mockDocText(page, TEXT);
    await page.goto("/");
    await railSettled(page);

    await searchBox(page).fill("Aurora");
    const row = results(page).filter({ hasText: "Project Aurora — kickoff" });
    await expect(row).toHaveCount(1);
    await row.locator(".card__open").click();
    await expect(page.locator(".findbar__count")).toHaveText("1 of 4", { timeout: 20_000 });

    await page.getByRole("textbox", { name: "Find in this note" }).fill("kickoff");
    await expect(page.locator(".findbar__count")).toHaveText("1 of 4", { timeout: 20_000 });

    const paths = text.searchPaths();
    expect(paths.filter((p) => p.startsWith("/api/controlplane/text/"))).toHaveLength(1);
    const strays = paths.filter(
      (p) => !p.startsWith("/api/controlplane/text/") && !p.startsWith("/api/controlplane/search-index/"),
    );
    expect(strays).toEqual([]);
  });

  // Positive half: "Endor" lives only in a transcript, so the name half cannot answer.
  // The mock decodes the `want` bitmap, checking its LSB-first order in a browser.
  test("the whole sweep, positively: manifest, stream, text/<md5>, and nothing else", async ({ page }) => {
    await signedIn(page);
    const index = await mockSearchIndex(page, { rows: INDEX_ROWS, documents: INDEX_DOCS });
    const text = await mockDocText(page, INDEX_TEXT);
    await page.goto("/");
    await railSettled(page);

    await expect.poll(() => index.streamHits(), { timeout: 20_000 }).toBe(1);
    expect(index.wanted()).toEqual([[0, 1, 2]]);

    await searchBox(page).fill("Endor");
    const row = results(page).filter({ hasText: "Project Aurora — kickoff" });
    await expect(row).toHaveCount(1);
    await expect(matchLine(row)).toHaveText("Matches on 2 pages");

    await row.locator(".card__open").click();
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
    await expect(page).toHaveURL(/#\/note\/121\/page\/2\?q=Endor$/);
    await expect(page.locator(".findbar__count")).toHaveText("1 of 2", { timeout: 20_000 });

    await page.getByRole("textbox", { name: "Find in this note" }).fill("witches");
    await expect(page.locator(".findbar__count")).toHaveText("1 of 2", { timeout: 20_000 });

    const paths = text.searchPaths();
    // `text/<md5>` is fetched by the tier-1 prefetch, so the find itself makes no request.
    expect(paths).toContain("/api/controlplane/search-index/manifest");
    expect(paths).toContain("/api/controlplane/search-index/stream");
    expect(paths).toContain(`/api/controlplane/text/${fakeFileHash("121")}`);
    const strays = paths.filter(
      (p) => !p.startsWith("/api/controlplane/text/") && !p.startsWith("/api/controlplane/search-index/"),
    );
    expect(strays).toEqual([]);
  });

  // "ednor" is a transposition one edit from "Endor" and no other fixture term is that close.
  test("a corrected query says which word it searched, and opens the viewer on it", async ({ page }) => {
    await signedIn(page);
    await mockSearchIndex(page, { rows: INDEX_ROWS, documents: INDEX_DOCS });
    await mockDocText(page, INDEX_TEXT);
    await page.goto("/");
    await railSettled(page);

    await searchBox(page).fill("ednor");
    const row = results(page).filter({ hasText: "Project Aurora — kickoff" });
    await expect(row).toHaveCount(1, { timeout: 20_000 });

    const notice = page.locator(".hits__notice");
    await expect(notice).toHaveCount(1);
    await expect(notice).toHaveText("Matched endor instead of “ednor”.");
    await expect(notice.locator(".hits__matched")).toHaveText("endor");
    await expect(page.locator(".hit__snippet")).toHaveCount(0);
    await expect(matchLine(row)).toHaveText("Matches on 2 pages");

    // The deep link carries the correction, or the viewer would find nothing.
    await row.locator(".card__open").click();
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
    await expect(page).toHaveURL(/#\/note\/121\/page\/2\?q=endor$/);
    await expect(page.getByRole("textbox", { name: "Find in this note" })).toHaveValue("endor");
    await expect(page.locator(".findbar__count")).toHaveText("1 of 2", { timeout: 20_000 });
  });

  test("a result row is reachable and openable by keyboard", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await searchBox(page).fill("Aurora");
    const row = results(page).filter({ hasText: "Project Aurora — kickoff" });
    await expect(row).toHaveCount(1);

    await row.locator(".card__open").focus();
    await expect(row.locator(".card__open")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
    await expect(page.locator(".reader__title")).toContainText("Project Aurora");
  });

  test("the page-carrying URL is truthful: a reload lands on the same page", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/121/page/4");

    await expect(page.locator(".pager__count")).toHaveValue("4 / 6");
    await page.reload();
    await expect(page.locator(".pager__count")).toHaveValue("4 / 6");
  });

  test("Back from a result returns to the library with the search still in place", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await searchBox(page).fill("Aurora");
    await expect(results(page)).not.toHaveCount(0);

    await results(page).first().locator(".card__open").click();
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();

    await page.goBack();

    await expect(page.getByRole("region", { name: "Reader" })).toBeHidden();
    await expect(page).not.toHaveURL(/#\/note\//);
    await expect(searchBox(page)).toHaveValue("Aurora");
    await expect(results(page)).not.toHaveCount(0);

    await page.goForward();
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
  });

  test("clearing the box restores the ordinary gallery", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await page.getByRole("navigation", { name: "Folders" }).getByText("Note", { exact: true }).click();
    const card = cardButton(page, /Weekly review/);
    await expect(card).toBeVisible();

    await searchBox(page).fill("Aurora");
    await expect(results(page)).not.toHaveCount(0);
    await expect(card).toHaveCount(0);

    await searchBox(page).fill("");

    await expect(card).toBeVisible();
    await expect(results(page)).toHaveCount(0);
  });

  test.describe("the breadcrumb and the folder controls over results", () => {
    test("the crumb reads just Search, with no folder ahead of it", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await railSettled(page);
      await page.getByRole("navigation", { name: "Folders" }).getByText("Note", { exact: true }).click();
      await expect(page.locator("#crumbs")).toContainText("Note");

      await searchBox(page).fill("Aurora");

      await expect(page.locator("#crumbs")).toHaveText("Search");
      await expect(page.locator("#crumbs")).not.toContainText("Note");
    });

    test("sort and the view toggle go away, and come back when the box clears", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await railSettled(page);
      await expect(page.locator("#sort")).toBeVisible();
      await expect(page.locator(".segmented")).toBeVisible();

      await searchBox(page).fill("Aurora");
      await expect(results(page)).not.toHaveCount(0);

      await expect(page.locator("#sort")).toBeHidden();
      await expect(page.locator(".segmented")).toBeHidden();

      await searchBox(page).fill("");
      await expect(page.locator("#sort")).toBeVisible();
      await expect(page.locator(".segmented")).toBeVisible();
    });
  });

  test.describe("what the empty state says about itself", () => {
    test("an unmatched query says why, without a count it no longer has", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await railSettled(page);

      await searchBox(page).fill("zzzznotawordanywhere");

      const empty = page.locator(".gallery .empty");
      await expect(empty).toContainText("No matches");
      await expect(empty).toContainText("Only notes recognised on the device are searchable.");
      await expect(empty).not.toContainText("of your");
    });

    // Pending sentences ride the live `event: index` frame, which the fake never sends;
    // they are pinned in `tests/unit/gallerySearch.test.ts`.
  });

  test("the library search box is not offered over an open reader", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/141");
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();

    await expect(searchBox(page)).toBeHidden();
    await expect(page).toHaveURL(/#\/note\/141$/);

    await page.locator(".backbtn").click();
    await expect(searchBox(page)).toBeVisible();
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`a result row and its title highlight stay legible in ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await signedIn(page);
      await page.goto("/");
      await railSettled(page);
      await searchBox(page).fill("Aurora");
      const row = results(page).filter({ hasText: "Project Aurora" });
      await expect(row.locator(".card__title")).toBeVisible();

      // The wash is translucent, so compare against the composited background.
      const { mark, over } = await row.locator(".card__title mark").first().evaluate((el) => {
        const wash = getComputedStyle(el).backgroundColor;
        let node: Element | null = el.parentElement;
        let behind = "rgb(255, 255, 255)";
        while (node) {
          const c = getComputedStyle(node).backgroundColor;
          if (c && c !== "transparent" && !/,\s*0\s*\)$/.test(c)) { behind = c; break; }
          node = node.parentElement;
        }
        const nums = (v: string) => (v.match(/[\d.]+/g) ?? []).map(Number);
        const [wr, wg, wb, wa = 1] = nums(wash);
        const [br, bg, bb] = nums(behind);
        const over = [wr * wa + br * (1 - wa), wg * wa + bg * (1 - wa), wb * wa + bb * (1 - wa)];
        return { mark: getComputedStyle(el).color, over: `rgb(${over.join(", ")})` };
      });
      expect(contrastRatio(mark, over)).toBeGreaterThanOrEqual(4.5);
    });

    test(`the row's path line stays legible in ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await signedIn(page);
      await page.goto("/");
      await railSettled(page);
      await searchBox(page).fill("Beta");
      const line = results(page).filter({ hasText: "Project Beta" }).locator(".card__path");
      await expect(line).toBeVisible();
      await freezeMotion(page);

      // Small secondary text, so it owes 4.5:1.
      const { color, background } = await paintedColours(line);
      expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
