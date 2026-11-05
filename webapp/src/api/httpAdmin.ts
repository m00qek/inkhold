// The admin console's HTTP calls; all but elevate and lock may answer 428.

import { challengeHash } from "./crypto";
import { ApiError } from "./errors";
import { request } from "./request";
import type { AdminBackups, BackupNotice, BackupNoticeKind, BackupRun } from "./adminTypes";

export const adminMethods = {
  // --- ADMIN WRITES ---
  //
  // All but `adminElevate`/`adminLock` may answer 428 (`ELEVATION_REQUIRED`);
  // the console handles it, nothing is caught here.

  async adminListUsers() {
    // The one snake_case response on this surface (`UserInfo` serialized verbatim).
    const r = await request<{
      users?: { id: number; email: string; is_admin?: boolean; must_change?: boolean; created_at?: number }[];
    }>("GET", "/api/admin/users");
    return (r.users ?? []).map((u) => ({
      id: u.id,
      email: u.email,
      // `=== true`: absent is the safe reading (not admin, no change owed).
      isAdmin: u.is_admin === true,
      mustChangePassword: u.must_change === true,
      // Absent reads as 0, which renders as no date rather than "Invalid Date".
      createdAt: typeof u.created_at === "number" ? u.created_at : 0,
    }));
  },

  async adminCreateUser(email: string, isAdmin: boolean): Promise<string> {
    // No password field: the server picks it.
    const r = await request<{ temporaryPassword?: string }>("POST", "/api/admin/users", { email, isAdmin });
    // A missing password is an error, never an empty credential.
    if (!r.temporaryPassword) throw new ApiError("SERVER", "The server returned an unexpected response.", 200);
    return r.temporaryPassword;
  },

  async adminDeleteUser(id: number): Promise<void> {
    await request("DELETE", `/api/admin/users/${encodeURIComponent(String(id))}`);
  },

  async adminResetPassword(id: number): Promise<string> {
    // Empty body: the server generates the password.
    const r = await request<{ temporaryPassword?: string }>(
      "POST",
      `/api/admin/users/${encodeURIComponent(String(id))}/reset`,
      {},
    );
    if (!r.temporaryPassword) throw new ApiError("SERVER", "The server returned an unexpected response.", 200);
    return r.temporaryPassword;
  },

  async adminElevate(account: string, plaintext: string): Promise<void> {
    // The full challenge flow, not a plain POST: on plaintext HTTP anything replayable is exposed.
    const challenge = await request<{ randomCode: string }>(
      "POST",
      "/api/official/user/query/random/code",
      { account },
    );
    const password = await challengeHash(plaintext, challenge.randomCode);
    // No account in the body: the session names the caller.
    await request("POST", "/api/admin/elevate", { password });
  },

  async adminLock(): Promise<void> {
    await request("POST", "/api/admin/lock", {});
  },

  // Responses are snake_case (service structs verbatim); request bodies are camelCase.

  async adminListDevices(userId: number) {
    const r = await request<{
      devices?: {
        equipment_no: string;
        name?: string;
        model?: string;
        firmware?: string;
        active?: boolean;
        created_at?: number;
      }[];
    }>("GET", `/api/admin/users/${encodeURIComponent(String(userId))}/devices`);
    return (r.devices ?? []).map((d) => ({
      equipmentNo: d.equipment_no,
      // The serial stands in for a name the device never sent.
      name: d.name || d.equipment_no,
      // Omitted when never reported; `?? null` avoids printing "undefined".
      model: d.model ?? null,
      firmware: d.firmware ?? null,
      // `!== false`: absent reads as active, so a working binding never looks revoked.
      active: d.active !== false,
      createdAt: typeof d.created_at === "number" ? d.created_at : 0,
    }));
  },

  async adminUnlinkDevice(userId: number, equipmentNo: string): Promise<void> {
    await request("POST", `/api/admin/users/${encodeURIComponent(String(userId))}/devices/unlink`, {
      equipmentNo,
    });
  },

  async adminGetQuota(userId: number) {
    const r = await request<{ used_bytes?: number; total_bytes?: number }>(
      "GET",
      `/api/admin/users/${encodeURIComponent(String(userId))}/quota`,
    );
    return quotaOf(r);
  },

  async adminSetQuota(userId: number, totalBytes: number) {
    const r = await request<{ used_bytes?: number; total_bytes?: number }>(
      "PUT",
      `/api/admin/users/${encodeURIComponent(String(userId))}/quota`,
      { totalBytes },
    );
    return quotaOf(r);
  },

  async adminGetRetention() {
    return retentionOf(await request<Record<string, number>>("GET", "/api/admin/settings/retention"));
  },

  async adminSetRetention(days: number) {
    return retentionOf(
      await request<Record<string, number>>("PUT", "/api/admin/settings/retention", { retentionDays: days }),
    );
  },

  async adminHealth() {
    const r = await request<{
      health?: {
        version?: string;
        memory_bytes?: number;
        memory_budget_bytes?: number;
        blob_bytes?: number;
        blob_count?: number;
      };
    }>("GET", "/api/admin/health");
    const h = r.health ?? {};
    return {
      version: h.version ?? "unknown",
      // Must not default to a number: absent means the platform cannot say, and
      // `0` would read as "using no memory". Null renders as "unknown".
      memoryBytes: typeof h.memory_bytes === "number" ? h.memory_bytes : null,
      memoryBudgetBytes: h.memory_budget_bytes ?? 0,
      blobBytes: h.blob_bytes ?? 0,
      blobCount: h.blob_count ?? 0,
    };
  },

  // --- BACKUPS ---
  // The notice is the library's (any signed-in caller, no elevation); the rest
  // is the Server panel's and `require_admin` like the calls above.

  async backupNotice(): Promise<BackupNotice> {
    return noticeOf(await request<RawNotice>("GET", "/api/backup-notice"));
  },

  async adminBackups(): Promise<AdminBackups> {
    return backupsOf(await request<RawBackups>("GET", "/api/admin/backups"));
  },

  async adminSetBackupDismissed(dismissed: boolean): Promise<AdminBackups> {
    return backupsOf(await request<RawBackups>("PUT", "/api/admin/backups/dismissed", { dismissed }));
  },

  async adminForgetBackupDir(dir: string): Promise<AdminBackups> {
    return backupsOf(await request<RawBackups>("POST", "/api/admin/backups/forget", { dir }));
  },
};

