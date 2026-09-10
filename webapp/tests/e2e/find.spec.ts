import { test, expect, type Locator, type Page } from "@playwright/test";
import { signedIn, freezeMotion, contrastRatio, paintedColours } from "./helpers/app";
import { mockDocText, noteTextRecord, type TextRecord } from "./helpers/docText";
import { fakeFileHash } from "../../src/api/fake";

// Find in note. Universal search answers WHICH NOTE; find answers WHERE ON THIS
// PAGE, because the device's recognition carries a rectangle per word.
//
// Everything asserted here is COMPUTED GEOMETRY or observed DOM history rather
// than "the rule exists", because every bug this feature already hit was
// invisible to the latter: badges with the right counts anchored to the wrong
// ancestor, a field that was a bare text node with no border or ground, and a
// counter that quietly revised its total.
//
// WHAT ANSWERS THE COUNTER NOW (§1.1, §6 step 7)
//
// The note-scoped `/note/:id/search` route is gone. Find fetches `text/<md5>`
// once, builds a per-document FTS5 index in the browser's own wasm engine, and
// answers every question below out of it — which words matched, how many
// instances, which to circle, in what document order. So the mock this file
// installs is the document's TEXT, not a search result: what is under test is
// the engine finding the word, not the viewer rendering a number it was handed.
//
// The ovals are still `getPageText`'s (the device's word rectangles, from the
// fake `Api`), and the counts are still the index's, so the two halves have the
// same seam they always had — see `matchWords` on why one is derived from the
// other rather than re-derived from the query.
//
// FIXTURE FACTS. "Attention Is All You Need" (`141`) is 20 pages with
// recognition on every page except index 2, 5, 8… — 14 recognised pages. Every
// recognised page's transcript carries the word "budget" exactly twice, so the
// note-wide total is 28 and page 1's badge is 2.
//
// "witches" is the OTHER shape, and the one the reported bug was in: it is on
// the ODD pages only, so it is never on the page find opens over. Recognised odd
// pages are 1, 3, 7, 9, 13, 15, 19 — seven pages, one match each, the first of
// them page 2 while you are looking at page 1.
//
// Both facts are properties of `helpers/docText.ts`'s transcript generator AND
// of `api/fake.ts`'s word boxes, which are two spellings of one string. The
// helper's header says what happens when they drift.

const NOTE = "/#/note/141";

/**
 * Every fixture note this file opens, as its text record — keyed by the blob md5
 * the reader hands to `docSearch` (`NoteMeta.fileHash`, which is `fakeFileHash`).
 *
 * The notes that are deliberately ABSENT are the ones that matter: `102`,
 * `103` and `143` carry no recognition, so find is refused at the
 * door and nothing is ever fetched for them. If one of them ever did fetch, the
 * mock's 404 would surface it as find's `error` state rather than letting a
 * silent "No matches" pass for the disabled control.
 */
