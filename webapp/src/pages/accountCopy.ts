// The account page's pure logic: what a change would discard, and every label it shows. No DOM.

import { relativeTime } from "../ui/relativeTime";
import { ApiError, RateLimitError } from "../api/client";
import { type MyDevice, type StorageByKind } from "../api/accountTypes";

// ---- pure logic (no DOM; unit-tested) ----

/**
* Σ max(0, count − keep) over per-file counts: `keep` is per file, not a pool.
* Raising `keep` discards nothing.
*/
export function versionsToDiscard(retainedPerFile: readonly number[], keep: number): number {
  if (!Number.isFinite(keep)) return 0;
  const k = Math.max(0, Math.floor(keep));
  return retainedPerFile.reduce((total, count) => total + Math.max(0, count - k), 0);
}

/**
* Stated before saving because discarded versions are gone (the bin doesn't
* hold them). Zero is a valid setting. Null when there's nothing to say.
*/
export function discardNotice(retainedPerFile: readonly number[], keep: number): string | null {
  const n = versionsToDiscard(retainedPerFile, keep);
  const k = Math.max(0, Math.floor(keep));
  if (n === 0) {
    return k === 0 ? "Nothing to discard, and no new versions will be kept." : null;
  }
  const versions = n === 1 ? "1 version" : `${n} versions`;
  const tail = k === 0 ? " No new versions will be kept." : "";
  return `Keeping ${k} will remove ${versions} now.${tail}`;
}

export interface StorageRow {
  key: "notebooks" | "sketches" | "documents" | "bin" | "versions";
  label: string;
  hint: string;
  bytes: number;
}

/**
* Names and orders the five lines only; they partition `used_bytes` (bin
* included), and re-deriving a figure would second-guess the meter.
*/
export function storageRows(byKind: StorageByKind): StorageRow[] {
  return [
    { key: "notebooks", label: "Notebooks", hint: ".note", bytes: byKind.notebookBytes },
    { key: "sketches", label: "Sketches", hint: ".spd", bytes: byKind.sketchBytes },
    { key: "documents", label: "Documents", hint: "PDF, EPUB, text, images", bytes: byKind.documentBytes },
    // The one line whose remedy is a click away.
    { key: "bin", label: "Recycle bin", hint: "freed by emptying it", bytes: byKind.binBytes },
    { key: "versions", label: "Versions", hint: "kept copies of edited files", bytes: byKind.versionBytes },
  ];
}

/**
* The absence is the common case: `users.password_changed_at` only records
* from the day it was added, so it reads "No change recorded yet", not "Never".
*/
export function passwordAgeLabel(changedAt: number | null, now: number = Date.now()): string {
  if (changedAt === null || !Number.isFinite(changedAt) || changedAt <= 0) return "No change recorded yet";
  return `Last changed ${relativeTime(changedAt * 1000, now)}`;
}

/** Excludes this browser: it answers "is anyone else in my account?". */
export function otherSessionsLabel(count: number): string {
  if (count <= 0) return "No other browsers are signed in";
  return count === 1 ? "1 other browser signed in" : `${count} other browsers signed in`;
}

/**
* "Seen", not "synced": the server has the device's last request, usually but
* not always a sync. Null means never seen.
*/
export function deviceSeenLabel(device: MyDevice, now: number = Date.now()): string {
  if (device.lastSeenAt === null) return "not seen since it was linked";
  return `last seen ${relativeTime(device.lastSeenAt * 1000, now)}`;
}

export function thisBrowserLabel(since: number | null, now: number = Date.now()): string {
  if (since === null || !Number.isFinite(since) || since <= 0) return "Signed in here";
  return `Signed in here since ${relativeTime(since * 1000, now)}`;
}

/** `ApiError` text (including `NOT_IMPLEMENTED`) passes through, naming what's missing. */
export function failureMessage(e: unknown): string {
  if (e instanceof RateLimitError) return "Too many attempts. Wait a moment and try again.";
  if (e instanceof ApiError) return e.message;
  return "Something went wrong. Try again.";
}

/**
* Stated before the change. `revokeAllSessions` also kills the Supernote's
* session, and it can't sign back in until the new password is typed on it
* (the binding survives). Names the device, and only when one is bound.
*/
export function passwordChangeConsequence(devices: readonly MyDevice[]): string {
  const browsers = "Other browsers are signed out too; this one stays signed in.";
  // `myDevices` already drops revoked bindings.
  if (devices.length === 0) return "Your other browsers will be signed out. This one stays signed in.";
  if (devices.length === 1) {
    const it = devices[0]!.name || devices[0]!.equipmentNo;
    return `${it} will stop syncing until you enter the new password on the device. ${browsers}`;
  }
  return `Your ${devices.length} devices will stop syncing until you enter the new password on each. ${browsers}`;
}

export function passwordFailureMessage(e: unknown): string {
  if (e instanceof RateLimitError) return "Too many attempts. Wait a moment and try again.";
  if (e instanceof ApiError && e.code === "INVALID_CREDENTIALS") {
    return "That isn't your current password.";
  }
  if (e instanceof ApiError && e.code === "SAME_PASSWORD") {
    return "Choose a password different from your current one.";
  }
  if (e instanceof ApiError) return e.message;
  return "Something went wrong. Try again.";
}
