import { test, expect } from "@playwright/test";
import { signedIn, imgInkFraction, imgPainted, freezeMotion } from "./helpers/app";

// Toggling the theme must repaint ONLY what's currently visible; off-screen
// thumbnails drop back to a blank placeholder and re-render lazily when next
// scrolled in (they're keyed by theme, so nothing is lost). Proven at the pixel
// level against the deep Archive folder.
//
// The gallery tiles are `<img src="blob:…">` now, not canvases: a repaint swaps
// the <img> to the OTHER theme's WebP blob (constraint: a toggle re-paints visible
// tiles to the correct theme, off-screen ones stay unpainted). "Blank" therefore
// means an unpainted <img> (empty src), not a near-zero-ink canvas.
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

    await page.getByRole("button", { name: "Toggle light or dark" }).click();

    // The theme is pinned on <html>.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // The visible card was repainted for the new theme (still inked, not blank)…
    await expect.poll(async () => imgInkFraction(firstImg), { timeout: 5000 }).toBeGreaterThan(0.003);
    // …while the off-screen card was NOT repainted — it stays an unpainted tile.
    expect(await imgPainted(lastImg)).toBe(false);
  });
});

// Regression: the chosen theme used to live ONLY on `<html data-theme>` — it was
// never written to storage, so any reload dropped it back to the OS preference.
// Precedence is: explicit stored choice > prefers-color-scheme > light.
test.describe("theme persistence", () => {
  const html = (page: import("@playwright/test").Page) => page.locator("html");
  const toggle = (page: import("@playwright/test").Page) =>
    page.getByRole("button", { name: "Toggle light or dark" });

  test("the chosen theme survives a reload", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await toggle(page).click();
    await expect(html(page)).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => localStorage.getItem("sn.theme"))).toBe("dark");

    await page.reload();
    // The whole bug: this used to come back unset.
    await expect(html(page)).toHaveAttribute("data-theme", "dark");

    // And toggling back is just as durable.
    await toggle(page).click();
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
    await page.goto("/");
    await toggle(page).click();
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
    await toggle(page).click();
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

    // The shell still boots and the toggle still works for this session.
    await expect(page.locator(".sn-root")).toBeVisible();
    await toggle(page).click();
    await expect(html(page)).toHaveAttribute("data-theme", "dark");
  });
});

// Regression: the toggle used to live in the library topbar, and `.sn-root.is-reading`
// hides that topbar outright — so the control disappeared exactly while reading a
// note, which is when someone most wants to switch to dark. It now lives in the
// left rail's footer, which is rendered in both views.
//
// These assert COMPUTED geometry, not mere presence. `toBeVisible()` alone would
// pass for a control that is technically in the layout but collapsed to zero
// width by a rail that ran out of room, and the whole failure mode here is a
// control that exists in the DOM but cannot be reached.
test.describe("theme toggle reach", () => {
  const toggle = (page: import("@playwright/test").Page) =>
    page.getByRole("button", { name: "Toggle light or dark" });

  /** Computed box + display of the toggle, measured with transitions frozen. */
  async function probe(page: import("@playwright/test").Page) {
    // An automated tab reports `visibilityState: hidden`, which freezes CSS
    // transitions mid-flight and hands back intermediate computed values.
    await freezeMotion(page);
    return toggle(page).evaluate((node) => {
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

    // Baseline: the library, where it has always worked.
    await page.goto("/");
    await expect(toggle(page)).toBeVisible();
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

    // …and the toggle is still there, still a real, clickable box.
    await expect(toggle(page)).toBeVisible();
    const inReader = await probe(page);
    expect(inReader.display).not.toBe("none");
    expect(inReader.visibility).toBe("visible");
    expect(inReader.opacity).toBeGreaterThan(0);
    expect(inReader.width).toBeGreaterThan(20);
    expect(inReader.height).toBeGreaterThan(20);

    // Exactly one of them — a duplicate in the reader bar would be a second
    // control for one piece of state.
    await expect(toggle(page)).toHaveCount(1);

    // And it still does its job from here.
    await toggle(page).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  // The rail footer holds an avatar, a name, a mono email, the theme toggle and
  // sign out inside a fixed 232px column. Adding the toggle must make the email
  // ellipsis, not make the row wider than the rail — an overflowing footer is how
  // a control silently ends up clipped out of reach.
  test("adding it does not push the rail footer into overflow", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await freezeMotion(page);

    const box = await page.locator(".account").evaluate((node) => {
      const rail = node.closest(".rail") as HTMLElement;
      const mail = node.querySelector(".account__mail") as HTMLElement;
      const topbar = document.querySelector(".topbar")!.getBoundingClientRect();
      const hit = document.elementFromPoint(topbar.x + 4, topbar.y + 4);
      return {
        railWidth: rail.getBoundingClientRect().width,
        // Every grid row of the rail, by width. They all share one column, so a
        // single over-wide row drags the rest out with it.
        rowWidths: [...rail.children].map((c) => c.getBoundingClientRect().width),
        footerWidth: node.getBoundingClientRect().width,
        footerScrollWidth: node.scrollWidth,
        footerClientWidth: node.clientWidth,
        mailTextOverflow: getComputedStyle(mail).textOverflow,
        mailOverflow: getComputedStyle(mail).overflow,
        mailClientWidth: mail.clientWidth,
        topLeftOfTopbar: hit ? hit.className : "",
      };
    });

    // Nothing spills horizontally out of the footer or out of the rail itself.
    expect(box.footerScrollWidth).toBeLessThanOrEqual(box.footerClientWidth);
    expect(box.railWidth).toBeCloseTo(232, 0);

    // No rail row is wider than the rail. (Deliberately not `rail.scrollWidth`:
    // `.rail::after`, the accent margin rule, is absolutely positioned at
    // `right: -1px` and overhangs by design, so scroll overflow reads 1px even
    // when every row fits.)
    expect(box.rowWidths.length).toBeGreaterThan(0);
    for (const w of box.rowWidths) expect(w).toBeLessThanOrEqual(box.railWidth);

    // The footer is not wider than the rail it sits in. This is the exact
    // regression the toggle caused: the rail's implicit `auto` grid column floors
    // at max-content, so a footer too wide for 232px stretched the column and
    // every rail row painted over the topbar — invisibly, but it ate clicks
    // aimed at the topbar's left edge.
    expect(box.footerWidth).toBeLessThanOrEqual(box.railWidth);
    expect(box.topLeftOfTopbar).toContain("topbar");

    // The email is what gives when the row runs out of room — it is set up to
    // ellipsis inside whatever is left rather than force the row wider.
    expect(box.mailOverflow).toBe("hidden");
    expect(box.mailTextOverflow).toBe("ellipsis");
    expect(box.mailClientWidth).toBeGreaterThan(0);
  });

  // Both siblings must survive: the point of the move was one reachable control,
  // not one control replacing another.
  test("sits beside sign out, both usable", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/note/n-doc-attn");
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();

    const actions = page.locator(".account__actions");
    await expect(actions.getByRole("button", { name: "Toggle light or dark" })).toBeVisible();
    await expect(actions.getByRole("button", { name: "Sign out" })).toBeVisible();
  });
});
