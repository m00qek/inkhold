import { describe, it, expect } from "vitest";
import { backupNoticeText, backupsCard, backupRunLine, BACKUP_COMMAND } from "../../src/pages/admin/backupCopy";
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
  notice: { kind: "none", dir: null, at: null, message: null },
  runs: [],
  ...over,
});

describe("the library's backup notice", () => {
  it("says nothing when all is well", () => {
    expect(backupNoticeText({ kind: "none", dir: null, at: null, message: null }, NOW)).toBeNull();
  });

  it("names the failing directory, when, and what the command said", () => {
    expect(
      backupNoticeText({ kind: "failed", dir: "/mnt/nas", at: T, message: "No backup directory at: /mnt/nas" }, NOW),
    ).toBe("The last backup to /mnt/nas failed 1 hour ago: No backup directory at: /mnt/nas");
  });

  it("asks whether the schedule still runs when the newest success is old", () => {
    expect(backupNoticeText({ kind: "late", dir: "/mnt/nas", at: T - 72 * HOUR, message: null }, NOW)).toBe(
      "The last backup was 3 days ago, to /mnt/nas. Is the scheduled one still running?",
    );
  });

  it("says plainly that nothing is backed up yet", () => {
    expect(backupNoticeText({ kind: "never", dir: null, at: null, message: null }, NOW)).toMatch(/Nothing has been backed up yet/);
  });
});

describe("the Server panel's Backups card", () => {
  it("shows the newest success, with its size and directory", () => {
    const c = backupsCard(backups({ runs: [run({ dir: "/media/usb", lastOkAt: T - 100 * HOUR }), run()] }), NOW);
    expect(c.value).toBe("1 hour ago");
    expect(c.sub).toBe("37 files, 112 MB in /mnt/nas");
  });

  it("reads Failing with the error, None yet with the command, Elsewhere once dismissed", () => {
    expect(backupsCard(backups({ notice: { kind: "failed", dir: "/mnt/nas", at: T, message: "disk full" } }), NOW)).toEqual({
      value: "Failing",
      sub: "disk full",
    });
    expect(backupsCard(backups({ notice: { kind: "never", dir: null, at: null, message: null } }), NOW).sub).toContain(BACKUP_COMMAND);
    expect(backupsCard(backups({ neverDismissed: true }), NOW).value).toBe("Elsewhere");
  });

  it("says how old the newest backup is when late, and against what", () => {
    const c = backupsCard(backups({ notice: { kind: "late", dir: "/mnt/nas", at: T - 72 * HOUR, message: null } }), NOW);
    expect(c).toEqual({ value: "3 days ago", sub: "newest backup, older than 48 hours" });
  });
});

describe("one directory's line", () => {
  it("is ok with the last success and check, and failing with its error", () => {
    expect(backupRunLine(run({ verifiedAt: T }), NOW)).toEqual({
      ok: true,
      detail: "backed up 1 hour ago, checked 1 hour ago · 37 files, 112 MB in /mnt/nas",
    });
    expect(backupRunLine(run({ lastRunAt: T, lastError: "disk full" }), NOW)).toEqual({ ok: false, detail: "failed 1 hour ago: disk full" });
    expect(backupRunLine(run({ verifiedAt: T, verifyError: "1 missing" }), NOW).ok).toBe(false);
    expect(backupRunLine(run({ lastOkAt: null, lastRunAt: null, verifiedAt: T }), NOW).detail).toBe(
      "checked 1 hour ago, no backup recorded",
    );
  });
});
