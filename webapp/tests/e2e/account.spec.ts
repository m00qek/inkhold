import { test, expect, type Page } from "@playwright/test";
import { railSettled, signedIn } from "./helpers/app";

// The e2e user is `isAdmin: false`, so every test here runs as a non-admin.

async function openAccount(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Your account" }).click();
  await expect(page.locator(".acct")).toBeVisible();
}

function section(page: Page, label: string) {
  return page.locator(".acct-sec").filter({ has: page.locator(".acct-sec__label", { hasText: label }) });
}

test.describe("the rail footer nameplate", () => {
  test("opens the account page and no longer carries the theme toggle or sign out", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");

    const rail = page.locator(".rail");
    await expect(rail.getByRole("button", { name: "Toggle light or dark" })).toHaveCount(0);
    await expect(rail.getByRole("button", { name: "Sign out" })).toHaveCount(0);

    await page.getByRole("button", { name: "Your account" }).click();

    await expect(page).toHaveURL(/#\/account$/);
    await expect(page.locator(".acct")).toBeVisible();
    await expect(page.locator(".crumbs")).toContainText("Library");
    await expect(page.locator(".crumbs__here")).toHaveText("You");

    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: "Theme" })).toBeVisible();
  });

  test("the name column grew and the address stops ellipsising at the default rail width", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");

    const box = await page.locator(".account").evaluate((node) => {
      const rail = node.closest(".rail") as HTMLElement;
      const who = node.querySelector(".account__who") as HTMLElement;
      const mail = node.querySelector(".account__mail") as HTMLElement;
      return {
        railWidth: rail.getBoundingClientRect().width,
        rowWidths: [...rail.children].map((c) => c.getBoundingClientRect().width),
        footerScrollWidth: node.scrollWidth,
        footerClientWidth: node.clientWidth,
        whoWidth: who.clientWidth,
        mailClientWidth: mail.clientWidth,
        mailScrollWidth: mail.scrollWidth,
      };
    });

    expect(box.railWidth).toBeCloseTo(232, 0);
    // 232 − 24 padding − 30 avatar − 16 chevron − 16 gaps = 146; a floor, so token nudges pass.
    expect(box.whoWidth).toBeGreaterThanOrEqual(140);
    expect(box.mailScrollWidth).toBeLessThanOrEqual(box.mailClientWidth);

    expect(box.footerScrollWidth).toBeLessThanOrEqual(box.footerClientWidth);
    for (const w of box.rowWidths) expect(w).toBeLessThanOrEqual(box.railWidth);
  });
});

