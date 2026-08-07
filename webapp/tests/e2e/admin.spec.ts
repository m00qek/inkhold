import { test, expect, type Page } from "@playwright/test";
import { mockApi } from "./helpers/mockApi";
import { contrastRatio, freezeMotion, paintedColours, railSettled } from "./helpers/app";

// The admin console end to end, against the in-memory fake `Api` — which gates
// every admin call on an elevation exactly as the server does, so the gate here
// is the real control flow and not a rehearsal of it. The fixture password is
// `inkhold` (see the ADMIN block in src/api/fake.ts).
//
// `isAdmin` comes from the boot guard, so "who is signed in" is expressed purely
// by what `/api/user/me` answers — the same way every other spec here does it.

const PASSWORD = "inkhold";

async function signedInAsAdmin(page: Page, isAdmin = true): Promise<void> {
  await mockApi(page, {
    "user/me": { json: { success: true, email: "ana@household.lan", isAdmin, mustChangePassword: false } },
  });
}

const railRow = (page: Page, name: string) => page.locator(".nav__item", { hasText: name });

/** The gate's live region. Scoped, because the shell's toast is a `role="status"`
 *  too and an unscoped lookup resolves to both. */
const gateStatus = (page: Page) => page.locator(".admin").getByRole("status");

/** Into the console and past the gate. */
async function unlocked(page: Page): Promise<void> {
  await signedInAsAdmin(page);
  await page.goto("/");
  await railSettled(page);
  await railRow(page, "Admin").click();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock console" }).click();
  await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
}

// --- where it lives ----------------------------------------------------------

test.describe("admin: the rail entry", () => {
  test("is offered to an admin and hidden from everyone else", async ({ page }) => {
    await signedInAsAdmin(page, false);
    await page.goto("/");
    await railSettled(page);
    // Not a security boundary — the server refuses every admin route regardless
    // — but a door that always refuses is worse than no door.
    await expect(railRow(page, "Admin")).toHaveCount(0);

    await signedInAsAdmin(page, true);
    await page.reload();
    await railSettled(page);
    await expect(railRow(page, "Admin")).toBeVisible();
  });

  test("carries no COUNT badge — the household is not a number on the navigation", async ({ page }) => {
    await signedInAsAdmin(page);
    await page.goto("/");
    await railSettled(page);
    // THE REGRESSION. The painter used to render `nav__count` unconditionally,
    // so a destination with nothing countable — which the console is, by design —
    // carried a permanent `0` and read as an empty inbox. No element, not a zero.
    await expect(railRow(page, "Admin").locator(".nav__count")).toHaveCount(0);
    // And the rule it must not have taken with it: a folder's 0 is an ANSWER
    // ("this category is empty"), so those rows keep their badge. Export is one
    // of the six pinned categories and the fixture leaves it genuinely empty.
    await expect(railRow(page, "Export").locator(".nav__count")).toHaveText("0");
  });

  test("shows a padlock that tracks the elevation, not a count", async ({ page }) => {
    await signedInAsAdmin(page);
    await page.goto("/");
    await railSettled(page);

    const padlock = railRow(page, "Admin").locator(".nav__state");
    // Before anyone has been anywhere: locked, and SAID so — the glyph swap
    // alone is not an accessible state, and colour is not used to carry it.
    await expect(padlock).toBeVisible();
    await expect(padlock).toHaveAttribute("aria-label", "Admin console locked");
    // A non-text indicator, so it owes 3.0 against what it is drawn on.
    await freezeMotion(page);
    const { color, background } = await paintedColours(padlock);
    expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(3);
    const box = await padlock.boundingBox();
    expect(box!.width).toBeGreaterThan(0);

    // Through the gate, and it opens.
    await railRow(page, "Admin").click();
    await expect(padlock).toHaveAttribute("aria-label", "Admin console locked");
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Unlock console" }).click();
    await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
    await expect(padlock).toHaveAttribute("aria-label", "Admin console unlocked");

    // …and shuts again on lock. A padlock that lies is worse than no padlock.
    await page.locator("#lock-console").click();
    await expect(page.getByRole("heading", { name: "Confirm your password" })).toBeVisible();
    await expect(padlock).toHaveAttribute("aria-label", "Admin console locked");
  });

  test("the padlock is drawn with a different SHAPE in each state, not a colour", async ({ page }) => {
    await unlocked(page);
    const padlock = railRow(page, "Admin").locator(".nav__state");
    const open = await padlock.locator("svg").innerHTML();
    await page.locator("#lock-console").click();
    await expect(page.getByRole("heading", { name: "Confirm your password" })).toBeVisible();
    const shut = await padlock.locator("svg").innerHTML();
    expect(shut).not.toBe(open);
  });
});

