import { describe, it, expect } from "vitest";
import { backupNoticeText, backupsCard, backupRunLine, noticeTone, BACKUP_COMMAND } from "../../src/pages/admin/backupCopy";
import type { AdminBackups, BackupRun } from "../../src/api/adminTypes";

// Seconds, as the server sends them; `NOW` in ms, as the copy takes it.
const T = 1_793_761_200;
const NOW = (T + 3600) * 1000;
const HOUR = 3600;

const run = (over: Partial<BackupRun> = {}): BackupRun => ({
  dir: "/mnt/nas",
  lastRunAt: T,
  lastOkAt: T,
  lastError: null,
  snapshot: "2026-11-04T030000Z",
  files: 37,
  bytes: 117_543_914,
  verifiedAt: null,
  verifyError: null,
  ...over,
});

const backups = (over: Partial<AdminBackups>): AdminBackups => ({
  warnAfterHours: 48,
  neverDismissed: false,
  notice: { kind: "none", dir: null, at: null, message: null, check: false },
  runs: [],
  ...over,
});

describe("the library's backup notice", () => {
  it("says nothing when all is well", () => {
    expect(backupNoticeText({ kind: "none", dir: null, at: null, message: null, check: false }, NOW)).toBeNull();
  });

  it("names the folder once: the command's message usually already does", () => {
    expect(
      backupNoticeText({ kind: "failed", dir: "/mnt/nas", at: T, message: "No backup directory at: /mnt/nas", check: false }, NOW),
    ).toBe("The last backup failed 1 hour ago: No backup directory at: /mnt/nas");
    expect(backupNoticeText({ kind: "failed", dir: "/mnt/nas", at: T, message: "disk full", check: false }, NOW)).toBe(
      "The last backup to /mnt/nas failed 1 hour ago: disk full",
    );
  });

  it("tells a failed check from a failed backup", () => {
    expect(backupNoticeText({ kind: "failed", dir: "/backup/old-usb-disk", at: T, message: "No snapshots to verify.", check: true }, NOW)).toBe(
      "The last check of the backups in /backup/old-usb-disk failed 1 hour ago: No snapshots to verify.",
    );
    expect(backupNoticeText({ kind: "failed", dir: "/mnt/nas", at: T, message: "1 missing in /mnt/nas", check: true }, NOW)).toBe(
      "The last check of the backups failed 1 hour ago: 1 missing in /mnt/nas",
    );
  });

  it("asks whether the schedule still runs when the newest success is old", () => {
    expect(backupNoticeText({ kind: "late", dir: "/mnt/nas", at: T - 72 * HOUR, message: null, check: false }, NOW)).toBe(
      "The last backup was 3 days ago, to /mnt/nas. Is the scheduled one still running?",
    );
  });

  it("says plainly that nothing is backed up yet", () => {
    expect(backupNoticeText({ kind: "never", dir: null, at: null, message: null, check: false }, NOW)).toMatch(/Nothing has been backed up yet/);
  });

  it("speaks in the app's two tints: danger for failed and late, information for nothing yet", () => {
    expect(noticeTone("failed")).toBe("danger");
    expect(noticeTone("late")).toBe("danger");
    expect(noticeTone("never")).toBe("info");
    expect(noticeTone("none")).toBeNull();
  });
});

describe("the Server panel's Backups card", () => {
  it("shows the newest success, with its size and folder, in plain ink", () => {
    const c = backupsCard(backups({ runs: [run({ dir: "/media/usb", lastOkAt: T - 100 * HOUR }), run()] }), NOW);
    expect(c).toEqual({ value: "1 hour ago", sub: "37 files, 112 MB in /mnt/nas", danger: false });
  });

  it("summarises a failure instead of repeating it, in the danger colour", () => {
    const failing = backups({
      notice: { kind: "failed", dir: "/media/usb", at: T, message: "disk full", check: false },
      runs: [run(), run({ dir: "/media/usb", lastError: "disk full" })],
    });
    expect(backupsCard(failing, NOW)).toEqual({ value: "Failing", sub: "1 of 2 folders failing", danger: true });
  });

  it("with one folder, says whether its backup or its check failed", () => {
    const ran = backups({ notice: { kind: "failed", dir: "/mnt/nas", at: T, message: "disk full", check: false }, runs: [run({ lastError: "disk full" })] });
    expect(backupsCard(ran, NOW).sub).toBe("its last backup failed");
    const checked = backups({
      notice: { kind: "failed", dir: "/mnt/nas", at: T, message: "1 missing", check: true },
      runs: [run({ verifiedAt: T, verifyError: "1 missing" })],
    });
    expect(backupsCard(checked, NOW).sub).toBe("its last check failed");
  });

  it("late is danger; none yet and elsewhere are not, and the command is not on the card", () => {
    expect(backupsCard(backups({ notice: { kind: "late", dir: "/mnt/nas", at: T - 72 * HOUR, message: null, check: false } }), NOW)).toEqual({
      value: "3 days ago",
      sub: "newest backup, older than 48 hours",
      danger: true,
    });
    const never = backupsCard(backups({ notice: { kind: "never", dir: null, at: null, message: null, check: false } }), NOW);
    expect(never).toEqual({ value: "None yet", sub: "no backup recorded", danger: false });
    expect(never.sub).not.toContain(BACKUP_COMMAND);
    expect(backupsCard(backups({ neverDismissed: true }), NOW).value).toBe("Elsewhere");
  });
});

describe("one folder's row", () => {
  it("is a plain sentence when healthy, with the exact time and snapshot for its title", () => {
    const line = backupRunLine(run({ verifiedAt: T }), NOW);
    expect(line.status).toBe("ok");
    expect(line.chip).toBeNull();
    expect(line.detail).toBe("backed up 1 hour ago, checked 1 hour ago · 37 files, 112 MB");
    expect(line.title).toMatch(/^Backed up .+ · snapshot 2026-11-04T030000Z$/);
  });

  it("carries trouble in a chip and keeps the sentence plain", () => {
    expect(backupRunLine(run({ lastRunAt: T, lastError: "disk full" }), NOW)).toMatchObject({
      status: "failed",
      chip: "Failing",
      detail: "disk full, 1 hour ago",
    });
    expect(backupRunLine(run({ verifiedAt: T, verifyError: "1 missing" }), NOW)).toMatchObject({ status: "check-failed", chip: "Check failed" });
    expect(backupRunLine(run({ lastOkAt: null, lastRunAt: null, verifiedAt: T }), NOW).detail).toBe(
      "checked 1 hour ago, no backup recorded",
    );
  });
});