test.describe("the account page", () => {
  test("every section renders, with data in the mono face", async ({ page }) => {
    await signedIn(page);
    await openAccount(page);

    const signingIn = section(page, "Signing in");
    await expect(signingIn).toContainText("Password");
    await expect(signingIn).toContainText("Last changed");
    await expect(signingIn.getByRole("button", { name: "Change your password" })).toBeVisible();
    await expect(signingIn).toContainText("2 other browsers signed in");
    await expect(signingIn.getByRole("button", { name: "Sign out everywhere" })).toBeVisible();
    await expect(signingIn.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();

    const devices = section(page, "Devices");
    await expect(devices).toContainText("Nomad");
    // The server records the device's last request, which is not necessarily a sync.
    await expect(devices).toContainText("last seen 20 minutes ago");
    await expect(devices.locator(".acct-device__sync")).not.toContainText("sync");
    await expect(devices).toContainText("Unlinking stops sync until the device is paired again");
    await expect(devices.getByRole("button", { name: "Unlink Nomad" })).toBeVisible();

    const storage = section(page, "Storage");
    await expect(storage.locator(".acct-total")).toContainText("463 MB");
    await expect(storage.locator(".acct-total")).toContainText("of 10 GB");
    for (const kind of ["Notebooks", "Sketches", "Documents", "Recycle bin", "Versions"]) {
      await expect(storage.locator(".acct-kind").filter({ hasText: kind })).toHaveCount(1);
    }
    await expect(storage.locator(".acct-kind")).toHaveCount(5);
    // Read off the screen: the five kinds must sum to the meter.
    const parts = await storage.locator(".acct-kind .acct-row__v").allInnerTexts();
    expect(parts).toEqual(["214 MB", "46 MB", "178 MB", "12 MB", "13 MB"]);
    await expect(storage.getByRole("button", { name: "Open the recycle bin" })).toHaveCount(1);
    await expect(storage.locator(".acct-kind .acct-row__acts button")).toHaveCount(1);

    const versions = section(page, "Versions");
    await expect(versions.locator("input.acct-keep")).toHaveValue("5");
    await expect(versions.getByRole("button", { name: "Keep one fewer" })).toBeVisible();
    await expect(versions.getByRole("button", { name: "Keep one more" })).toBeVisible();
    await expect(storage.locator("input.acct-keep")).toHaveCount(0);

    const appearance = section(page, "Appearance");
    await expect(appearance.getByRole("button", { name: "Paper", exact: true })).toBeVisible();
    await expect(appearance.getByRole("button", { name: "Paper Dark" })).toBeVisible();

    const monoOf = (selector: string) =>
      page.locator(selector).first().evaluate((n) => getComputedStyle(n).fontFamily);
    for (const selector of [".acct__mail", ".acct-total__v", ".acct-kind .acct-row__v", "input.acct-keep", ".acct-device__sync"]) {
      expect(await monoOf(selector), selector).toContain("Space Mono");
    }
  });

  test("lowering the versions count says what it will discard, before the change", async ({ page }) => {
    await signedIn(page);
    await openAccount(page);

    const keep = page.locator("input.acct-keep");
    const note = page.locator(".acct-keep__note");
    await expect(keep).toHaveValue("5");
    await expect(note).toHaveText("");

    await keep.fill("3");

    await expect(note).toHaveText("Keeping 3 will remove 8 versions now.");
    // The notice is a prediction: the stored total has not moved yet.
    await expect(page.locator(".acct-kind").filter({ hasText: "Versions" })).toContainText("13 MB");

    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.locator(".toast")).toContainText("Removed 8 versions");
    await expect(note).toHaveText("");
    await expect(page.locator(".acct-kind").filter({ hasText: "Versions" })).toContainText("8.8 MB");

    await keep.fill("9");
    await expect(note).toHaveText("");
  });

  test("zero is a real setting, and the ceiling comes from the server", async ({ page }) => {
    await signedIn(page);
    await openAccount(page);

    const keep = page.locator("input.acct-keep");
    const note = page.locator(".acct-keep__note");

    await keep.fill("0");
    await expect(note).toContainText("Keeping 0 will remove 25 versions now.");
    await expect(note).toContainText("No new versions will be kept.");
    await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();

    await keep.fill("99");
    await expect(note).toHaveText("This server keeps at most 20 for each file.");
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);

    await keep.fill("0");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".acct-kind").filter({ hasText: "Versions" })).toContainText("0 B");
  });

  test("the change-password warning names the DEVICE, not just the browsers", async ({ page }) => {
    // The form is built before the device list lands, so copy decided at build time
    // would never correct itself.
    await signedIn(page);
    await openAccount(page);
    await page.getByRole("button", { name: "Change your password" }).click();

    const hint = page.locator(".acct-pw .acct-hint");
    await expect(hint).toContainText("Nomad will stop syncing");
    await expect(hint).toContainText("enter the new password on the device");
  });

  test("a wrong current password is refused; the right one goes through", async ({ page }) => {
    await signedIn(page);
    await openAccount(page);

    await page.getByRole("button", { name: "Change your password" }).click();
    const form = page.locator(".acct-pw");
    await expect(form).toBeVisible();
    // A password change stops the tablet syncing until it gets the new password; it
    // does not require re-pairing, so the form must not claim that.
    await expect(form).toContainText("will stop syncing until you enter the new password");
    await expect(form).toContainText("this one stays signed in");
    await expect(form).not.toContainText("pair");

    await page.getByLabel("Current password").fill("not-my-password");
    await page.getByLabel("New password", { exact: true }).fill("a-longer-password");
    await page.getByLabel("Confirm new password").fill("a-longer-password");
    await form.getByRole("button", { name: "Change password" }).click();

    await expect(form.getByRole("status")).toHaveText("That isn't your current password.");
    await expect(form).toBeVisible();
    await expect(section(page, "Signing in")).toContainText("2 other browsers signed in");

    await page.getByLabel("Current password").fill("inkhold");
    await form.getByRole("button", { name: "Change password" }).click();

    await expect(page.locator(".toast")).toContainText("Password changed");
    await expect(form).toBeHidden();
    await expect(section(page, "Signing in")).toContainText("No other browsers are signed in");
    await expect(section(page, "Signing in")).toContainText("Last changed just now");
  });

  test("unlinking asks first, and CANCEL really does nothing", async ({ page }) => {
    await signedIn(page);

    // Record the request: a retrying DOM check passes before an unlink would resolve.
    const unlinkCalls: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/account/devices/unlink")) unlinkCalls.push(r.url());
    });

    await openAccount(page);

    const devices = section(page, "Devices");
    await expect(devices.locator(".acct-device")).toHaveCount(1);

    await devices.getByRole("button", { name: "Unlink Nomad" }).click();
    const dialog = page.locator("dialog.confirm");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("stop syncing until you pair it again");
    await expect(dialog).toContainText("Nothing already synced is removed");

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(devices.getByRole("button", { name: "Unlink Nomad" })).toBeEnabled();
    await expect(async () => {
      expect(unlinkCalls).toEqual([]);
    }).toPass({ timeout: 1500 });
    // `.toast` exists empty from page load, so read its text rather than its count.
    await expect(devices.locator(".acct-device")).toHaveCount(1);
    await expect(page.locator(".toast")).toHaveText("");
  });

  test("unlinking a device removes its row", async ({ page }) => {
    await signedIn(page);
    await openAccount(page);

    const devices = section(page, "Devices");
    await expect(devices.locator(".acct-device")).toHaveCount(1);

    await devices.getByRole("button", { name: "Unlink Nomad" }).click();
    await page.locator("dialog.confirm").getByRole("button", { name: "Unlink" }).click();

    await expect(devices.locator(".acct-device")).toHaveCount(0);
    await expect(devices).toContainText("No Supernote is linked to this account yet.");
    await expect(page.locator(".toast")).toContainText("Nomad won't sync until it's paired again.");
  });

  test("sign out still works from its new home", async ({ page }) => {
    await signedIn(page);
    await openAccount(page);

    await page.getByRole("button", { name: "Sign out", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page).toHaveURL(/#\/login$/);
  });

  test("a non-admin can open it, even though the admin console is shut to them", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Folders" })).toBeVisible();
    await expect(page.locator(".rail").getByRole("button", { name: "Admin" })).toHaveCount(0);

    await page.getByRole("button", { name: "Your account" }).click();
    await expect(page.locator(".acct")).toBeVisible();
    await expect(section(page, "Storage").locator(".acct-kind")).toHaveCount(5);
    await expect(section(page, "Devices")).toContainText("Nomad");
  });

  test("the toolbar does not keep controls that belong to where you CAME from", async ({ page }) => {
    // Regression: `renderGallery` returns early while a destination is open, so the
    // previous view's toolbar controls (Upload, Empty bin) leaked in.
    await signedIn(page);
    await page.goto("/");

    await expect(page.locator("#upload")).toBeVisible();
    await page.getByRole("button", { name: "Your account" }).click();
    await expect(page.locator(".acct")).toBeVisible();
    await expect(page.locator("#upload")).toBeHidden();
    await expect(page.locator(".tools__sep")).toBeHidden();

    await page.locator(".crumbs button", { hasText: "Library" }).click();
    await expect(page.locator(".acct")).toBeHidden();
    await expect(page.locator("#upload")).toBeVisible();

    await page
      .getByRole("navigation", { name: "Folders" })
      .locator(".nav__item", { has: page.locator(".nav__name", { hasText: /^Recycle bin$/ }) })
      .click();
    await expect(page.locator("#empty-bin")).toBeVisible();
    await page.getByRole("button", { name: "Your account" }).click();
    await expect(page.locator(".acct")).toBeVisible();
    await expect(page.locator("#empty-bin")).toBeHidden();
    await expect(page.locator("#upload")).toBeHidden();
  });

  test("is addressable: a deep link lands on it, and leaving goes back to the library", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/account");

    await expect(page.locator(".acct")).toBeVisible();
    await expect(page.locator(".sn-root")).toHaveClass(/is-destination/);
    await expect(page.locator("#sort")).toBeHidden();

    await page.locator(".crumbs").getByRole("button", { name: "Library" }).click();

    await expect(page.locator(".acct")).toBeHidden();
    await expect(page.locator("#sort")).toBeVisible();
    await expect(page).toHaveURL(/#\/$/);
  });

  test("the folder behind it survives the visit — no refetch on the way back", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");
    await expect(page.locator(".card").first()).toBeVisible();
    // After the tree walk, or the root gallery is still gaining category cards.
    await railSettled(page);
    const before = await page.locator(".card").count();

    await page.getByRole("button", { name: "Your account" }).click();
    await expect(page.locator(".acct")).toBeVisible();
    expect(await page.locator(".card").count()).toBe(before);

    await page.goBack();
    await expect(page.locator(".acct")).toBeHidden();
    await expect(page.locator(".card")).toHaveCount(before);
  });
});
