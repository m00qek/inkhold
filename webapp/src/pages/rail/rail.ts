// The library's left rail: the controller that turns the folder tree and the
// places (`railPlaces.ts`: categories, destinations, the container
// flattening shared with the breadcrumb and the root gallery) into rows, with
// the DOM injected as a `RailView` (`railView.ts`).

import { type IconName } from "../../ui/icons";
import type { Entry, Folder, Id } from "../../core/types";
import { KNOWN_ROOT_NAMES, CATEGORIES, CONTAINER_NAMES, pendingCategoryFolder, categoryForPendingId, DESTINATIONS, type Category, type Destination } from "./railPlaces";

// ---- the seams ----

/** The rail is a pure function of this plus `RailDeps.place`; it never fetches. */
export interface FolderTree {
  roots(): readonly Folder[];
  /** Empty until the walk reaches it; the rail rebuilds when it lands. */
  children(id: Id): readonly Folder[];
  /** Lets `rootEntries` emit an unwalked container as itself. */
  walked(id: Id): boolean;
}

export interface RailPlace {
  folderId: Id | null;
  /** Mutually exclusive with being in a folder. */
  destination?: string | null;
  /** Ancestors of the current folder, or null when there is no listing yet. */
  openPath: readonly Folder[] | null;
  /**
  * A search's name half reads the walked tree at any depth, so `treeWalked`
  * must repaint it, not only the root.
  */
  searching?: boolean;
}

/**
* What follows a row's name. A union because the admin padlock is not a count;
* whether to show anything is the producer's call, never the painter's.
*/
export type RailBadge =
  /** `0` is a real answer for a folder. */
  | { kind: "count"; value: number }
  /** `label` is the accessible name and must change with the state. */
  | { kind: "state"; icon: IconName; label: string };

/** One painted row; says nothing about why it exists. */
export type RailRow =
  | { kind: "label"; text: string }
  | {
      kind: "item";
      icon: IconName;
      /** Device-authored: painted as text, never markup. */
      name: string;
      badge: RailBadge | null;
      depth: number;
      current: boolean;
      /** Where the row goes, so it is a link; null for a place with no address (a category not created yet). */
      href: string | null;
      select(): void;
      /** A chevron that folds the rows beneath (To-Do's views). */
      toggle?: { expanded: boolean; label: string; onToggle(): void };
    };

/** Rows nested under a destination, e.g. To-Do's views and lists. */
export interface RailChildren {
  expanded: boolean;
  /** The chevron's accessible name; says what it will do. */
  toggleLabel: string;
  onToggle(): void;
  rows: readonly { icon: IconName; name: string; count: number; current: boolean; href: string; select(): void }[];
}

export interface RailView {
  render(rows: readonly RailRow[]): void;
  /** Counts are provisional until the walk lands; a real a11y signal. */
  setBusy(busy: boolean): void;
}

export interface RailDeps {
  view: RailView;
  tree: FolderTree;
  place(): RailPlace;
  onOpenFolder(id: Id): void;
  /** No id to list; the shell paints `Category.pending` and fetches nothing. */
  onSelectCategory(cat: Category): void;
  onOpenDestination(key: string): void;
  /** The addresses rows link to; without them rows are buttons (tests). */
  folderHref?(id: Id): string;
  destinationHref?(key: string): string;
  /** 0 renders as no badge. */
  destinationCount(key: string): number;
  /**
  * A destination's state glyph (the admin padlock). Separate from the count:
  * elevation is learned from the server and can lapse, so the shell calls
  * `rail.build()` when it changes. Asked only for painted rows, so `adminOnly`
  * destinations never leak elevation to non-admins.
  */
  destinationState(key: string): { icon: IconName; label: string } | null;
  isAdmin(): boolean;
  /** False hides the row (To-Do while the server keeps none). Default: shown. */
  destinationShown?(key: string): boolean;
  /** Rows nested under a destination, or null for none. */
  destinationChildren?(key: string): RailChildren | null;
  /** Repaint the gallery without rebuilding the rail. */
  onSettled(): void;
  /**
  * A folder listing's narrower repaint: only names depend on the walk
  * (`labelFor`/`categoryIconFor`), e.g. a deep link to the export folder
  * reading `EXPORT` until then.
  */
  onLabelsSettled(): void;
}

