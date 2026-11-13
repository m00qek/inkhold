// The library's left rail: folder tree, destinations, nameplate and storage meter.

import { el } from "../../ui/dom";
import { brandMark } from "../../ui/chrome";
import { accountHref, destinationHref, digestHref, folderHref, go, todoHref } from "../../router";
import { createFolderCache } from "../folderCache";
import { createNameplate, createQuotaMeter } from "../railFooter";
import { createRail } from "../rail/rail";
import { createRailView } from "../rail/railView";
import { BIN_KEY } from "../bin/bin";
import type { LibraryCtx } from "./libraryContext";
import { ADMIN_KEY, DIGEST_KEY, TODO_KEY } from "./library";
import type { RailChildren } from "../rail/rail";
import { FIXED_VIEWS, openCount, sameView, viewPath, type TodoView } from "../todo/todoModel";
import { ALL, categoryRows, placePath, sameView as sameDigestView, type DigestView } from "../digest/digestModel";
import type { IconName } from "../../ui/icons";

/** To-Do's rows in the rail, in the tablet's order; the lists besides the Inbox are the overview's cards. */
const VIEW_ROWS: Record<(typeof FIXED_VIEWS)[number], { name: string; icon: IconName }> = {
  inbox: { name: "Inbox", icon: "inbox" },
  planned: { name: "Planned", icon: "clock" },
  all: { name: "All", icon: "stack" },
  completed: { name: "Completed", icon: "done" },
};

/** Digest's rows: its fixed views, as To-Do's; the categories it made are the overview's cards. */
const DIGEST_ROWS: { view: DigestView; name: string; icon: IconName }[] = [
  { view: ALL, name: "All", icon: "stack" },
  { view: { kind: "category", uid: "" }, name: "Uncategorized", icon: "inbox" },
  { view: { kind: "sources" }, name: "Sources", icon: "sources" },
];

type ChildRow = RailChildren["rows"][number];

/**
 * A tablet app's rows in the rail: unfolded while you are in the app and
 * folded everywhere else; the chevron overrides that until you next enter or
 * leave it.
 */
function appChildren(name: string, rebuild: () => void) {
  let folded = false;
  let peek = false;
  let wasHere = false;
  return (here: boolean, rows: ChildRow[]): RailChildren => {
    if (here !== wasHere) {
      folded = false;
      peek = false;
      wasHere = here;
    }
    const expanded = here ? !folded : peek;
    return {
      expanded,
      toggleLabel: expanded ? `Fold ${name}` : `Unfold ${name}`,
      onToggle: () => {
        if (here) folded = !folded;
        else peek = !peek;
        rebuild();
      },
      rows,
    };
  };
}

