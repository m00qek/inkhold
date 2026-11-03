import { test, expect, type Page } from "@playwright/test";
import { mockApi } from "./helpers/mockApi";
import { contrastRatio, freezeMotion, paintedColours, railSettled } from "./helpers/app";

// The fake `Api` gates admin calls on an elevation as the server does. Password: `inkhold`.

const PASSWORD = "inkhold";

async function signedInAsAdmin(page: Page, isAdmin = true): Promise<void> {
  await mockApi(page, {
    "user/me": { json: { success: true, email: "ana@household.lan", isAdmin, mustChangePassword: false } },
  });
}

const railRow = (page: Page, name: string) => page.locator(".nav__item", { hasText: name });

/** Scoped: the shell's toast is a `role="status"` too. */
const gateStatus = (page: Page) => page.locator(".admin").getByRole("status");

async function unlocked(page: Page): Promise<void> {
  await signedInAsAdmin(page);
  await page.goto("/");
  await railSettled(page);
  await railRow(page, "Admin").click();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock console" }).click();
  await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
}

// --- where it lives ---

test.describe("admin: the rail entry", () => {
  test("is offered to an admin and hidden from everyone else", async ({ page }) => {
    await signedInAsAdmin(page, false);
    await page.goto("/");
    await railSettled(page);
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
    // Regression: `nav__count` rendered unconditionally, so the console showed a permanent `0`.
    await expect(railRow(page, "Admin").locator(".nav__count")).toHaveCount(0);
    // A folder's 0 is an answer, so category rows keep their badge.
    await expect(railRow(page, "Export").locator(".nav__count")).toHaveText("0");
  });

  test("shows a padlock that tracks the elevation, not a count", async ({ page }) => {
    await signedInAsAdmin(page);
    await page.goto("/");
    await railSettled(page);

    const padlock = railRow(page, "Admin").locator(".nav__state");
    await expect(padlock).toBeVisible();
    await expect(padlock).toHaveAttribute("aria-label", "Admin console locked");
    // A non-text indicator, so it owes 3.0 contrast.
    await freezeMotion(page);
    const { color, background } = await paintedColours(padlock);
    expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(3);
    const box = await padlock.boundingBox();
    expect(box!.width).toBeGreaterThan(0);

    await railRow(page, "Admin").click();
    await expect(padlock).toHaveAttribute("aria-label", "Admin console locked");
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Unlock console" }).click();
    await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
    await expect(padlock).toHaveAttribute("aria-label", "Admin console unlocked");

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

// --- the topbar over the console ---

test.describe("admin: the boot race", () => {
  test("a hard reload straight onto #/admin lands on the gate, and the tree walk does not paint over it", async ({
    page,
  }) => {
    await signedInAsAdmin(page);
    // A cold goto, so the folder-tree prefetch is still in flight and its late gallery
    // repaint must not blank the gate (the same race that closed the bin).
    await page.goto("/#/admin");
    await expect(page.locator(".admin")).toBeVisible();
    await expect(page.getByRole("button", { name: "Unlock console" })).toBeVisible();

    await railSettled(page);
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
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();

    await railRow(page, "Admin").click();
    await expect(page.locator(".admin")).toBeVisible();
    // The same `.sn-root.is-destination` mode the bin uses.
    await expect(page.locator(".sn-root")).toHaveClass(/is-destination/);
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeHidden();

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
    await expect(lock).toBeHidden();

    await railRow(page, "Admin").click();
    await expect(lock).toBeVisible();
    await expect(page.locator(".tools #lock-console")).toHaveCount(1);
    await expect(page.locator(".admin-head__acts #lock-console")).toHaveCount(0);
    await expect(lock).toHaveText("Lock console");
    await expect(lock.locator("svg")).toHaveCount(1);

    await freezeMotion(page);
    // Locking destroys nothing, so it must not inherit `Empty bin`'s danger styling.
    await expect(lock).not.toHaveClass(/is-danger/);
    const { color, background } = await paintedColours(lock);
    expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(4.5);
    const empty = await paintedColours(page.locator("#empty-bin"));
    expect(color).not.toBe(empty.color);
    const box = await lock.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
    expect(box!.width).toBeGreaterThanOrEqual(24);
  });

  test("and it still locks — the behaviour travelled with the button", async ({ page }) => {
    await unlocked(page);
    await page.locator("#lock-console").click();
    await expect(page.getByRole("heading", { name: "Confirm your password" })).toBeVisible();
    await expect(page.locator(".admin-person")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add person" })).toHaveCount(0);
  });

  test("Lock console leaves with the console, and never appears over the bin", async ({ page }) => {
    await unlocked(page);
    const lock = page.locator("#lock-console");
    await expect(lock).toBeVisible();

    await railRow(page, "Recycle bin").click();
    await expect(lock).toBeHidden();
    await expect(page.locator("#empty-bin")).toBeVisible();
    await expect(page.locator(".sn-root")).toHaveClass(/is-destination/);
  });
});

// --- the gate ---

test.describe("admin: the gate", () => {
  test("asks for the password before any of the household is on screen", async ({ page }) => {
    await signedInAsAdmin(page);
    await page.goto("/");
    await railSettled(page);
    await railRow(page, "Admin").click();

    await expect(page.getByRole("heading", { name: "Confirm your password" })).toBeVisible();
    await expect(page.locator(".admin-gate__why")).toContainText("delete another person's notes");
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

    // The elevation lives on the session, so the next admin call answers 428. The 428
    // resume loop is pinned in tests/unit/admin.test.ts.
    await expect(page.locator(".admin-person")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add person" })).toHaveCount(0);
  });
});

// --- the actions ---

test.describe("admin: actions", () => {
  test("deleting a person is the one action that asks you to type it out", async ({ page }) => {
    await unlocked(page);
    const rui = page.locator(".admin-person", { hasText: "rui@household.lan" });
    await rui.getByRole("button", { name: /^Delete/ }).click();

    const go = page.getByRole("button", { name: "Delete permanently" });
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

    // First in DOM order and focused, so Enter reaches the safe answer.
    await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Enter");
    // `.admin-dialog`: the shell keeps the bin's own `<dialog>` mounted.
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
    // Regression: an admin reset their own password and locked themselves out. Your row
    // points elsewhere instead of offering a disabled button.
    await unlocked(page);
    const me = page.locator(".admin-person", { hasText: "ana@household.lan" });
    await expect(me).toHaveCount(1);
    await expect(me.getByRole("button", { name: /^Reset/ })).toHaveCount(0);
    await expect(me.locator(".admin-selfnote")).toContainText("on your account page");

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
    // The server keeps only a hash, so this is the only moment it can be read.
    await expect(page.locator(".admin-dialog__text")).toContainText("cannot be shown again");
    await expect(secret).not.toHaveText("");

    await page.getByRole("button", { name: "Done" }).click();
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
    await expect(sofia).toContainText("must set password");
  });

  test("YOUR OWN row cannot be deleted either — the control is absent, not disabled", async ({ page }) => {
    // Your own row has no Delete; the `LastAdmin` / `CannotDeleteSelf` refusals are
    // unit-tested in `services/auth/service.zig`.
    await unlocked(page);
    const me = page.locator(".admin-person", { hasText: "ana@household.lan" });
    await expect(me).toHaveCount(1);
    await expect(me.getByRole("button", { name: /^Delete/ })).toHaveCount(0);

    const rui = page.locator(".admin-person", { hasText: "rui@household.lan" });
    await expect(rui.getByRole("button", { name: /^Delete/ })).toHaveCount(1);
  });
});

// --- what it will not say ---

test.describe("admin: storage, devices and the server panel", () => {
  test("draws the over-quota state instead of a bar that just looks full", async ({ page }) => {
    await unlocked(page);
    const rui = page.locator(".admin-person", { hasText: "rui@household.lan" });
    const meter = rui.locator(".admin-meter");

    // 11.2 GB against 10 GB: a bar pinned at 100% looks full, so the overage must be in words.
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
    await expect(changes).not.toHaveCount(0);

    for (const change of await changes.all()) {
      await expect(change).toHaveText("Change");
      await expect(change.locator(".admin-change__mark svg")).toHaveCount(1);
      await expect(change.locator(".admin-change__mark")).toHaveAttribute("aria-hidden", "true");
      const box = await change.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(24);
      expect(box!.width).toBeGreaterThanOrEqual(24);
    }

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

    await expect(page.locator(".toast")).toContainText("over their allotment");
    await expect(ana.locator(".admin-meter")).toHaveClass(/is-over/);
    await expect(ana.locator(".admin-meter")).toContainText("of 1.0 GB");
  });

  test("the server panel shows memory against its budget, and the version", async ({ page }) => {
    await unlocked(page);
    const server = page.locator(".admin-server");
    await expect(server.getByRole("heading", { name: "Server" })).toBeVisible();
    await expect(server).toContainText("of 50 MB budget");
    await expect(server).toContainText("deduplicated");
    await expect(page.locator(".admin-head__ver")).toHaveText("0.0.1");
  });

  test("the retention control promises, on the card, that lowering it purges nothing", async ({ page }) => {
    await unlocked(page);
    await expect(page.locator(".admin-server__note")).toContainText("full new window");

    await page.getByRole("button", { name: /Change how long/ }).click();
    await expect(page.locator(".admin-dialog")).toContainText("full new window");
    const days = page.getByLabel("Days");
    await expect(days).toHaveValue("30");

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
    // An admin manages accounts and does not watch activity; device "since" is the binding date.
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
    await expect(server).not.toContainText(/uptime/i);
  });
});

// --- leaving ---

test.describe("admin: leaving and coming back", () => {
  test("clicking a folder leaves the console; coming back does not ask again", async ({ page }) => {
    await unlocked(page);
    await railRow(page, "Note").first().click();
    await expect(page.locator(".admin")).toBeHidden();
    await expect(page.locator(".gallery")).toBeVisible();

    await railRow(page, "Admin").click();
    // The elevation is a session fact, so re-entering must not repaint the gate.
    await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
  });
});

// --- accessibility ---

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
      // `.admin-btn` transitions its background; read colours only after freezing.
      await freezeMotion(page);

      const rui = page.locator(".admin-person", { hasText: "rui@household.lan" });
      // `--margin` is 4.49 on the light sheet; `--admin-danger` corrects it for type.
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

    // Regression: the auth pages' `.button` ties with the shell's `color: inherit` reset and
    // is declared first, painting `--ink` on `--ink` (ratio 1).
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