export interface RailController {
  build(): void;
  /** A category anchor shows its category label, not the device folder name. */
  labelFor(folder: { id: Id; name: string }): string;
  /** The pinned-category glyph, by identity, so a user's own `Note` gets nothing. */
  categoryIconFor(folder: { id: Id }): IconName | null;
  /** Full category by identity, e.g. for the upload zone's template check. */
  categoryFor(folder: { id: Id }): Category | null;
  /**
  * Drops `aria-busy`, rebuilds, and settles a pending category. `changed` is
  * false when the tree signature didn't move; a pending category still settles
  * but the gallery needs no repaint. Defaults to true.
  */
  treeWalked(changed?: boolean): void;
  loaded(): boolean;
  /** A selected category with no device folder yet; nothing is fetched. */
  pending(): Category | null;
  /** Cleared on ordinary navigation so it never lingers over a real listing. */
  clearPending(): void;
  /**
  * The root gallery, matching the rail: all six anchors (stand-ins for missing
  * ones, so the shape is settled from first paint), then other folders.
  */
  rootEntries(entries: readonly Entry[]): Entry[];
  /** Ask before navigating to or acting on a folder: a stand-in has none. */
  pendingCategoryOf(folder: Folder): Category | null;
  selectCategory(cat: Category): void;
}

// ---- the controller ----