/** Builds the folder cache, the rail, the nameplate and the storage meter onto `ctx`. */
export function installLibraryRail(ctx: LibraryCtx): void {
  const { st } = ctx;
  const todoRows = appChildren("To-Do", () => ctx.rail.build());
  const digestRows = appChildren("Digest", () => ctx.rail.build());

  function todoChildren(): RailChildren | null {
    const snap = ctx.todo?.snapshot();
    if (!snap?.enabled) return null;
    const onTodo = st.destination === TODO_KEY;
    const here = ctx.todo.view();
    const row = (v: TodoView, name: string, icon: IconName): ChildRow => ({
      icon,
      name,
      count: openCount(snap, v),
      current: onTodo && here !== null && sameView(here, v),
      href: todoHref(viewPath(v)),
      select: () => go(todoHref(viewPath(v))),
    });
    return todoRows(onTodo, FIXED_VIEWS.map((k) => row({ kind: k }, VIEW_ROWS[k].name, VIEW_ROWS[k].icon)));
  }

  function digestChildren(): RailChildren | null {
    const snap = ctx.digest?.snapshot();
    if (!snap?.enabled) return null;
    const onDigest = st.destination === DIGEST_KEY;
    const view = ctx.digest.place()?.view ?? null;
    // A row counts the digests it shows, as To-Do's count tasks: the sources' page shows them all.
    const count = (v: DigestView) =>
      v.kind === "sources" ? snap.digests.length : (categoryRows(snap).find((r) => v.kind === "category" && r.uid === v.uid)?.count ?? 0);
    return digestRows(
      onDigest,
      DIGEST_ROWS.map(({ view: v, name, icon }) => {
        const href = digestHref(placePath({ view: v, digest: null }));
        // A source's digests are the Sources row's.
        const current = onDigest && view !== null && (sameDigestView(view, v) || (view.kind === "source" && v.kind === "sources"));
        return { icon, name, count: count(v), current, href, select: () => go(href) };
      }),
    );
  }
  // `aria-busy` until the walk lands: counts are provisional.
  const nav = el("div", { class: "nav", role: "group", "aria-label": "Folders", "aria-busy": "true" });

  /** The shell keeps only where the user is; the tree lives in `folderCache.ts`. */
  ctx.folderCache = createFolderCache({
    api: ctx.api,
    handled: ctx.handled,
    onWalked: (changed) => {
      ctx.rail.treeWalked(changed);
      if (changed) ctx.searchItems.refreshNames();
    },
  });

  ctx.rail = createRail({
    view: createRailView(nav),
    tree: ctx.folderCache.tree,
    // From the route via `folderId`/`destination`, not panel DOM. A destination
    // reports no folder (one `aria-current` only); the shell's own `folderId` is
    // kept so leaving the bin lands back in that folder.
    place: () =>
      st.destination !== null
        ? { folderId: null, destination: st.destination, openPath: null }
        : {
            folderId: st.folderId,
            destination: null,
            openPath: st.listing ? st.listing.path : null,
            // See `RailPlace.searching`.
            searching: st.query.trim() !== "",
          },
    // The rail never navigates; it names a URL.
    onOpenFolder: (id) => go(folderHref(id)),
    onSelectCategory: () => ctx.data.enterPendingCategory(),
    onOpenDestination: (key) => go(destinationHref(key)),
    folderHref: (id) => folderHref(id),
    destinationHref: (key) => destinationHref(key),
    destinationCount: (key) => {
      switch (key) {
        // --- BIN COUNT ---
        case BIN_KEY:
          return ctx.bin.count();
        // --- TO-DO COUNT --- open tasks, everywhere
        case TODO_KEY: {
          const snap = ctx.todo?.snapshot();
          return snap?.enabled ? openCount(snap, { kind: "all" }) : 0;
        }
        // --- DIGEST COUNT --- every digest
        case DIGEST_KEY: {
          const snap = ctx.digest?.snapshot();
          return snap?.enabled ? snap.digests.length : 0;
        }
        // --- ADMIN COUNT ---
        // None: a household headcount is an ambient stat about housemates.
        default:
          return 0;
      }
    },
    destinationState: (key) => {
      switch (key) {
        // --- ADMIN STATE ---
        // Read through `isElevated()`, the panel's fact. Locked before the console was
        // ever imported, which is also what the gate will show.
        case ADMIN_KEY:
          return ctx.adminDest.isElevated()
            ? { icon: "unlock", label: "Admin console unlocked" }
            : { icon: "lock", label: "Admin console locked" };
        // The bin has a count, and a row has room for one badge.
        default:
          return null;
      }
    },
    isAdmin: () => ctx.identity.isAdmin,
    // The tablet's apps only while the server keeps their data: an off switch is not a place to go.
    destinationShown: (key) =>
      key === TODO_KEY ? ctx.todo?.snapshot()?.enabled === true : key === DIGEST_KEY ? ctx.digest?.snapshot()?.enabled === true : true,
    destinationChildren: (key) => (key === TODO_KEY ? todoChildren() : key === DIGEST_KEY ? digestChildren() : null),
    onSettled: () => ctx.render.renderGallery({ rail: false }),
    onLabelsSettled: () => ctx.render.relabelFolders(),
  });

  const nameplate = createNameplate(ctx.identity.email, () => go(accountHref()));

  ctx.quota = createQuotaMeter();

  // The storage meter stays under the nameplate: room for the file you're about
  // to drop should be visible at a glance.
  // The rail is the app's navigation landmark: the places, and who you are.
  ctx.sidebar = el(
    "nav",
    { class: "rail", id: "rail", "aria-label": "Library" },
    el(
      "div",
      { class: "brand" },
      el("span", { class: "brand__mark", html: brandMark() }),
      el("span", { text: "INKHOLD" }),
    ),
    nav,
    nameplate,
    ctx.quota.el,
  );
}
