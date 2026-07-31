import { test, expect, type Page } from "@playwright/test";
import { railSettled, signedIn } from "./helpers/app";

// YOUR OWN ACCOUNT (src/pages/account.ts, docs/scratch/user-options.md §7).
//
// WHAT EACH TEST PINS, so a later refactorer can tell whether one has quietly
// stopped biting:
//
//   1. the rail footer is a NAMEPLATE — one button that opens the page — and it
//      carries NEITHER the theme toggle nor sign out any more. Both moved; the
//      one thing that must never happen is that either was deleted, so the
//      second half of that test finds them in their new home;
//   2. the name column really did grow (96 → ~146px) and the address stops
//      ellipsising at the default rail width — the legibility problem the shape
//      was chosen to fix, and the one that would silently return;
//   3. lowering the versions count STATES WHAT IT WILL DISCARD before the
//      change, not after — a fact in the interface, not an apology;
//   4. zero is a real setting, not a disabled state;
//   5. a wrong CURRENT password is refused. That check exists only in the fake
//      today (the endpoint ignores the field — §4), so this test is what proves
//      the UI collects it, sends it, and shows the typed refusal;
//   6. unlink removes the row;
//   7. sign out still works from its new home. If this ever goes red, the app
//      has no way out of itself;
//   8. a NON-ADMIN can open the page. The whole surface exists because the admin
//      console is the one door a household member cannot walk through.
//
// The e2e user (`signedIn`) is deliberately `isAdmin: false`, so 8 is the state
// every other test here runs in too.

/** The page, opened the way a person opens it. */
async function openAccount(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Your account" }).click();
  await expect(page.locator(".acct")).toBeVisible();
}

/** A section's body, addressed by the label sitting in the margin. */
function section(page: Page, label: string) {
  return page.locator(".acct-sec").filter({ has: page.locator(".acct-sec__label", { hasText: label }) });
}

