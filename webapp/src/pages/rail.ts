// The library's left rail, and the tree/category resolution the whole app's
// navigation model rests on — split out of library.ts the same way ocrPanel.ts
// is split out of reader.ts: all of the resolution and state logic with the DOM
// injected as a {@link RailView}, so it is exercisable on plain Node while
// library.ts keeps only the wiring.
//
// WHAT THIS FILE IS FOR, beyond making library.ts shorter. The rail is the one
// surface every new console wants a row in, and while it lived inside an
// 1800-line file that also owned the gallery, the search results and the failure
// sink, two features adding a row meant two large diffs in one place. So the rail
// is DATA HERE, not code: {@link CATEGORIES} is the list, the controller turns
// it into {@link RailRow}s, and {@link createRailView} paints rows. Adding a row
// is a line in the list; nothing in the painter knows what a category is.
//
// It also owns the CONTAINER FLATTENING, which is not a rail detail: the rail,
// the breadcrumb (`crumbPath`) and the root gallery (`rootEntries`) have to agree
// about what the tree looks like, and the app once ran two models of it — the
// rail flattened `NOTE`/`DOCUMENT` away, the other two did not, so a note inside
// `NOTE/Note` read `Library / NOTE / Note` and named a folder the rail never
// showed. One model, one file.

import { el } from "../ui/dom";
import { ICONS, svg, type IconName } from "../ui/icons";
import type { Entry, Folder, Id } from "../core/types";

/**
 * The rail is anchored in the Supernote's own top-level categories rather than
 * the raw folder tree. The device ships a fixed default tree whose *container*
 * folders (`NOTE`, `DOCUMENT`) are noise — their meaningful children (`Note`,
 * `MyStyle`, `Document`) are what a user thinks of as categories. So each anchor
 * is a fixed `{label, icon, path}` that we resolve to the user's real folder (by
 * walking the tree by name), flattening the containers away and matching the
 * approved mockup's clean six-entry rail.
 *
 * ALL SIX ARE ALWAYS RENDERED, resolved or not. The device creates these folders
 * lazily, so before a first sync several genuinely do not exist — and a rail that
 * grew an entry each time the device happened to write a folder would be a
 * different shape every week, with no way to learn where anything lives. An
 * unresolved category is not an error state and must not look like one: it is a
 * category with nothing in it yet, so it renders with a `0`, stays focusable, and
 * on selection shows `pending` in the gallery instead of requesting a listing for
 * an id that does not exist. See {@link RailController.pending}.
 *
 * `path[0]` is also the set of "known" root names we hide from the custom-folder
 * ("Other") group, so pinning a category never makes a real folder appear twice.
 */
export interface Category {
  label: string;
  icon: IconName;
  /** Device path segments from root, matched by folder name (case-exact). */
  path: string[];
  /**
   * What the gallery says when this category has no folder yet. Written as a
   * fact about the device, never as a failure — nothing has gone wrong, the
   * folder simply has not been created on the device yet.
   */
  pending: string;
  /**
   * This category's folder is where the DEVICE reads page TEMPLATES from — true
   * for exactly one anchor, `NOTE/MyStyle`.
   *
   * A CAPABILITY STATED AS DATA, beside the rest of the category, rather than a
   * name test at the call site. It is the one meaningful placement rule the
   * device has (docs/scratch/upload.md §4): an image or PDF is usable as a
   * template only if it sits here, which turns dropping one in from a generic
   * upload into "add a template" — different dropzone copy, a different toast.
   * Callers ask {@link RailController.categoryFor} and read this flag, so
   * "which folder IS MyStyle" stays the one identity resolution this module
   * already owns and never becomes a string comparison somewhere else.
   */
  templates?: boolean;
}

/**
 * THE RAIL, AS DATA. One line per anchor, in the order they are painted.
 *
 * Everything downstream is derived: the resolution walk, the "known root names"
 * that keep a real folder from appearing twice, the container set that drives
 * the breadcrumb and the root listing, and the rows themselves. Adding a
 * category is this list plus nothing.
 */
export const CATEGORIES: Category[] = [
  { label: "Note", icon: "note", path: ["NOTE", "Note"], pending: "Notebooks you write on the device will appear here after a sync." },
  { label: "Document", icon: "doc", path: ["DOCUMENT", "Document"], pending: "PDFs and documents you open on the device will appear here after a sync." },
  { label: "MyStyle", icon: "layers", path: ["NOTE", "MyStyle"], pending: "Templates you save on the device will appear here after a sync.", templates: true },
  { label: "Export", icon: "export", path: ["EXPORT"], pending: "Nothing has been exported on the device yet. Exports will appear here after a sync." },
  { label: "Screenshot", icon: "image", path: ["SCREENSHOT"], pending: "Screenshots you take on the device will appear here after a sync." },
  { label: "Inbox", icon: "inbox", path: ["INBOX"], pending: "Files sent to the device's inbox will appear here after a sync." },
];

/** Root folder names owned by a category (as anchor or flattened container). */
const KNOWN_ROOT_NAMES = new Set(CATEGORIES.map((c) => c.path[0]!));

