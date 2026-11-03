import { test, expect, type Page } from "@playwright/test";
import { signedIn, imgInkFraction, imgPainted, freezeMotion } from "./helpers/app";

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

    await expect(light).toHaveAttribute("aria-pressed", "true");
    await expect(dark).toHaveAttribute("aria-pressed", "false");

    await dark.click();

    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(dark).toHaveAttribute("aria-pressed", "true");
    await expect(light).toHaveAttribute("aria-pressed", "false");
  });
});

// Off-screen tiles drop to an unpainted <img> and re-render lazily for the new theme.
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

    await expect.poll(async () => imgInkFraction(firstImg), { timeout: 5000 }).toBeGreaterThan(0.003);
    expect(await imgPainted(lastImg)).toBe(false);

    await page.getByRole("button", { name: "Your account" }).click();
    await page.locator(".acct-theme").getByRole("button", { name: "Paper Dark" }).click();

    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.goBack();
    await expect(page.locator("#gallery")).toBeVisible();
    await expect.poll(async () => cards.count()).toBeGreaterThan(20);

    await expect.poll(async () => imgInkFraction(firstImg), { timeout: 5000 }).toBeGreaterThan(0.003);
    expect(await imgPainted(lastImg)).toBe(false);
  });
});

// Regression: the theme was never written to storage. Precedence: stored > OS > light.
test.describe("theme persistence", () => {
  const html = (page: Page) => page.locator("html");

  test("the chosen theme survives a reload", async ({ page }) => {
    await signedIn(page);
    await pinTheme(page, "dark");
    await expect(html(page)).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => localStorage.getItem("sn.theme"))).toBe("dark");

    await page.reload();
    await expect(html(page)).toHaveAttribute("data-theme", "dark");

    await page.locator(".acct-theme").getByRole("button", { name: "Paper", exact: true }).click();
    await expect(html(page)).toHaveAttribute("data-theme", "light");
    await page.reload();
    await expect(html(page)).toHaveAttribute("data-theme", "light");
  });

  // The entry module is deferred, so a restore there flashes the wrong theme; blocking
  // the bundle proves the restore runs without it.
  test("the restore does not wait for the app bundle (no flash of the wrong theme)", async ({ page }) => {
    await signedIn(page);
    await pinTheme(page, "dark");
    await expect(html(page)).toHaveAttribute("data-theme", "dark");

    await page.route("**/src/main.ts", (route) => route.abort());
    await page.reload();

    await expect(html(page)).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => document.getElementById("app")?.childElementCount)).toBe(0);
  });

  test("with no stored choice the OS preference wins and stays live", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await signedIn(page);
    await page.goto("/");

    expect(await page.evaluate(() => document.documentElement.hasAttribute("data-theme"))).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem("sn.theme"))).toBeNull();

    await page.emulateMedia({ colorScheme: "light" });
    expect(await page.evaluate(() => document.documentElement.hasAttribute("data-theme"))).toBe(false);

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

    await expect(page.locator(".sn-root")).toBeVisible();
    await pinTheme(page, "dark");
    await expect(html(page)).toHaveAttribute("data-theme", "dark");
  });
});

// Regression: the control vanished while reading because its container was hidden.
// Asserts computed geometry, since `toBeVisible()` passes for a zero-width box.
test.describe("theme control reach", () => {
  const nameplate = (page: Page) => page.getByRole("button", { name: "Your account" });

  async function probe(page: Page) {
    // An automated tab is `visibilityState: hidden`, which freezes CSS transitions mid-flight.
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

    await page.goto("/");
    await expect(nameplate(page)).toBeVisible();
    const inLibrary = await probe(page);
    expect(inLibrary.display).not.toBe("none");
    expect(inLibrary.visibility).toBe("visible");
    expect(inLibrary.width).toBeGreaterThan(20);
    expect(inLibrary.height).toBeGreaterThan(20);

    await page.goto("/#/note/141");
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
    await expect(page.locator(".sn-root")).toHaveClass(/is-reading/);
    await expect(page.locator(".topbar")).toBeHidden();

    await expect(nameplate(page)).toBeVisible();
    const inReader = await probe(page);
    expect(inReader.display).not.toBe("none");
    expect(inReader.visibility).toBe("visible");
    expect(inReader.opacity).toBeGreaterThan(0);
    expect(inReader.width).toBeGreaterThan(20);
    expect(inReader.height).toBeGreaterThan(20);

    await expect(nameplate(page)).toHaveCount(1);

    await nameplate(page).click();
    await page.locator(".acct-theme").getByRole("button", { name: "Paper Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("there is exactly one theme control, and it is not in the rail", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/account");

    await expect(page.locator(".acct-theme")).toHaveCount(1);
    await expect(page.locator(".rail").getByRole("group", { name: "Theme" })).toHaveCount(0);
    await expect(page.locator(".rail").getByRole("button", { name: "Toggle light or dark" })).toHaveCount(0);
  });
});
