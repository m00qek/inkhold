// What the console says about backups, as pure text: the library's notice and
// the Server panel's card and per-directory lines. Times are epoch seconds from
// the server; `nowMs` is injectable for tests. Relative times are what is
// shown; the exact one goes in a title, as the history panel does.

import type { AdminBackups, BackupNotice, BackupNoticeKind, BackupRun } from "../../api/adminTypes";
import { formatBytes } from "../../core/fileKind";
import { absoluteTime, relativeTime } from "../../ui/relativeTime";

/** The command a household runs; the README has the rest. */
export const BACKUP_COMMAND = "inkhold backup create <dir> --keep=7";

const ago = (atSeconds: number | null, nowMs: number): string =>
  atSeconds === null ? "at an unknown time" : relativeTime(atSeconds * 1000, nowMs);

/** The exact time behind a relative one, for a title; null when unknown. */
export function exactTime(atSeconds: number | null): string | null {
  return atSeconds === null ? null : absoluteTime(atSeconds * 1000);
}

/**
 * The app's two tints: a failure or a stalled schedule is danger (the
 * margin's red); "nothing yet" is information, an invitation to act.
 */
export function noticeTone(kind: BackupNoticeKind): "danger" | "info" | null {
  if (kind === "failed" || kind === "late") return "danger";
  return kind === "never" ? "info" : null;
}

/** The library notice's sentence, or null when there is nothing to say. */
export function backupNoticeText(n: BackupNotice, nowMs: number = Date.now()): string | null {
  switch (n.kind) {
    case "none":
      return null;
    case "failed": {
      // The command's message usually names the folder already; say it once.
      const where = n.dir && !(n.message ?? "").includes(n.dir) ? ` to ${n.dir}` : "";
      return `The last backup${where} failed ${ago(n.at, nowMs)}` + (n.message ? `: ${n.message}` : ".");
    }
    case "late":
      return `The last backup was ${ago(n.at, nowMs)}${n.dir ? `, to ${n.dir}` : ""}. Is the scheduled one still running?`;
    case "never":
      return "Nothing has been backed up yet: your notes live only on this server and the tablets.";
  }
}

/** The Server panel's Backups card; `danger` paints the value like an overfull meter. */
export function backupsCard(b: AdminBackups, nowMs: number = Date.now()): { value: string; sub: string; danger: boolean } {
  switch (b.notice.kind) {
    case "failed": {
      const failing = b.runs.filter((r) => runStatus(r) !== "ok").length;
      const of = b.runs.length;
      return { value: "Failing", sub: of > 1 ? `${failing} of ${of} folders failing` : "its last run failed", danger: true };
    }
    case "late":
      return { value: ago(b.notice.at, nowMs), sub: `newest backup, older than ${b.warnAfterHours} hours`, danger: true };
    case "never":
      return { value: "None yet", sub: "no backup recorded", danger: false };
    case "none": {
      const newest = newestSuccess(b.runs);
      if (!newest) return { value: "Elsewhere", sub: "you back up another way", danger: false };
      return { value: ago(newest.lastOkAt, nowMs), sub: snapshotLine(newest), danger: false };
    }
  }
}

export type RunStatus = "ok" | "failed" | "check-failed";

export function runStatus(r: BackupRun): RunStatus {
  if (r.lastError !== null) return "failed";
  return r.verifyError !== null ? "check-failed" : "ok";
}

/**
 * One directory's line: a chip for trouble (the console's status vocabulary,
 * like a pending password), a plain sentence, and the exact time and snapshot
 * for its title.
 */
export function backupRunLine(
  r: BackupRun,
  nowMs: number = Date.now(),
): { status: RunStatus; chip: string | null; detail: string; title: string | null } {
  const status = runStatus(r);
  if (status === "failed") {
    return { status, chip: "Failing", detail: `${r.lastError}, ${ago(r.lastRunAt, nowMs)}`, title: titled("Tried", r.lastRunAt, null) };
  }
  if (status === "check-failed") {
    return { status, chip: "Check failed", detail: `${r.verifyError}, ${ago(r.verifiedAt, nowMs)}`, title: titled("Checked", r.verifiedAt, null) };
  }
  if (r.lastOkAt === null) {
    return { status, chip: null, detail: `checked ${ago(r.verifiedAt, nowMs)}, no backup recorded`, title: titled("Checked", r.verifiedAt, null) };
  }
  const checked = r.verifiedAt !== null ? `, checked ${ago(r.verifiedAt, nowMs)}` : "";
  // The directory is the row's own first column; not repeated here.
  const size = sizeLine(r);
  return {
    status,
    chip: null,
    detail: `backed up ${ago(r.lastOkAt, nowMs)}${checked}${size ? ` · ${size}` : ""}`,
    title: titled("Backed up", r.lastOkAt, r.snapshot),
  };
}

/** `Backed up 4 Nov 2026, 03:00 · snapshot 2026-11-04T030000Z`: what `inkhold restore` takes. */
function titled(what: string, atSeconds: number | null, snapshot: string | null): string | null {
  const when = exactTime(atSeconds);
  if (!when) return null;
  return snapshot ? `${what} ${when} · snapshot ${snapshot}` : `${what} ${when}`;
}

/** On the card, which shows no directory, the size says where. */
function snapshotLine(r: BackupRun): string {
  const size = sizeLine(r);
  return size ? `${size} in ${r.dir}` : r.dir;
}

function sizeLine(r: BackupRun): string {
  const parts: string[] = [];
  if (r.files !== null) parts.push(`${r.files.toLocaleString("en-GB")} ${r.files === 1 ? "file" : "files"}`);
  if (r.bytes !== null) parts.push(formatBytes(r.bytes));
  return parts.join(", ");
}

function newestSuccess(runs: BackupRun[]): BackupRun | null {
  let best: BackupRun | null = null;
  for (const r of runs) if (r.lastOkAt !== null && (best === null || r.lastOkAt > best.lastOkAt!)) best = r;
  return best;
}