test.describe("the rail footer nameplate", () => {
  test("opens the account page and no longer carries the theme toggle or sign out", async ({ page }) => {
    await signedIn(page);
    await page.goto("/");

    const rail = page.locator(".rail");
    // BOTH GONE FROM THE RAIL. The row had no room, which is the whole reason
    // the identity block became the door.
    await expect(rail.getByRole("button", { name: "Toggle light or dark" })).toHaveCount(0);
    await expect(rail.getByRole("button", { name: "Sign out" })).toHaveCount(0);

    await page.getByRole("button", { name: "Your account" }).click();

    await expect(page).toHaveURL(/#\/account$/);
    await expect(page.locator(".acct")).toBeVisible();
    // "Library / You" — the path the URL spells.
    await expect(page.locator(".crumbs")).toContainText("Library");
    await expect(page.locator(".crumbs__here")).toHaveText("You");

    // NEITHER CONTROL WAS DELETED. Sign out is the last row of "Signing in";
    // the theme toggle is Appearance.
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
    // 232 − 24 padding − 30 avatar − 16 chevron − 16 gaps = 146. Asserted as a
    // FLOOR rather than an equality so a token nudge is not a failure, but a
    // regression back to the two-button 96px is.
    expect(box.whoWidth).toBeGreaterThanOrEqual(140);
    // THE ADDRESS FITS. `ana@household.lan` is 17 characters of Space Mono at
    // 11px, which did not fit in 96px and does fit in 146.
    expect(box.mailScrollWidth).toBeLessThanOrEqual(box.mailClientWidth);

    // And the row still does not spill — the failure that painted the rail over
    // the topbar and ate clicks aimed at it.
    expect(box.footerScrollWidth).toBeLessThanOrEqual(box.footerClientWidth);
    for (const w of box.rowWidths) expect(w).toBeLessThanOrEqual(box.railWidth);
  });
});

test.describe("the account page", () => {
  test("every section renders, with data in the mono face", async ({ page }) => {
    await signedIn(page);
    await openAccount(page);

    // --- Signing in ---
    const signingIn = section(page, "Signing in");
    await expect(signingIn).toContainText("Password");
    await expect(signingIn).toContainText("Last changed");
    await expect(signingIn.getByRole("button", { name: "Change your password" })).toBeVisible();
    await expect(signingIn).toContainText("2 other browsers signed in");
    await expect(signingIn.getByRole("button", { name: "Sign out everywhere" })).toBeVisible();
    await expect(signingIn.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();

    // --- Devices: named as an OBJECT, with its last sync ---
    const devices = section(page, "Devices");
    await expect(devices).toContainText("Nomad");
    // "LAST SEEN", not "last synced": the server records the last request the
    // device made, which is usually a sync and is not the same claim (§7).
    await expect(devices).toContainText("last seen 20 minutes ago");
    await expect(devices.locator(".acct-device__sync")).not.toContainText("sync");
    await expect(devices).toContainText("Unlinking stops sync until the device is paired again");
    await expect(devices.getByRole("button", { name: "Unlink Nomad" })).toBeVisible();

    // --- Storage: the total, then FIVE figures by kind ---
    const storage = section(page, "Storage");
    await expect(storage.locator(".acct-total")).toContainText("463 MB");
    await expect(storage.locator(".acct-total")).toContainText("of 10 GB");
    for (const kind of ["Notebooks", "Sketches", "Documents", "Recycle bin", "Versions"]) {
      await expect(storage.locator(".acct-kind").filter({ hasText: kind })).toHaveCount(1);
    }
    await expect(storage.locator(".acct-kind")).toHaveCount(5);
    // A PARTITION: the five lines sum to the meter. Read off the screen rather
    // than trusted from the fixture, because "the parts do not add up" is the
    // exact failure a person notices and cannot explain.
    const parts = await storage.locator(".acct-kind .acct-row__v").allInnerTexts();
    expect(parts).toEqual(["214 MB", "46 MB", "178 MB", "12 MB", "13 MB"]);
    // The bin is the ONE line whose remedy is a click away, so it is the one
    // line with somewhere to send you.
    await expect(storage.getByRole("button", { name: "Open the recycle bin" })).toHaveCount(1);
    await expect(storage.locator(".acct-kind .acct-row__acts button")).toHaveCount(1);

    // --- Versions: ITS OWN SECTION, not a tail on Storage. Storage reports;
    //     this is the one control on the page that discards data, and it earns
    //     its own margin label rather than reading as a footnote to a readout.
    const versions = section(page, "Versions");
    await expect(versions.locator("input.acct-keep")).toHaveValue("5");
    // The stepper is how this value moves: it is a small integer compared with
    // its neighbours, not a quantity anyone types out.
    await expect(versions.getByRole("button", { name: "Keep one fewer" })).toBeVisible();
    await expect(versions.getByRole("button", { name: "Keep one more" })).toBeVisible();
    // And Storage keeps no version control of its own.
    await expect(storage.locator("input.acct-keep")).toHaveCount(0);

    // --- Appearance: the app's OWN material, not the generic pair. The tokens
    //     are `--desk`/`--sheet`/`--ink`; this is where the interface says so.
    const appearance = section(page, "Appearance");
    await expect(appearance.getByRole("button", { name: "Paper", exact: true })).toBeVisible();
    await expect(appearance.getByRole("button", { name: "Paper Dark" })).toBeVisible();

    // EVERY PIECE OF DATA IS SPACE MONO — the address, the byte counts, the
    // timestamps, the version count. Asserted on the computed face rather than
    // on a class name, so removing the class does not quietly pass.
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
    // Nothing to say while the value is the saved one.
    await expect(note).toHaveText("");

    await keep.fill("3");

    // THE FACT, BEFORE THE CHANGE — and nothing has been discarded yet.
    await expect(note).toHaveText("Keeping 3 will remove 8 versions now.");
    // The stored total has NOT moved — the notice is a prediction, not a receipt.
    // Read off Storage's Versions line, which is where that figure lives now: it
    // used to sit on this control's own line, where next to a pending Save it
    // read as the delta the change would cost rather than the current total.
    await expect(page.locator(".acct-kind").filter({ hasText: "Versions" })).toContainText("13 MB");

    await page.getByRole("button", { name: "Save" }).click();

    // The count it predicted is the count it did.
    await expect(page.locator(".toast")).toContainText("Removed 8 versions");
    await expect(note).toHaveText("");
    // The Versions line in Storage moved with it, rather than going stale.
    await expect(page.locator(".acct-kind").filter({ hasText: "Versions" })).toContainText("8.8 MB");

    // RAISING IT DISCARDS NOTHING, and says nothing.
    await keep.fill("9");
    await expect(note).toHaveText("");
  });

  test("zero is a real setting, and the ceiling comes from the server", async ({ page }) => {
    await signedIn(page);
    await openAccount(page);

    const keep = page.locator("input.acct-keep");
    const note = page.locator(".acct-keep__note");

    await keep.fill("0");
    // NOT a disabled state: it is offered, it is explained, and it saves.
    await expect(note).toContainText("Keeping 0 will remove 25 versions now.");
    await expect(note).toContainText("No new versions will be kept.");
    await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();

    // BOUNDED ABOVE BY THE SERVER — one person does not set the household's
    // disk policy — and the ceiling is stated rather than silently clamped.
    await keep.fill("99");
    await expect(note).toHaveText("This server keeps at most 20 for each file.");
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);

    await keep.fill("0");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".acct-kind").filter({ hasText: "Versions" })).toContainText("0 B");
  });

  test("a wrong current password is refused; the right one goes through", async ({ page }) => {
    await signedIn(page);
    await openAccount(page);

    await page.getByRole("button", { name: "Change your password" }).click();
    const form = page.locator(".acct-pw");
    await expect(form).toBeVisible();
    // Said plainly, and only about what we know: other browsers are signed out.
    // NOTHING is claimed about the Supernote's sync binding — that is an open
    // question being tested against a real device (§8.1).
    await expect(form).toContainText("Your other browsers will be signed out");
    await expect(form).not.toContainText("sync");
    await expect(form).not.toContainText("pair");

    await page.getByLabel("Current password").fill("not-my-password");
    await page.getByLabel("New password", { exact: true }).fill("a-longer-password");
    await page.getByLabel("Confirm new password").fill("a-longer-password");
    await form.getByRole("button", { name: "Change password" }).click();

    await expect(form.getByRole("status")).toHaveText("That isn't your current password.");
    // Refused means UNCHANGED: the form is still open and nothing was signed out.
    await expect(form).toBeVisible();
    await expect(section(page, "Signing in")).toContainText("2 other browsers signed in");

    await page.getByLabel("Current password").fill("inkhold");
    await form.getByRole("button", { name: "Change password" }).click();

    await expect(page.locator(".toast")).toContainText("Password changed");
    await expect(form).toBeHidden();
    // The other sessions really are gone, so the line must stop saying otherwise.
    await expect(section(page, "Signing in")).toContainText("No other browsers are signed in");
    await expect(section(page, "Signing in")).toContainText("Last changed just now");
  });

  test("unlinking asks first, and CANCEL really does nothing", async ({ page }) => {
    // Unlink is the one action on this page the webapp cannot undo: re-pairing
    // happens on the tablet, so a mis-click sends you across the room with a
    // login code — or nowhere at all, if the tablet is not to hand. The dialog
    // is only worth having if backing out of it is genuinely inert, which is
    // what this pins: a cancelled confirm must leave the binding alone.
    await signedIn(page);

    // RECORD THE REQUEST, do not watch the DOM. Asserting "the row is still
    // there" after Cancel proves nothing: `toHaveCount(1)` is a retrying matcher
    // and the row IS still there for the instant before an unlink would resolve,
    // so it passes on its first poll and the test goes green against code that
    // unlinks anyway. Verified by making Cancel fall through — the DOM version
    // stayed green, this one goes red.
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
    // BOTH HALVES stated: what stops, and what is safe.
    await expect(dialog).toContainText("stop syncing until you pair it again");
    await expect(dialog).toContainText("Nothing already synced is removed");

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    // THE ASSERTION THAT BITES: the server was never asked. Given time for one
    // to have gone out and come back, no unlink request exists at all.
    await expect(devices.getByRole("button", { name: "Unlink Nomad" })).toBeEnabled();
    await expect(async () => {
      expect(unlinkCalls).toEqual([]);
    }).toPass({ timeout: 1500 });
    // ...and nothing was announced. `.toast` is a PERSISTENT container that
    // exists empty from page load, so this reads its text rather than its count.
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
    // The known-empty state, claimed only now that the data supports it.
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
    // `signedIn` is `isAdmin: false` — the case §9.2 says the whole surface has
    // to be designed for, since it is the one with no fallback.
    await signedIn(page);
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Folders" })).toBeVisible();
    // No door to the console at all…
    await expect(page.locator(".rail").getByRole("button", { name: "Admin" })).toHaveCount(0);

    // …and yet the account page opens, fully.
    await page.getByRole("button", { name: "Your account" }).click();
    await expect(page.locator(".acct")).toBeVisible();
    await expect(section(page, "Storage").locator(".acct-kind")).toHaveCount(5);
    await expect(section(page, "Devices")).toContainText("Nomad");
  });

  test("the toolbar does not keep controls that belong to where you CAME from", async ({ page }) => {
    // `renderGallery` was the only thing clearing these, and it returns early
    // while a destination is open — so entering one carried its predecessor's
    // controls in: `Upload` over your account settings, `Empty bin` still on the
    // toolbar after coming here from the bin. It read as intermittent because it
    // depended on where you came from, which is why it survived.
    await signedIn(page);
    await page.goto("/");

    // --- from a folder that DOES take uploads.
    await expect(page.locator("#upload")).toBeVisible();
    await page.getByRole("button", { name: "Your account" }).click();
    await expect(page.locator(".acct")).toBeVisible();
    await expect(page.locator("#upload")).toBeHidden();
    await expect(page.locator(".tools__sep")).toBeHidden();

    // ...and it comes BACK on the way out: this hides, it does not disable.
    await page.locator(".crumbs button", { hasText: "Library" }).click();
    await expect(page.locator(".acct")).toBeHidden();
    await expect(page.locator("#upload")).toBeVisible();

    // --- from the BIN, whose own action must not follow us either.
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
    // Not a folder listing, so the search box stands down (`is-destination`) and
    // the folder-shaped controls go with it.
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
    // AFTER the tree walk: until it settles the root gallery is still gaining
    // category cards, and a count taken across that lands on a moving number.
    await railSettled(page);
    const before = await page.locator(".card").count();

    await page.getByRole("button", { name: "Your account" }).click();
    await expect(page.locator(".acct")).toBeVisible();
    // HIDDEN, not emptied: the shell's listing, its lazy engine and every bitmap
    // already drawn are still there, under the overlay.
    expect(await page.locator(".card").count()).toBe(before);

    await page.goBack();
    await expect(page.locator(".acct")).toBeHidden();
    await expect(page.locator(".card")).toHaveCount(before);
  });
});
