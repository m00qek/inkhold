// What the console says about backups, as pure text: the library's notice and
// the Server panel's card and per-directory lines. Times are epoch seconds from
// the server; `nowMs` is injectable for tests.

import type { AdminBackups, BackupNotice, BackupRun } from "../../api/adminTypes";
import { formatBytes } from "../../core/fileKind";
import { relativeTime } from "../../ui/relativeTime";

/** The command a household runs; the README has the rest. */
export const BACKUP_COMMAND = "inkhold backup create <dir> --keep=7";

const ago = (atSeconds: number | null, nowMs: number): string =>
  atSeconds === null ? "at an unknown time" : relativeTime(atSeconds * 1000, nowMs);

/** The library notice's sentence, or null when there is nothing to say. */
export function backupNoticeText(n: BackupNotice, nowMs: number = Date.now()): string | null {
  switch (n.kind) {
    case "none":
      return null;
    case "failed":
      return (
        `The last backup${n.dir ? ` to ${n.dir}` : ""} failed ${ago(n.at, nowMs)}` +
        (n.message ? `: ${n.message}` : ".")
      );
    case "late":
      return `The last backup was ${ago(n.at, nowMs)}${n.dir ? `, to ${n.dir}` : ""}. Is the scheduled one still running?`;
    case "never":
      return "Nothing has been backed up yet: your notes live only on this server and the tablets.";
  }
}

/** The Server panel's Backups card. */
export function backupsCard(b: AdminBackups, nowMs: number = Date.now()): { value: string; sub: string } {
  const newest = newestSuccess(b.runs);
  switch (b.notice.kind) {
    case "failed":
      return { value: "Failing", sub: b.notice.message ?? `the last run to ${b.notice.dir ?? "a directory"} failed` };
    case "never":
      return { value: "None yet", sub: `run ${BACKUP_COMMAND} on the server` };
    case "late":
      return { value: ago(b.notice.at, nowMs), sub: `newest backup, older than ${b.warnAfterHours} hours` };
    case "none":
      if (!newest) return { value: "Elsewhere", sub: "you said you back up another way" };
      return { value: ago(newest.lastOkAt, nowMs), sub: snapshotLine(newest) };
  }
}

/** One directory's line in the panel: what last happened there. */
export function backupRunLine(r: BackupRun, nowMs: number = Date.now()): { ok: boolean; detail: string } {
  if (r.lastError !== null) return { ok: false, detail: `failed ${ago(r.lastRunAt, nowMs)}: ${r.lastError}` };
  if (r.verifyError !== null) return { ok: false, detail: `check failed ${ago(r.verifiedAt, nowMs)}: ${r.verifyError}` };
  if (r.lastOkAt === null) return { ok: true, detail: `checked ${ago(r.verifiedAt, nowMs)}, no backup recorded` };
  const checked = r.verifiedAt !== null ? `, checked ${ago(r.verifiedAt, nowMs)}` : "";
  // The directory is the row's own first column; not repeated here.
  const size = sizeLine(r);
  return { ok: true, detail: `backed up ${ago(r.lastOkAt, nowMs)}${checked}${size ? ` · ${size}` : ""}` };
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