// --- the topbar over the console ---------------------------------------------

test.describe("admin: the boot race", () => {
  test("a hard reload straight onto #/admin lands on the gate, and the tree walk does not paint over it", async ({
    page,
  }) => {
    await signedInAsAdmin(page);
    // THE REAL BOOT PATH: a cold goto with no prior navigation, so the folder-
    // tree prefetch is still in flight when the admin route dispatches. Its late
    // response repaints the folder gallery — the same repaint that closes the
    // bin — and the console mounts into that gallery too, so an unguarded
    // settle would blank the gate (and strip the console's topbar mode) exactly
    // as it did the bin. The console can never afford this, so the guard covers
    // it as well as the bin.
    await page.goto("/#/admin");
    await expect(page.locator(".admin")).toBeVisible();
    // The gate is the cold-start screen — addressable is not accessible.
    await expect(page.getByRole("button", { name: "Unlock console" })).toBeVisible();

    await railSettled(page);
    // Still up, still the gate, still in destination mode after the walk lands.
    await expect(page.locator(".admin")).toBeVisible();
    await expect(page.getByRole("button", { name: "Unlock console" })).toBeVisible();
    await expect(page.locator(".sn-root")).toHaveClass(/is-destination/);
    await expect(page.locator("#lock-console")).toBeVisible();
  });
});

test.describe("admin: the topbar", () => {
  test("takes the search box away, because it searches a library you are not looking at", async ({ page }) => {
    await signedInAsAdmin(page);
    await page.goto("/");
    await railSettled(page);
    // Present over a folder — this is not a box that never existed.
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();

    await railRow(page, "Admin").click();
    await expect(page.locator(".admin")).toBeVisible();
    // THE SAME MODE THE BIN USES (`.sn-root.is-destination`), not a second
    // mechanism: the rule is "what is on screen is not the library", which is
    // equally true of both. Gone from the accessibility tree too, not merely
    // invisible — typing in it would leave the console entirely, which is the
    // trap rather than the box.
    await expect(page.locator(".sn-root")).toHaveClass(/is-destination/);
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeHidden();

    // And it comes back on the way out.
    await page
      .getByRole("navigation", { name: "Folders" })
      .locator(".nav__item", { has: page.locator(".nav__name", { hasText: /^Note$/ }) })
      .click();
    await expect(page.locator(".sn-root")).not.toHaveClass(/is-destination/);
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
  });

  test("puts Lock console in the topbar, iconed and labelled, and only where it means something", async ({ page }) => {
    await signedInAsAdmin(page);
    await page.goto("/");
    await railSettled(page);

    const lock = page.locator("#lock-console");
    // A view-level control on a view you are not on.
    await expect(lock).toBeHidden();

    await railRow(page, "Admin").click();
    await expect(lock).toBeVisible();
    // In `.tools`, beside sort and the view toggle — where `Empty bin` sits, not
    // buried in a section heading called "People".
    await expect(page.locator(".tools #lock-console")).toHaveCount(1);
    await expect(page.locator(".admin-head__acts #lock-console")).toHaveCount(0);
    // Words beside a glyph, as every labelled action in this app reads.
    await expect(lock).toHaveText("Lock console");
    await expect(lock.locator("svg")).toHaveCount(1);

    await freezeMotion(page);
    // NOT RED. Red is danger and nothing else here, and locking destroys
    // nothing — it is the safe direction. `Empty bin` is the red one, and this
    // must not have inherited its treatment.
    await expect(lock).not.toHaveClass(/is-danger/);
    const { color, background } = await paintedColours(lock);
    expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(4.5);
    const empty = await paintedColours(page.locator("#empty-bin"));
    expect(color).not.toBe(empty.color);
    // The WCAG target floor, on a control that ends a privileged session.
    const box = await lock.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
    expect(box!.width).toBeGreaterThanOrEqual(24);
  });

  test("and it still locks — the behaviour travelled with the button", async ({ page }) => {
    await unlocked(page);
    await page.locator("#lock-console").click();
    await expect(page.getByRole("heading", { name: "Confirm your password" })).toBeVisible();
    await expect(page.locator(".admin-person")).toHaveCount(0);
    // The elevation is gone for the SERVER too, not just on screen.
    await expect(page.getByRole("button", { name: "Add person" })).toHaveCount(0);
  });

  test("Lock console leaves with the console, and never appears over the bin", async ({ page }) => {
    await unlocked(page);
    const lock = page.locator("#lock-console");
    await expect(lock).toBeVisible();

    await railRow(page, "Recycle bin").click();
    // One destination at a time: the bin's action arrives, the console's leaves.
    await expect(lock).toBeHidden();
    await expect(page.locator("#empty-bin")).toBeVisible();
    // …and the mode is still on, because a destination is still open.
    await expect(page.locator(".sn-root")).toHaveClass(/is-destination/);
  });
});