export function createRail(deps: RailDeps): RailController {
  const { view, tree } = deps;

  let pendingCategory: Category | null = null;

  /**
  * Until the first walk, an unresolved category is indistinguishable from one
  * the device never created; without this, "Export is empty" would be claimed
  * while still loading.
  */
  let treeLoaded = false;

  function subfoldersOf(id: Id | null): readonly Folder[] {
    return id === null ? tree.roots() : tree.children(id);
  }

  function childByName(parentId: Id | null, name: string): Folder | undefined {
    return subfoldersOf(parentId).find((f) => f.name === name);
  }

  /** Undefined if any segment is missing; relies on cached ancestor listings. */
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
  * The server's `itemCount` (direct live children, every kind), so the rail
  * never disagrees with the gallery. Undefined reads as 0 here only; the gallery
  * shows no meta line for an uncounted folder.
  */
  function itemsIn(folder: Folder | undefined): number {
    return folder?.itemCount ?? 0;
  }

  /** The one identity resolution behind `categoryFor` and `categoryIconFor`. */
  function categoryOf(folder: { id: Id }): Category | null {
    const pending = categoryForPendingId(folder.id);
    if (pending) return pending;
    for (const cat of CATEGORIES) {
      if (resolveCategory(cat.path)?.id === folder.id) return cat;
    }
    return null;
  }

  function categoryFolderIds(): Set<Id> {
    const ids = new Set<Id>();
    for (const cat of CATEGORIES) {
      const folder = resolveCategory(cat.path);
      if (folder) ids.add(folder.id);
    }
    return ids;
  }

  /**
  * Non-anchor root folders: user folders at the root plus non-category children
  * of a container (a device-made `NOTE/Scratch`), promoted so flattening never
  * hides one. Shared by the rail's "Other" group and the root gallery.
  */
  function otherRootFolders(): Folder[] {
    const categoryIds = categoryFolderIds();
    const out: Folder[] = [];
    for (const folder of tree.roots()) {
      if (CONTAINER_NAMES.has(folder.name)) {
        for (const child of subfoldersOf(folder.id)) if (!categoryIds.has(child.id)) out.push(child);
        continue;
      }
      if (KNOWN_ROOT_NAMES.has(folder.name)) continue;
      out.push(folder);
    }
    return out;
  }

  function folderRow(folder: Folder, depth: number, currentId: Id | null): RailRow {
    return {
      kind: "item",
      icon: "folder",
      name: folder.name,
      // Always a count, including `0`, like category rows.
      badge: { kind: "count", value: itemsIn(folder) },
      depth,
      current: currentId === folder.id,
      href: deps.folderHref?.(folder.id) ?? null,
      select: () => deps.onOpenFolder(folder.id),
    };
  }

  /** Identical whether or not the folder exists; only `select` differs. */
  function categoryRow(cat: Category, folder: Folder | undefined, currentId: Id | null): RailRow {
    return {
      kind: "item",
      icon: cat.icon,
      name: cat.label,
      badge: { kind: "count", value: itemsIn(folder) },
      depth: 0,
      current: folder ? currentId === folder.id : pendingCategory === cat,
      href: folder ? (deps.folderHref?.(folder.id) ?? null) : null,
      select: folder ? () => deps.onOpenFolder(folder.id) : () => selectCategory(cat),
    };
  }

  /** Not a navigation to root, which would show the whole library under "Export". */
  function selectCategory(cat: Category): void {
    pendingCategory = cat;
    deps.onSelectCategory(cat);
  }

  /**
  * A destination's 0 is nothing (empty bin), unlike a folder's, so it is
  * omitted here rather than by the painter. A state wins over a count.
  */
  function destinationRow(dest: Destination, current: string | null, children: RailChildren | null): RailRow {
    const state = deps.destinationState(dest.key);
    const count = deps.destinationCount(dest.key);
    return {
      kind: "item",
      icon: dest.icon,
      name: dest.label,
      badge: state ? { kind: "state", ...state } : count > 0 ? { kind: "count", value: count } : null,
      depth: 0,
      // With its rows unfolded one of them is current; folded, the parent stands in.
      current: current === dest.key && !(children?.expanded && children.rows.some((r) => r.current)),
      href: deps.destinationHref?.(dest.key) ?? null,
      select: () => deps.onOpenDestination(dest.key),
      toggle: children ? { expanded: children.expanded, label: children.toggleLabel, onToggle: children.onToggle } : undefined,
    };
  }

  function childRows(children: RailChildren): RailRow[] {
    return children.rows.map((r) => ({
      kind: "item",
      icon: r.icon,
      name: r.name,
      badge: r.count > 0 ? { kind: "count", value: r.count } : null,
      depth: 1,
      current: r.current,
      href: r.href,
      select: r.select,
    }));
  }

  function visibleDestinations(): Destination[] {
    const admin = deps.isAdmin();
    return DESTINATIONS.filter((d) => (!d.adminOnly || admin) && (deps.destinationShown?.(d.key) ?? true));
  }

  function rows(): RailRow[] {
    const place = deps.place();
    const { openPath, destination } = place;
    // Search results span the library: no folder is where you are, though the
    // one the search started from stays open in the tree.
    const folderId = place.searching === true ? null : place.folderId;
    const out: RailRow[] = [{ kind: "label", text: "Folders" }];

    const open = new Set<Id>();
    if (openPath) {
      for (const folder of openPath) open.add(folder.id);
      if (folderId !== null) open.add(folderId);
    }
    // Subfolders shown only for the branch you're in.
    const walk = (parentId: Id, depth: number): void => {
      for (const folder of subfoldersOf(parentId)) {
        out.push(folderRow(folder, depth, folderId));
        if (open.has(folder.id)) walk(folder.id, depth + 1);
      }
    };

    for (const cat of CATEGORIES) {
      const folder = resolveCategory(cat.path);
      out.push(categoryRow(cat, folder, folderId));
      if (folder && open.has(folder.id)) walk(folder.id, 1);
    }

    const visible = visibleDestinations();
    const pushDest = (dest: Destination): void => {
      const children = deps.destinationChildren?.(dest.key) ?? null;
      out.push(destinationRow(dest, destination ?? null, children));
      if (children?.expanded) out.push(...childRows(children));
    };
    // The tablet's apps: what it makes besides files, so neither a folder nor a tool.
    const apps = visible.filter((d) => d.group === "apps");
    if (apps.length > 0) {
      out.push({ kind: "label", text: "Apps" });
      apps.forEach(pushDest);
    }

    const others = otherRootFolders();
    const dests = visible.filter((d) => d.group !== "apps");
    if (others.length > 0 || dests.length > 0) {
      out.push({ kind: "label", text: "Other" });
      for (const folder of others) {
        out.push(folderRow(folder, 0, folderId));
        if (open.has(folder.id)) walk(folder.id, 1);
      }
      dests.forEach(pushDest);
    }

    return out;
  }

  function build(): void {
    view.render(rows());
  }

  /**
  * The walk finished while a category was pending: go to it if it resolved,
  * else repaint "Loading…" into its real empty state.
  */
  function settle(changed: boolean): void {
    if (!pendingCategory) {
      // Nothing moved, so no repaint (a syncing tablet re-walks per bump). A pending
      // category is exempt: the walk landing is what answers it.
      if (!changed) return;
      const place = deps.place();
      // Root flattens containers and search reads the tree, so both repaint.
      if (place.folderId === null || place.searching === true) deps.onSettled();
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
      // Identity, not name: two folders can share a name.
      for (const cat of CATEGORIES) {
        if (resolveCategory(cat.path)?.id === folder.id) return cat.label;
      }
      return folder.name;
    },

    categoryFor: categoryOf,

    categoryIconFor(folder) {
      return categoryOf(folder)?.icon ?? null;
    },
    treeWalked(changed = true): void {
      treeLoaded = true;
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
    * Never the raw containers, except one not yet walked, which shows as itself
    * so nothing is unreachable early on.
    */
    rootEntries(entries: readonly Entry[]): Entry[] {
      const out: Entry[] = [];
      // All six always: nested anchors resolve only after the walk, and pushing only
      // resolved ones made the root grow from 3 tiles to 6 on a slow link.
      for (const cat of CATEGORIES) {
        out.push(resolveCategory(cat.path) ?? pendingCategoryFolder(cat));
      }
      out.push(...otherRootFolders());
      for (const e of entries) {
        // Containers are known statically, so never shown even before the walk.
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

// The DOM half lives in `railView.ts`.
