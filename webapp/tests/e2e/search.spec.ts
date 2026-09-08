import { test, expect, type Locator, type Page } from "@playwright/test";
import { signedIn, contrastRatio, cardButton, freezeMotion, paintedColours, railSettled } from "./helpers/app";

// ONE QUERY, ONE SCOPE, ONE LIST — and, since `golden-search.md` §6 step 6, one
// ENGINE.
//
// The library used to answer a query twice: a gallery filtered by NAME to the
// folder you were standing in, plus a separate list of transcript matches from
// the WHOLE library, each row a page with a server-rendered excerpt. Both halves
// are library-wide now and both land in one list of DOCUMENTS, and the excerpt
// is gone: a row is a card plus one quiet line saying how far into the document
// the query reached (§4.3).
//
// WHAT THIS FILE ASSERTS, AND WHAT IT CANNOT
//
// Step 6 deleted `searchText` and the fallback with it, so the transcript half
// is answered by the browser's own index — built from the terms stream, held in
// IndexedDB. This suite runs against the in-memory fake `Api` with no backend
// behind it (`helpers/app.ts`), and the fake ships no index fixture: there is no
// `search-index/manifest` and no `search-index/stream` for the sync to fetch, so
// the store stays empty and the index answers every query with zero documents.
//
// So the NAME half is what is exercisable here, and that is stated rather than
// worked around. What the name half proves is exactly what the excerpt's removal
// changed about a row — no `.hit__snippet` anywhere, no "More results" control,
// no fuzzy notice, a header that counts plainly — plus the routing, the focus
// behaviour and the deep link. The transcript half's own contract (the count
// line, its wording per file kind, the first-matching-page link) is pinned in
// `tests/unit/resultRow.test.ts` against the real card factory, and the engine's
// answers in `tests/unit/searchService.test.ts`.
//
// The sweep's own assertion — a network log holding `search-index/manifest`,
// `search-index/stream` and `text/<md5>` and nothing else — needs a fixture that
// serves those routes. It lands with §6 step 7, which is when the in-document
// routes it would also have to exclude actually go.

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