// --- the gate ----------------------------------------------------------------

test.describe("admin: the gate", () => {
  test("asks for the password before any of the household is on screen", async ({ page }) => {
    await signedInAsAdmin(page);
    await page.goto("/");
    await railSettled(page);
    await railRow(page, "Admin").click();

    await expect(page.getByRole("heading", { name: "Confirm your password" })).toBeVisible();
    // The reason, not the rule.
    await expect(page.locator(".admin-gate__why")).toContainText("delete another person's notes");
    // Nothing about anyone has been painted.
    await expect(page.locator(".admin-person")).toHaveCount(0);
    await expect(page.getByText("rui@household.lan")).toHaveCount(0);
  });

  test("a wrong password says so and keeps the gate up", async ({ page }) => {
    await signedInAsAdmin(page);
    await page.goto("/");
    await railSettled(page);
    await railRow(page, "Admin").click();

    await page.getByLabel("Password", { exact: true }).fill("not-it");
    await page.getByRole("button", { name: "Unlock console" }).click();

    await expect(gateStatus(page)).toHaveText(/doesn't match/);
    await expect(page.locator(".admin-person")).toHaveCount(0);
  });

  test("the right password reveals the household as a list of people", async ({ page }) => {
    await unlocked(page);
    const people = page.locator(".admin-person");
    await expect(people).toHaveCount(3);
    await expect(people.first()).toContainText("ana@household.lan");
    // The one row that owes a password change says so.
    await expect(people.filter({ hasText: "guest@household.lan" })).toContainText("must set password");
    await expect(people.filter({ hasText: "ana@household.lan" })).toContainText("admin");
  });

  test("locking puts the gate back", async ({ page }) => {
    await unlocked(page);
    await page.getByRole("button", { name: "Lock console" }).click();
    await expect(page.getByRole("heading", { name: "Confirm your password" })).toBeVisible();
    await expect(page.locator(".admin-person")).toHaveCount(0);
  });

  test("locking mid-session cannot be walked past — the console is gated again", async ({ page }) => {
    await unlocked(page);
    await page.getByRole("button", { name: "Lock console" }).click();
    await expect(page.getByRole("heading", { name: "Confirm your password" })).toBeVisible();

    // The elevation lives on the SESSION, so it is gone for the server too: the
    // next admin call answers 428 and there is nothing on screen to act on. The
    // resume half of that loop — a 428 mid-action opening the gate and the same
    // call finishing afterwards — is pinned in tests/unit/admin.test.ts, where
    // the window can be lapsed underneath a rendered list without the client
    // being told; there is no way to stage that through the fake from a page.
    await expect(page.locator(".admin-person")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add person" })).toHaveCount(0);
  });
});

// --- the actions -------------------------------------------------------------

test.describe("admin: actions", () => {
  test("deleting a person is the one action that asks you to type it out", async ({ page }) => {
    await unlocked(page);
    const rui = page.locator(".admin-person", { hasText: "rui@household.lan" });
    await rui.getByRole("button", { name: /^Delete/ }).click();

    const go = page.getByRole("button", { name: "Delete permanently" });
    // Disabled until the address matches, exactly.
    await expect(go).toBeDisabled();
    await page.getByLabel("Type the address to confirm").fill("rui@");
    await expect(go).toBeDisabled();
    await page.getByLabel("Type the address to confirm").fill("rui@household.lan");
    await expect(go).toBeEnabled();

    await go.click();
    await expect(page.locator(".admin-person", { hasText: "rui@household.lan" })).toHaveCount(0);
  });

  test("Cancel is the default, so Enter never deletes anyone", async ({ page }) => {
    await unlocked(page);
    const rui = page.locator(".admin-person", { hasText: "rui@household.lan" });
    await rui.getByRole("button", { name: /^Delete/ }).click();

    // First in DOM order and focused: with `method="dialog"` that makes the safe
    // answer what Enter reaches. A destructive button must never be the default.
    await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Enter");
    // `.admin-dialog`, not `dialog`: the shell keeps the recycle bin's own
    // `<dialog>` mounted, so the bare tag counts one that was never opened.
    await expect(page.locator(".admin-dialog")).toHaveCount(0);
    await expect(page.locator(".admin-person", { hasText: "rui@household.lan" })).toHaveCount(1);
  });

  test("Escape cancels too, and nothing is destroyed", async ({ page }) => {
    await unlocked(page);
    const rui = page.locator(".admin-person", { hasText: "rui@household.lan" });
    await rui.getByRole("button", { name: /^Delete/ }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".admin-person", { hasText: "rui@household.lan" })).toHaveCount(1);
  });

  test("YOUR OWN row has no reset button — it points at the account page instead", async ({ page }) => {
    // THE BUTTON THAT STARTED. A beta tester opened this console,
    // saw "Reset password" against their own name, pressed it, and locked
    // themselves out of their own server. Every verb here points OUTWARD; this
    // one pointed outward at everybody except the person holding it.
    //
    // A POINTER, not a disabled button: greying it out invites "why can't I?",
    // and the answer is not "you can't" but "not here".
    await unlocked(page);
    const me = page.locator(".admin-person", { hasText: "ana@household.lan" });
    await expect(me).toHaveCount(1);
    await expect(me.getByRole("button", { name: /^Reset/ })).toHaveCount(0);
    await expect(me.locator(".admin-selfnote")).toContainText("on your account page");

    // ...and it is gone from YOUR row only. This removes a footgun, not a verb.
    const rui = page.locator(".admin-person", { hasText: "rui@household.lan" });
    await expect(rui.getByRole("button", { name: /^Reset/ })).toHaveCount(1);
  });

  test("a reset hands over the generated password, once", async ({ page }) => {
    await unlocked(page);
    const rui = page.locator(".admin-person", { hasText: "rui@household.lan" });
    await rui.getByRole("button", { name: /^Reset/ }).click();
    await page.getByRole("button", { name: "Reset password" }).click();

    const secret = page.locator(".admin-secret");
    await expect(secret).toBeVisible();
    // The server keeps a hash, so this is the only moment it can be read — and
    // the dialog has to say so rather than implying it can be looked up later.
    await expect(page.locator(".admin-dialog__text")).toContainText("cannot be shown again");
    await expect(secret).not.toHaveText("");

    await page.getByRole("button", { name: "Done" }).click();
    // The row now shows the state the reset left the account in.
    await expect(rui).toContainText("must set password");
  });

  test("adding a person asks for an address and hands back a password", async ({ page }) => {
    await unlocked(page);
    await page.getByRole("button", { name: "Add person" }).click();
    await page.getByLabel("Email").fill("sofia@household.lan");
    await page.getByRole("button", { name: "Add person" }).last().click();

    await expect(page.locator(".admin-secret")).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();

    const sofia = page.locator(".admin-person", { hasText: "sofia@household.lan" });
    await expect(sofia).toHaveCount(1);
    // Must-change from birth: the temporary password unlocks nothing but its
    // own replacement.
    await expect(sofia).toContainText("must set password");
  });

  test("YOUR OWN row cannot be deleted either — the control is absent, not disabled", async ({ page }) => {
    // This test used to delete `ana`, the SIGNED-IN admin, to reach the
    // last-administrator refusal. It cannot any more, because the button is
    // gone from your own row — which is the point: the old test was driving the
    // exact footgun that locked a beta tester out, and only the server's refusal
    // stood between it and a purged account.
    //
    // Deleting an account purges its FILES, so this matters more than the reset
    // beside it. The `LastAdmin` guard behind it only looks like the same
    // protection: it saves the household, not you, and with two admins it would
    // let you purge yourself.
    //
    // NOTHING replaces it. The reset has somewhere to send you and says so; this
    // has nowhere — another admin must do it — and a note to that effect on a row
    // you are only passing through is noise. Absence is the honest shape.
    //
    // The two server-side refusals (`LastAdmin` for the sole admin,
    // `CannotDeleteSelf` when there is another) are unit-tested in
    // `services/auth/service.zig`, where both audiences can actually be built.
    await unlocked(page);
    const me = page.locator(".admin-person", { hasText: "ana@household.lan" });
    await expect(me).toHaveCount(1);
    await expect(me.getByRole("button", { name: /^Delete/ })).toHaveCount(0);

    // ...and it is gone from YOUR row only.
    const rui = page.locator(".admin-person", { hasText: "rui@household.lan" });
    await expect(rui.getByRole("button", { name: /^Delete/ })).toHaveCount(1);
  });
});

// --- what it will not say ----------------------------------------------------

test.describe("admin: storage, devices and the server panel", () => {
  test("draws the over-quota state instead of a bar that just looks full", async ({ page }) => {
    await unlocked(page);
    const rui = page.locator(".admin-person", { hasText: "rui@household.lan" });
    const meter = rui.locator(".admin-meter");

    // Rui stores 11.2 GB against a 10 GB allotment — the state a lowered
    // allotment produces. A rule pinned at 100% looks identical to one exactly
    // full, so the overage has to be in the words.
    await expect(meter).toHaveClass(/is-over/);
    await expect(meter).toContainText("11.2 GB of 10.0 GB");
    await expect(meter).toContainText("1.2 GB over");
  });

  test("lists a revoked device as revoked rather than hiding it", async ({ page }) => {
    await unlocked(page);
    const rui = page.locator(".admin-person", { hasText: "rui@household.lan" });
    await expect(rui.locator(".admin-device")).toHaveCount(2);
    const revoked = rui.locator(".admin-device.is-revoked");
    await expect(revoked).toHaveCount(1);
    // Nothing left to cut, so no Unlink — but the row survives, which is what
    // makes re-pairing possible.
    await expect(revoked).toContainText("unlinked");
    await expect(revoked.getByRole("button", { name: /Unlink/ })).toHaveCount(0);
  });

  test("unlinking flips a device to revoked, and it stays on the row", async ({ page }) => {
    await unlocked(page);
    const rui = page.locator(".admin-person", { hasText: "rui@household.lan" });
    await rui.getByRole("button", { name: /^Unlink Manta/ }).click();
    await expect(page.locator(".admin-dialog__text")).toContainText("device in hand");
    await page.getByRole("button", { name: "Unlink device" }).click();

    await expect(page.locator(".toast")).toContainText("Unlinked Manta");
    await expect(rui.locator(".admin-device")).toHaveCount(2);
    await expect(rui.locator(".admin-device.is-revoked")).toHaveCount(2);
  });

  test("a person with no tablet says so, and never shows an empty device list", async ({ page }) => {
    await unlocked(page);
    const guest = page.locator(".admin-person", { hasText: "guest@household.lan" });
    await expect(guest.locator(".admin-device")).toHaveCount(0);
    await expect(guest).toContainText("No device linked yet");
  });

  test("both Change buttons carry a glyph beside the word, and stay one control", async ({ page }) => {
    await unlocked(page);
    const changes = page.locator(".admin-change");
    // Both of them: the allotment on a person's row, the retention on the
    // Recycle bin card. ONE EDITING IDIOM, so they must not diverge here either.
    await expect(changes).not.toHaveCount(0);

    for (const change of await changes.all()) {
      // Glyph then words. Text-only, they scanned as a link among a row of
      // buttons rather than as the same kind of thing.
      await expect(change).toHaveText("Change");
      await expect(change.locator(".admin-change__mark svg")).toHaveCount(1);
      // DECORATION, not a second thing to hear: the word already says what
      // happens and the `aria-label` says what it happens to.
      await expect(change.locator(".admin-change__mark")).toHaveAttribute("aria-hidden", "true");
      const box = await change.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(24);
      expect(box!.width).toBeGreaterThanOrEqual(24);
    }

    // The glyph did not cost the accessible name it had before.
    await expect(page.getByRole("button", { name: /Change the allotment for ana/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Change how long the recycle bin/ })).toBeVisible();
  });

  test("the allotment edits in gigabytes, and lowering it below usage is allowed", async ({ page }) => {
    await unlocked(page);
    const ana = page.locator(".admin-person", { hasText: "ana@household.lan" });
    await ana.getByRole("button", { name: /Change the allotment/ }).click();

    await expect(page.locator(".admin-dialog__text")).toContainText("does not delete anything");
    const days = page.getByLabel("Gigabytes");
    await expect(days).toHaveValue("10");
    await days.fill("1"); // she is storing 5.4 GB
    await page.getByRole("button", { name: "Save allotment" }).click();

    // Nothing deleted, nothing refused — and the console says what that did.
    await expect(page.locator(".toast")).toContainText("over their allotment");
    await expect(ana.locator(".admin-meter")).toHaveClass(/is-over/);
    await expect(ana.locator(".admin-meter")).toContainText("of 1.0 GB");
  });

  test("the server panel shows memory against its budget, and the version", async ({ page }) => {
    await unlocked(page);
    const server = page.locator(".admin-server");
    await expect(server.getByRole("heading", { name: "Server" })).toBeVisible();
    await expect(server).toContainText("of 50 MB budget");
    // Disk states its own denominator too — "Disk / 15 GB" was read as how much
    // there IS rather than how much is gone.
    await expect(server).toContainText("deduplicated");
    await expect(page.locator(".admin-head__ver")).toHaveText("0.0.1");
  });

  test("the retention control promises, on the card, that lowering it purges nothing", async ({ page }) => {
    await unlocked(page);
    // Said where the number is read, not only where it is edited: an admin
    // lowering 30 to 7 otherwise fears they just destroyed a month of notes.
    await expect(page.locator(".admin-server__note")).toContainText("full new window");

    await page.getByRole("button", { name: /Change how long/ }).click();
    await expect(page.locator(".admin-dialog")).toContainText("full new window");
    const days = page.getByLabel("Days");
    await expect(days).toHaveValue("30");

    // The server's own bounds, refused here rather than as a 400 to interpret.
    await days.fill("0");
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
    await days.fill("400");
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();

    await days.fill("7");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".toast")).toContainText("7 days");
    await expect(page.locator(".admin-stat", { hasText: "Recycle bin" })).toContainText("7 days");
  });
});

