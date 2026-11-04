import { test, expect, type Page } from "@playwright/test";
import { mockApi } from "./helpers/mockApi";
import { railSettled } from "./helpers/app";

// The fake starts with a healthy nightly backup, so no other spec sees a notice.
// These seed another state before boot: the fake reads `__snFakeBackups` once.

const PASSWORD = "inkhold";

type Run = {
  dir: string;
  lastRunAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  snapshot: string | null;
  files: number | null;
  bytes: number | null;
  verifiedAt: number | null;
  verifyError: string | null;
};

async function seed(page: Page, state: { runs: Run[]; neverDismissed?: boolean }): Promise<void> {
  await page.addInitScript((s) => {
    (globalThis as { __snFakeBackups?: unknown }).__snFakeBackups = s;
  }, state);
}

async function signedIn(page: Page, isAdmin: boolean): Promise<void> {
  await mockApi(page, {
    "user/me": { json: { success: true, email: "ana@household.lan", isAdmin, mustChangePassword: false } },
  });
}

const nowS = (): number => Math.floor(Date.now() / 1000);
const nasOk = (): Run => ({
  dir: "/mnt/nas/inkhold",
  lastRunAt: nowS() - 3600,
  lastOkAt: nowS() - 3600,
  lastError: null,
  snapshot: "2026-11-04T030000Z",
  files: 37,
  bytes: 117_543_914,
  verifiedAt: null,
  verifyError: null,
});
const usbFailing = (): Run => ({
  dir: "/media/usb/inkhold",
  lastRunAt: nowS() - 7200,
  lastOkAt: nowS() - 9 * 86400,
  lastError: "No backup directory at: /media/usb/inkhold",
  snapshot: "2026-10-26T030000Z",
  files: 30,
  bytes: 90_000_000,
  verifiedAt: null,
  verifyError: null,
});

const notice = (page: Page) => page.getByRole("complementary", { name: "Backups" });

async function unlock(page: Page): Promise<void> {
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock console" }).click();
  await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
}

test.describe("backups: the library's notice", () => {
  test("says nothing while backups are healthy", async ({ page }) => {
    await signedIn(page, true);
    await page.goto("/");
    await railSettled(page);
    await expect(notice(page)).toBeHidden();
  });

  test("tells an admin a backup failed, and is never shown to anyone else", async ({ page }) => {
    await seed(page, { runs: [nasOk(), usbFailing()] });
    await signedIn(page, false);
    await page.goto("/");
    await railSettled(page);
    await expect(notice(page)).toBeHidden();

    await signedIn(page, true);
    await page.reload();
    await railSettled(page);
    await expect(notice(page)).toBeVisible();
    await expect(notice(page)).toContainText("The last backup to /media/usb/inkhold failed 2 hours ago");
    await expect(notice(page)).toContainText("No backup directory at: /media/usb/inkhold");
  });

  test("leads to the Server panel, where forgetting the dead disk clears the warning", async ({ page }) => {
    await seed(page, { runs: [nasOk(), usbFailing()] });
    await signedIn(page, true);
    await page.goto("/");
    await railSettled(page);

    await notice(page).getByRole("button", { name: "Open backups" }).click();
    await expect(page).toHaveURL(/#\/admin$/);
    await unlock(page);

    const dirs = page.getByRole("list", { name: "Backup directories" });
    await expect(dirs.getByRole("listitem")).toHaveCount(2);
    await expect(page.locator(".admin-stat", { hasText: "Backups" })).toContainText("Failing");

    await page.getByRole("button", { name: "Forget /media/usb/inkhold" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Forget", exact: true }).click();
    await expect(dirs.getByRole("listitem")).toHaveCount(1);
    await expect(notice(page)).toBeHidden();
  });

  test("nothing backed up yet: said once, until an admin says they back up another way", async ({ page }) => {
    await seed(page, { runs: [] });
    await signedIn(page, true);
    await page.goto("/");
    await railSettled(page);
    await expect(notice(page)).toContainText("Nothing has been backed up yet");

    await notice(page).getByRole("button", { name: "Open backups" }).click();
    await unlock(page);
    await expect(page.locator(".admin-stat", { hasText: "Backups" })).toContainText("None yet");
    await page.getByRole("button", { name: "I back up another way" }).click();
    await expect(notice(page)).toBeHidden();
    await expect(page.getByRole("button", { name: "Remind me when nothing is backed up" })).toBeVisible();
  });
});
