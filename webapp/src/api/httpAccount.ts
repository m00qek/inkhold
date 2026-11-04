// The caller's own account over HTTP; no route takes a user id.

import { md5Hex } from "./crypto";
import { ApiError } from "./errors";
import { request } from "./request";

export const accountMethods = {
  // --- ACCOUNT (self-service) ---
  //
  // Every route here targets the session; none takes a user id (unlike `/api/admin/*`).

  async accountSecurity() {
    const r = await accountRequest();
    return {
      // The backend omits null optionals: absent is "no such fact", not 0.
      passwordChangedAt: typeof r.passwordChangedAt === "number" ? r.passwordChangedAt : null,
      otherSessions: typeof r.otherBrowsers === "number" ? r.otherBrowsers : 0,
      thisSessionSince: typeof r.thisSessionSince === "number" ? r.thisSessionSince : null,
    };
  },

  async myDevices() {
    const r = await accountRequest();
    return (r.devices ?? [])
      // Active only: the route includes revoked bindings for the admin console.
      .filter((d) => d.active !== false)
      .map((d) => ({
        equipmentNo: d.equipment_no,
        name: d.name ?? "",
        model: d.model ?? null,
        firmware: d.firmware ?? null,
        lastSeenAt: typeof d.last_seen === "number" ? d.last_seen : null,
        linkedAt: d.created_at ?? 0,
      }));
  },

  async unlinkMyDevice(equipmentNo: string): Promise<void> {
    // Not `equipment/unlink`, which answers 200 for an unmatched serial; this one 404s.
    await request("POST", "/api/controlplane/account/devices/unlink", { equipmentNo });
  },

  async signOutEverywhere(): Promise<number> {
    const r = await request<{ revoked?: number }>("POST", "/api/controlplane/account/sign-out-others");
    return typeof r.revoked === "number" ? r.revoked : 0;
  },

  async storageBreakdown(): Promise<import("./accountTypes").StorageBreakdown> {
    const r = await request<{
      used_bytes?: number;
      total_bytes?: number;
      notebooks?: number;
      sketches?: number;
      documents?: number;
      recycle_bin?: number;
      versions?: number;
    }>("GET", "/api/controlplane/account/storage");
    if (typeof r.used_bytes !== "number" || typeof r.total_bytes !== "number") {
      throw new ApiError("SERVER", "The server returned an unexpected response.", 200);
    }
    // A partition of `used_bytes` audited by the backend; never re-derived here.
    const byKind =
      typeof r.notebooks === "number" &&
      typeof r.sketches === "number" &&
      typeof r.documents === "number" &&
      typeof r.recycle_bin === "number" &&
      typeof r.versions === "number"
        ? {
            notebookBytes: r.notebooks,
            sketchBytes: r.sketches,
            documentBytes: r.documents,
            binBytes: r.recycle_bin,
            versionBytes: r.versions,
          }
        : null;
    return { usedBytes: r.used_bytes, totalBytes: r.total_bytes, byKind };
  },

  async versionPolicy() {
    const r = await accountRequest();
    return readPolicy(r.versions);
  },

  async setVersionPolicy(keep: number) {
    const r = await request<{
      policy?: AccountResponse["versions"];
      removedVersions?: number;
      freedBytes?: number;
    }>("PUT", "/api/controlplane/account/versions", { keep });
    return {
      policy: readPolicy(r.policy),
      // What was actually discarded, not the page's own prediction.
      removedVersions: r.removedVersions ?? 0,
      freedBytes: r.freedBytes ?? 0,
    };
  },

  async changePassword(currentPlaintext: string, newPlaintext: string): Promise<void> {
    // A control-plane caller must send `currentPassword`; the server verifies it
    // before writing or revoking anything (`INVALID_CREDENTIALS` on mismatch).
    // Rate-limited 5 per 5 minutes per account. Hashed like the new one.
    await request("PUT", "/api/user/password", {
      currentPassword: md5Hex(currentPlaintext),
      newPassword: md5Hex(newPlaintext),
    });
  },
};

/** `GET /api/controlplane/account`. `devices` rows are snake_case (`DeviceInfo` verbatim). */
interface AccountResponse {
  passwordChangedAt?: number;
  thisSessionSince?: number;
  otherBrowsers?: number;
  devices?: {
    equipment_no: string;
    name?: string;
    model?: string | null;
    firmware?: string | null;
    active?: boolean;
    created_at?: number;
    last_seen?: number;
  }[];
  versions?: {
    keep?: number;
    maxKeep?: number;
    retainedPerFile?: number[];
  };
}

/**
 * `retainedPerFile` drives a destructive control, so non-finite entries are
 * dropped (a NaN would break the "will remove N versions" notice). Missing
 * `keep`/`maxKeep` read as 0: versioning off, nothing to discard.
 */
function readPolicy(v: AccountResponse["versions"]): import("./accountTypes").VersionPolicy {
  const counts = Array.isArray(v?.retainedPerFile) ? v.retainedPerFile : [];
  return {
    keep: Number.isFinite(v?.keep) ? (v?.keep as number) : 0,
    maxKeep: Number.isFinite(v?.maxKeep) ? (v?.maxKeep as number) : 0,
    retainedPerFile: counts.filter((n): n is number => Number.isFinite(n) && n >= 0),
  };
}

let accountInFlight: Promise<AccountResponse> | null = null;
function accountRequest(): Promise<AccountResponse> {
  if (accountInFlight) return accountInFlight;
  const p = request<AccountResponse>("GET", "/api/controlplane/account").finally(() => {
    if (accountInFlight === p) accountInFlight = null;
  });
  accountInFlight = p;
  return p;
}