// ---- backups: the server omits a null field, so absent becomes null here ----

type RawNotice = { kind?: string; dir?: string; at?: number; message?: string; check?: boolean };
type RawRun = Partial<Record<keyof BackupRun, unknown>>;
type RawBackups = { warnAfterHours?: number; neverDismissed?: boolean; notice?: RawNotice; runs?: RawRun[] };

const KINDS: readonly BackupNoticeKind[] = ["none", "never", "late", "failed"];

/** An unknown kind reads as `none`: a newer server must not paint a false alarm. */
function noticeOf(r: RawNotice | undefined): BackupNotice {
  const kind = KINDS.includes(r?.kind as BackupNoticeKind) ? (r!.kind as BackupNoticeKind) : "none";
  return { kind, dir: r?.dir ?? null, at: num(r?.at), message: r?.message ?? null, check: r?.check === true };
}

function backupsOf(r: RawBackups): AdminBackups {
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    warnAfterHours: typeof r.warnAfterHours === "number" ? r.warnAfterHours : 48,
    neverDismissed: r.neverDismissed === true,
    notice: noticeOf(r.notice),
    runs: (r.runs ?? []).flatMap((x) =>
      typeof x.dir === "string"
        ? [
            {
              dir: x.dir,
              lastRunAt: num(x.lastRunAt),
              lastOkAt: num(x.lastOkAt),
              lastError: str(x.lastError),
              snapshot: str(x.snapshot),
              files: num(x.files),
              bytes: num(x.bytes),
              verifiedAt: num(x.verifiedAt),
              verifyError: str(x.verifyError),
            },
          ]
        : [],
    ),
  };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Not clamped: over-quota is a real state the meter draws. */
function quotaOf(r: { used_bytes?: number; total_bytes?: number }): { usedBytes: number; totalBytes: number } {
  const n = (v: number | undefined): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return { usedBytes: n(r.used_bytes), totalBytes: n(r.total_bytes) };
}

/** Bounds fall back to 1..365, not 0, or every value would look out of range. */
function retentionOf(r: Record<string, number>): {
  retentionDays: number;
  defaultDays: number;
  minDays: number;
  maxDays: number;
  changedAt: number;
} {
  const n = (v: number | undefined, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    retentionDays: n(r.retentionDays, 30),
    defaultDays: n(r.defaultDays, 30),
    minDays: n(r.minDays, 1),
    maxDays: n(r.maxDays, 365),
    // 0 means "never changed".
    changedAt: n(r.changedAt, 0),
  };
}