test.describe("admin: what the console does not show", () => {
  test("carries no per-person activity", async ({ page }) => {
    await unlocked(page);
    const people = page.locator(".admin-people");
    // U7: an admin manages accounts, they do not watch the people using them.
    // "since" on a device row is when the BINDING was made, not when it last
    // synced, so the ban is on the activity words themselves.
    await expect(people).not.toContainText(/last sync/i);
    await expect(people).not.toContainText(/ago\b/i);
    await expect(people).not.toContainText(/\bnotes\b/i);
  });

  test("the server panel carries no per-person figure at all", async ({ page }) => {
    await unlocked(page);
    const server = page.locator(".admin-server");
    for (const who of ["ana", "rui", "guest"]) {
      await expect(server).not.toContainText(who);
    }
    // Both cut on purpose: uptime answers "has it crashed?", which in a
    // household you would already know.
    await expect(server).not.toContainText(/uptime/i);
  });
});

// --- leaving -----------------------------------------------------------------

test.describe("admin: leaving and coming back", () => {
  test("clicking a folder leaves the console; coming back does not ask again", async ({ page }) => {
    await unlocked(page);
    await railRow(page, "Note").first().click();
    await expect(page.locator(".admin")).toBeHidden();
    await expect(page.locator(".gallery")).toBeVisible();

    await railRow(page, "Admin").click();
    // The elevation is a fact about the SESSION, so re-entering must not repaint
    // a gate the server no longer needs.
    await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
  });
});

