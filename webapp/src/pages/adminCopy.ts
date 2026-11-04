// The admin console's pure presentation: names, ages, byte figures, meters and failure copy.

import { ApiError, RateLimitError } from "../api/client";
import { type AdminDevice, type AdminHealth, type AdminQuota } from "../api/adminTypes";

/** The address's local part; the server stores no name. Same as the rail footer. */
export function displayName(email: string): string {
  return email.split("@")[0] || email;
}

export function initials(email: string): string {
  const name = displayName(email);
  const parts = name.split(/[.\-_]+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "?";
  const b = parts[1]?.[0] ?? parts[0]?.[1] ?? "";
  return (a + b).toUpperCase();
}

/** Epoch seconds; `0` means absent and renders nothing. A fact about the login, not activity. */
export function accountAge(createdAtSeconds: number): string {
  if (!Number.isFinite(createdAtSeconds) || createdAtSeconds <= 0) return "";
  return new Date(createdAtSeconds * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
* An entry's clock runs from the later of trashing and the last window change
* (`settings.sweepCutoff`), so shortening never makes old entries instantly due.
*/
export const RETENTION_NEVER_PURGES =
  "Nothing already in the bin is removed early: everything in it gets a full new window from the moment you change this.";

export const GB = 1024 ** 3;

/** Binary units; one decimal at GB, whole numbers below. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

export interface Meter {
  /** Clamped drawn length; overage is carried by `tone` and `label`. */
  fill: number;
  /** `tight` at 90% (a sync is about to fail); `over` once the allotment is passed. */
  tone: "normal" | "tight" | "over";
  overBytes: number;
  label: string;
}

/**
* Only the drawn length is clamped. `used > total` is a real state (lowering an
* allotment deletes nothing and stops the next sync), stated in bytes. A zero
* allotment is a limit of nothing, not "no limit".
*/
export function meterFor(quota: AdminQuota): Meter {
  const used = Math.max(0, quota.usedBytes);
  const total = Math.max(0, quota.totalBytes);

  if (total === 0) {
    return used === 0
      ? { fill: 0, tone: "normal", overBytes: 0, label: "No allotment set" }
      : { fill: 100, tone: "over", overBytes: used, label: `${formatBytes(used)} stored, with no allotment` };
  }

  const ratio = used / total;
  const tone = ratio > 1 ? "over" : ratio >= 0.9 ? "tight" : "normal";
  const base = `${formatBytes(used)} of ${formatBytes(total)}`;
  return {
    fill: Math.min(100, Math.round(ratio * 100)),
    tone,
    overBytes: tone === "over" ? used - total : 0,
    label: tone === "over" ? `${base} — ${formatBytes(used - total)} over` : base,
  };
}

/**
* `memoryBytes` is null off Linux and must not render as `0 B`. Always shown
* against the 50 MB ceiling.
*/
export function memoryCard(health: AdminHealth): { value: string; sub: string; meter: Meter | null } {
  const budget = health.memoryBudgetBytes;
  const sub = budget > 0 ? `of ${formatBytes(budget)} budget` : "no budget reported";
  if (health.memoryBytes === null) {
    return { value: "unknown", sub: "this platform does not report it", meter: null };
  }
  return {
    value: formatBytes(health.memoryBytes),
    sub,
    meter: budget > 0 ? meterFor({ usedBytes: health.memoryBytes, totalBytes: budget }) : null,
  };
}

/** `model` and `firmware` may be missing on older bindings; dropped, not dashed. */
export function deviceTitle(device: AdminDevice): string {
  return device.model ? `${device.name} (${device.model})` : device.name;
}

export function deviceMeta(device: AdminDevice): string {
  const parts = [device.equipmentNo];
  if (device.firmware) parts.push(`fw ${device.firmware}`);
  const since = accountAge(device.createdAt);
  if (since) parts.push(`since ${since}`);
  return parts.join(" · ");
}

/** The two server outcomes with their own wording; others keep the client's message. */
export function failureMessage(e: unknown): string {
  if (e instanceof RateLimitError) {
    const wait = e.retryAfterSeconds ? ` Try again in ${e.retryAfterSeconds}s.` : "";
    return `Too many attempts.${wait}`;
  }
  if (e instanceof ApiError) {
    if (e.code === "EMAIL_EXISTS") return "There is already an account with that address.";
    if (e.code === "LAST_ADMIN") return "That is the last administrator. Make someone else an admin first.";
    return e.message;
  }
  return "Something went wrong. Try again.";
}

/** Deliberately doesn't distinguish its refusals. */
export function gateMessage(e: unknown): string {
  if (e instanceof RateLimitError) {
    const wait = e.retryAfterSeconds ? ` Try again in ${e.retryAfterSeconds}s.` : "";
    // Keyed by account on the server, not IP.
    return `Too many attempts.${wait}`;
  }
  // One code for wrong password, non-admin and pending password change, so the
  // endpoint can't reveal who the admins are.
  return e instanceof ApiError && (e.code === "INVALID_CREDENTIALS" || e.code === "NO_CHALLENGE")
    ? "That password doesn't match."
    : failureMessage(e);
}
