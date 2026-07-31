import { test, expect, type Page } from "@playwright/test";
import { signedIn, imgInkFraction, imgPainted, freezeMotion } from "./helpers/app";

// THE THEME CONTROL MOVED. It used to be an icon button in the rail's footer;
// it is now the Appearance section of the account page, as a two-option control
// (docs/scratch/user-options.md §7). The argument for keeping it one click away
// — people flip it often — did not survive the fact that the app already follows
// `prefers-color-scheme`: it is a set-once override, it was already listed under
// Appearance, and leaving it in the rail meant one control in two places.
//
// So every test below reaches it through the page. What is being pinned has not
// changed: the precedence rule, the persistence, the pre-paint restore, and the
// lazy repaint.

/** Pin a theme the way a person does now: nameplate → Appearance. */
async function pinTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.goto("/#/account");
  await expect(page.locator(".acct")).toBeVisible();
  await page.locator(".acct-theme").getByRole("button", { name: theme === "dark" ? "Paper Dark" : "Paper", exact: true }).click();
}

test.describe("the Appearance control", () => {
  test("pins the theme and says which one is in force", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/account");

    const light = page.locator(".acct-theme").getByRole("button", { name: "Paper", exact: true });
    const dark = page.locator(".acct-theme").getByRole("button", { name: "Paper Dark" });

    // A TWO-OPTION CONTROL, so which one you are in is readable rather than
    // inferred from a glyph that could mean either state.
    await expect(light).toHaveAttribute("aria-pressed", "true");
    await expect(dark).toHaveAttribute("aria-pressed", "false");

    await dark.click();

    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(dark).toHaveAttribute("aria-pressed", "true");
    await expect(light).toHaveAttribute("aria-pressed", "false");
  });
});

// Toggling the theme must repaint ONLY what's currently visible; off-screen
// thumbnails drop back to a blank placeholder and re-render lazily when next
// scrolled in (they're keyed by theme, so nothing is lost). Proven at the pixel
// level against the deep Archive folder.
//
// The gallery tiles are `<img src="blob:…">`, not canvases: a repaint swaps the
// <img> to the OTHER theme's WebP blob. "Blank" therefore means an unpainted
// <img> (empty src), not a near-zero-ink canvas.
test.describe("theme toggle", () => {
  test("sets data-theme and repaints visible thumbnails while off-screen ones stay blank", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await page.locator(".card--folder", { hasText: "Archive" }).click();

    const cards = page.locator(".card");
    await expect(cards.first()).toBeVisible();
    await expect.poll(async () => cards.count()).toBeGreaterThan(20);

    const firstImg = cards.first().locator("img.thumb__img");
    const lastImg = cards.last().locator("img.thumb__img");

    // The top card renders (inked); the far card is an unpainted placeholder.
    await expect.poll(async () => imgInkFraction(firstImg), { timeout: 5000 }).toBeGreaterThan(0.003);
    expect(await imgPainted(lastImg)).toBe(false);

    // The route a person takes to the control now: the nameplate opens the
    // account page over the gallery (which is HIDDEN, not destroyed), Appearance
    // pins the theme, and Back returns to the folder.
    await page.getByRole("button", { name: "Your account" }).click();
    await page.locator(".acct-theme").getByRole("button", { name: "Paper Dark" }).click();

    // The theme is pinned on <html>.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.goBack();
    await expect(page.locator("#gallery")).toBeVisible();
    await expect.poll(async () => cards.count()).toBeGreaterThan(20);

    // The visible card is painted for the new theme (still inked, not blank)…
    await expect.poll(async () => imgInkFraction(firstImg), { timeout: 5000 }).toBeGreaterThan(0.003);
    // …while the off-screen card was NOT painted — it stays an unpainted tile.
    expect(await imgPainted(lastImg)).toBe(false);
  });
});

