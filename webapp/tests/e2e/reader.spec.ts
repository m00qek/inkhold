import { test, expect, type Page } from "@playwright/test";
import { signedIn, inkFraction, contrastRatio, paintedColours, cardButton, freezeMotion, railSettled } from "./helpers/app";

// The reader: routed by note id, a lazy filmstrip of every page, a main viewer
// that paints the current page, and page navigation via buttons / filmstrip /
// keyboard. The Document "Attention Is All You Need" note has 20 pages — enough
// for an off-screen filmstrip thumbnail.
test.describe("reader", () => {
  test("opens a note by route and paints the current page", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/n-doc-attn");

    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
    await expect(page.locator(".reader__title")).toContainText("Attention");
    await expect(page.locator(".pager__count")).toHaveText("1 / 20");

    // The main viewer canvas actually rendered ink.
    const viewer = page.locator(".page canvas");
    await expect.poll(async () => inkFraction(viewer), { timeout: 5000 }).toBeGreaterThan(0.01);
  });

  test("navigates pages with the pager, the filmstrip, and the keyboard", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/n-doc-attn");
    await expect(page.locator(".pager__count")).toHaveText("1 / 20");

    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.locator(".pager__count")).toHaveText("2 / 20");

    // The reader's arrow-key paging is claimed while the PAGE has focus; the
    // toolbar now owns arrow keys for roving between its own controls (WAI-ARIA
    // toolbar), so clicking Next left focus on a toolbar button. Move focus onto
    // the stage before paging with the keyboard.
    await page.locator(".stage").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".pager__count")).toHaveText("3 / 20");

    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".pager__count")).toHaveText("2 / 20");

    // Jump via a filmstrip thumbnail.
    await page.getByRole("button", { name: "Page 5" }).click();
    await expect(page.locator(".pager__count")).toHaveText("5 / 20");
  });

  // The recognized-text panel. The fake fixture leaves every third page (index 2,
  // 5, 8…) without recognition, so page 3 of any note is the "no text" case.
  test.describe("recognized text", () => {
    const toggle = (page: import("@playwright/test").Page) =>
      page.getByRole("button", { name: "Recognized text" });
    const panel = (page: import("@playwright/test").Page) =>
      page.getByRole("complementary", { name: "Recognized text" });

    test("toggling shows and hides the panel and tracks aria-pressed", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/n-doc-attn");
      await expect(page.locator(".pager__count")).toHaveText("1 / 20");

      await expect(panel(page)).toBeHidden();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");

      await toggle(page).click();
      await expect(panel(page)).toBeVisible();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
      await expect(panel(page).locator(".ocr__body")).toContainText("page 1");

      await toggle(page).click();
      await expect(panel(page)).toBeHidden();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
    });

    test("the panel head reads `[icon] Recognized text` — a decorative icon before the label", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/n-doc-attn");
      await expect(page.locator(".pager__count")).toHaveText("1 / 20");

      await toggle(page).click();
      const head = panel(page).locator(".ocr__head");
      // A decorative svg icon before the label; the label text stays intact.
      await expect(head.locator(".ocr__head-ic svg")).toBeVisible();
      await expect(head).toContainText("Recognized text");
    });

    test("the page canvas re-lays out when the panel takes its share of the stage", async ({ page }) => {
      // A tall, narrow stage so the page is WIDTH-constrained — that is the
      // regime where the panel's 268px+22px actually competes with the canvas.
      await page.setViewportSize({ width: 800, height: 1000 });
      await signedIn(page);
      await page.goto("/#/note/n-doc-attn");
      await expect(page.locator(".pager__count")).toHaveText("1 / 20");

      // The page index docks on the LEFT and is open by default; close it so this
      // measures the recognized-text (right) panel as the single variable, on a
      // stage too narrow to hold both docks.
      await page.getByRole("button", { name: "Pages" }).click();
      await expect(page.getByRole("complementary", { name: "Pages" })).toBeHidden();

      const pageEl = page.locator(".page");
      const wide = await pageEl.evaluate((el: HTMLElement) => el.offsetWidth);

      await toggle(page).click();
      await expect(panel(page)).toBeVisible();
      // Opening the panel narrows the stage, so the page must shrink — if the
      // reader skipped the showPage() re-layout this stays equal.
      await expect.poll(async () => pageEl.evaluate((el: HTMLElement) => el.offsetWidth)).toBeLessThan(wide);

      await toggle(page).click();
      await expect.poll(async () => pageEl.evaluate((el: HTMLElement) => el.offsetWidth)).toBe(wide);
    });

    test("content follows the current page while the panel stays open", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/n-doc-attn");
      // Wait for the note to finish opening: opening a note RESETS the panel, so
      // a toggle click racing that reset would be undone by it.
      await expect(page.locator(".pager__count")).toHaveText("1 / 20");
      await toggle(page).click();
      await expect(panel(page).locator(".ocr__body")).toContainText("page 1");

      await page.getByRole("button", { name: "Next page" }).click();
      await expect(page.locator(".pager__count")).toHaveText("2 / 20");
      await expect(panel(page)).toBeVisible();
      await expect(panel(page).locator(".ocr__body")).toContainText("page 2");
    });

    test("a page with no recognized text disables the toggle and states so plainly", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/n-doc-attn");
      await expect(page.locator(".pager__count")).toHaveText("1 / 20");
      await expect(toggle(page)).toBeEnabled();

      // Page 3 (index 2) is the fixture's un-recognized page.
      await page.getByRole("button", { name: "Page 3", exact: true }).click();
      await expect(page.locator(".pager__count")).toHaveText("3 / 20");
      await expect(toggle(page)).toBeDisabled();

      // Open the panel from a page that HAS text, then walk onto the one that
      // doesn't: the panel stays closable and says why it is blank.
      await page.getByRole("button", { name: "Page 2", exact: true }).click();
      await expect(toggle(page)).toBeEnabled();
      await toggle(page).click();
      await page.getByRole("button", { name: "Page 3", exact: true }).click();
      // The blank body says why, in the SHARED side-panel state line (loading /
      // empty / error) every docked panel speaks — see src/ui/sidePanel.ts.
      await expect(panel(page).locator(".side-panel__state")).toContainText("No recognized text");
      await expect(toggle(page)).toBeEnabled();
    });

    test("the panel resets to closed when a different note opens", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/n-doc-attn");
      await expect(page.locator(".pager__count")).toHaveText("1 / 20");
      await toggle(page).click();
      await expect(panel(page)).toBeVisible();

      await page.goto("/#/note/n-weekly");
      await expect(page.locator(".pager__count")).toHaveText("1 / 3");
      await expect(panel(page)).toBeHidden();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
    });
  });

  // The PAGE INDEX is a member of the docked side-panel family now (Layers/OCR):
  // same primitive and chrome, but docked LEFT and open by default. A chrome
  // unification — the filmstrip's own behaviour (lazy thumbs, current-page
  // highlight, click-to-jump, keyboard) is unchanged and covered above.
  test.describe("the page index side panel", () => {
    const pagesPanel = (page: Page) => page.getByRole("complementary", { name: "Pages" });
    const pagesToggle = (page: Page) => page.locator(".reader__bar").getByRole("button", { name: "Pages" });

    test("rides the shared side-panel primitive, docked LEFT, open by default", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/n-doc-attn");
      await expect(page.locator(".pager__count")).toHaveText("1 / 20");

      // One family: a `.side-panel` with the `.pages` hook and a `[icon] Pages`
      // head, exactly like Recognized text / Layers — but OPEN by default.
      const panel = pagesPanel(page);
      await expect(panel).toBeVisible();
      await expect(panel).toHaveClass(/side-panel/);
      await expect(panel).toHaveClass(/\bpages\b/);
      const head = panel.locator(".pages__head");
      await expect(head.locator(".pages__head-ic svg")).toBeVisible();
      await expect(head).toContainText("Pages");
      await expect(pagesToggle(page)).toHaveAttribute("aria-pressed", "true");

      // The filmstrip rail IS the panel's body — the page buttons live inside it.
      await expect(panel.locator(".filmstrip .filmstrip__page").first()).toBeVisible();

      // Docked on the LEFT: the panel sits BEFORE the page (narrowing, not overlaying).
      const panelBox = (await panel.boundingBox())!;
      const pageBox = (await page.locator(".page").boundingBox())!;
      expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(pageBox.x + 2);

      // Layers/OCR stay CLOSED by default — same component, different initial state.
      await expect(page.getByRole("complementary", { name: "Recognized text" })).toBeHidden();
      await expect(
        page.locator(".reader__bar").getByRole("button", { name: "Recognized text" }),
      ).toHaveAttribute("aria-pressed", "false");
    });

    test("the toggle collapses and reopens it, and the page re-lays out", async ({ page }) => {
      // A tall, narrow stage so the page is WIDTH-constrained and the panel's slice
      // actually moves the page width.
      await page.setViewportSize({ width: 800, height: 1000 });
      await signedIn(page);
      await page.goto("/#/note/n-doc-attn");
      await expect(page.locator(".pager__count")).toHaveText("1 / 20");

      const pageEl = page.locator(".page");
      const narrow = await pageEl.evaluate((el: HTMLElement) => el.offsetWidth);

      // Closing the left panel gives the page its width back.
      await pagesToggle(page).click();
      await expect(pagesPanel(page)).toBeHidden();
      await expect(pagesToggle(page)).toHaveAttribute("aria-pressed", "false");
      await expect.poll(async () => pageEl.evaluate((el: HTMLElement) => el.offsetWidth)).toBeGreaterThan(narrow);

      // Reopening narrows it again.
      await pagesToggle(page).click();
      await expect(pagesPanel(page)).toBeVisible();
      await expect.poll(async () => pageEl.evaluate((el: HTMLElement) => el.offsetWidth)).toBe(narrow);
    });

    test("on a narrow stage, opening a right-hand tool auto-collapses the page index", async ({ page }) => {
      await page.setViewportSize({ width: 800, height: 1000 });
      await signedIn(page);
      await page.goto("/#/note/n-doc-attn");
      await expect(page.locator(".pager__count")).toHaveText("1 / 20");
      await expect(pagesPanel(page)).toBeVisible();

      // Opening Recognized text (a RIGHT dock) on a stage too narrow to hold both
      // collapses the LEFT page index — never squeeze the page from both sides.
      await page.locator(".reader__bar").getByRole("button", { name: "Recognized text" }).click();
      await expect(page.getByRole("complementary", { name: "Recognized text" })).toBeVisible();
      await expect(pagesPanel(page)).toBeHidden();
      await expect(pagesToggle(page)).toHaveAttribute("aria-pressed", "false");
    });
  });

  test("Back returns to the library", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/n-doc-attn");
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();

    await page.getByRole("button", { name: "Library" }).click();

    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Reader" })).toBeHidden();
  });

  // Regression: the shell's form-control reset was written as `.sn-root button,
  // …` — specificity (0,1,1) — so its `font: inherit; color: inherit` silently
  // outranked every component class that styles a control, `.btn--ink` included.
  // The filled Export button therefore inherited `--ink` for its label and (via
  // currentColor) its icon stroke, against an `--ink` background: a solid,
  // unreadable block. Contrast is the durable assertion here — it fails for any
  // cause (a dropped declaration, a bad token, an invalid color-mix), not just
  // this one.
  test.describe("toolbar buttons are legible", () => {
    for (const scheme of ["light", "dark"] as const) {
      test(`toolbar buttons show their label and icon in ${scheme} mode`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await signedIn(page);
        await page.goto("/#/note/n-doc-attn");

        await expect(page.locator(".pager__count")).toHaveText("1 / 20");

        // "Move to bin" is now the icon+label control in the file zone — Download
        // and recognised-text went icon-only (`toolbar.md` override), so this is
        // the button that still carries a visible word beside its glyph, which is
        // exactly what a "label AND icon" legibility test wants. Scoped to the bar
        // so the rail's "Recycle bin" row does not stand in for it.
        const labelledBtn = page.locator(".reader__bar").getByRole("button", { name: "Move to bin" });
        await expect(labelledBtn).toBeVisible();

        // The label is a real, visible text node — not just an accessible name.
        await expect(labelledBtn).toHaveText("Move to bin");

        // The leading glyph is present and actually sized.
        const icon = labelledBtn.locator("svg");
        await expect(icon).toBeVisible();
        const box = await icon.boundingBox();
        expect(box?.width).toBeGreaterThan(8);
        expect(box?.height).toBeGreaterThan(8);

        const { color, background, stroke } = await paintedColours(labelledBtn);

        // The bug in one number: label vs. the background it is painted
        // against scored 1.0 (identical colours).
        expect(contrastRatio(color, background)).toBeGreaterThan(4.5);
        // The icon is stroked with currentColor, so it must be just as legible.
        expect(stroke).not.toBeNull();
        expect(contrastRatio(stroke!, background)).toBeGreaterThan(4.5);

        // And the component's own typography survives the reset (the mono
        // eyebrow step, not the inherited 16px system sans the reset was
        // forcing). The size is the design-system --fs-eyebrow token: this was
        // 11.5px before the coherence pass snapped every control label to the
        // 11px eyebrow step (a -0.5px tightening, not a behaviour change).
        const font = await labelledBtn.evaluate((el) => {
          const cs = getComputedStyle(el);
          return { size: cs.fontSize, family: cs.fontFamily };
        });
        expect(font.size).toBe("11px");
        expect(font.family).toContain("monospace");
      });
    }
  });

  // ---- the reader owns the header ----------------------------------------
  //
  // Opening a note used to show its title twice and its folder twice, because
  // the library's topbar stayed on screen during a mode that is not the library
  // — and two of the controls it kept were wrong there: sort and the view toggle
  // describe a listing, and typing in the search box CLOSED the reader.
  test.describe("the reader owns the header", () => {
    test("opening a note hides the library topbar and the reader still has height", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/n-doc-attn");
      await expect(page.locator(".pager__count")).toHaveText("1 / 20");
      await freezeMotion(page);

      // The library header, and specifically the three controls that were wrong
      // over a note, are gone rather than merely visually quiet.
      await expect(page.locator(".topbar")).toBeHidden();
      await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeHidden();
      await expect(page.getByRole("combobox", { name: "Sort notes" })).toBeHidden();
      await expect(page.getByRole("group", { name: "View" })).toBeHidden();

      // THE TRAP, asserted as GEOMETRY. `.reader` is `position: absolute;
      // inset: 0`, so its height comes from `.content`; auto-placed rows let
      // hiding the topbar promote `.content` into the collapsed `auto` row and
      // the reader resolved to `Wx0` — blank, while `is-open`, `display: grid`
      // and `visibility` all still read correctly. Every class-and-computed-style
      // check passes on that bug; only a measurement catches it.
      const box = await page.locator(".reader").boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThan(200);
      expect(box!.width).toBeGreaterThan(200);

      // And the thing that has to be inside it really is painted.
      const pageBox = await page.locator(".page").boundingBox();
      expect(pageBox!.height).toBeGreaterThan(100);
    });

    test("closing the reader brings the library header back", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/n-doc-attn");
      await expect(page.locator(".topbar")).toBeHidden();

      await page.locator(".backbtn").click();

      await expect(page.locator(".topbar")).toBeVisible();
      await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
    });

    test("Back names the folder it returns to, and the subtitle does not repeat it", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await railSettled(page);
      await page.getByRole("button", { name: "Document" }).first().click();
      await cardButton(page, /Attention Is All You Need/).click();

      await expect(page.locator(".backbtn")).toHaveText("Document");
      // Back carries the folder, so the subtitle must not carry it too — that
      // duplication is the whole reason the library header left.
      await expect(page.locator(".reader__title span")).toHaveText("20 pages");
    });

    test("Back from a search result says Search, and the subtitle names the folder", async ({ page }) => {
      await signedIn(page);
      await page.goto("/");
      await railSettled(page);
      await page.getByRole("searchbox", { name: "Search notes" }).fill("Aurora");
      await page.locator(".card--result .card__open").first().click();

      // Results are LIBRARY-WIDE, so the note's folder is not where you were.
      await expect(page.locator(".backbtn")).toHaveText("Search");
      // …which makes the folder new information, so here it stays.
      await expect(page.locator(".reader__title span")).toContainText("Note / Projects");
    });
  });

  // ---- the shared viewer toolbar -----------------------------------------
  //
  // The reader's bar is the first consumer of `pages/toolbar.ts`. These assert
  // the SEMANTICS the shared component adds — a `role="toolbar"` landmark, two
  // zones, a decorative divider, and roving-tabindex keyboard movement — so a
  // future `.spd`/`.txt` viewer inherits a bar that is already accessible.
  test.describe("the shared toolbar", () => {
    test("exposes a toolbar landmark with two zones and a decorative divider", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/n-doc-attn");
      await expect(page.locator(".pager__count")).toHaveText("1 / 20");

      const bar = page.getByRole("toolbar", { name: "Reader controls" });
      await expect(bar).toBeVisible();

      // Two zones: the contextual reading controls, and the universal file actions.
      await expect(bar.getByRole("group", { name: "Reading controls" })).toBeVisible();
      await expect(bar.getByRole("group", { name: "File actions" })).toBeVisible();

      // Download is a UNIVERSAL action — it lives in the right zone, the same spot
      // it will occupy in every viewer.
      await expect(
        bar.getByRole("group", { name: "File actions" }).getByRole("button", { name: "Download" }),
      ).toBeVisible();

      // The divider is a decorative CSS rule: hidden from assistive tech and
      // carrying NO text — never a `|` glyph a screen reader would read aloud.
      const sep = page.locator(".reader__bar .toolbar__sep");
      await expect(sep).toHaveAttribute("aria-hidden", "true");
      await expect(sep).toHaveText("");
    });

    test("is one tab stop and arrow keys rove between its controls", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/n-doc-attn");
      await expect(page.locator(".pager__count")).toHaveText("1 / 20");

      // Opens with Back focused (the keyboard entry point) and exactly one control
      // in the bar is a tab stop; the rest are removed from the Tab order.
      await expect(page.getByRole("button", { name: "Library" })).toBeFocused();
      expect(await page.locator('.reader__bar [tabindex="0"]').count()).toBe(1);

      // Arrow-right roves to the next control rather than paging: the toolbar
      // claims the key while one of its controls has focus, so the page does NOT
      // turn (that is the reader's arrow paging, and it is off the toolbar now).
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("button", { name: "Previous page" })).toBeFocused();
      await expect(page.locator(".pager__count")).toHaveText("1 / 20");
      expect(await page.locator('.reader__bar [tabindex="0"]').count()).toBe(1);

      await page.keyboard.press("ArrowLeft");
      await expect(page.getByRole("button", { name: "Library" })).toBeFocused();
    });

    test("roves through the right zone to the added Move to bin control", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/n-doc-attn");
      await expect(page.getByRole("button", { name: "Library" })).toBeFocused();

      // End jumps to the LAST control in the bar's single tab stop. Adding Move to
      // bin to the right zone moved that endpoint onto it with no per-consumer
      // wiring — the shared roving order absorbed the new control.
      await page.keyboard.press("End");
      await expect(
        page.locator(".reader__bar").getByRole("button", { name: "Move to bin" }),
      ).toBeFocused();
      expect(await page.locator('.reader__bar [tabindex="0"]').count()).toBe(1);

      // Home returns to Back, and the bar is still exactly one tab stop.
      await page.keyboard.press("Home");
      await expect(page.getByRole("button", { name: "Library" })).toBeFocused();
    });

    test("Download and recognised-text are icon-only but keep their accessible names", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/n-doc-attn");
      await expect(page.locator(".pager__count")).toHaveText("1 / 20");

      const bar = page.locator(".reader__bar");

      // Download: the visible word is dropped (a deliberate override of the
      // icon+label default — the user's call), but the accessible name and the
      // tooltip still say "Download", and the glyph is there.
      const download = bar.getByRole("button", { name: "Download" });
      await expect(download).toBeVisible();
      await expect(download).toHaveText(""); // no visible label — glyph only
      await expect(download).toHaveAttribute("title", "Download");
      await expect(download.locator("svg")).toBeVisible();

      // Recognised text: same treatment, and it keeps its aria-pressed toggle
      // state (the name is "Recognized text", matching the panel).
      const ocr = bar.getByRole("button", { name: "Recognized text" });
      await expect(ocr).toHaveText("");
      await expect(ocr).toHaveAttribute("title", "Recognized text");
      await expect(ocr).toHaveAttribute("aria-pressed", "false");
    });

    test("the Download trigger wears an active look while its menu is open, cleared when it closes", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/n-doc-attn");
      await expect(page.locator(".pager__count")).toHaveText("1 / 20");
      // AFTER navigation (a hash goto reloads the document and would drop a style
      // tag added earlier): freeze so the active background is its settled value,
      // not a frame partway through the 0.14s transition.
      await freezeMotion(page);

      const download = page.locator(".reader__bar").getByRole("button", { name: "Download" });
      const bg = () => download.evaluate((node) => getComputedStyle(node).backgroundColor);

      // Rest, pointer away: the transparent base.
      await page.mouse.move(2, 2);
      const restBg = await bg();
      await expect(download).toHaveAttribute("aria-expanded", "false");

      await download.click();
      await expect(download).toHaveAttribute("aria-expanded", "true");
      // Pointer OFF the button while the menu stays open, so what we measure is the
      // active-state rule (10-toolbar.css, keyed off aria-expanded) and not :hover.
      await page.mouse.move(2, 2);
      expect(await bg()).not.toBe(restBg);

      // Closing the menu any way — here a click outside — clears the look, because
      // the rule tracks the REAL menu state (aria-expanded), not a second flag.
      await page.locator(".stage").click({ position: { x: 5, y: 5 } });
      await expect(download).toHaveAttribute("aria-expanded", "false");
      await page.mouse.move(2, 2);
      expect(await bg()).toBe(restBg);
    });

    test("Move to bin trashes the open note, offers an undo with the device line, and leaves the reader", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/n-doc-attn");
      await expect(page.locator(".reader.is-open")).toBeVisible();
      await expect(page.locator(".pager__count")).toHaveText("1 / 20");

      const moveBin = page.locator(".reader__bar").getByRole("button", { name: "Move to bin" });
      await expect(moveBin).toBeVisible();
      // QUIET, NEVER RED: trash is recoverable, red is reserved for purge
      // (`toolbar.md`). It must not carry the danger styling.
      await expect(moveBin).not.toHaveClass(/is-danger/);

      await moveBin.click();

      // The SAME undo toast the library card's delete raises — reused, not a second
      // path: "Moved …", the U6 device asymmetry line, and an Undo control.
      const toast = page.locator(".bin-toast");
      await expect(toast).toContainText("Moved");
      await expect(toast).toContainText("Also comes off your Supernote at the next sync.");
      await expect(toast.locator(".bin-toast__action")).toHaveText("Undo");

      // The note now lives in the bin, so the reader closes and the library is back.
      await expect(page.locator(".reader.is-open")).toBeHidden();
      await expect(page.locator(".gallery")).toBeVisible();
    });

    test("Move to bin is absent in the recycle-bin context, where the note is already trashed", async ({ page }) => {
      await signedIn(page);
      // Open a trashed note straight from the bin: the reader is reused with a
      // "bin" origin, and re-trashing an already-trashed file is nonsense — so the
      // action is hidden until the bin's own Restore/Delete right zone exists.
      await page.goto("/#/bin");
      await expect(page.locator(".bin")).toBeVisible();
      await page.locator(".bin__row", { hasText: "download_test.note" }).locator("button.bin__open").click();
      await expect(page.locator(".backbtn__label")).toHaveText("Recycle bin");

      await expect(
        page.locator(".reader__bar").getByRole("button", { name: "Move to bin" }),
      ).toBeHidden();
    });
  });
  // A `.note`'s OWN links — the rectangles a PDF used as a page's template
  // brought with it (`parsers/note/note-format.md` §14). The fake serves them
  // for ONE fixture (`n-proj-beta`, seven pages), exactly as the real page list
  // carries `linksHash` for only the pages that have a link block.
  //
  // Rendered by the SAME component the PDF viewer uses (`pages/pdfLinkLayer.ts`),
  // so the anchors, the allowlist, the accessible names and the modifier-click
  // rule are not reimplemented here — what these tests pin is the wiring and the
  // GEOMETRY, which is the part that is specific to a `.note`: the rects are
  // device panel pixels and the page IS the panel, so there is no letterbox and
  // no page-rect mapping, just the scale the ink is already drawn at.
  test.describe("template links", () => {
    const layer = (page: Page) => page.locator(".page .pdf-links");

    test("puts each link on its own rect, as a real anchor, labelled", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/n-proj-beta");
      await expect(page.locator(".pager__count")).toHaveText("1 / 7");
      await expect(layer(page).locator("a")).toHaveCount(2, { timeout: 10_000 });

      // The EXTERNAL one: a new tab, severed from this one, and named by its URL
      // because the page underneath is a raster with no text to borrow.
      const ext = layer(page).locator('a[href^="https://example.com/planner"]');
      await expect(ext).toHaveAttribute("target", "_blank");
      await expect(ext).toHaveAttribute("rel", "noopener noreferrer");
      await expect(ext).toHaveAttribute("aria-label", /^https:\/\/example\.com\/planner/);

      // ABOVE THE INK, and that is DOM order rather than a z-index: the page's
      // canvases (the composite, and every canvas of a layered page's stack)
      // take pointer events, so a link layer mounted under them would be a link
      // you cannot click on exactly the pages people annotate most.
      await expect(
        page.locator(".page > *:last-child").evaluate((n) => n.className),
      ).resolves.toContain("pdf-links");

      // The INTERNAL one: this app's own route, in this tab.
      const internal = layer(page).locator('a[href="#/note/n-proj-beta/page/2"]');
      await expect(internal).toHaveCount(1);
      await expect(internal).toHaveAttribute("aria-label", "Go to page 2");
      await expect(internal).not.toHaveAttribute("target", "_blank");

      // AND IT IS WHERE THE FILE PUT IT. The fixture's external rect is
      // (980,96) 340×64 in PANEL PIXELS on a 1404×1872 page, so it lands at
      // those fractions of the page box whatever size Fit chose. Asserted as
      // fractions, which is what makes this independent of the viewport — and
      // the rect is deliberately NOT centred on either axis, so a placement that
      // dropped an offset could not pass by symmetry.
      const geo = await page.evaluate(() => {
        const box = (document.querySelector(".page") as HTMLElement).getBoundingClientRect();
        const a = (
          document.querySelector('.page .pdf-links a[href^="https://example.com/planner"]') as HTMLElement
        ).getBoundingClientRect();
        return {
          left: (a.left - box.left) / box.width,
          top: (a.top - box.top) / box.height,
          width: a.width / box.width,
          height: a.height / box.height,
        };
      });
      expect(geo.left).toBeCloseTo(980 / 1404, 2);
      expect(geo.top).toBeCloseTo(96 / 1872, 2);
      expect(geo.width).toBeCloseTo(340 / 1404, 2);
      expect(geo.height).toBeCloseTo(64 / 1872, 2);
    });

    test("following an internal link is a page turn, at a real address", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/n-proj-beta");
      await expect(page.locator(".pager__count")).toHaveText("1 / 7");

      await layer(page).locator('a[href="#/note/n-proj-beta/page/2"]').click();
      await expect(page.locator(".pager__count")).toHaveText("2 / 7");
      // A REAL ADDRESS, not a scroll: shareable, and it survives a reload.
      expect(page.url()).toContain("#/note/n-proj-beta/page/2");
      // The layer followed the turn — page 2's jump goes to page 3, so the
      // previous page's anchor is gone rather than left offering a stale target.
      await expect(layer(page).locator('a[href="#/note/n-proj-beta/page/3"]')).toHaveCount(1, {
        timeout: 10_000,
      });
      await expect(layer(page).locator('a[href="#/note/n-proj-beta/page/2"]')).toHaveCount(0);
    });

    test("a note with no imported template has no layer at all", async ({ page }) => {
      // The overwhelming case: a note on a built-in style has nothing to
      // preserve, so there is no link block, no request and nothing focusable.
      await signedIn(page);
      await page.goto("/#/note/n-doc-attn");
      await expect(page.locator(".pager__count")).toHaveText("1 / 20");
      await expect(page.locator(".page canvas")).toBeVisible();
      await expect(layer(page).locator("a")).toHaveCount(0);
    });

    test("the layer follows the page box through a zoom step", async ({ page }) => {
      await signedIn(page);
      await page.goto("/#/note/n-proj-beta");
      const anchor = layer(page).locator('a[href^="https://example.com/planner"]');
      await expect(anchor).toBeVisible({ timeout: 10_000 });

      // NULL WHILE THE LAYER IS DOWN rather than throwing: every repaint takes
      // the old anchors away before placing the new ones, so a measurement in
      // that window has to wait.
      const measure = async (): Promise<{ page: number; left: number; width: number } | null> =>
        page.evaluate(() => {
          const box = document.querySelector(".page") as HTMLElement | null;
          const a = document.querySelector(
            '.page .pdf-links a[href^="https://example.com/planner"]',
          ) as HTMLElement | null;
          if (!box || !a) return null;
          const b = box.getBoundingClientRect();
          const r = a.getBoundingClientRect();
          return { page: b.width, left: (r.left - b.left) / b.width, width: r.width / b.width };
        });

      const before = await measure();
      expect(before).not.toBeNull();

      await page.getByRole("button", { name: "Zoom in" }).click();
      // The page box actually grew...
      await expect.poll(async () => (await measure())?.page ?? 0, { timeout: 10_000 }).toBeGreaterThan(
        before!.page,
      );
      // ...and the anchor is still on the same part of it.
      const after = await measure();
      expect(after!.left).toBeCloseTo(before!.left, 2);
      expect(after!.width).toBeCloseTo(before!.width, 2);
    });
  });
});