/**
 * The device's CONTAINER folders — the ones the rail calls noise and flattens
 * away, promoting their meaningful children (`NOTE` → `Note`, `MyStyle`;
 * `DOCUMENT` → `Document`).
 *
 * DERIVED, never hardcoded: a root folder is a container iff it is the first
 * segment of a category path with MORE THAN ONE segment. That is exactly what
 * "this folder is a wrapper around the thing the user means" says in data, so
 * adding a category later cannot leave a stale list behind.
 *
 * It must not catch `EXPORT`, `SCREENSHOT` or `INBOX`: those are single-segment
 * categories — they ARE the category, not a wrapper around one — and flattening
 * them would promote their notes to the root and delete the folders from the UI.
 *
 * This set is the whole of the fix for the seam the app used to have, where the
 * rail flattened and the breadcrumb and root gallery did not, so navigating into
 * notes read `Library / NOTE / Note` and named a folder the rail never showed.
 */
export const CONTAINER_NAMES = new Set(CATEGORIES.filter((c) => c.path.length > 1).map((c) => c.path[0]!));

/**
 * The id a category anchor carries in the ROOT GALLERY while it has no folder
 * behind it yet — the gallery's equivalent of the rail's unresolved row.
 *
 * A synthetic id rather than a new `Entry` kind: the gallery's render loop, its
 * folder/note split and its card renderer all key off `kind`, and a third kind
 * would ripple through every one of them to express "a folder card, but its
 * folder does not exist yet". The prefix is not a device-reachable name (a real
 * id is a number from the server), so it cannot collide, and every consumer that
 * must not treat it as a real folder asks `pendingCategoryOf` first.
 */
const PENDING_ID_PREFIX = "pending-category:";

function pendingCategoryFolder(cat: Category): Folder {
  // `itemCount` is deliberately OMITTED, not 0: nothing has been counted yet, and
  // `itemCountLabel` renders 0 as the word "Empty" — a confident lie about a
  // folder still being fetched, which is worse than the reflow this stand-in
  // exists to remove. An absent count renders no meta line at all, which is what
  // "not counted yet" honestly looks like.
  return { kind: "folder", id: `${PENDING_ID_PREFIX}${cat.label}` as Id, name: cat.label };
}

/** The category behind a {@link pendingCategoryFolder} id, or null for a real folder. */
function categoryForPendingId(id: Id): Category | null {
  if (typeof id !== "string" || !id.startsWith(PENDING_ID_PREFIX)) return null;
  const label = id.slice(PENDING_ID_PREFIX.length);
  return CATEGORIES.find((c) => c.label === label) ?? null;
}

/**
 * A device path, in the vocabulary the rail shows — the SAME model the rail, the
 * breadcrumb and the root gallery already share, extended to a path that arrives
 * as plain segments rather than as resolved folders.
 *
 * The recycle bin needs this: a trashed entry's path is reconstructed on the
 * server from the tree it was deleted from, so it names the device's real
 * folders (`NOTE`, `Note`) and no `Folder` object survives to run `labelFor`
 * against. Rendering it raw brings back exactly the defect this file's header
 * records — a note in `NOTE/Note` reading `NOTE / Note`, naming a container the
 * rail never shows.
 *
 * LONGEST category prefix wins, because the categories overlap: `NOTE/Note` and
 * `NOTE/MyStyle` share a first segment, so matching the shortest would label
 * every one of them "Note".
 *
 * @param segments Folder names from the root, WITHOUT a trailing file name.
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
  // No category owns it. A bare container still has to go: `NOTE/Whatever` is
  // shown by the rail as `Whatever`, and the bin must not disagree.
  if (segments.length > 0 && CONTAINER_NAMES.has(segments[0]!)) return segments.slice(1);
  return [...segments];
}

/**
 * A server path with the device's container segments removed, so it says
 * `Library / Note` where the server said `NOTE / Note`.
 *
 * A PRESENTATION FILTER, deliberately client-side. `listing.path` is the
 * server's truthful answer about the real tree and stays that way; flattening
 * is a decision about how this UI names things, and pushing it into the backend
 * would bake one client's navigation model into the wire format.
 *
 * EXPORTED, and the only copy. The breadcrumb is not the only caller — the
 * reader's origin subtitle and the search results' folder column ask the same
 * question about a path they did not navigate to — and the flattening rule has
 * to be the rail's rule or the seam this file exists to close reopens somewhere
 * else. The breadcrumb's *rendering* stays in library.ts, where its other inputs
 * (the search query, the pending category) live; only the resolution is here.
 *
 * TWO GUARDS on what counts as a container segment:
 *
 *  - only at INDEX 0 — a container name is a root-folder fact, and a user's own
 *    deeply-nested folder that happens to be called `NOTE` is not noise;
 *  - never when it is the LAST segment. If you are standing IN the container,
 *    it is where you are, and dropping it would leave the breadcrumb saying
 *    "Library" while the gallery showed something else. See `navigate` in
 *    library.ts for how you can end up there.
 */
export function crumbPath(path: readonly Folder[]): Folder[] {
  return path.filter((f, i) => !(i === 0 && i < path.length - 1 && CONTAINER_NAMES.has(f.name)));
}

// --- the seams ---------------------------------------------------------------

