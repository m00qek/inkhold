import { test, expect, type Locator, type Page } from "@playwright/test";
import { signedIn, contrastRatio, cardButton, freezeMotion, paintedColours, railSettled } from "./helpers/app";

// ONE QUERY, ONE SCOPE, ONE LIST.
//
// The library used to answer a query twice — a gallery filtered by NAME to the
// folder you were standing in, plus a separate `.hit` list of transcript matches
// from the WHOLE library. Two scopes, no way to see which, so the same word
// found a note in another folder by its handwriting but not by its name.
//
// Now both halves are library-wide and both land in one list of NOTES: a
// library row plus a marked excerpt and one quiet line saying how far into the
// note the query reached.
//
// The fixture's transcripts all open with `<note name> — page <n>`, so a query
// for a word in one note's name reaches several pages of that one note — which
// is exactly the shape grouping has to handle.

/** A result row: the library's own card, in its search variant. */
function results(page: Page): Locator {
  return page.locator(".card--result");
}

function searchBox(page: Page): Locator {
  return page.getByRole("searchbox", { name: "Search notes" });
}

/** The row's quiet metadata: how many pages of that note the query reached. */
function matchLine(row: Locator): Locator {
  return row.locator(".card__matches");
}

test.describe("universal search", () => {
  test("typing surfaces results with real <mark> highlighting", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    // Nothing is claimed before a query.
    await expect(results(page)).toHaveCount(0);

    await searchBox(page).fill("Aurora");

    await expect(results(page)).not.toHaveCount(0);
    const first = results(page).first();
    await expect(first.locator(".card__title")).toHaveText("Project Aurora — kickoff");

    // The highlight is a real <mark> ELEMENT, not the literal text "<mark>".
    // Asserting on the text alone passes just as happily when the snippet was
    // double-escaped and the user is reading `&lt;mark&gt;` on screen.
    const mark = first.locator(".hit__snippet mark");
    await expect(mark).toBeVisible();
    await expect(mark.first()).toHaveText("Aurora");
    await expect(first.locator(".hit__snippet")).not.toContainText("&lt;");

    // And it is actually highlighted — a distinct background, not inherited.
    const marked = await mark.first().evaluate((el) => getComputedStyle(el).backgroundColor);
    const around = await first.locator(".hit__snippet").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(marked).not.toBe(around);
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
  // Note/Projects and has NO recognised text, so it was reachable by neither
  // half from anywhere else: the name filter was scoped to the folder in view
  // and the transcript index has nothing of it at all.
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
    // …and there is no excerpt, because no handwriting matched.
    await expect(row.locator(".hit__snippet")).toHaveCount(0);
    // Library-wide results have to say where the note actually lives.
    await expect(row.locator(".card__path")).toHaveText("Note / Projects");
  });

  test("the path uses the bin's treatment, not a second one of its own", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
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

  // Ranking is per PAGE, so a note matching on six of them used to be six rows
  // and pushed everything else out of the limit's window.
  test("a note matching on several pages appears ONCE, and says how many", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await searchBox(page).fill("Aurora");

    const row = results(page).filter({ hasText: "Project Aurora — kickoff" });
    await expect(row).toHaveCount(1);
    // Four of the six pages carry recognition, and "Aurora" is in the note's
    // name, which every page's transcript opens with — so all four match.
    await expect(matchLine(row)).toHaveText("Matches on 4 pages");
  });

  // THIS REPLACES "the strip appears only when there is more than one match".
  // The strip is gone: a note matching on twenty pages was twenty targets to read
  // past, and the destination was never the question — the row now opens the note
  // with the query still running and Next walks the rest.
  //
  // Both shapes are asserted in one test, because what a single-page group does
  // is the whole tell. It used to say "Matches on 1 page"; global search names
  // DOCUMENTS now, so a group of one is the ordinary case and that line would
  // ride nearly every row while claiming a reach the row does not know. It says
  // nothing instead, and find-in-note — which the row opens — gives the count.
  test("the row counts the pages it reached, and says nothing when it reached one", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");

    // "page 4" appears in the fixture transcript's opening line — `<name> — page
    // 4` — and nowhere else, so it matches EXACTLY ONE page of each note it hits.
    await searchBox(page).fill("page 4");
    await expect(results(page)).not.toHaveCount(0);

    // Non-vacuity FIRST: there really are rows here, so "no count line" is the
    // rule being observed and not an empty result set passing by default.
    expect(await results(page).count()).toBeGreaterThan(0);
    await expect(matchLine(results(page))).toHaveCount(0);

    // …and the count still appears over a query that really does span pages.
    await searchBox(page).fill("Aurora");
    const many = matchLine(results(page).filter({ hasText: "Project Aurora" }));
    await expect(many).toHaveText(/^Matches on [2-9]\d* pages$/);
  });

  // The row is a ROW, not a menu. A page count that rendered as a target would be
  // the chip strip growing back one button at a time.
  test("the count is metadata, not a control", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await searchBox(page).fill("Aurora");
    const row = results(page).filter({ hasText: "Project Aurora" });
    await expect(matchLine(row)).toBeVisible();
    await freezeMotion(page);

    // No buttons but the row's own opener and its overflow trigger — the strip
    // used to add one per matching page.
    expect(await row.locator("button").count()).toBeLessThanOrEqual(2);
    expect(await row.locator(".pagechip").count()).toBe(0);
    // COMPUTED, not "the class is there": quiet means it is set apart from the
    // ink of the title it sits under, the same way the path beside it is.
    const { line, title } = await row.evaluate((el) => ({
      line: getComputedStyle(el.querySelector(".card__matches")!).color,
      title: getComputedStyle(el.querySelector(".card__title")!).color,
    }));
    expect(line).not.toBe(title);
  });

  // A name-only match reached no page at all, and saying "Matches on 0 pages"
  // would make the reader parse a number to learn the title was the whole answer.
  test("a name-only match says nothing about pages", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await searchBox(page).fill("Beta");
    const row = results(page).filter({ hasText: "Project Beta" });
    await expect(row).toHaveCount(1);
    await expect(matchLine(row)).toHaveCount(0);
  });

  test("the header counts both notes and pages", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await searchBox(page).fill("Aurora");
    await expect(results(page)).not.toHaveCount(0);

    await expect(page.locator(".gallery .section-head")).toContainText(/\d+ notes? · \d+ pages?/);
  });

  test("the excerpt survives on every row — it is the answer to why this is here", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    // "Endor" appears in no note NAME, so every result here matched by
    // transcript, on a mix of one page and several.
    await searchBox(page).fill("Endor");
    await expect(results(page)).not.toHaveCount(0);

    // The EXCERPT is the subject: it is on every row without exception, because
    // it is the answer to "why is this here". The count line beside it is not —
    // a single-page group deliberately carries none.
    for (const row of await results(page).all()) {
      await expect(row.locator(".hit__snippet")).toBeVisible();
    }
  });

  // WHAT REPLACED THE CHIPS. A result's link carries the best page AND the query,
  // so clicking it lands you inside the note with find already running — every
  // other matching page one Next away, instead of one chip away out here.
  test("a result opens the note at its best page WITH find already running", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    // "Endor" is on the ODD pages only, so the best-ranked page is not page 1 —
    // "opened at the right page" is a real claim rather than one page 1 would
    // also satisfy.
    await searchBox(page).fill("Endor");
    const row = results(page).filter({ hasText: "Project Aurora — kickoff" });
    await expect(row).toHaveCount(1);
    await row.locator(".card__open").click();

    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
    await expect(page.locator(".reader__title")).toContainText("Project Aurora");
    await expect(page.locator(".pager__count")).toHaveText("2 / 6");
    // The URL says all three things: which note, which page, which search.
    await expect(page).toHaveURL(/#\/note\/n-proj-alpha\/page\/2\?q=Endor$/);

    // Primed, not merely carried: the bar is open, the field is filled, and the
    // counter has settled on a real total.
    await expect(page.locator(".findbar")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Find in this note" })).toHaveValue("Endor");
    await expect(page.locator(".findbar__count")).toHaveText(/^1 of \d+$/);
    // …and something is actually circled on the page in front of you.
    await expect(page.locator(".page .findbox.is-current")).toHaveCount(1);
  });

  // ROUTE 2 (in-doc-search Phase 3): a GLOBAL fuzzy hit deep-links the RESOLVED
  // (corrected) term, not the typo — so the in-note find runs it EXACT (the word
  // really is in the note) instead of re-fuzzing inside the document. The result
  // is a settled counter and NO "search similar" gate, unlike a typo typed
  // straight into the bar (find.spec's opt-in test).
  test("a fuzzy hit opens the note searching the RESOLVED term, running exact", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    // "Auroras" matches nothing exactly; the fixture answers only by widening to
    // "Aurora" (the fuzzy notice below proves the answer WAS approximate).
    await searchBox(page).fill("Auroras");
    await expect(page.locator(".hits__notice")).toHaveText("No exact match — showing close matches.");
    const row = results(page).filter({ hasText: "Project Aurora" }).first();
    await expect(row).toHaveCount(1);
    await row.locator(".card__open").click();

    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
    // THE DEEP LINK CARRIES "Aurora" — the correction the server marked — NOT the
    // typed "Auroras".
    await expect(page).toHaveURL(/\?q=Aurora$/);
    await expect(page.getByRole("textbox", { name: "Find in this note" })).toHaveValue("Aurora");
    // And find ran it EXACT: a real settled count, with neither the fuzzy notice
    // nor the "search similar" opt-in the manual-typo path shows.
    await expect(page.locator(".findbar__count")).toHaveText(/^1 of \d+$/);
    await expect(page.locator(".findbar__ask")).toBeHidden();
    await expect(page.locator(".findbar__fuzzy")).toBeHidden();
  });

  test("a result row is reachable and openable by keyboard", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await searchBox(page).fill("Aurora");
    const row = results(page).filter({ hasText: "Project Aurora — kickoff" });
    await expect(row).toHaveCount(1);

    // Focusable, and Enter opens it — the row is a real button, and the chips
    // beside it are siblings rather than buttons nested inside one (which would
    // be invalid markup and unreachable).
    await row.locator(".card__open").focus();
    await expect(row.locator(".card__open")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
    await expect(page.locator(".reader__title")).toContainText("Project Aurora");
  });

  // The snippet is the one server string this app hands to innerHTML. The
  // backend escapes the transcript around its own markers, so device-authored
  // angle brackets must arrive as TEXT — visible to the reader, inert to the
  // parser. The fixture's transcript carries `· <draft> R&D budget — flag "open"
  // items & re-check` for exactly this assertion.
  //
  // The query is "R&D" and NOT "draft" on purpose. Matching inside the tag
  // splits it across the `<mark>` boundary (`<` + `<mark>draft</mark>` + `>`),
  // and a `<` followed by another `<` is literal text to an HTML parser — so an
  // unescaped snippet would still produce no element and the test would pass
  // while proving nothing. Matching AFTER the tag keeps `<draft>` whole inside
  // the excerpt, which is the only arrangement where dropped escaping actually
  // shows up as a parsed element.
  test("device-authored markup in a transcript renders as text, never as elements", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");

    await searchBox(page).fill("R&D");
    await expect(results(page)).not.toHaveCount(0);

    const snippet = results(page).first().locator(".hit__snippet");
    // The user sees the characters the device wrote — the whole tag, as text…
    await expect(snippet).toContainText("<draft>");
    // …and the ampersand exactly once. Double-escaping would read "R&amp;D" here.
    await expect(snippet).toContainText("R&D");
    await expect(snippet).not.toContainText("&amp;");
    await expect(snippet).not.toContainText("&lt;");

    // …and the parser saw no element but the highlight. A DRAFT element in the
    // DOM would mean the escaping was dropped somewhere in the chain.
    const tags = await snippet.evaluate((el) => Array.from(el.querySelectorAll("*")).map((n) => n.tagName));
    expect(new Set(tags)).toEqual(new Set(["MARK"]));
    // And the highlight really is on the matched term, inside that same excerpt.
    await expect(snippet.locator("mark")).toHaveText("R&D");
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

    // Forward still routes back into the note, at its page.
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

  test.describe("what the results say about themselves", () => {
    // `usedFuzzy` has always been on the response and nothing ever rendered it,
    // so "calig" returning "caligrafia" was presented as though it were exact.
    test("the fuzzy notice appears ONCE for an approximate answer", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");

      // The fixture answers this only by widening (see `searchFixture`).
      await searchBox(page).fill("Auroras");
      await expect(results(page)).not.toHaveCount(0);

      const notice = page.locator(".hits__notice");
      await expect(notice).toHaveCount(1); // once, above the results — never per row
      await expect(notice).toHaveText("No exact match — showing close matches.");
      // The same sentence find-in-note says, so the two faces of one fallback
      // do not teach two different vocabularies.
    });

    test("an exact answer says nothing at all", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await searchBox(page).fill("Aurora");
      await expect(results(page)).not.toHaveCount(0);

      await expect(page.locator(".hits__notice")).toHaveCount(0);
    });

    // "Only notes recognised on the device are searchable" is true and useless:
    // it leaves the user unable to tell "it is not there" from "it might be and
    // I cannot see it".
    test("the empty state QUANTIFIES the unsearchable when the server counted", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");

      await searchBox(page).fill("zzzznotawordanywhere");

      const empty = page.locator(".gallery .empty");
      await expect(empty).toContainText("No matches");
      await expect(empty).toContainText(/\d+ of your \d+ notes have no recognised text/);
    });

    // The OTHER half of coverage — a server that did not send the numbers must
    // degrade to the unquantified sentence rather than fabricate "0 of your 0
    // notes" — is asserted in `tests/unit/noteSearch.test.ts`. It cannot be
    // driven from here: the library and reader run against the in-memory fake
    // `Api` with no HTTP behind it, so there is no response for a route handler
    // to take the field out of, and the fake always counts its own fixture.
    // The same goes for the failed-search state.
  });

  // KEYSET PAGING. The server clamps a search response at 20 hits and NEVER
  // serves a total — the early-terminating query stops at the page boundary
  // precisely so it does not count the rest (decision
  // 6). What it serves instead is an opaque cursor, present exactly while more
  // hits may exist; the UI's whole vocabulary for that is a "+" floor in the
  // header and one "More results" control that spends the cursor.
  //
  // "Endor" is the fixture's broad query: the marginalia line sits on the odd
  // pages of every recognised transcript — 28 matching pages across 16 notes,
  // so page one is 20 hits (11 notes) and one More click fetches the last 8.
  test.describe("keyset paging", () => {
    const moreButton = (page: Page) => page.getByRole("button", { name: "More results" });
    const header = (page: Page) => page.locator(".gallery .section-head");

    test("over the cap: 20 hits, a More control, and floors — never a total", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await searchBox(page).fill("Endor");

      await expect(moreButton(page)).toBeVisible();
      await expect(results(page)).toHaveCount(11);

      // The header speaks in floors while a cursor exists. `20+ pages` is the
      // 20 hits actually shown plus the server's "more may exist" — and the
      // strict shape assertion is the no-total rule itself: no bare count is
      // on screen anywhere a total could be read into.
      await expect(header(page)).toHaveText(/^\d+\+ notes · 20\+ pages$/);
    });

    test("More appends the next page in place: order kept, scroll kept, control honest", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await searchBox(page).fill("Endor");
      await expect(moreButton(page)).toBeVisible();

      const before = await results(page).locator(".card__title").allInnerTexts();
      expect(before).toHaveLength(11);

      // Stand at the bottom, where the control is — the position appending
      // must not disturb.
      await moreButton(page).scrollIntoViewIfNeeded();
      const scrollBefore = await page.evaluate(() => document.querySelector(".content")!.scrollTop);

      await moreButton(page).click();
      // 17, not 16: the corpus includes `n-late-ocr`, a route-only fixture that
      // joins no listing but IS recognised, so universal search finds it too.
      await expect(results(page)).toHaveCount(17);

      // APPENDED, not repainted: every row that was on screen is still there,
      // in the same order, ahead of the new ones.
      const after = await results(page).locator(".card__title").allInnerTexts();
      expect(after.slice(0, before.length)).toEqual(before);

      const scrollAfter = await page.evaluate(() => document.querySelector(".content")!.scrollTop);
      expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThanOrEqual(1);

      // The stream is exhausted: no cursor came back, so the control is GONE —
      // not disabled, gone — and the header's floors settle into the plain
      // counts of what is (now completely) on screen.
      await expect(moreButton(page)).toHaveCount(0);
      await expect(header(page)).toHaveText("17 notes · 30 pages");
    });

    test("a page-boundary note GROWS its row rather than gaining a duplicate", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await searchBox(page).fill("Endor");
      await expect(moreButton(page)).toBeVisible();

      // The 20-hit window splits this note's two matching pages across the
      // boundary: its row is painted knowing one page, which a row says nothing
      // about…
      const row = results(page).filter({ hasText: "Archive note 17" });
      await expect(row).toHaveCount(1);
      await expect(matchLine(row)).toHaveCount(0);

      await moreButton(page).click();

      // …and the second page's arrival updates THAT row, in place. Two rows
      // for one note would be the grouping regressing under paging.
      await expect(matchLine(row)).toHaveText("Matches on 2 pages");
      await expect(row).toHaveCount(1);
    });

    test("a query under the cap never offers More, and its counts stay plain", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await searchBox(page).fill("Aurora");
      await expect(results(page)).not.toHaveCount(0);

      await expect(moreButton(page)).toHaveCount(0);
      // Complete results count plainly — no floor where nothing more exists.
      await expect(header(page)).toHaveText(/^\d+ notes? · \d+ pages?$/);
    });

    test("the More control is a real button, reachable and workable by keyboard", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await searchBox(page).fill("Endor");
      await expect(moreButton(page)).toBeVisible();

      await moreButton(page).focus();
      await expect(moreButton(page)).toBeFocused();
      await page.keyboard.press("Enter");

      await expect(results(page)).toHaveCount(17);
      await expect(moreButton(page)).toHaveCount(0);
    });
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
    test(`results and their highlight stay legible in ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await signedIn(page);
      await page.goto("/");
      await searchBox(page).fill("Aurora");
      await expect(results(page)).not.toHaveCount(0);

      const row = results(page).first();
      await expect(row.locator(".card__title")).toBeVisible();
      await expect(row.locator(".hit__snippet")).toBeVisible();

      // The highlight is a translucent wash, so what matters is that the marked
      // text stays readable *against the wash* — not that it keeps the snippet's
      // own colour. Asserting equality was a proxy for legibility and got it
      // backwards: the softer snippet ink scores 3.87 over a 24% accent wash,
      // while the full-strength ink the highlight now uses clears 4.5 easily.
      // Compare the composited background, since the wash is semi-transparent
      // and reading its own colour would ignore whatever it sits on.
      const { mark, over } = await row.locator(".hit__snippet mark").first().evaluate((el) => {
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

    test(`the row's page count stays legible in ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await signedIn(page);
      await page.goto("/");
      await searchBox(page).fill("Aurora");
      const line = matchLine(results(page).filter({ hasText: "Project Aurora" }));
      await expect(line).toBeVisible();
      await freezeMotion(page);

      // Quiet is not the same as faint. It is small secondary text, so it is held
      // to the 4.5:1 body-text bar rather than the large-text one.
      const { color, background } = await paintedColours(line);
      expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
