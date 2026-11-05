// The admin console's wire types, kept out of `types.ts` so `Api` can reach
// them via inline `import("./adminTypes")` types.

/**
 * One household account. `GET /api/admin/users` serializes `UserInfo`
 * verbatim in snake_case; `createHttpApi` camel-cases it at the seam. No
 * activity timestamp, deliberately (U7): admins manage accounts, not watch use.
 */
export interface AdminUser {
  id: number;
  email: string;
  isAdmin: boolean;
  /**
   * The account owes a password change, as after create or reset; this is what
   * makes handing over a server-generated temporary password safe.
   */
  mustChangePassword: boolean;
  /** Account creation, epoch SECONDS (the server's `created_at`, not ms). */
  createdAt: number;
}

/** One tablet bound to an account. `model`/`firmware` may be absent on old bindings. */
export interface AdminDevice {
  /** The device serial. The unlink key, and unique per binding. */
  equipmentNo: string;
  /** What the device calls itself. */
  name: string;
  model: string | null;
  firmware: string | null;
  /**
   * Revocation is a soft flip, so revoked bindings are still listed;
   * `false` means unlinked and re-pairable, which the row must say.
   */
  active: boolean;
  /** When the binding was made, epoch SECONDS — the row's "since". */
  createdAt: number;
}

/**
 * One person's storage, in bytes. `usedBytes` can exceed `totalBytes` after an
 * allotment is lowered; don't clamp it.
 */
export interface AdminQuota {
  usedBytes: number;
  totalBytes: number;
}

/** The recycle bin's server-wide retention window, with its own bounds. */
export interface AdminRetention {
  retentionDays: number;
  /** What the install started at, so the UI can say what "back to normal" is. */
  defaultDays: number;
  minDays: number;
  maxDays: number;
  /**
   * Epoch seconds of the last change, 0 if never. Not retroactive: an entry's
   * clock runs from the later of its trashing and this (`settings.sweepCutoff`).
   */
  changedAt: number;
}

/** Server-wide health. Household totals only, no per-person figures. */
export interface AdminHealth {
  version: string;
  /** RSS in bytes, or null where unsupported (Linux only); render "unknown", not 0. */
  memoryBytes: number | null;
  /** The 50 MB ceiling memory is shown against. */
  memoryBudgetBytes: number;
  /** Deduplicated blob-store bytes, not the sum of quota usage. */
  blobBytes: number;
  blobCount: number;
}

/**
 * What to tell an admin about backups (`services/backup/status.zig`): `failed`
 * when any directory's last run failed, `never` when nothing has succeeded and
 * the admin has not said they back up another way, `late` when the newest
 * success anywhere is older than the server's threshold.
 */
export type BackupNoticeKind = "none" | "never" | "late" | "failed";

export interface BackupNotice {
  kind: BackupNoticeKind;
  /** The directory concerned: the failing one, or the one with the newest success. */
  dir: string | null;
  /** Epoch seconds: when it failed, or the newest success (`late`). */
  at: number | null;
  /** The first line the backup command printed when it failed. */
  message: string | null;
  /** `failed` only: it was the check of the backups (`verify`), not a backup run. */
  check: boolean;
}

/** One backup directory's record. Epoch seconds; null where it never happened. */
export interface BackupRun {
  dir: string;
  lastRunAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  snapshot: string | null;
  files: number | null;
  bytes: number | null;
  verifiedAt: number | null;
  verifyError: string | null;
}

export interface AdminBackups {
  warnAfterHours: number;
  /** An admin said they back up another way: `never` is not shown. */
  neverDismissed: boolean;
  notice: BackupNotice;
  /** Most recent activity first. */
  runs: BackupRun[];
}