/**
 * Read-only access to the shell's cached folder tree. The rail is a PURE
 * FUNCTION of this plus {@link RailDeps.place} — it holds no listings of its own
 * and issues no requests, which is what keeps `prefetchTree` the single thing
 * that talks to the server about folders.
 */
export interface FolderTree {
  /** The device's top-level folders, from the root listing. */
  roots(): readonly Folder[];
  /**
   * A folder's immediate subfolders, from its cached listing. EMPTY when the
   * walk has not reached it yet — indistinguishable here from a folder with no
   * subfolders, which is fine: `prefetchTree` rebuilds the rail when it lands.
   */
  children(id: Id): readonly Folder[];
  /**
   * Has this folder's listing been fetched? Distinct from `children(id).length
   * === 0` and load-bearing for exactly one case — see {@link RailController.rootEntries},
   * where a container we have not walked yet must be emitted as itself rather
   * than silently vanishing.
   */
  walked(id: Id): boolean;
}

/** Where the user currently is, for the open branch and `aria-current`. */
/**
 * A rail entry with NO device folder behind it — the recycle bin, the admin
 * console. Categories cannot express these: a {@link Category} is resolved by
 * walking the device tree, and these exist whether or not the Nomad has ever
 * synced.
 *
 * Same contract as {@link CATEGORIES}: this is DATA. Adding a destination is a
 * line in {@link DESTINATIONS}; the shell routes on {@link Destination.key} and
 * the painter is untouched.
 */
export interface Destination {
  /** Stable id the shell routes on. Never shown. */
  key: string;
  label: string;
  icon: IconName;
  /**
   * Hidden from non-admins. A rail row is not a security boundary — the server
   * gates every admin route on `require_admin` AND a live elevation — but
   * showing a door that always refuses is worse than not showing it.
   */
  adminOnly?: boolean;
}

/**
 * One line per destination, exactly as {@link CATEGORIES} is one line per
 * anchor; nothing in the producer or the painter knows what any of them is.
 */
export const DESTINATIONS: Destination[] = [
  // The bin sits under "Other" rather than among the folders because it is not
  // one: nothing can be moved into it and it does not sync, and presenting it as
  // a folder invites both misconceptions. Not `adminOnly` — a household member's
  // bin is their own data, so there is nothing to elevate for.
  { key: "bin", label: "Recycle bin", icon: "trash" },
  // The admin console. `adminOnly` hides it from a household member who could
  // never get past the server's `require_admin` anyway — the row is a door, not
  // a lock. No count: the console has nothing whose number belongs on a rail
  // badge, and a badge reading "3 people" would be a stat about housemates.
  { key: "admin", label: "Admin", icon: "users", adminOnly: true },
];

export interface RailPlace {
  folderId: Id | null;
  /**
   * The {@link Destination.key} currently open, or null when the shell is in a
   * folder. Mutually exclusive with a folder: you are in one or the other, and
   * the rail highlights accordingly.
   */
  destination?: string | null;
  /**
   * The current folder's ancestors (the server's `listing.path`), or NULL when
   * there is no listing yet — in which case nothing is expanded, not even the
   * current folder.
   */
  openPath: readonly Folder[] | null;
  /**
   * Is a library-wide SEARCH what is on screen?
   *
   * The rail does not highlight anything for it (a query is not a place), but
   * {@link RailController.treeWalked} has to know: a search's NAME half is
   * matched against the same cached tree the rail resolves categories from, so
   * the gallery is a function of the walk whether the user is standing at the
   * root or three folders down. Without this, `settle()`'s `folderId === null`
   * test meant a query typed inside a subfolder never got the repaint — and its
   * "Searching…" never became an answer.
   */
  searching?: boolean;
}

/**
 * WHAT A ROW SAYS AFTER ITS NAME, as a discriminated union rather than as one
 * number.
 *
 * The rail used to carry exactly one badge channel, `count: number`, which is
 * fine while every row is a folder — but the admin console's row has to show
 * whether the session is elevated, and a padlock is NOT a count. Overloading the
 * number (0 = locked, 1 = unlocked?) would put the meaning in the painter, which
 * is the one thing this file promises never to do.
 *
 * `null` is "nothing after the name", and the DECISION IS THE PRODUCER'S, never
 * the painter's — see {@link destinationRow} for why a destination's 0 renders
 * as nothing while a folder's 0 renders as `0`.
 */
export type RailBadge =
  /** How many items are in there. `0` is a real answer; see {@link Category}. */
  | { kind: "count"; value: number }
  /**
   * A STATE glyph. `label` is its accessible name and must change WITH the
   * state — a padlock that is only a shape swap says nothing to a screen reader,
   * and WCAG's non-text rules do not accept "it looks different".
   */
  | { kind: "state"; icon: IconName; label: string };

/**
 * One painted row. Deliberately says nothing about WHY it exists: a category
 * anchor, a nested user folder and a promoted container child are all just a
 * glyph, a name, a badge, an indent and something to do when clicked. That is
 * what makes {@link createRailView} generic — a new kind of rail entry is a new
 * producer of rows, never a change to the painter.
 */