// Regression: the chosen theme used to live ONLY on `<html data-theme>` — it was
// never written to storage, so any reload dropped it back to the OS preference.
// Precedence is: explicit stored choice > prefers-color-scheme > light.
test.describe("theme persistence", () => {
  const html = (page: Page) => page.locator("html");

  test("the chosen theme survives a reload", async ({ page }) => {
    await signedIn(page);
    await pinTheme(page, "dark");
    await expect(html(page)).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => localStorage.getItem("sn.theme"))).toBe("dark");

    await page.reload();
    // The whole bug: this used to come back unset.
    await expect(html(page)).toHaveAttribute("data-theme", "dark");

    // And choosing back is just as durable.
    await page.locator(".acct-theme").getByRole("button", { name: "Paper", exact: true }).click();
    await expect(html(page)).toHaveAttribute("data-theme", "light");
    await page.reload();
    await expect(html(page)).toHaveAttribute("data-theme", "light");
  });

  // The restore must not depend on the app bundle: the entry module is deferred,
  // so by the time it runs the browser has usually already painted the body
  // background — restoring there is a visible flash of the wrong theme. Proven by
  // blocking the bundle entirely: if the only restore lived in the module, no
  // attribute would ever appear.
  test("the restore does not wait for the app bundle (no flash of the wrong theme)", async ({ page }) => {
    await signedIn(page);
    await pinTheme(page, "dark");
    await expect(html(page)).toHaveAttribute("data-theme", "dark");

    await page.route("**/src/main.ts", (route) => route.abort());
    await page.reload();

    // The document never ran a line of app code, yet the theme is already pinned.
    await expect(html(page)).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => document.getElementById("app")?.childElementCount)).toBe(0);
  });

  test("with no stored choice the OS preference wins and stays live", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await signedIn(page);
    await page.goto("/");

    // Nothing pinned => no attribute at all, so the media query stays in charge.
    expect(await page.evaluate(() => document.documentElement.hasAttribute("data-theme"))).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem("sn.theme"))).toBeNull();

    // An OS flip applies immediately, with still nothing pinned.
    await page.emulateMedia({ colorScheme: "light" });
    expect(await page.evaluate(() => document.documentElement.hasAttribute("data-theme"))).toBe(false);

    // Once the user chooses, their choice outranks the OS and survives a reload.
    await pinTheme(page, "dark");
    await expect(html(page)).toHaveAttribute("data-theme", "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await page.reload();
    await expect(html(page)).toHaveAttribute("data-theme", "dark");
  });

  test("boots normally when localStorage throws (private mode)", async ({ page }) => {
    await signedIn(page);
    await page.addInitScript(() => {
      const boom = () => {
        throw new DOMException("denied", "SecurityError");
      };
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get: boom,
      });
    });
    await page.goto("/");

    // The shell still boots and the control still works for this session.
    await expect(page.locator(".sn-root")).toBeVisible();
    await pinTheme(page, "dark");
    await expect(html(page)).toHaveAttribute("data-theme", "dark");
  });
});

// Regression, in its second form. The toggle used to live in the library topbar,
// and `.sn-root.is-reading` hides that topbar outright — so the control
// disappeared exactly while reading a note, which is when someone most wants to
// switch to dark. It moved to the rail footer, which is rendered in both views,
// and has now moved once more onto the account page. THE PROPERTY THAT MUST
// SURVIVE BOTH MOVES is that the door to it is reachable from the reader: the
// rail is what carries that door now, and nothing hides the rail at any width.
//
// These assert COMPUTED geometry, not mere presence. `toBeVisible()` alone would
// pass for a control that is technically in the layout but collapsed to zero
// width by a rail that ran out of room, and the whole failure mode here is a
// control that exists in the DOM but cannot be reached.
test.describe("theme control reach", () => {
  const nameplate = (page: Page) => page.getByRole("button", { name: "Your account" });

  /** Computed box + display of the nameplate, measured with transitions frozen. */
  async function probe(page: Page) {
    // An automated tab reports `visibilityState: hidden`, which freezes CSS
    // transitions mid-flight and hands back intermediate computed values.
    await freezeMotion(page);
    return nameplate(page).evaluate((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return {
        display: style.display,
        visibility: style.visibility,
        opacity: Number(style.opacity),
        width: rect.width,
        height: rect.height,
      };
    });
  }

  test("is reachable while a note is open, not just in the library", async ({ page }) => {
    await signedIn(page);

    // Baseline: the library.
    await page.goto("/");
    await expect(nameplate(page)).toBeVisible();
    const inLibrary = await probe(page);
    expect(inLibrary.display).not.toBe("none");
    expect(inLibrary.visibility).toBe("visible");
    expect(inLibrary.width).toBeGreaterThan(20);
    expect(inLibrary.height).toBeGreaterThan(20);

    // The regression: open a note. The library topbar is gone…
    await page.goto("/#/note/n-doc-attn");
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
    await expect(page.locator(".sn-root")).toHaveClass(/is-reading/);
    await expect(page.locator(".topbar")).toBeHidden();

    // …and the nameplate is still there, still a real, clickable box.
    await expect(nameplate(page)).toBeVisible();
    const inReader = await probe(page);
    expect(inReader.display).not.toBe("none");
    expect(inReader.visibility).toBe("visible");
    expect(inReader.opacity).toBeGreaterThan(0);
    expect(inReader.width).toBeGreaterThan(20);
    expect(inReader.height).toBeGreaterThan(20);

    // Exactly one of them — a duplicate would be a second door to one place.
    await expect(nameplate(page)).toHaveCount(1);

    // And it still gets you to the theme, from here.
    await nameplate(page).click();
    await page.locator(".acct-theme").getByRole("button", { name: "Paper Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  // ONE CONTROL, IN ONE PLACE. The point of the move was not to add a second
  // theme control on a page while leaving the first in the rail — that is the
  // duplication §7 removed.
  test("there is exactly one theme control, and it is not in the rail", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/account");

    await expect(page.locator(".acct-theme")).toHaveCount(1);
    await expect(page.locator(".rail").getByRole("group", { name: "Theme" })).toHaveCount(0);
    await expect(page.locator(".rail").getByRole("button", { name: "Toggle light or dark" })).toHaveCount(0);
  });
});