test.describe("universal search", () => {
  test("typing surfaces rows that mark the matched name — and carry no excerpt", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    // Nothing is claimed before a query.
    await expect(results(page)).toHaveCount(0);

    await searchBox(page).fill("Aurora");

    const first = results(page).filter({ hasText: "Project Aurora — kickoff" });
    await expect(first).toHaveCount(1);
    await expect(first.locator(".card__title")).toContainText("Project Aurora — kickoff");

    // The highlight is a real <mark> ELEMENT on the TITLE, not the literal text
    // "<mark>". The title is the only marked thing left: the excerpt that used
    // to carry the other marks is gone, and with it the app's only `innerHTML`
    // of server-authored text.
    const mark = first.locator(".card__title mark");
    await expect(mark).toBeVisible();
    await expect(mark.first()).toHaveText("Aurora");
    await expect(first.locator(".card__title")).not.toContainText("&lt;");

    // And it is actually highlighted — a distinct background, not inherited.
    const marked = await mark.first().evaluate((el) => getComputedStyle(el).backgroundColor);
    const around = await first.locator(".card__title").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(marked).not.toBe(around);
  });

  // THE RETIRED CONTRACT, asserted as an absence so it cannot come back by
  // accident. Each of these was a mechanism the server's answer paid for.
  test("no excerpt, no continuation control, no fuzzy notice — anywhere in a result list", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await searchBox(page).fill("Project");

    // Non-vacuity first: there really are rows, so the absences below are the
    // rule being observed rather than an empty list passing by default.
    expect(await results(page).count()).toBeGreaterThan(0);

    // The excerpt and its element (§4.3: dropped, not deferred).
    await expect(page.locator(".hit__snippet")).toHaveCount(0);
    // The cursor's "More results" — a whole local index answers whole.
    await expect(page.getByRole("button", { name: "More results" })).toHaveCount(0);
    await expect(page.locator(".hits__more")).toHaveCount(0);
    // The fuzzy notice rode `usedFuzzy` on a server response, and there is no
    // response. Nothing here is pending either, so no notice of any kind.
    await expect(page.locator(".hits__notice")).toHaveCount(0);
  });

  // The GLOBAL floor: a 1–2 char library-wide query is broad-term cost and noise,
  // so the box does not search below three characters — it shows a quiet hint. The
  // in-document find bars (find-in-note, the .txt viewer) are NOT gated; that is
  // covered in their own specs.
  test("a query under three characters shows a hint instead of searching; the 3rd char fires it", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);

    const box = searchBox(page);

    // One and two characters: no result rows, a hint instead.
    await box.fill("A");
    await expect(results(page)).toHaveCount(0);
    await expect(page.locator(".gallery .empty")).toContainText("at least 3 characters");
    await box.fill("Au");
    await expect(results(page)).toHaveCount(0);
    await expect(page.locator(".gallery .empty")).toContainText("at least 3 characters");

    // The third character crosses the floor and the search runs.
    await box.fill("Aur");
    await expect(results(page).filter({ hasText: "Project Aurora — kickoff" })).toHaveCount(1);
    await expect(page.locator(".gallery .empty")).toHaveCount(0);

    // Deleting back below the floor abandons the results and returns the hint —
    // no stale hits left standing under a query too short to have earned them.
    await box.fill("Au");
    await expect(results(page)).toHaveCount(0);
    await expect(page.locator(".gallery .empty")).toContainText("at least 3 characters");
  });

  // FOCUS SURVIVES THE ARRIVING KEYSTROKE. Typing the first character enters the
  // search route, which is a hash navigation — and a fragment matching no element
  // makes the browser reset document focus to <body>. Before the fix that dropped
  // the caret out of the box mid-word: the letters after the first landed nowhere
  // or at the wrong caret, so "Aur" typed one key at a time came out scrambled.
  // The box must keep focus, and the value the caret, across chars 1, 2 and 3 —
  // through the sub-threshold hint (1, 2) and into real results (3).
  test("the search box keeps focus and caret while typing the first characters", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);

    const box = searchBox(page);
    await box.focus();

    // The box carries an id, so `document.activeElement` is checkable by it.
    const activeId = () => page.evaluate(() => document.activeElement?.id ?? "");

    // Char 1 — the ONE that navigates. This is the keystroke the regression hit.
    await box.pressSequentially("A", { delay: 10 });
    expect(await activeId()).toBe("search");
    await expect(box).toHaveValue("A");
    await expect(page.locator(".gallery .empty")).toContainText("at least 3 characters");

    // Char 2 — still under the floor, still the hint, still focused.
    await box.pressSequentially("u", { delay: 10 });
    expect(await activeId()).toBe("search");
    await expect(box).toHaveValue("Au");
    await expect(page.locator(".gallery .empty")).toContainText("at least 3 characters");

    // Char 3 — crosses the floor into real results, focus and value intact. The
    // value being "Aur" (not "urA"/"Aru") is the caret-preservation half: each
    // character landed at the end, where it was typed.
    await box.pressSequentially("r", { delay: 10 });
    expect(await activeId()).toBe("search");
    await expect(box).toHaveValue("Aur");
    await expect(results(page).filter({ hasText: "Project Aurora — kickoff" })).toHaveCount(1);
  });

  // THE ASYMMETRY THIS CHANGE EXISTS TO REMOVE. `Project Beta` lives in
  // Note/Projects, so it used to be unreachable from anywhere else: the name
  // filter was scoped to the folder in view.
  test("a note NAMED for the query in another folder is found", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    // Stand somewhere the note is NOT.
    await page.getByRole("navigation", { name: "Folders" }).getByText("Document", { exact: true }).click();
    await expect(cardButton(page, /Attention Is All You Need/)).toBeVisible();

    await searchBox(page).fill("Beta");

    const row = results(page).filter({ hasText: "Project Beta" });
    await expect(row).toHaveCount(1);
    // Matched by NAME, so the title is what carries the highlight…
    await expect(row.locator(".card__title mark")).toHaveText("Beta");
    // …and there is no excerpt, because there are no excerpts.
    await expect(row.locator(".hit__snippet")).toHaveCount(0);
    // Library-wide results have to say where the note actually lives.
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

    // One shared rule (`.bin__path, .card__path` in the mockup), so the path is
    // set apart from the date beside it in exactly the same way. Asserting the
    // COMPUTED colour, not that a class is present: the bug this file keeps
    // catching is a rule that reads correct and renders wrong.
    const { path: pathColour, meta } = await path.evaluate((el) => ({
      path: getComputedStyle(el).color,
      meta: getComputedStyle(el.parentElement!).color,
    }));
    expect(pathColour).not.toBe(meta);
  });

  // A name-only match reached no page at all, and saying "Matches on 0 pages"
  // would make the reader parse a number to learn the title was the whole answer.
  test("a name-only match says nothing about pages", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await searchBox(page).fill("Beta");
    const row = results(page).filter({ hasText: "Project Beta" });
    await expect(row).toHaveCount(1);
    await expect(matchLine(row)).toHaveCount(0);
  });

  // The row is a ROW, not a menu. The page chips used to add one button per
  // matching page; the count line replaced them and must stay metadata.
  test("a row offers no per-page targets", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await searchBox(page).fill("Aurora");
    const row = results(page).filter({ hasText: "Project Aurora" });
    await expect(row).toHaveCount(1);
    await freezeMotion(page);

    // No buttons but the row's own opener and its overflow trigger.
    expect(await row.locator("button").count()).toBeLessThanOrEqual(2);
    expect(await row.locator(".pagechip").count()).toBe(0);
  });

  // IT COUNTS WHAT IT IS SHOWING. The old header spoke in "3+ notes · 20+ pages"
  // because the server stopped at a page boundary and never counted the rest;
  // there is no cursor and no floor to speak in any more. With no index fixture
  // behind the fake, every row here is a name match and reached no page — so the
  // header is the documents alone, and the strict shape is the no-floor rule.
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

  // WHAT REPLACED THE CHIPS. A result's link carries the document AND the query,
  // so clicking it lands you inside with find already running — every matching
  // page one Next away, instead of one chip away out here.
  test("a result opens the note WITH find already running on the typed query", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await searchBox(page).fill("Aurora");
    const row = results(page).filter({ hasText: "Project Aurora — kickoff" });
    await expect(row).toHaveCount(1);
    await row.locator(".card__open").click();

    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
    await expect(page.locator(".reader__title")).toContainText("Project Aurora");
    // THE DEEP LINK CARRIES WHAT WAS TYPED, verbatim. It used to carry a term
    // read back out of the excerpt's `<mark>` elements — a correction on a fuzzy
    // answer — and §4.3 took the excerpt, so there is no mark to read and no
    // expansion the row holds. `deepLinkQuery` is where that changes when the
    // index's own expansion reaches the row.
    await expect(page).toHaveURL(/#\/note\/n-proj-alpha(\/page\/\d+)?\?q=Aurora$/);

    // Primed, not merely carried: the bar is open, the field is filled, and the
    // counter has settled on a real total.
    await expect(page.locator(".findbar")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Find in this note" })).toHaveValue("Aurora");
    await expect(page.locator(".findbar__count")).toHaveText(/^1 of \d+$/);
    // …and something is actually circled on the page in front of you.
    await expect(page.locator(".page .findbox.is-current")).toHaveCount(1);
  });

  test("a result row is reachable and openable by keyboard", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    await searchBox(page).fill("Aurora");
    const row = results(page).filter({ hasText: "Project Aurora — kickoff" });
    await expect(row).toHaveCount(1);

    // Focusable, and Enter opens it — the row is a real button.
    await row.locator(".card__open").focus();
    await expect(row.locator(".card__open")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
    await expect(page.locator(".reader__title")).toContainText("Project Aurora");
  });

  test("the page-carrying URL is truthful: a reload lands on the same page", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/n-proj-alpha/page/4");

    await expect(page.locator(".pager__count")).toHaveText("4 / 6");
    await page.reload();
    // The whole reason the page lives in the route rather than in shell state.
    await expect(page.locator(".pager__count")).toHaveText("4 / 6");
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

    // The reader closes and the results the user came from are still there —
    // Back means "undo the navigation", not "throw away my search".
    await expect(page.getByRole("region", { name: "Reader" })).toBeHidden();
    await expect(page).not.toHaveURL(/#\/note\//);
    await expect(searchBox(page)).toHaveValue("Aurora");
    await expect(results(page)).not.toHaveCount(0);

    // Forward still routes back into the note.
    await page.goForward();
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
  });

  test("clearing the box restores the ordinary gallery", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await railSettled(page);
    // A folder with real cards, so "the gallery came back" is observable.
    await page.getByRole("navigation", { name: "Folders" }).getByText("Note", { exact: true }).click();
    const card = cardButton(page, /Weekly review/);
    await expect(card).toBeVisible();

    await searchBox(page).fill("Aurora");
    await expect(results(page)).not.toHaveCount(0);
    // The folder listing is gone: results replaced it rather than filtered it.
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

      // `Note / Search` would claim a scope the search does not have.
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

      // They describe a folder listing, and the query has left the folder.
      await expect(page.locator("#sort")).toBeHidden();
      await expect(page.locator(".segmented")).toBeHidden();

      await searchBox(page).fill("");
      await expect(page.locator("#sort")).toBeVisible();
      await expect(page.locator(".segmented")).toBeVisible();
    });
  });

  test.describe("what the empty state says about itself", () => {
    // THE SENTENCE THAT SURVIVES IS THE ONE THAT NEVER NEEDED A COUNT. It used
    // to quantify — "12 of your 40 notes have no recognised text" — off numbers
    // the server attached to a zero-hit response. There is no response now, so
    // nothing counts anything at query time, and the honest degradation is to
    // say less rather than to assert "0 of your 0 notes" (`coverageLine`).
    test("an unmatched query says why, without a count it no longer has", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await railSettled(page);

      await searchBox(page).fill("zzzznotawordanywhere");

      const empty = page.locator(".gallery .empty");
      await expect(empty).toContainText("No matches");
      await expect(empty).toContainText("Only notes recognised on the device are searchable.");
      // The claim that is gone: no fabricated "N of your M notes".
      await expect(empty).not.toContainText("of your");
    });

    // The pending sentences ("N documents are still being indexed", and the
    // quieter "More may appear" over real results) ride the live channel's
    // `event: index` frame, which the fake's live channel never sends. Their
    // wording and their two-sentence ordering are pinned in
    // `tests/unit/gallerySearch.test.ts`; the failed-search state is there too.
  });

  test("the library search box is not offered over an open reader", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/n-doc-attn");
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();

    await expect(searchBox(page)).toBeHidden();
    await expect(page).toHaveURL(/#\/note\/n-doc-attn$/);

    // Closing the reader gives it straight back, query and all.
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

      // The highlight is a translucent wash, so what matters is that the marked
      // text stays readable *against the wash* — not that it keeps the title's
      // own colour. Compare the COMPOSITED background, since the wash is
      // semi-transparent and reading its own colour would ignore what it sits on.
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

      // Quiet is not the same as faint. It is small secondary text, so it is held
      // to the 4.5:1 body-text bar rather than the large-text one.
      const { color, background } = await paintedColours(line);
      expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