export type RailRow =
  /** A group heading (`Folders`, `Other`). Not focusable, not a control. */
  | { kind: "label"; text: string }
  | {
      kind: "item";
      icon: IconName;
      /** DEVICE-AUTHORED in general — always painted as text, never as markup. */
      name: string;
      /** Null paints nothing at all after the name. */
      badge: RailBadge | null;
      /** Indent level; 0 is a top-level row. */
      depth: number;
      current: boolean;
      select(): void;
    };

export interface RailView {
  /** Paint the rail. Replaces everything — the rail is rebuilt wholesale. */
  render(rows: readonly RailRow[]): void;
  /**
   * The rail's counts and its resolved/absent split are provisional until the
   * tree walk lands. A REAL a11y signal, not a test hook — a screen reader
   * should not announce "Export, 0" as settled while it is still being counted.
   */
  setBusy(busy: boolean): void;
}

export interface RailDeps {
  view: RailView;
  tree: FolderTree;
  place(): RailPlace;
  /** A row backed by a real folder was chosen. */
  onOpenFolder(id: Id): void;
  /**
   * A category with no folder behind it was chosen. There is no id to list, so
   * the shell paints {@link Category.pending} and fetches nothing; this callback
   * carries only the shell-level part (close the reader, clear the query,
   * repaint). The pending state itself is held here — see
   * {@link RailController.pending}.
   */
  onSelectCategory(cat: Category): void;
  /** A {@link Destination} row was chosen. The shell decides what that means. */
  onOpenDestination(key: string): void;
  /**
   * The badge for a destination — the bin's item count. Returns 0 for anything
   * with nothing to count, which the row renders as no badge at all.
   */
  destinationCount(key: string): number;
  /**
   * A destination's STATE, as a glyph and the accessible name that goes with it —
   * the admin console's padlock. Null for a destination with no state to show,
   * which is every one of them but that.
   *
   * A SEPARATE CHANNEL from {@link RailDeps.destinationCount} rather than a
   * widening of it, because they have different owners and different lifetimes:
   * a count is a fact about a listing the shell already holds, and elevation is
   * a fact the admin panel learns from the server and can lose at any moment. A
   * shell that had to answer both through one function would be re-deriving one
   * of them. The shell repaints the rail (`rail.build()`) whenever the answer
   * here changes — an out-of-date padlock is worse than no padlock.
   *
   * ASKED ONLY FOR ROWS THAT ARE PAINTED, which is what keeps elevation from
   * leaking: an `adminOnly` destination is filtered out before it can be asked
   * about (see {@link visibleDestinations}), so a household member's rail never
   * puts the question.
   */
  destinationState(key: string): { icon: IconName; label: string } | null;
  /** Whether the signed-in account may see `adminOnly` destinations. */
  isAdmin(): boolean;
  /**
   * Repaint the gallery WITHOUT rebuilding the rail, because the rail has just
   * been rebuilt. Called when the tree walk settles what was provisional.
   */
  onSettled(): void;
  /**
   * The much smaller repaint a FOLDER LISTING owes the walk: its NAMES, and
   * nothing else.
   *
   * A folder's contents are one request that never depended on the walk, so
   * {@link onSettled}'s full repaint would be pure churn there — the very churn
   * `freshness.ts` exists to avoid. What DOES depend on the walk is what those
   * contents are CALLED: `labelFor` and `categoryIconFor` resolve a category
   * anchor by identity against the walked tree, so until it lands a deep link to
   * `#/folder/<export-id>` shows the breadcrumb "Library / EXPORT" — the raw
   * device name, beside a rail row that says `Export` — and any anchor among its
   * children arrives as a plain folder card. That used to stand until some
   * unrelated event repainted, which for a bookmarked folder could be never.
   */
  onLabelsSettled(): void;
}