const TEXT: Record<string, TextRecord> = {
  [fakeFileHash("141")]: noteTextRecord("Attention Is All You Need", 20),
  // Nothing on page 1, a transcript from page 2 on — so its recognised pages are
  // indices 1 and 3 only.
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

/**
 * What the counter says, waited for GENEROUSLY.
 *
 * The first find of a session pays what the design says it pays and no test can
 * wish it away: `WebAssembly.instantiate` of `sqlite-core.wasm` is a 16.13 MB
 * allocation (§8.1) and the index build follows it. On this fixture that is tens
 * of milliseconds and Playwright's 5 s default is ample — but the e2e suite runs
 * `fullyParallel` against a Vite dev server, and under that contention a cold
 * instantiate is the one step here that can take seconds. Every counter
 * assertion goes through this rather than only the ones that looked slow in
 * somebody's run, because a per-site guess is how a suite acquires a flake that
 * passes alone and fails in a full run — this file has already paid for that
 * lesson twice (see the two POLLED comments below).
 *
 * It costs nothing when the assertion passes, which is the ordinary case.
 */
async function settles(page: Page, text: string | RegExp): Promise<void> {
  await expect(counter(page)).toHaveText(text, { timeout: 20_000 });
}

async function openNote(
  page: Page,
  route = NOTE,
  opts: { textDelayMs?: number } = {},
): Promise<{ count(md5?: string): number }> {
  await signedIn(page);
  // AFTER `signedIn`, so this wins over `mockApi`'s catch-all — see
  // `mockDocText`. Nothing is fetched until somebody types (§4.1: the text
  // arrives on the first find, never on open), which several tests below assert
  // by observing the counter claim nothing while the bar is merely open.
  const hits = await mockDocText(page, TEXT, { delayMs: opts.textDelayMs });
  await page.goto(route);
  await expect(page.locator(".reader.is-open")).toBeVisible();
  await freezeMotion(page);
  return hits;
}

// The reader paints from a SKELETON page list (the listing summary + placeholder
// pages) while `getNoteMeta` is in flight, and a skeleton page carries
// `textHash: null` because it was invented. Deriving "can this note be searched"
// from it therefore answers for page 1 alone — and nothing recomputed it when the
// real metadata landed, so Find stayed disabled for the whole session on any note
// whose recognition starts later. Not slow-link-only: it was wrong immediately.
//
// `181` ("Recognised from page two") exists for this: 4 pages, nothing
// recognised on page 1, a
// transcript from page 2 on. The default fixture pattern always recognises page
// 1, which is exactly why the bug was unrepresentable and shipped.
test.describe("the Find affordance reflects the WHOLE note, not the skeleton", () => {
  test("a note recognised only from page two still offers Find", async ({ page }) => {
    await openNote(page, "/#/note/181");

    const toggle = findToggle(page);
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute("title", "Find in this note");

    // And it really searches: the transcript on the LATER pages is reachable.
    // Recognition starts at index 1 and index 2 carries none, so the recognised
    // pages are 1 and 3 — four "budget"s, none of them on the page find opened
    // over, so settling has to leave page 1 to reach the first.
    await toggle.click();
    await expect(findBar(page)).toBeVisible();
    await findField(page).fill("budget");
    await settles(page, "1 of 4");
    await expect(page.locator(".pager__count")).toHaveValue("2 / 4");
  });

  // The other half of the same rule: a note with NO recognition anywhere must
  // still say so, rather than being made hopeful by the summary's flag.
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

    // The control is a REAL, always-visible button — not a hover reveal. This
    // app is browsed from a phone, where `:hover` never fires.
    await expect(findToggle(page)).toBeVisible();
    const box = await findToggle(page).boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(24);
    expect(box!.height).toBeGreaterThanOrEqual(24);

    await findToggle(page).click();
    await expect(findBar(page)).toBeVisible();
    await expect(findField(page)).toBeFocused();
    await expect(findToggle(page)).toHaveAttribute("aria-pressed", "true");
    // Opening fetches nothing and claims nothing.
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

    // Nothing of ours reacts out here, so the browser's own find still works.
    await page.keyboard.press("ControlOrMeta+f");
    await expect(findBar(page)).toBeHidden();
  });

  test("Esc closes find BEFORE it closes the reader", async ({ page }) => {
    await openNote(page);
    await findToggle(page).click();
    await expect(findBar(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(findBar(page)).toBeHidden();
    // The reader is still there — one Escape dismissed the innermost thing only.
    await expect(page.locator(".reader.is-open")).toBeVisible();
    await expect(page).toHaveURL(/#\/note\/141$/);

    await page.keyboard.press("Escape");
    await expect(page.locator(".reader.is-open")).toBeHidden();
  });

  // In the mockup's first version the field was a bare text node — no border, no
  // ground, no focus ring — so the only thing saying "type here" was the
  // placeholder, and once you typed, nothing at all.
  test("the field looks like a field: a border, its own ground, and a focus ring", async ({ page }) => {
    await openNote(page);
    await findToggle(page).click();
    await freezeMotion(page);

    // Opening the bar focuses the field, so the resting state has to be read
    // with it blurred — otherwise "unfocused" and "focused" are the same read
    // and the focus assertion below passes against a field with no ring at all.
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
    // Its own ground, distinct from the bar it sits on.
    expect(style.background).not.toBe(style.barBackground);
    expect(style.background).not.toBe("rgba(0, 0, 0, 0)");

    // Focus is visible as a real colour change, not just an outline the reset
    // removes.
    await findField(page).click();
    const focused = await findField(page).evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(focused).not.toBe(style.borderColour);

    // And the magnifier inside the field is really rendered.
    await expect(page.locator(".findbar__field svg")).toBeVisible();
  });

  test("typing circles the matched words on the page, as drawn strokes", async ({ page }) => {
    await openNote(page);
    await findToggle(page).click();
    await findField(page).fill("budget");
    // SETTLED FIRST, because the `is-current` assertion at the bottom needs a
    // current match and there is none until the counts land. The ovals themselves
    // appear a beat earlier — phase 1's substring guess draws them off the word
    // boxes alone — so this waits for the half that has to be waited for.
    await settles(page, "1 of 28");

    // Two on page 1 — the ovals come from the page's word rectangles.
    await expect(ovals(page)).toHaveCount(2);

    const pageBox = (await page.locator(".page").boundingBox())!;
    for (const oval of await ovals(page).all()) {
      const box = (await oval.boundingBox())!;
      // Really on the page, not piled at the origin — which is what a
      // millimetre-read-as-pixel would look like.
      expect(box.width).toBeGreaterThan(4);
      expect(box.height).toBeGreaterThan(4);
      expect(box.x).toBeGreaterThanOrEqual(pageBox.x - 2);
      expect(box.y).toBeGreaterThanOrEqual(pageBox.y - 2);
      expect(box.x + box.width).toBeLessThanOrEqual(pageBox.x + pageBox.width + 2);
    }

    // A DRAWN loop, and the two properties that let one path stretch to any
    // word without smearing: no fill (a wash would obscure the ink it points
    // at) and a stroke that does not scale with the box.
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
    // POLLED, because a single sample is not stable here. The oval layer is
    // rebuilt as the find results settle, so `.first()` can resolve an element
    // that is being replaced — and `getComputedStyle` on one that is no longer
    // rendered returns EMPTY STRINGS rather than throwing. That failed as
    // `Expected: "none", Received: ""` under parallel load and passed alone,
    // which reads like a styling bug and is a sampling one.
    await expect.poll(async () => (await read()).fill, { timeout: 10_000 }).not.toBe("");
    const drawn = await read();
    expect(drawn.fill).toBe("none");
    expect(drawn.vectorEffect).toBe("non-scaling-stroke");
    expect(drawn.preserve).toBe("none");
    // The overshoot is the whole tell: the path does not close, it carries on
    // past where it started. A closed ellipse would end in `Z`.
    expect(drawn.d.trim().toUpperCase()).not.toMatch(/Z$/);
    expect(drawn.d.length).toBeGreaterThan(60);

    // The current match is marked by weight alone — no fill, ever.
    //
    // BOTH WIDTHS IN ONE SNAPSHOT, AND POLLED. The ovals are re-rendered whenever
    // the find state moves (the counts landing, a re-measure), so reading the
    // two in separate round trips can straddle a repaint: the second handle goes
    // stale and its computed style reads back "" (→ NaN), or the two samples
    // momentarily come from different renders and report the same weight. Both
    // were reproducible under CPU contention, and this was the suite's only
    // flake — it failed roughly one full run in two while passing every time it
    // ran alone. One `evaluate` cannot straddle anything, and the poll rides out
    // a sample taken mid-repaint.
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

  // THE PROGRESSIVE COUNTER. The count is never invented: before any total it
  // says only what it knows (this page, still counting), and it SETTLES to the
  // exact "1 of 28". Asserted over the counter's whole DOM history rather than by
  // racing a frame, so the ordering (phase 1 → exact) cannot pass by simply
  // missing the window.
  //
  // WHAT THIS TEST LOST, AND IT IS NOT A RELAXATION. It used to require a FLOOR
  // ("N of M+") in the middle, because the server answered a note-wide count in
  // streamed batches and the counter accumulated them the way browser Ctrl+F
  // does. There are no batches: `text/<md5>` is one request and `idx_query`
  // produces the exact total in one call, so `FindState` has no floor state at
  // all — `findInNote.ts` says so in the `settled` doc comment, and asserting a
  // floor here would now be asserting a mechanism the design deleted on purpose.
  //
  // What is still progressive is the WAIT, and that is what the history below
  // pins: phase 1 answers the page in front of you off its word boxes and claims
  // NOTHING about the note ("2 on this page · searching 14 pages…") until the
  // index has been built. That is the property the floor was only one expression
  // of, and it is the one that could still regress.
  //
  // HELD, because the wait is what is being observed. The build is ~40 ms on this
  // fixture and the fetch is local, so on a fast machine phase 1 and the settle
  // can land in the same frame — and then the history has one entry and the
  // ordering below is vacuously true. The delay makes the window real rather than
  // lucky, exactly as `slowLink.spec.ts` argues for its own held responses.
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

    // Before ANY total the counter claimed none — only "this page" and "still
    // counting". A number that quietly revises itself is how a search loses
    // trust, and this is the whole of the rule that says so.
    const firstCount = history.findIndex((t) => /\d+ of \d+/.test(t));
    expect(firstCount).toBeGreaterThan(0);
    for (const text of history.slice(0, firstCount)) {
      expect(text).not.toMatch(/\d+ of \d+/);
    }
    expect(history.slice(0, firstCount).some((t) => /on this page/.test(t))).toBe(true);
    // 14 of the 20 pages carry recognition, and that is the number counted.
    expect(history.slice(0, firstCount).some((t) => /searching 14 pages/.test(t))).toBe(true);

    // NO FLOOR EVER APPEARED. The absence is asserted rather than assumed: a
    // "N of M+" reaching the counter again would mean somebody had reintroduced a
    // provisional total over an answer that is exact by construction.
    expect(history.filter((t) => /\d+ of \d+\+/.test(t))).toEqual([]);

    // …and the total, once claimed, never moved.
    expect(history[history.length - 1]).toBe("1 of 28");
    for (const text of history.slice(firstCount)) expect(text).toBe("1 of 28");
  });

  // §4.1 AS AN OBSERVATION. The text is fetched on the FIRST find and never
  // again: it is content-addressed and served `immutable`, so every later
  // keystroke queries an index that is already built. Nothing on screen shows
  // this, which is exactly why it is worth a test — the regression is silent and
  // costs a round trip per keystroke on a 3G link.
  test("the document's text is fetched once, on the first find, and reused after that", async ({ page }) => {
    const text = await openNote(page);
    const md5Requests = () => text.count();

    // Opening the bar is free. §4.1: reading a note needs the renderer, not a
    // text index, and nobody should pay for a table they never query.
    await findToggle(page).click();
    await expect(findBar(page)).toBeVisible();
    expect(md5Requests()).toBe(0);

    await findField(page).fill("budget");
    await settles(page, "1 of 28");
    expect(md5Requests()).toBe(1);

    // A second query on the same document is answered from the built index.
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

    // Match 3 is the first on the next recognised page — stepping turns the page.
    await next.click();
    await settles(page, "3 of 28");
    await expect(page.locator(".pager__count")).toHaveValue("2 / 20");
    await expect(ovals(page)).toHaveCount(2);

    // Backwards from the first match wraps to the last, on the last matching page.
    await prev.click();
    await prev.click();
    await prev.click();
    await settles(page, "28 of 28");
    await expect(page.locator(".pager__count")).toHaveValue("20 / 20");
  });

  // THE ONE THE FEATURE SHIPPED BROKEN. Every earlier test here searches a word
  // that happens to be on the page find opens over, so the reader never had to
  // move. On real data (`BuJo.note`, "witches", page 2 while reading page 1) the
  // counter said `1 of 1`, the filmstrip badged page 2, nothing was circled and
  // Next did nothing — every part individually right, the feature broken.
  test("settling GOES TO the match when it is not on the page in front of you", async ({ page }) => {
    await openNote(page);
    await findToggle(page).click();
    await expect(page.locator(".pager__count")).toHaveValue("1 / 20");

    await findField(page).fill("witches");
    await settles(page, "1 of 7");

    // The reader followed the count instead of leaving it stranded.
    await expect(page.locator(".pager__count")).toHaveValue("2 / 20");
    await expect(ovals(page)).toHaveCount(1);
    await expect(page.locator(".findbox.is-current")).toHaveCount(1);

    // …and stepping carries on across pages from where it landed.
    const next = page.getByRole("button", { name: "Next match" });
    await next.click();
    await settles(page, "2 of 7");
    await expect(page.locator(".pager__count")).toHaveValue("4 / 20");
    await expect(ovals(page)).toHaveCount(1);

    // Backwards from the first match wraps to the last, on the last odd page.
    await page.getByRole("button", { name: "Previous match" }).click();
    await page.getByRole("button", { name: "Previous match" }).click();
    await settles(page, "7 of 7");
    await expect(page.locator(".pager__count")).toHaveValue("20 / 20");
    await expect(ovals(page)).toHaveCount(1);
  });

  // Find used to be the ONE search in this app that did not tolerate typos, and
  // silently: the same slip that global search forgave here returned "No
  // matches". It was left out because the ovals were re-derived from the query
  // and would have disagreed with a count that included near-misses — so the fix
  // was the term list, not the tolerance.
  //
  // THE LADDER IS NOW THE WASM'S, and this is where that is observable. The
  // server's in-document routes never ran their fuzzy fallback at all, so §6 step
  // 6 briefly reopened the regression above; step 7 closes it by asking
  // `idx_fuzzy` — the same ladder the library search uses, over THIS document's
  // vocabulary, gated by the engine itself so it fires only when the query as
  // typed matched nothing. `docSearch.ts` says so in its `usedFuzzy` comment.
  // MANUAL FUZZY IS OPT-IN (in-doc-search Phase 3). A typo typed into the bar is
  // not silently answered with close matches — the bar offers "search similar",
  // and only on request does the typo-tolerant result appear. (A deep link from a
  // global fuzzy hit is the other path: it carries the resolved term and runs
  // exact, never reaching this gate — see search.spec.)
  test("a typo is OPT-IN: 'search similar' reveals the close matches, marked approximate", async ({ page }) => {
    await openNote(page);
    await findToggle(page).click();

    // The exact word is found directly — nothing approximate is claimed.
    await findField(page).fill("witches");
    await settles(page, "1 of 7");
    await expect(page.locator(".findbar__fuzzy")).toBeHidden();
    const exactPages = await badges(page).count();

    // The typo: the exact search is empty, so the bar OFFERS the fuzzy fallback
    // rather than running it — no marks, no fuzzy notice, just the affordance.
    await findField(page).fill("witchez");
    await settles(page, "No matches");
    await expect(page.locator(".findbar__ask")).toBeVisible();
    await expect(page.locator(".findbar__fuzzy")).toBeHidden();
    await expect(badges(page)).toHaveCount(0);
    await expect(ovals(page)).toHaveCount(0);

    // Opt in → the SAME pages as the exact word, now marked approximate. The
    // count and the ovals agree on the fuzzy hit: the oval is round "witches",
    // the word that was counted, though nothing on the page spells "witchez".
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

  // The badges shipped once with the right counts in the DOM and nothing visible
  // where they belonged: `.filmstrip__page` was not `position: relative`, so they
  // resolved against a distant ancestor and stacked in the window corner.
  test("filmstrip badges carry per-page counts AND sit on their own thumbnail", async ({ page }) => {
    await openNote(page);
    await findToggle(page).click();
    await findField(page).fill("budget");
    await settles(page, "1 of 28");

    // 14 recognised pages, two matches each (but only visible ones are in the DOM).
    await expect(badges(page).first()).toBeVisible();
    await expect(badges(page).first()).toHaveText("2");

    const first = badges(page).first();
    const badgeBox = (await first.boundingBox())!;
    const ownerBox = (await page.locator(".filmstrip__page").first().boundingBox())!;

    // THE ANCHORING ASSERTION: the badge is inside the button it describes.
    // Under the bug this was somewhere near (0, 0) of the window.
    expect(badgeBox.x).toBeGreaterThanOrEqual(ownerBox.x - 1);
    expect(badgeBox.y).toBeGreaterThanOrEqual(ownerBox.y - 1);
    expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(ownerBox.x + ownerBox.width + 1);
    expect(badgeBox.y + badgeBox.height).toBeLessThanOrEqual(ownerBox.y + ownerBox.height + 1);
    // …and it is really painted, not a zero-size node.
    expect(badgeBox.width).toBeGreaterThan(8);
    expect(badgeBox.height).toBeGreaterThan(8);

    // Page 3 (index 2) has no recognition, so it carries no badge.
    const third = page.locator(".filmstrip__page").nth(2);
    await expect(third.locator(".filmstrip__hits")).toHaveCount(0);

    // Closing find takes the badges with it — they are find's state, not the
    // filmstrip's.
    await page.getByRole("button", { name: "Close find" }).click();
    await expect(badges(page)).toHaveCount(0);
    await expect(ovals(page)).toHaveCount(0);
  });

  // "Not recognised on the device" and "No matches" are DIFFERENT CLAIMS, and
  // only the second one asserts that a search happened.
  // Find is not OFFERED on a note the device never recognised: there is nothing
  // to search, so the control would promise a search that can only ever answer
  // "nothing". The bar's own "Not recognised on the device" state still exists
  // for a recognised note opened on a page that has none; the whole-note case is
  // now refused at the door instead.
  test("an unrecognised note does not offer find at all", async ({ page }) => {
    await openNote(page, "/#/note/102");
    const toggle = findToggle(page);
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeDisabled();
    // The reason travels ON the control, not in a hover state a touch screen
    // never produces.
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

  // `pxPerMm === null` — the server has not verified this hardware's millimetre
  // scale, which is the COMMON case. The counter still works (the count comes
  // from the transcript, which needs no geometry at all), so the bar has to
  // explain why the page carries no marks rather than leaving a count beside a
  // blank page. The two halves are independent by construction, and this is what
  // says so: the index answered, the rectangles could not be placed.
  test("an unverified device scale draws no ovals and says why", async ({ page }) => {
    await openNote(page, "/#/note/144");
    await findToggle(page).click();
    await findField(page).fill("budget");

    await settles(page, /\d+ of \d+/);
    await expect(ovals(page)).toHaveCount(0);
    await expect(page.locator(".findbar__note")).toBeVisible();
    // The filmstrip badges are counts, not positions, so they still appear.
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

    // WAIT FOR THE OVAL, not just the page. The page growing and the ovals being
    // re-measured against it are two separate frames, so sampling the loop the
    // moment the PAGE is wide enough can still catch its old pixel size — which
    // fails as "the loop did not grow" while the code under test is fine, and
    // only under load, because that is when the two frames separate.
    //
    // AND THE OVAL CAN BE ABSENT FOR A FRAME, which is the second half of the
    // same fact and is what made this test fail about one run in four. The layer
    // is cleared and repainted rather than resized in place, so between the two
    // frames there is a moment with no oval in the DOM at all — and
    // `boundingBox()` answers `null` there, so the non-null assertion threw
    // out of the poll instead of letting it retry. A poll that cannot survive
    // the very gap it was written to wait through is not waiting for anything.
    // Zero is the right stand-in: it can never satisfy the predicate, so an oval
    // that never comes back still fails, on the timeout, saying so.
    await expect
      .poll(async () => (await ovals(page).first().boundingBox())?.width ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(before.width);

    const after = (await ovals(page).first().boundingBox())!;
    const pageAfter = (await page.locator(".page").boundingBox())!;
    // The loop grew with the page rather than staying at its old pixel size —
    // which is what a set of boxes laid out against a stale measurement does.
    expect(after.width).toBeGreaterThan(before.width);
    // And it is still over the same part of the page, proportionally.
    const relBefore = (before.x - pageBefore.x) / pageBefore.width;
    const relAfter = (after.x - pageAfter.x) / pageAfter.width;
    expect(Math.abs(relAfter - relBefore)).toBeLessThan(0.02);
  });

  test("paging by hand repaints the ovals for the page you land on", async ({ page }) => {
    await openNote(page);
    await findToggle(page).click();
    await findField(page).fill("budget");
    // Settled before the page is turned, so what is being observed is the
    // repaint and not the counts landing on top of it.
    await settles(page, "1 of 28");
    await expect(ovals(page)).toHaveCount(2);

    // Page 3 (index 2) has no recognition: nothing to circle, and the counter
    // still describes the whole note.
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
    // An `.epub`: no viewer, so the reader's no-preview state — and no word
    // boxes, no transcript, nothing for find to answer. (A PDF would no longer
    // do: it opens in its own viewer now, which has no find of its own either.)
    await openNote(page, "/#/note/143");
    await expect(findToggle(page)).toBeHidden();
    await page.keyboard.press("ControlOrMeta+f");
    await expect(findBar(page)).toBeHidden();
  });

  // New painted chrome, and the badge INVERTS (accent ground, sheet ink) — the
  // shape of thing that reads fine in one scheme and vanishes in the other.
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

      // The oval's stroke has to be distinguishable from the page it is drawn
      // on, or the match is marked with an invisible mark.
      const stroke = await ovals(page)
        .first()
        .locator("path")
        .evaluate((el) => getComputedStyle(el).stroke);
      const sheet = await page.locator(".page").evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(contrastRatio(stroke, sheet)).toBeGreaterThan(3);
    });
  }

  // ==========================================================================
  // THE SEARCH IS ADDRESSABLE
  // ==========================================================================
  //
  // A document, a page within it, and the search running over it are the three
  // things the URL has to be able to describe. Find is the third, and it is
  // written with `replaceState` — so it survives a reload and a share while
  // costing nothing in history (see `navigation.spec.ts` for that half).
  test.describe("the URL carries the search", () => {
    test("a query reaches the URL, and clearing it takes it away again", async ({ page }) => {
      await openNote(page);
      await findToggle(page).click();
      // Opening the bar claims nothing — peeking is free out here too.
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

    // RELOAD RESTORES BOTH. Page 4 (`/page/4`, index 3) is an ODD page, which is where the
    // fixture puts "witches" — so the page really does hold a match and settling
    // has no reason to move off it. That is what makes "the page was restored" a
    // claim about the URL rather than about where find happened to land.
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

    // The find field is DEVICE-FACING TEXT, and a hash URL is built out of some
    // of the same characters. `#` is the sharp one: unencoded it truncates the
    // hash and takes the whole route with it, so the note would reopen as the
    // library. The accent is the household's own (Portuguese), and the space is
    // the ordinary case that `+`-encoding would quietly mangle.
    test("a query with a space, a # and an accent survives the round trip", async ({ page }) => {
      const hostile = 'café #2 "R&D" budget';
      await openNote(page);
      await findToggle(page).click();
      await findField(page).fill(hostile);

      // It reached the URL escaped, not raw — a bare `#` here would mean the
      // route ended two characters ago.
      await expect(page).toHaveURL(/#\/note\/141\?q=/);
      await expect(page).not.toHaveURL(/q=caf%C3%A9 /);
      const hash = await page.evaluate(() => location.hash);
      expect(hash).not.toContain("#2");

      // And it survives the trip back intact, character for character.
      await page.reload();
      await expect(findBar(page)).toBeVisible();
      await expect(findField(page)).toHaveValue(hostile);
      // Still the note, not the library the truncated hash would have produced.
      await expect(page.locator(".reader.is-open")).toBeVisible();
    });

    // Paging with find running must not drop the search out of the URL: the two
    // halves of the position are written together or the URL describes half a
    // screen.
    test("turning the page keeps the query in the URL", async ({ page }) => {
      await openNote(page, "/#/note/141?q=witches");
      await expect(findField(page)).toHaveValue("witches");

      await page.getByRole("button", { name: "Next match" }).click();
      await expect(page).toHaveURL(/\/page\/\d+\?q=witches$/);
    });
  });
});
