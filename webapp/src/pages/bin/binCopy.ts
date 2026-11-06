// The bin's words and rows: grouping by day, confirmations and result messages. No DOM.

import { pinAspect } from "../../ui/tileAspect";
import { labelPathSegments } from "../rail/railPlaces";
import { formatBytes } from "../../core/fileKind";
import { type Bin, type BinEntry, type Restored, type Trashed } from "../../core/binTypes";
import { type Id } from "../../core/types";

const DAY_MS = 24 * 60 * 60 * 1000;

const SOON_DAYS = 5;

/** False when the entry states no shape; the caller may use the dims memo. */
export function preclampAspect(tile: HTMLElement, entry: BinEntry): boolean {
  const a = entry.thumbAspect;
  if (!a || !(a.w > 0) || !(a.h > 0)) return false;
  pinAspect(tile, a.w / a.h, true);
  return true;
}

/**
* Trashing removes the file from the device at the next sync; the bin keeps
* only the server copy. Said on the undo toast, at the moment it matters.
*/
export const DEVICE_LINE = "Also comes off your Supernote at the next sync.";

export function plural(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`;
}

function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Calendar days, not 24-hour blocks, so headings agree with the wall clock. */
function daysBetween(from: number, to: number): number {
  return Math.max(0, Math.round((dayStart(to) - dayStart(from)) / DAY_MS));
}

function timeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function dayAndTime(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${timeOfDay(ms)}`;
}

export function groupLabel(deletedAt: number, now: number): string {
  const days = daysBetween(deletedAt, now);
  if (days === 0) return "Deleted today";
  if (days === 1) return "Deleted yesterday";
  return `Deleted ${days} days ago`;
}

/**
* `fanout` and `bytes` describe the subtree, computed once so the dialog and
* the list agree.
*/
export interface BinRow {
  entry: BinEntry;
  child: boolean;
  group: string;
  /** The "deleted twice" tiebreak. */
  time: string;
  daysLeft: number;
  soon: boolean;
  detail: string;
  /** Folders aren't clickable: their contents are listed beneath them. */
  openable: boolean;
  fanout: number;
  /** Folders contribute 0; see `BinEntry.size`. */
  bytes: number;
}

/**
* Newest first with each trashed subtree kept together under its root's date
* heading: the device sends a folder delete as separate per-entity requests,
* children first. Orphans (parent purged or restored mid-flight) are promoted
* to roots, never dropped.
*/
export function binRows(bin: Bin, now: number = Date.now()): BinRow[] {
  const present = new Set(bin.entries.map((e) => e.id));
  const childrenOf = new Map<Id, BinEntry[]>();
  for (const e of bin.entries) {
    if (e.parentId === null || !present.has(e.parentId)) continue;
    const list = childrenOf.get(e.parentId);
    if (list) list.push(e);
    else childrenOf.set(e.parentId, [e]);
  }

  function subtree(entry: BinEntry): BinEntry[] {
    const out = [entry];
    for (const child of childrenOf.get(entry.id) ?? []) out.push(...subtree(child));
    return out;
  }

  const rows: BinRow[] = [];
  const emit = (entry: BinEntry, group: string, child: boolean): void => {
    const below = subtree(entry);
    const elapsed = daysBetween(entry.deletedAt, now);
    const daysLeft = Math.max(0, bin.retentionDays - elapsed);
    rows.push({
      entry,
      child,
      group,
      time: daysBetween(entry.deletedAt, now) === 0 ? timeOfDay(entry.deletedAt) : dayAndTime(entry.deletedAt),
      daysLeft,
      soon: daysLeft <= SOON_DAYS,
      detail: detailOf(entry, below.length - 1),
      openable: entry.kind !== "folder",
      fanout: below.length,
      bytes: below.reduce((n, e) => n + e.size, 0),
    });
    for (const c of childrenOf.get(entry.id) ?? []) emit(c, group, true);
  };

  for (const entry of bin.entries) {
    if (!entry.isRoot && entry.parentId !== null && present.has(entry.parentId)) continue;
    emit(entry, groupLabel(entry.deletedAt, now), false);
  }
  return rows;
}

function detailOf(entry: BinEntry, descendants: number): string {
  if (entry.kind === "folder") return descendants === 0 ? "folder" : `folder · ${plural(descendants, "item")}`;
  const type = (entry.fileType || "file").toUpperCase();
  return `${type} · ${formatBytes(entry.size)}`;
}

// ---- the sentences ----

/** Not "Are you sure?": the title and `action` name the object and the act. */
export interface ConfirmSpec {
  title: string;
  body: string;
  frees: string | null;
  /** Never "OK" or "Yes". */
  action: string;
}

export function purgeConfirm(row: BinRow): ConfirmSpec {
  const inside = row.fanout - 1;
  return {
    title: `Delete ${row.entry.name} permanently?`,
    // Fanout stated only when it exceeds the selection.
    body:
      inside > 0
        ? `Deletes the folder and the ${plural(inside, "item")} inside it. This can’t be undone.`
        : "This can’t be undone.",
    frees: row.bytes > 0 ? formatBytes(row.bytes) : null,
    action: "Delete permanently",
  };
}

export function emptyConfirm(bin: Bin): ConfirmSpec {
  return {
    title: `Delete all ${plural(bin.entries.length, "item")} permanently?`,
    body: "Empties the recycle bin. This can’t be undone.",
    // The server's total sums files only; summing rows would double-count folders.
    frees: bin.totalBytes > 0 ? formatBytes(bin.totalBytes) : null,
    action: "Empty bin",
  };
}

/**
* What restore did, not what was asked: trashed ancestors brought back,
* descendants returned with a folder, and any forced auto-rename.
*/
export function restoreMessage(r: Restored): string {
  const parts: string[] = [r.renamed ? `Restored as ${r.name}` : `Restored ${r.name}`];
  if (r.descendants > 0) parts.push(`with the ${plural(r.descendants, "item")} inside it`);
  if (r.ancestors > 0) parts.push(`also restored ${plural(r.ancestors, "folder")}`);
  return `${parts.join(" · ")} — back on your Supernote at the next sync`;
}

export function trashMessage(t: Trashed): string {
  const inside = t.entries - 1;
  return inside > 0
    ? `Moved ${t.name} and the ${plural(inside, "item")} inside it to Recycle bin`
    : `Moved ${t.name} to Recycle bin`;
}

/**
* The server `path` minus the entry's own trailing name, flattened and
* labelled the way the rail names folders.
*/
export function folderLabel(path: string, name: string): string {
  const segments = path.split("/").filter(Boolean);
  // Only the trailing segment: `/NOTE/Note/Work/Work` keeps its parent.
  if (segments[segments.length - 1] === name) segments.pop();
  const shown = labelPathSegments(segments);
  return shown.length > 0 ? shown.join(" / ") : "Library";
}

export function emptyStateBody(retentionDays: number): string {
  return `Notes you delete — here or on your Supernote — wait here for ${retentionDays} days before they’re removed for good.`;
}