export interface RailController {
  /** Rebuild from the current tree and place. Cheap, idempotent. */
  build(): void;
  /**
   * What to CALL a folder on screen. A category anchor is shown by its category
   * label, not by the device's own folder name — the rail says "Export" while
   * the device calls it `EXPORT`, and a breadcrumb printing the raw name made
   * the same folder read as two different places.
   *
   * Lives here because `CATEGORIES` does: one mapping, one owner.
   */
  labelFor(folder: { id: Id; name: string }): string;
  /**
   * The GLYPH a folder gets IFF it is one of the six pinned category anchors —
   * the notebook for `Note`, the doc for `Document`, and so on — else null.
   *
   * Resolved by IDENTITY, exactly like {@link RailController.labelFor} and for
   * the same reason: a user's own folder that merely happens to be named `Note`
   * is not the resolved anchor and gets nothing. This is the whole of what scopes
   * the gallery's folder-silhouette treatment to the pinned categories alone —
   * an ordinary folder keeps its plain tile, so the special ones read as special.
   *
   * Lives here beside `labelFor` because it draws on the same `CATEGORIES` and
   * the same tree resolution: one owner for "which folder IS a category".
   */
  categoryIconFor(folder: { id: Id }): IconName | null;
  /**
   * WHICH category a folder is, or null — the full answer
   * {@link RailController.categoryIconFor} returns only the glyph of, resolved by
   * the same identity match and covering the same pending stand-ins.
   *
   * Exists because a caller can need more of the category than its icon: the
   * upload dropzone asks whether the destination is the TEMPLATE folder
   * ({@link Category.templates}), which decides both its copy and the toast. That
   * question has to be answered by this module — a folder merely NAMED `MyStyle`
   * is not the anchor, and name-matching it elsewhere would be a second, wrong
   * copy of a resolution that lives here.
   */
  categoryFor(folder: { id: Id }): Category | null;
  /**
   * The tree walk finished. Drops `aria-busy`, rebuilds, and settles a category
   * that was selected while still unresolved.
   *
   * `changed` is whether the walk MOVED anything the rail, the crumbs or
   * name-search read — the shell answers it from a signature of the tree it just
   * walked, the same "return the identical thing when nothing changed" reading
   * `freshness.ts` takes of a listing. A walk that found no difference still
   * settles a pending category (that transition is about the walk having
   * FINISHED, not about what it found) but owes the gallery no repaint.
   * Defaults to true, so a caller that cannot tell asks for the repaint.
   */
  treeWalked(changed?: boolean): void;
  /**
   * Has the walk landed? The gallery's "Loading…" / real-empty-state branch —
   * see {@link RailController.pending}.
   */
  loaded(): boolean;
  /**
   * The category the user selected that has NO folder on the device yet, or
   * null. There is no id to list, so this is the whole of that state: the
   * gallery renders `pending` and nothing is fetched.
   */
  pending(): Category | null;
  /**
   * Ordinary folder navigation happened. Clears any pending category, so it can
   * never linger over a real folder's listing.
   */
  clearPending(): void;
  /**
   * What the ROOT gallery shows, given the server's raw root listing — the same
   * things the rail shows, in the same order. ALL SIX anchors are always present:
   * one with no folder yet comes back as a stand-in (see
   * {@link RailController.pendingCategoryOf}) so the gallery's shape is settled
   * from the first paint.
   */
  rootEntries(entries: readonly Entry[]): Entry[];
  /**
   * The category behind a {@link rootEntries} stand-in — an anchor the device has
   * not created yet — or null for a real folder. A caller that would otherwise
   * treat it as a folder (navigate to its id, offer folder actions) must ask
   * this first: there is no folder to open or act on.
   */
  pendingCategoryOf(folder: Folder): Category | null;
  /**
   * Select an anchor that has no folder yet: the gallery paints
   * {@link Category.pending} and nothing is fetched. The same path the rail's own
   * unresolved row takes, so both surfaces land in one state.
   */
  selectCategory(cat: Category): void;
}

// --- the controller ----------------------------------------------------------

