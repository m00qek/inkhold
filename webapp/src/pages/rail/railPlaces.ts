// The places the rail is made of, as data: the device's categories (found by
// folder name, the `NOTE`/`DOCUMENT` containers flattened away) and the
// destinations that are no folder (bin, To-Do, admin), with the path
// vocabulary they give the breadcrumb and the bin. No DOM, no tree walk; the
// controller that turns them into rows is `rail.ts`.

import type { IconName } from "../../ui/icons";
import type { DestinationKey } from "../../core/destinations";
import type { Folder, Id } from "../../core/types";

/**
* A rail anchor: a device category resolved to the user's real folder by name,
* with the `NOTE`/`DOCUMENT` containers flattened away. All six always render;
* the device creates them lazily, so an unresolved one is an empty category,
* not an error. `path[0]` names are hidden from the "Other" group.
*/
export interface Category {
  label: string;
  icon: IconName;
  /** Device path segments from root, matched by name (case-exact). */
  path: string[];
  /** Gallery copy when the folder doesn't exist yet; a fact, not a failure. */
  pending: string;
  /**
  * True only for `NOTE/MyStyle`, where the device reads page templates; uploads
  * there become "add a template". Callers ask `categoryFor`, never match names.
  */
  templates?: boolean;
}

export const CATEGORIES: Category[] = [
  { label: "Note", icon: "note", path: ["NOTE", "Note"], pending: "Notebooks you write on the device will appear here after a sync." },
  { label: "Document", icon: "doc", path: ["DOCUMENT", "Document"], pending: "PDFs and documents you open on the device will appear here after a sync." },
  { label: "MyStyle", icon: "layers", path: ["NOTE", "MyStyle"], pending: "Templates you save on the device will appear here after a sync.", templates: true },
  { label: "Export", icon: "export", path: ["EXPORT"], pending: "Nothing has been exported on the device yet. Exports will appear here after a sync." },
  { label: "Screenshot", icon: "image", path: ["SCREENSHOT"], pending: "Screenshots you take on the device will appear here after a sync." },
  { label: "Inbox", icon: "inbox", path: ["INBOX"], pending: "Files sent to the device's inbox will appear here after a sync." },
];

/** Root folder names a category claims, hidden from the rail's "Other" group. */
export const KNOWN_ROOT_NAMES = new Set(CATEGORIES.map((c) => c.path[0]!));

/**
* Root folders flattened away (first segment of a multi-segment category).
* Derived, not hardcoded. Single-segment categories (`EXPORT` etc.) are the
* category itself and must not be flattened.
*/
export const CONTAINER_NAMES = new Set(CATEGORIES.filter((c) => c.path.length > 1).map((c) => c.path[0]!));

/**
* Root-gallery id for an anchor with no folder yet. A synthetic id rather than
* a new `Entry` kind; real ids are numbers, so it can't collide. Consumers ask
* `pendingCategoryOf` first.
*/
const PENDING_ID_PREFIX = "pending-category:";

export function pendingCategoryFolder(cat: Category): Folder {
  // `itemCount` omitted, not 0: 0 would render "Empty" for an uncounted folder.
  return { kind: "folder", id: `${PENDING_ID_PREFIX}${cat.label}` as Id, name: cat.label };
}

export function categoryForPendingId(id: Id): Category | null {
  if (typeof id !== "string" || !id.startsWith(PENDING_ID_PREFIX)) return null;
  const label = id.slice(PENDING_ID_PREFIX.length);
  return CATEGORIES.find((c) => c.label === label) ?? null;
}

/**
* A plain-segment device path (e.g. a trashed entry's) in rail vocabulary.
* Longest category prefix wins, since `NOTE/Note` and `NOTE/MyStyle` overlap.
*
* @param segments Folder names from the root, without a file name.
* @returns The segments to show; empty means the root itself.
*/
export function labelPathSegments(segments: readonly string[]): string[] {
  let best: Category | null = null;
  for (const cat of CATEGORIES) {
    if (cat.path.length > segments.length) continue;
    if (!cat.path.every((seg, i) => seg === segments[i])) continue;
    if (best === null || cat.path.length > best.path.length) best = cat;
  }
  if (best !== null) return [best.label, ...segments.slice(best.path.length)];
  // A bare container still goes: the rail shows `NOTE/Whatever` as `Whatever`.
  if (segments.length > 0 && CONTAINER_NAMES.has(segments[0]!)) return segments.slice(1);
  return [...segments];
}

/**
* A server path with container segments removed (`Library / Note`, not
* `NOTE / Note`). Client-side so the wire format keeps the truth. Only at
* index 0 (a nested user `NOTE` is real), and never the last segment.
*/
export function crumbPath(path: readonly Folder[]): Folder[] {
  return path.filter((f, i) => !(i === 0 && i < path.length - 1 && CONTAINER_NAMES.has(f.name)));
}

/**
* A rail entry with no device folder behind it (bin, admin console); exists
* whether or not the device ever synced.
*/
export interface Destination {
  /** Declared in `core/destinations.ts` so the router needn't import this file. */
  key: DestinationKey;
  label: string;
  icon: IconName;
  /** Hidden from non-admins; a door, not a lock (the server gates admin routes). */
  adminOnly?: boolean;
  /** The tablet's apps (To-Do) get their own "Apps" group; the rest sit under "Other". */
  group?: "apps";
}

export const DESTINATIONS: Destination[] = [
  // Under "Other": it isn't a folder (nothing moves in, it doesn't sync).
  { key: "bin", label: "Recycle bin", icon: "trash" },
  // The tablet's to-dos; shown only while the server keeps them (`destinationShown`).
  { key: "todo", label: "To-Do", icon: "todo", group: "apps" },
  // No count: a badge here would be a stat about housemates.
  { key: "admin", label: "Admin", icon: "users", adminOnly: true },
];