// --- accessibility -----------------------------------------------------------

test.describe("admin: accessibility", () => {
  test("every control clears the 24x24 target minimum", async ({ page }) => {
    await unlocked(page);
    const buttons = page.locator(".admin__body button");
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const box = await buttons.nth(i).boundingBox();
      expect(box, `button ${i} has no box`).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(24);
      expect(box!.width).toBeGreaterThanOrEqual(24);
    }
  });

  for (const theme of ["light", "dark"] as const) {
    test(`red type clears 4.5:1 on the sheet in ${theme} mode`, async ({ page }) => {
      await unlocked(page);
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      // AFTER the flip, and load-bearing: `.admin-btn` transitions its
      // background, so a colour read in the next 150ms catches the OLD sheet
      // mid-fade — which is how a perfectly legible dark-mode button measures
      // 2.9 against a background it is not painted on.
      await freezeMotion(page);

      const rui = page.locator(".admin-person", { hasText: "rui@household.lan" });
      // Red is the one colour reserved for destruction here, so it has to be
      // legible rather than merely alarming. `--margin` itself is 4.49 on the
      // light sheet — tuned as a printed rule, not as type — which is what
      // `--admin-danger` exists to correct.
      const remove = await paintedColours(rui.getByRole("button", { name: /^Delete/ }));
      expect(contrastRatio(remove.color, remove.background)).toBeGreaterThanOrEqual(4.5);

      const guest = page.locator(".admin-person", { hasText: "guest@household.lan" });
      const chip = await paintedColours(guest.locator(".admin-chip--pending"));
      expect(contrastRatio(chip.color, chip.background)).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("the gate's own button is legible inside the shell", async ({ page }) => {
    await signedInAsAdmin(page);
    await page.goto("/");
    await railSettled(page);
    await railRow(page, "Admin").click();
    await expect(page.getByRole("heading", { name: "Confirm your password" })).toBeVisible();
    await freezeMotion(page);

    // REGRESSION. The auth pages' `.button` scores the same as `02`'s
    // `.sn-root :where(button) { color: inherit }` reset and is declared before
    // it, so reusing that class inside the shell painted `--ink` on `--ink` — a
    // solid, unreadable slab, exactly what the reset once did to the reader's
    // Export button. A ratio of 1 is what that looks like from here.
    const { color, background } = await paintedColours(page.locator(".admin-gate__submit"));
    expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(4.5);
  });

  test("the gate's field is labelled and its error is announced", async ({ page }) => {
    await signedInAsAdmin(page);
    await page.goto("/");
    await railSettled(page);
    await railRow(page, "Admin").click();

    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill("nope");
    await page.getByRole("button", { name: "Unlock console" }).click();
    await expect(gateStatus(page)).toHaveAttribute("aria-live", "assertive");
  });
});