export function createRail(deps: RailDeps): RailController {
  const { view, tree } = deps;

  /**
   * Set when the user selected a category whose folder does NOT exist on the
   * device yet. There is no id to list, so this is the whole of the state: the
   * gallery renders `category.pending` and nothing is fetched. Cleared by every
   * ordinary navigation, so it can never linger over a real folder's listing.
   */
  let pendingCategory: Category | null = null;

  /**
   * Has the tree walk finished at least once?
   *
   * LOAD-BEARING, because the rail pins all six categories from the first paint:
   * until the walk completes, a category that has not resolved yet is
   * indistinguishable from one the device never created. Without this flag the
   * first second of every session would offer six rows that all claim to be
   * empty, and clicking one would assert "Export is empty" about a folder that
   * was merely still loading — a confident lie, which is worse than a spinner.
   */
  let treeLoaded = false;

  /** Immediate subfolders of a folder (root = the top-level folders). */
  function subfoldersOf(id: Id | null): readonly Folder[] {
    return id === null ? tree.roots() : tree.children(id);
  }

  /** Immediate subfolder of `parentId` named `name`, from cached listings. */
  function childByName(parentId: Id | null, name: string): Folder | undefined {
    return subfoldersOf(parentId).find((f) => f.name === name);
  }

  /** Walk a device path (by folder name) to the real folder, or undefined if any
   *  segment is missing from the user's tree. Relies on the ancestor listings
   *  being cached (see `prefetchTree`). */
  function resolveCategory(path: string[]): Folder | undefined {
    let parent: Id | null = null;
    let folder: Folder | undefined;
    for (const seg of path) {
      folder = childByName(parent, seg);
      if (!folder) return undefined;
      parent = folder.id;
    }
    return folder;
  }

  /**
   * How many items a folder holds, as ONE number, for every count in the rail —
   * the category rows and the nested rows alike.
   *
   * The server counts it (`FolderVO.itemCount`: direct children, live rows,
   * every kind), so there is exactly ONE counting path and the rail can never
   * disagree with the row beside it. This replaced a client-side recursive walk
   * over the cached listings, which had two problems beyond duplication: it
   * counted only `.note` entries — calling every PDF and screenshot a "note" —
   * and it returned 0 for any folder the prefetch had not reached yet, so the
   * rail under-reported until the whole tree had loaded.
   *
   * `undefined` (the server did not count this folder — a breadcrumb entry) reads
   * as 0 HERE ONLY, because a rail row must show a number. The gallery's own
   * folder rows take the opposite decision and render no meta line at all (see
   * `itemCountLabel` in library.ts): an uncounted folder must not claim to be
   * empty where there is room to say nothing.
   */
  function itemsIn(folder: Folder | undefined): number {
    return folder?.itemCount ?? 0;
  }

  /**
   * WHICH category a folder is, or null — the ONE identity resolution behind
   * `categoryFor`, `categoryIconFor` and everything downstream of them.
   *
   * A pending stand-in still IS its category (see `pendingCategoryFolder`); a
   * real folder is one only if a category path resolves to that exact id, so a
   * user's own folder named `Note` is never caught.
   */
  function categoryOf(folder: { id: Id }): Category | null {
    const pending = categoryForPendingId(folder.id);
    if (pending) return pending;
    for (const cat of CATEGORIES) {
      if (resolveCategory(cat.path)?.id === folder.id) return cat;
    }
    return null;
  }

  /** The folder each category currently resolves to, as a set of ids. */
  function categoryFolderIds(): Set<Id> {
    const ids = new Set<Id>();
    for (const cat of CATEGORIES) {
      const folder = resolveCategory(cat.path);
      if (folder) ids.add(folder.id);
    }
    return ids;
  }

  /**
   * Root-level folders that are NOT category anchors — the rail's "Other" group,
   * and the tail of the root gallery. ONE definition, used by both, which is the
   * point: the gallery listing something the rail does not (or the reverse) is
   * the seam this whole module exists to close.
   *
   * Two sources, and the second is the one that used to lose data:
   *
   *  1. folders the user made at the device's root (`Archive`);
   *  2. children of a CONTAINER that are not categories — a `NOTE/Scratch` made
   *     on the device. Flattening `NOTE` away without promoting `Scratch` would
   *     make it unreachable from anywhere in the UI. Losing a user's folder is
   *     far worse than showing an extra row, so it is promoted alongside the
   *     categories rather than dropped.
   *
   * A container we have not walked yet contributes nothing (its listing is not
   * cached); `prefetchTree` rebuilds the rail and repaints the root when it
   * lands, so the promoted rows appear then.
   */
  function otherRootFolders(): Folder[] {
    const categoryIds = categoryFolderIds();
    const out: Folder[] = [];
    for (const folder of tree.roots()) {
      if (CONTAINER_NAMES.has(folder.name)) {
        for (const child of subfoldersOf(folder.id)) if (!categoryIds.has(child.id)) out.push(child);
        continue;
      }
      // A single-segment category (EXPORT/SCREENSHOT/INBOX) is already an anchor.
      if (KNOWN_ROOT_NAMES.has(folder.name)) continue;
      out.push(folder);
    }
    return out;
  }

  /**
   * A nested (or custom top-level) folder row. Carries the SAME count as a
   * category row, from the same server-supplied field — the mockup's rail shows
   * one on every row, and a rail where only some rows are counted reads as though
   * the uncounted ones were a different kind of thing.
   */
  function folderRow(folder: Folder, depth: number, currentId: Id | null): RailRow {
    return {
      kind: "item",
      icon: "folder",
      name: folder.name,
      // ALWAYS a count, including `0`. See `itemsIn`: a folder row must show a
      // number, and a rail where only the non-empty rows are counted reads as
      // though the uncounted ones were a different kind of thing.
      badge: { kind: "count", value: itemsIn(folder) },
      depth,
      current: currentId === folder.id,
      select: () => deps.onOpenFolder(folder.id),
    };
  }

  /**
   * A top-level category anchor: mockup icon + label + its item count.
   *
   * `folder` is undefined when the device has not created this category's folder
   * yet. The row is IDENTICAL either way — no `disabled`, no dimming, no "not
   * available" — because from the user's side nothing is wrong: the category is
   * simply empty. Only what `select` does differs, and the unresolved one paints
   * the empty state without asking the server for an id that does not exist.
   */
  function categoryRow(cat: Category, folder: Folder | undefined, currentId: Id | null): RailRow {
    return {
      kind: "item",
      icon: cat.icon,
      name: cat.label,
      // A `0` here is the point of the row, not an omission: an unresolved
      // category is one the device has not created yet, and it must look like a
      // category with nothing in it rather than like a different kind of entry.
      badge: { kind: "count", value: itemsIn(folder) },
      depth: 0,
      current: folder ? currentId === folder.id : pendingCategory === cat,
      select: folder ? () => deps.onOpenFolder(folder.id) : () => selectCategory(cat),
    };
  }

  /**
   * Select a category whose folder does not exist on the device yet.
   *
   * Deliberately NOT a navigation to root: root is a real listing and would show
   * the whole library under a rail row that says "Export". No request is made —
   * there is no id to make one with, and inventing one would 404.
   */
  function selectCategory(cat: Category): void {
    pendingCategory = cat;
    deps.onSelectCategory(cat);
  }

  /**
   * A destination row: no folder, no depth, and a badge only where there is
   * something to say.
   *
   * WHERE THE "OMIT AT 0" RULE LIVES, and why it lives here rather than in the
   * painter. A destination's 0 is genuinely nothing — an empty recycle bin has
   * no number worth a badge, and the admin console has no countable thing at all
   * (see `destinationCount` in library.ts) — while a FOLDER's 0 is an answer, so
   * the folder rows above keep theirs. A painter that dropped every 0 would be
   * making that call for both, and it is not the painter's to make.
   *
   * STATE WINS OVER A COUNT when a destination offers both. Nothing does today:
   * the bin counts and does not have a state, the console has a state and
   * deliberately nothing to count. The order is stated rather than left to
   * chance because a row has room for one badge, and a padlock that a stray `0`
   * could displace would be the lying padlock this exists to avoid.
   */
  function destinationRow(dest: Destination, current: string | null): RailRow {
    const state = deps.destinationState(dest.key);
    const count = deps.destinationCount(dest.key);
    return {
      kind: "item",
      icon: dest.icon,
      name: dest.label,
      badge: state ? { kind: "state", ...state } : count > 0 ? { kind: "count", value: count } : null,
      depth: 0,
      current: current === dest.key,
      select: () => deps.onOpenDestination(dest.key),
    };
  }

  function visibleDestinations(): Destination[] {
    const admin = deps.isAdmin();
    return DESTINATIONS.filter((d) => !d.adminOnly || admin);
  }

  function rows(): RailRow[] {
    const { folderId, openPath, destination } = deps.place();
    const out: RailRow[] = [{ kind: "label", text: "Folders" }];

    // The open branch — the current folder and its ancestors — is auto-expanded
    // so the folder you're in shows its subfolders nested beneath its anchor.
    const open = new Set<Id>();
    if (openPath) {
      for (const folder of openPath) open.add(folder.id);
      if (folderId !== null) open.add(folderId);
    }
    // Render a category's user-created subfolders, indented under its anchor,
    // but only for the branch you're currently inside (reveal-on-navigate).
    const walk = (parentId: Id, depth: number): void => {
      for (const folder of subfoldersOf(parentId)) {
        out.push(folderRow(folder, depth, folderId));
        if (open.has(folder.id)) walk(folder.id, depth + 1);
      }
    };

    // 1) The fixed category anchors. ALL SIX, always — see `CATEGORIES`. An
    //    unresolved one is a real, selectable row with a 0; it just has no
    //    folder behind it yet.
    for (const cat of CATEGORIES) {
      const folder = resolveCategory(cat.path);
      out.push(categoryRow(cat, folder, folderId));
      if (folder && open.has(folder.id)) walk(folder.id, 1);
    }

    // 2) Custom top-level folders (anything not owned by a known category) so
    //    nothing the user made at the root is ever hidden, then the destinations
    //    that have no folder at all. They share one "Other" heading — it is the
    //    same answer to "what else is there" — so the label is emitted once, for
    //    whichever of the two exists.
    const others = otherRootFolders();
    const dests = visibleDestinations();
    if (others.length > 0 || dests.length > 0) {
      out.push({ kind: "label", text: "Other" });
      for (const folder of others) {
        out.push(folderRow(folder, 0, folderId));
        if (open.has(folder.id)) walk(folder.id, 1);
      }
      for (const dest of dests) out.push(destinationRow(dest, destination ?? null));
    }

    return out;
  }

  function build(): void {
    view.render(rows());
  }

  /**
   * The tree has finished loading while a category was selected but unresolved.
   * Either it resolves now — in which case that folder is where the user asked
   * to be, so go there — or it genuinely does not exist and the gallery repaints
   * from "Loading…" to the category's real empty state.
   *
   * `changed` is whether this walk actually moved the tree (see
   * {@link RailController.treeWalked}). A walk that found everything exactly as
   * it was owes the gallery nothing — and a live sync bump fires one per bump.
   */
  function settle(changed: boolean): void {
    if (!pendingCategory) {
      // NOTHING MOVED, so nothing needs repainting. A syncing tablet bumps the
      // sync version repeatedly and each bump re-walks the whole tree; every one
      // of those used to end in a full `replaceChildren` + `galleryEngine.reset()`
      // of a gallery that was already correct, discarding every drawn thumbnail
      // to redraw the same pixels. `freshness.ts` refuses the same repaint on the
      // same grounds one layer down.
      //
      // A PENDING CATEGORY is exempt (below): the walk landing is what turns its
      // "Loading…" into an answer, and that transition is real even when the tree
      // is byte-identical to the last walk's.
      if (!changed) return;
      const place = deps.place();
      // The ROOT gallery is a function of the tree too (it flattens the
      // containers away), so it has to repaint once the walk lands — otherwise
      // the first paint's raw `NOTE`/`DOCUMENT` rows would stay on screen.
      //
      // So is a live SEARCH, at any depth: its name half reads the cached tree
      // this walk fills (see `RailPlace.searching`).
      if (place.folderId === null || place.searching === true) deps.onSettled();
      // A PLAIN FOLDER LISTING gets the narrow one instead — its rows came from
      // one request that never depended on the walk, but what they are CALLED
      // does. See `onLabelsSettled`.
      else deps.onLabelsSettled();
      return;
    }
    const folder = resolveCategory(pendingCategory.path);
    if (folder) {
      deps.onOpenFolder(folder.id);
      return;
    }
    deps.onSettled();
  }

  return {
    build,

    labelFor(folder) {
      // Match on identity, not on name: two folders can share a name at
      // different depths, and only the resolved anchor is the category.
      for (const cat of CATEGORIES) {
        if (resolveCategory(cat.path)?.id === folder.id) return cat.label;
      }
      return folder.name;
    },

    categoryFor: categoryOf,

    // The glyph half of the answer above, and deliberately derived from it: two
    // independent walks over CATEGORIES could disagree about which folder is a
    // category, and every surface that styles one reads this.
    categoryIconFor(folder) {
      return categoryOf(folder)?.icon ?? null;
    },
    treeWalked(changed = true): void {
      treeLoaded = true;
      // The rail is no longer guessing which categories exist.
      view.setBusy(false);
      build();
      settle(changed);
    },

    loaded: () => treeLoaded,
    pending: () => pendingCategory,

    clearPending(): void {
      pendingCategory = null;
    },

    /**
     * What the ROOT gallery shows: the same things the rail shows, in the same
     * order — the resolved categories, then the promoted/custom folders. Never
     * the raw `NOTE`/`DOCUMENT` containers, which is what the root used to list
     * right after the rail had taught the user to think in categories.
     *
     * The one exception is a container we have not walked yet: it is emitted AS
     * ITSELF rather than silently vanishing, so nothing is unreachable during the
     * first moments of a session. It is replaced by its children on the repaint
     * the tree walk triggers.
     */
    rootEntries(entries: readonly Entry[]): Entry[] {
      const out: Entry[] = [];
      // ALL SIX, ALWAYS — the same rule the rail rows follow, for the same
      // reason. Three anchors are NESTED (`NOTE/Note`, `NOTE/MyStyle`,
      // `DOCUMENT/Document`), so they cannot resolve until the walk fetches the
      // containers' children — a whole round-trip after first paint. Pushing only
      // what resolves made the root gallery paint 3 tiles, then silently grow to
      // 6 when the walk landed: a visible re-layout on a slow link, and a
      // different shape every load. An unresolved anchor renders as itself with a
      // 0 (see `pendingCategoryOf`) and settles into the real folder in place.
      for (const cat of CATEGORIES) {
        out.push(resolveCategory(cat.path) ?? pendingCategoryFolder(cat));
      }
      out.push(...otherRootFolders());
      for (const e of entries) {
        // Any non-folder the device left at the root. The CONTAINERS
        // (`NOTE`/`DOCUMENT`) are never shown: they are noise the rail flattens
        // away, and `CONTAINER_NAMES` is STATIC DATA derived from `CATEGORIES` —
        // known before any fetch — so there is nothing to wait for. Showing them
        // "until walked" is what made two folder cards appear and then vanish.
        if (e.kind !== "folder") out.push(e);
      }
      return out;
    },

    pendingCategoryOf(folder) {
      return categoryForPendingId(folder.id);
    },

    selectCategory,
  };
}

// --- the painter -------------------------------------------------------------

/**
 * The DOM half, over a `<nav>` the shell owns (the rail's brand block and its
 * account footer are shell concerns — identity, theme, sign-out — and stay in
 * library.ts).
 *
 * IT KNOWS NOTHING ABOUT CATEGORIES. Every row is a glyph, a name, a badge and
 * an indent, so a new kind of entry never reaches this function. The name is set
 * as TEXT throughout: a folder called `<img onerror=…>` is a name someone typed
 * on a tablet, not markup, and having one path for trusted labels and another
 * for device text is how the untrusted one eventually gets the wrong treatment.
 *
 * It knows nothing about PADLOCKS either, which is the same rule one level down:
 * a {@link RailBadge} of kind `state` is an icon name and an accessible name,
 * and this function neither knows nor asks what the state is.
 */
export function createRailView(nav: HTMLElement): RailView {
  /**
   * What follows the name, or nothing at all.
   *
   * THE `null` ARM IS A FIX, not a tidy-up: this used to render `nav__count`
   * unconditionally, so the admin console — which has nothing to count, by
   * design — carried a permanent `0` beside its name, reading as an empty
   * inbox. The producer decides; here there is simply nothing to paint.
   */
  function badgeEl(badge: RailBadge | null): HTMLElement | null {
    if (badge === null) return null;
    if (badge.kind === "count") return el("span", { class: "nav__count", text: String(badge.value) });
    // `role="img"` + a label that MOVES WITH THE STATE. The glyph swap alone
    // (closed shackle vs open) carries it for sighted users; this is the other
    // half, and it is why `label` is on the badge rather than derived here from
    // an icon name the painter would then have to interpret.
    return el("span", {
      class: "nav__state",
      role: "img",
      "aria-label": badge.label,
      title: badge.label,
      html: svg(ICONS[badge.icon], 1.7),
    });
  }

  return {
    render(rows: readonly RailRow[]): void {
      nav.replaceChildren(
        ...rows.map((row) => {
          if (row.kind === "label") return el("div", { class: "nav__label", text: row.text });
          const item = el(
            "button",
            {
              class: row.depth > 0 ? "nav__item is-nested" : "nav__item",
              type: "button",
              "aria-current": String(row.current),
            },
            // The glyph is wrapped so it cannot take flex space; see the CSS.
            el("span", { class: "nav__glyph", html: svg(ICONS[row.icon]) }),
            el("span", { class: "nav__name", text: row.name }),
            badgeEl(row.badge),
          );
          item.style.setProperty("--depth", String(row.depth));
          item.addEventListener("click", () => row.select());
          return item;
        }),
      );
    },

    setBusy(busy: boolean): void {
      nav.setAttribute("aria-busy", String(busy));
    },
  };
}
