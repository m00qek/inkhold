// The recycle bin (U1–U7) — a soft-delete tier with restore, so that deleting a
// note is recoverable rather than final.
//
// Split the same way rail.ts and noteSearch.ts are: everything that decides
// WHAT is on screen — the ordering, the nesting, the countdown, and every
// sentence the user reads — is plain data-in/data-out behind a {@link BinView}
// seam, so it is exercisable on plain Node; {@link createBinView} is the thin
// DOM half that paints it.
//
// THE COPY IS THE FEATURE HERE, which is why so much of this file is string
// construction and so little of it is DOM. Three rules run through it:
//
//  1. **Confirm what cannot be undone, undo what can** (U4). Trashing is frequent
//     and recoverable, so it gets an undo toast; purging and emptying are rare
//     and permanent, so they get a dialog. Spending a confirm on the safe action
//     is precisely what trains people to dismiss the final one.
//  2. **Declare the fanout when it exceeds the selection.** The user clicked one
//     row; the operation may destroy three. Restore has the same obligation in
//     the other direction — it routinely brings back more than was asked.
//  3. **State the space freed.** Trash keeps charging quota, so purge is the only
//     moment the bytes come back, and the figure answers "why didn't deleting
//     free space?" at exactly the moment it is being asked.
//
// WHERE THE BIN LIVES ON SCREEN. It paints into the library's own gallery
// element rather than into a section beside it, and that is load-bearing rather
// than incidental: `renderGallery()` replaces the gallery's children on every
// navigation, so leaving the bin needs no teardown hook anywhere in the shell —
// the next folder click simply overwrites it. {@link BinController.isOpen} is
// derived from whether our node is still mounted, so the rail's highlight can
// never disagree with what is actually on screen.
//
// THE BIN IS ALSO A MODE, in the topbar. Reading already is one — `is-reading`
// takes the whole library header away from a class on the root — and the bin
// needs the same lever for less: the search box has to go (it searches a library
// you are not looking at, and typing in it would navigate you off the bin), and
// `Empty bin` has to arrive, because it acts on the WHOLE view rather than on
// any row and belongs beside sort and the view toggle. That is {@link
// BinViewOptions.setMode}; the elements stay the shell's, and `renderGallery()`
// turns the mode off on the way out — the same overwrite that closes the bin.

import { el } from "../ui/dom";
import { openDialog } from "../ui/confirm";
import { learnsAspect, pinAspect, provisionalAspect } from "../ui/tileAspect";
import { ICONS, svg } from "../ui/icons";
import { createMenu } from "../ui/menu";
import { labelPathSegments } from "./rail";
// The SAME set the gallery's cards dispatch on, imported rather than restated:
// this file used to keep an inline copy of a list like it, and it drifted the
// day the PDF viewer shipped (see `hasDedicatedViewer`'s comment).
import { FACADE_THUMB_TYPES } from "./galleryCards";
import { fileKind, formatBytes, hasDedicatedViewer, rawFileUrl } from "../core/fileKind";
// The image dims memo — the row lead's aspect source for images, which carry no
// `thumbAspect` of their own. Null = unknown yet.
import { getDims } from "../cache/dimsMemo";
import type { Api } from "../api/types";
import type { LazyEngine, LazySlotInput } from "../render/lazy";
import type { Bin, BinEntry, Restored, Trashed } from "../core/binTypes";
import type { Hash, Id, PageRef, PageText } from "../core/types";
import type { FileHistory } from "../core/types";
import type { NoteMeta } from "../core/types";

/** The {@link Destination} key the rail routes on. One string, one owner. */
export const BIN_KEY = "bin";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days left at which the countdown turns red. */
const SOON_DAYS = 5;

/** Pre-set a lead from the entry's own stated shape; false when it has none —
 *  the caller may then fall back to the image dims memo. The bin is a LIST, so
 *  every lead is a row: the shared `pinAspect` pre-clamps to the 2.5× width cap
 *  (see 08's `has-aspect` rules). */
function preclampAspect(tile: HTMLElement, entry: BinEntry): boolean {
  const a = entry.thumbAspect;
  if (!a || !(a.w > 0) || !(a.h > 0)) return false;
  pinAspect(tile, a.w / a.h, true);
  return true;
}

/**
 * The device asymmetry (U6), said at the point of deletion and nowhere else.
 *
 * **The device never sees the bin.** Trashing removes the file from the Nomad
 * immediately; the bin protects only the server copy, and restoring re-syncs it
 * back down. Nobody guesses this, and the moment it matters is the moment the
 * file leaves — so it rides on the undo toast rather than sitting in a settings
 * page nobody opens.
 */
export const DEVICE_LINE = "Also comes off your Supernote at the next sync.";

/** `n thing` / `n things`, with the plural only where it belongs. */
function plural(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`;
}

/** Midnight local time — the boundary "today" and "yesterday" are counted from. */
function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Whole days between two instants, counted in CALENDAR days rather than in
 * 24-hour blocks. Something deleted at 23:50 was deleted "yesterday" at 00:10,
 * not "0 days ago", and the group heading has to agree with the clock on the
 * wall rather than with the arithmetic.
 */
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

/** The date heading a subtree files under. */
export function groupLabel(deletedAt: number, now: number): string {
  const days = daysBetween(deletedAt, now);
  if (days === 0) return "Deleted today";
  if (days === 1) return "Deleted yesterday";
  return `Deleted ${days} days ago`;
}

/**
 * ONE PAINTED ROW, and everything the row and its two actions need to say.
 *
 * `fanout` and `bytes` describe the SUBTREE, not the row: purging a folder
 * destroys its contents and frees their bytes, and the confirmation has to state
 * both. They are computed once here rather than at the click, so the dialog and
 * the list can never disagree about what a row is worth.
 */
export interface BinRow {
  entry: BinEntry;
  /** This row's parent is in the bin too, so it renders nested beneath it. */
  child: boolean;
  /** The date heading this row files under. Shared by a whole subtree. */
  group: string;
  /** `14:52` today, `2 Jul, 09:14` otherwise — the "deleted twice" tiebreak. */
  time: string;
  daysLeft: number;
  soon: boolean;
  /** `folder · 2 items`, or `NOTE · 1.4 MB`. */
  detail: string;
  /**
   * Folders are NOT clickable. A folder has nothing to open — it is a container
   * and its contents are already listed beneath it — so rendering it as a button
   * would promise a view that does not exist.
   */
  openable: boolean;
  /** Rows a purge of this one destroys, itself included. */
  fanout: number;
  /** Bytes a purge of this one frees. Folders contribute 0; see `BinEntry.size`. */
  bytes: number;
}

/**
 * The flat server list, ordered and nested for the screen (U2).
 *
 * NEWEST FIRST, with each trashed subtree kept together: the roots keep the
 * server's order and every descendant follows its parent immediately, so a
 * folder and the notes that went down with it read as the one delete they were.
 * That matters because the DEVICE sends a folder delete as separate per-entity
 * requests, children first — three rows for one user action — and only the
 * nesting reunites them.
 *
 * The whole subtree also takes its ROOT's date heading, so a group can never be
 * split down the middle by a child whose timestamp landed a second past midnight.
 *
 * An orphan — a row whose `parentId` names something not in the bin — is
 * promoted to a root rather than dropped. Losing a row would be far worse than
 * showing it flush, and the server can legitimately produce one (the parent was
 * purged, or restored, while this listing was in flight).
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

  /** Everything at or below `id` — what a purge destroys and a restore returns. */
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
    // Roots, in the server's order, plus anything whose parent is not here.
    if (!entry.isRoot && entry.parentId !== null && present.has(entry.parentId)) continue;
    emit(entry, groupLabel(entry.deletedAt, now), false);
  }
  return rows;
}

/** The row's middle fact: what it is, and how big. */
function detailOf(entry: BinEntry, descendants: number): string {
  if (entry.kind === "folder") return descendants === 0 ? "folder" : `folder · ${plural(descendants, "item")}`;
  const type = (entry.fileType || "file").toUpperCase();
  return `${type} · ${formatBytes(entry.size)}`;
}

// --- the sentences -----------------------------------------------------------

/**
 * A confirmation, as content rather than as a question.
 *
 * NOT "Are you sure?": the title names the object and the act, and `action`
 * repeats it, so the sentence the user reads is the sentence the button
 * performs. `frees` is the number worth reading twice — see the file header.
 */
export interface ConfirmSpec {
  title: string;
  body: string;
  /** Human size, or null when there are no bytes to promise back. */
  frees: string | null;
  /** The destructive button's label. Never "OK", never "Yes". */
  action: string;
}

export function purgeConfirm(row: BinRow): ConfirmSpec {
  const inside = row.fanout - 1;
  return {
    title: `Delete ${row.entry.name} permanently?`,
    // The fanout, stated only when it exceeds what was selected. A row that
    // destroys exactly itself does not need a sentence explaining that.
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
    // The SERVER's total, which sums files only. A folder's bytes are its
    // children's and the children are rows in the same list, so summing every
    // row here would count a folder together with its contents.
    frees: bin.totalBytes > 0 ? formatBytes(bin.totalBytes) : null,
    action: "Empty bin",
  };
}

/**
 * What restore did — not what was asked (U3).
 *
 * Three things routinely exceed the selection and all three are reported: the
 * trashed ancestors that had to come back for this to be reachable at all, the
 * descendants that came back with a folder, and an auto-rename forced by a live
 * entry that took the name in the meantime.
 */
export function restoreMessage(r: Restored): string {
  const parts: string[] = [r.renamed ? `Restored as ${r.name}` : `Restored ${r.name}`];
  if (r.descendants > 0) parts.push(`with the ${plural(r.descendants, "item")} inside it`);
  if (r.ancestors > 0) parts.push(`also restored ${plural(r.ancestors, "folder")}`);
  return `${parts.join(" · ")} — back on your Supernote at the next sync`;
}

/** The undo toast's headline (U5). Same fanout obligation as the confirm. */
export function trashMessage(t: Trashed): string {
  const inside = t.entries - 1;
  return inside > 0
    ? `Moved ${t.name} and the ${plural(inside, "item")} inside it to Recycle bin`
    : `Moved ${t.name} to Recycle bin`;
}

/**
 * WHERE the entry used to live, named the way the rail names it.
 *
 * Two corrections to the server's `path`, which is the full path INCLUDING the
 * entry's own name (`/NOTE/Note/deep.note`):
 *
 *  - the trailing name comes off, because the row already shows it directly
 *    above and repeating it spends the line on nothing;
 *  - the containers are flattened and the categories labelled, via the rail's
 *    own {@link labelPathSegments}, so the bin cannot name a folder — `NOTE` —
 *    that no other surface in the app admits exists.
 *
 * Out here with the other sentences rather than inside the painter, because it
 * is one: data in, the string the user reads out, and testable on plain Node.
 */
export function folderLabel(path: string, name: string): string {
  const segments = path.split("/").filter(Boolean);
  // Only when it IS the trailing segment. A folder deleted from inside a
  // same-named parent (`/NOTE/Note/Work/Work`) must not lose the parent as well.
  if (segments[segments.length - 1] === name) segments.pop();
  const shown = labelPathSegments(segments);
  // The root has no name of its own on any other surface either.
  return shown.length > 0 ? shown.join(" / ") : "Library";
}

/** The empty state (U7): what the bin is for, and the real retention window. */
export function emptyStateBody(retentionDays: number): string {
  return `Notes you delete — here or on your Supernote — wait here for ${retentionDays} days before they’re removed for good.`;
}

// --- the seams ---------------------------------------------------------------

export interface BinModel {
  state: "loading" | "ready" | "error";
  rows: BinRow[];
  retentionDays: number;
  totalBytes: number;
  /**
   * Entry ids with a restore or a purge IN FLIGHT. Their rows paint as busy and
   * their actions are inert until the call settles — see the `inFlight` set in
   * the controller for why that is not merely a nicety.
   */
  busy: readonly Id[];
  /** `Empty bin` is in flight. Disables the topbar control that started it. */
  emptying: boolean;
}

export interface ToastOpts {
  /** A second line — the U6 device sentence, or a result detail. */
  sub?: string;
  /**
   * The reverse of what just happened. Its presence is what holds the toast on
   * screen long enough to be used: an undo has to outlast reading the sentence
   * that offers it, which a 2.4s notification does not.
   */
  undo?: () => void;
}

/**
 * What a painted row can do. Handed to the view on every render rather than at
 * construction, which is what keeps the view and the controller from needing a
 * reference to each other before either exists — and keeps the painter free of
 * any opinion about what "restore" means.
 */
export interface BinActions {
  open(entry: BinEntry): void;
  restore(row: BinRow): void;
  purge(row: BinRow): void;
  // NO `empty` HERE. Emptying is not a row's action and is no longer painted by
  // this view at all — it is the topbar's `[trash] Empty bin`, which calls
  // {@link BinController.empty} directly.
}

export interface BinView {
  render(model: BinModel, actions: BinActions): void;
  /**
   * Show a trashed IMAGE or a file with no preview, with the decision controls
   * and the deadline beside it. A kind with a REAL viewer — `.note`, `.spd`,
   * `.txt` — never comes here: it goes to its own viewer (see
   * `library.viewerFor`), which reads through the bin-scoped routes.
   */
  preview(row: BinRow, retentionDays: number, actions: BinActions): void;
  /** True while the bin's node is still the gallery's content. */
  isMounted(): boolean;
  /** Resolves true only when the DESTRUCTIVE button was chosen. */
  confirm(spec: ConfirmSpec): Promise<boolean>;
  toast(message: string, opts?: ToastOpts): void;
  destroy(): void;
}

export interface BinDeps {
  api: Api;
  view: BinView;
  /**
   * Open a trashed file. The shell routes it, so Back and a reload behave; the
   * viewer is given a `"bin"` origin, which is what makes its Back control say
   * "Recycle bin" and land here rather than in a library the file is not in —
   * and what swaps its file actions to Restore / Delete permanently.
   */
  onOpen(entry: BinEntry): void;
  /**
   * The bin's contents changed, so the rail badge and the gallery behind it are
   * out of date. The shell repaints; nothing here knows how.
   */
  onChanged(mutated: boolean): void;
  /**
   * Classify a caught error through the shell's failure sink. True means it was
   * actionable (a dead session) and this module must not also paint its own
   * "that didn't work" over a shell on its way out.
   */
  handled(e: unknown): boolean;
}

export interface BinController {
  /** Paint the bin into the gallery and refresh it. */
  open(): void;
  /**
   * Resolve once a bin listing is in hand — the startup fetch when it lands, or a
   * fresh fetch if that one failed. WITHOUT PAINTING: the recycle-bin deep-link
   * open (`AppShell.openBinNote`, cold `#/bin/note/:id`) needs the listing loaded
   * to find the trashed entry and build its `bin` origin (`isTrashed` / `pathOf` /
   * `retentionOf`) before the viewer opens over whatever gallery is behind it —
   * but it must not paint the bin, which the viewer would only cover. Reuses the
   * boot-time listing rather than firing a second one.
   */
  ensureLoaded(): Promise<void>;
  /**
   * Empty the whole bin, confirm and all. EXPOSED because the control lives in
   * the shell's topbar (`[trash] Empty bin`) rather than inside the bin's own
   * markup — it is a view-level control, alongside sort and the view toggle.
   *
   * The CONFIRM travels with it. Empty-bin is irreversible and bulk, so the
   * dialog is not the button's decoration but half of what the button is; moving
   * the control without it would have been the one change this file's rules
   * forbid. It stays behind this method for exactly that reason: a caller cannot
   * reach the destructive half without it.
   */
  empty(): void;
  /** The rail's `place().destination` — derived, never a second copy of state. */
  isOpen(): boolean;
  /** The rail badge. 0 renders as no badge at all. */
  count(): number;
  /**
   * Is this id in the bin? The shell asks before every note read, because a
   * trashed note has to be fetched through the bin-scoped routes — see
   * {@link createBinScope}.
   */
  isTrashed(id: Id): boolean;
  /** The path a trashed entry had when it was deleted, for the reader subtitle. */
  pathOf(id: Id): string | null;
  /**
   * A trashed entry's countdown — days left, whether it is "soon", and the
   * retention window — so a viewer opened FROM the bin can paint the SAME `.life`
   * rule the row shows. Null when the bin does not hold the id.
   */
  retentionOf(id: Id): { daysLeft: number; soon: boolean; retentionDays: number } | null;
  /** U5: move a live entry to the bin, with an undo toast and the device line. */
  trash(entry: { id: Id; name: string; kind: "folder" | "note" }): Promise<void>;
  /**
   * Restore a trashed entry BY ID — the viewers' Restore action, when a file is
   * open from the bin. The same toast-and-refresh path the bin's own row action
   * takes; resolves true only when the entry actually came back, so the caller
   * knows whether to leave a viewer that is now showing a live file.
   */
  restore(id: Id): Promise<boolean>;
  /**
   * Purge a trashed entry BY ID, CONFIRM AND ALL — the viewers' Delete
   * permanently. As with {@link empty}, the confirm travels with the method:
   * purging is irreversible, so the dialog is half of what the action is, and no
   * caller can reach the destructive half without it. Resolves true only when
   * the entry is really gone (the confirm accepted and the call succeeded).
   */
  purge(id: Id): Promise<boolean>;
  destroy(): void;
}

// --- the controller ----------------------------------------------------------

export function createBin(deps: BinDeps): BinController {
  const { api, view } = deps;

  let bin: Bin | null = null;
  let state: BinModel["state"] = "loading";
  /**
   * Bumped by every refresh. A response that is not the newest is DISCARDED
   * rather than painted: restore, purge and empty each trigger a refresh, and
   * clicking two rows in quick succession would otherwise let the first, longer
   * response repaint the bin with rows the second one has already removed.
   */
  let token = 0;

  /**
   * The entries whose restore or purge is TRAVELLING RIGHT NOW.
   *
   * IN FLIGHT IS A STATE, and it was the one state this file did not keep. On a
   * slow link nothing at all happens when Restore is chosen — no optimistic
   * paint, no disabled control — so the natural reading is that the click missed,
   * and the natural response is to click again. The second call then reaches a
   * server that has already restored the entry, finds nothing to restore, and
   * the bin reports "Couldn't restore X. Try again." for an operation that
   * SUCCEEDED. Purge and Empty had the same hole.
   *
   * So every mutating entry point is a no-op while its own call is pending, and
   * the pending one is PAINTED — the row dims and its ⋯ is disabled, the topbar's
   * `Empty bin` goes flat — so the click that was already made is visible and
   * there is nothing to re-click. Released on BOTH arms (a guard that outlives
   * its own failure is a control that never comes back), and held across the
   * refresh that follows, so the window between "the write returned" and "the
   * list agrees" is covered too.
   */
  const inFlight = new Set<Id>();
  let emptying = false;

  function model(): BinModel {
    return {
      state,
      rows: bin ? binRows(bin) : [],
      retentionDays: bin?.retentionDays ?? 30,
      totalBytes: bin?.totalBytes ?? 0,
      busy: [...inFlight],
      emptying,
    };
  }

  const actions: BinActions = {
    // A kind with a REAL viewer — `.note`, `.spd`, `.txt`, the same set
    // `library.viewerFor` dispatches on — is routed by the SHELL, so Back, a
    // reload and the browser's own history all work and the viewer is given a
    // `"bin"` origin (its reads and raw fetches then go through the bin-scoped
    // routes, and its file actions swap to Restore / Delete permanently).
    // Everything else — an image, an unrecognised type — is a smaller question:
    // is this the screenshot I meant? That is answered in a panel this module
    // owns, because no real viewer exists to answer it better.
    open: (entry) => {
      if (hasDedicatedViewer(entry.fileType)) {
        deps.onOpen(entry);
        return;
      }
      const row = rowFor(entry.id);
      if (row) view.preview(row, bin?.retentionDays ?? 30, actions);
    },
    restore: (row) => void restore(row),
    purge: (row) => void purge(row),
  };

  /** The painted row for an id, or null when the listing does not hold it. */
  function rowFor(id: Id): BinRow | null {
    return (bin ? binRows(bin) : []).find((r) => r.entry.id === id) ?? null;
  }

  /**
   * A cheap signature of what a render would paint. Two models with the same
   * signature produce the same rows, so re-rendering the second is a no-op the
   * user cannot see — except that `replaceChildren` would DETACH an open row
   * menu. `paint()` skips those; a real mutation (a purge, a restore, a countdown
   * that ticked over) changes the signature and repaints as before.
   */
  function renderKey(m: BinModel): string {
    return JSON.stringify([
      m.state,
      m.retentionDays,
      m.totalBytes,
      // The busy flags are part of what a render PAINTS (a dimmed row, a
      // disabled control), so they belong in the signature: without them the
      // repaint that shows an action starting would be skipped as a no-op.
      m.busy,
      m.emptying,
      m.rows.map((r) => [r.entry.id, r.child, r.daysLeft, r.soon, r.detail, r.openable]),
    ]);
  }
  let lastRenderKey: string | null = null;

  /** Render and remember the signature. UNCONDITIONAL — used on open, where the
   *  section may have been unmounted (leaving the bin) and must re-mount even
   *  when the data is unchanged. */
  function renderNow(m: BinModel): void {
    view.render(m, actions);
    lastRenderKey = renderKey(m);
  }

  /** Repaint, but only if the bin is still on screen AND the rows actually
   *  changed — see `renderKey`. */
  function paint(): void {
    if (!view.isMounted()) return;
    const m = model();
    if (renderKey(m) === lastRenderKey) return;
    renderNow(m);
  }

  async function refresh(mutated = false): Promise<void> {
    const mine = ++token;
    // A RETRY HAS TO READ AS A RETRY. `state` is only ever moved by a response,
    // so a listing that failed left "Couldn't load the bin" standing — and the
    // NEXT listing then ran its whole round trip underneath that sentence, with
    // the screen reporting a failure about a request that had already been
    // replaced by one in progress. Nothing on screen said anything was happening,
    // so the natural reading was that the retry had not been taken.
    //
    // ONLY out of `error`, never out of `ready`: a refresh that follows a restore
    // or a purge is revalidating a list the user is looking at, and dropping that
    // to "Loading…" would blank a good bin for the length of a round trip. The
    // in-flight affordance for those is the row's own (`inFlight`), which is a
    // statement about the ROW rather than about the listing.
    if (state === "error") {
      state = "loading";
      paint();
    }
    try {
      const next = await api.listBin();
      if (mine !== token) return;
      bin = next;
      state = "ready";
    } catch (e) {
      if (mine !== token) return;
      if (deps.handled(e)) return;
      // Distinct from an empty bin, deliberately. A failed listing rendered as
      // "Nothing deleted" is indistinguishable from a bin that really is empty —
      // and the person reading it is deciding whether their file still exists.
      state = "error";
    }
    paint();
    // The rail badge is a function of the same list, and it is visible whether
    // or not the bin is on screen. `mutated` separates "the badge moved" from
    // "the library behind this changed too" — the boot-time listing must not
    // make the shell refetch a folder it has only just fetched.
    deps.onChanged(mutated);
  }

  // The count is a rail badge, so it is needed from the first paint of the shell
  // — long before anyone opens the bin. One listing at start-up, then one per
  // change; nothing polls. The promise is KEPT so `ensureLoaded` (a cold
  // bin-note deep link) can await this same fetch rather than firing a second.
  let firstLoad: Promise<void> | null = refresh();

  /** True only when the entry really came back — the viewers leave on that. */
  async function restore(row: BinRow): Promise<boolean> {
    const id = row.entry.id;
    if (inFlight.has(id)) return false; // already travelling — see `inFlight`
    inFlight.add(id);
    paint(); // the click that was made becomes visible
    let done = false;
    try {
      try {
        const result = await api.restoreEntry(id);
        view.toast(restoreMessage(result));
        done = true;
      } catch (e) {
        if (deps.handled(e)) return false;
        view.toast(`Couldn’t restore ${row.entry.name}. Try again.`);
      }
      await refresh(true);
    } finally {
      inFlight.delete(id);
      paint();
    }
    return done;
  }

  /** True only when the confirm was accepted AND the purge succeeded. */
  async function purge(row: BinRow): Promise<boolean> {
    const id = row.entry.id;
    if (inFlight.has(id)) return false;
    // The confirm comes FIRST and the row is not marked busy for it: a dialog is
    // already modal, and dimming the row behind it would claim work had started
    // that the user has not yet agreed to.
    if (!(await view.confirm(purgeConfirm(row)))) return false;
    if (inFlight.has(id)) return false; // something else started while it was open
    inFlight.add(id);
    paint();
    let done = false;
    try {
      try {
        await api.purgeEntry(id);
        view.toast(
          row.bytes > 0
            ? `Deleted ${row.entry.name} — ${formatBytes(row.bytes)} freed`
            : `Deleted ${row.entry.name}`,
        );
        done = true;
      } catch (e) {
        if (deps.handled(e)) return false;
        view.toast(`Couldn’t delete ${row.entry.name}. Try again.`);
      }
      await refresh(true);
    } finally {
      inFlight.delete(id);
      paint();
    }
    return done;
  }

  async function empty(): Promise<void> {
    if (emptying) return; // one at a time — see `inFlight`
    if (!bin || bin.entries.length === 0) return;
    const freed = bin.totalBytes;
    if (!(await view.confirm(emptyConfirm(bin)))) return;
    if (emptying) return;
    emptying = true;
    paint();
    try {
      try {
        const n = await api.emptyBin();
        view.toast(freed > 0 ? `Bin emptied — ${plural(n, "item")}, ${formatBytes(freed)} freed` : `Bin emptied — ${plural(n, "item")}`);
      } catch (e) {
        if (deps.handled(e)) return;
        view.toast("Couldn’t empty the bin. Try again.");
      }
      await refresh(true);
    } finally {
      emptying = false;
      paint();
    }
  }

  return {
    open(): void {
      // What is in hand is a FAILURE, and opening the bin is asking again — so
      // the state it paints from is the retry, not the answer to the request the
      // retry replaces. Done here as well as in `refresh` (which is what actually
      // owns the transition) because `renderNow` below runs BEFORE that call:
      // without this the first thing painted is a sentence about a listing that
      // is already being re-fetched.
      if (state === "error") state = "loading";
      // Paint what is already in hand FIRST — the count has usually been fetched
      // long ago for the rail badge, so the bin opens populated rather than
      // through a "Loading…" that nothing was waiting on. Unconditional (the
      // section may have been unmounted), and it records the signature so the
      // refresh below — which fetches the SAME listing — skips its redundant
      // repaint rather than detaching a menu the user just opened.
      renderNow(model());
      void refresh();
    },

    async ensureLoaded(): Promise<void> {
      if (bin) return; // already have a listing
      // Await the boot-time fetch first, so a cold deep-link does not race a
      // second listing against it. If that one FAILED (state stayed non-ready),
      // fetch once more — the deep link is the user asking again.
      if (firstLoad) {
        await firstLoad;
        firstLoad = null;
      }
      if (!bin) await refresh();
    },

    empty: () => void empty(),
    isOpen: () => view.isMounted(),
    count: () => bin?.entries.length ?? 0,
    isTrashed: (id) => (bin?.entries ?? []).some((e) => e.id === id),
    pathOf: (id) => (bin?.entries ?? []).find((e) => e.id === id)?.path ?? null,
    // Read off the same `binRows` the list is painted from, so the viewer's
    // timeline and the row's cannot disagree about how long a file has left.
    retentionOf: (id) => {
      const row = rowFor(id);
      return row ? { daysLeft: row.daysLeft, soon: row.soon, retentionDays: bin?.retentionDays ?? 30 } : null;
    },

    // The viewers' two bin-origin actions, by id. Each resolves through the SAME
    // internal path the bin's own row actions take — one toast, one confirm, one
    // refresh — so a viewer cannot reach `purgeEntry` around the dialog, and the
    // rail badge and the folder behind the bin refresh exactly as they do for a
    // row click. An id the listing does not hold (already purged, never trashed)
    // is a quiet false: there is nothing to act on and nothing to confirm.
    restore: async (id) => {
      const row = rowFor(id);
      return row ? restore(row) : false;
    },
    purge: async (id) => {
      const row = rowFor(id);
      return row ? purge(row) : false;
    },

    async trash(entry): Promise<void> {
      let done: Trashed;
      try {
        done = await api.trashEntry(entry.id);
      } catch (e) {
        if (deps.handled(e)) return;
        view.toast(`Couldn’t delete ${entry.name}. Try again.`);
        return;
      }
      // NO CONFIRMATION, on purpose (U4). This is the reversible one, so it acts
      // and offers the reverse; the sub-line is the device asymmetry, said every
      // time rather than once, because it stays true on the hundredth delete and
      // suppressing it optimises for the person who already knows.
      view.toast(trashMessage(done), {
        sub: DEVICE_LINE,
        undo: () => {
          void (async () => {
            try {
              const back = await api.restoreEntry(done.id);
              view.toast(restoreMessage(back));
            } catch (e) {
              if (deps.handled(e)) return;
              view.toast(`Couldn’t put ${done.name} back. It is in the Recycle bin.`);
            }
            await refresh(true);
          })();
        },
      });
      await refresh(true);
    },

    destroy(): void {
      // Orphans any in-flight listing, so a shell torn down mid-refresh (a
      // sign-out, an expired session) leaves nothing scheduled to paint.
      token++;
      view.destroy();
    },
  };
}

// --- the bin-scoped read seam ------------------------------------------------

/**
 * Routes reads for a TRASHED id through the bin's own endpoints (U2b).
 *
 * The server's `Files.get` hardcodes `deleted = 0` and is the shared ownership
 * boundary behind every live read, so it is deliberately NOT relaxed to see the
 * bin; the bin gets its own PARALLEL routes instead — meta, page bytes, page
 * text, in-note search, and the whole view-only version-history family. That
 * split has to be honoured somewhere on the client, and the reader is the wrong
 * place: it should not know that a bin exists, and neither should the lazy render
 * engine or the exporter that also pull page bytes through this seam.
 *
 * So the SHELL's `Api` is wrapped once, at construction, and every consumer
 * downstream is unchanged. `attach` supplies the predicate late because the bin
 * controller is built after the reader that reads through this wrapper.
 */
export interface BinScope {
  wrap(api: Api): Api;
  attach(isTrashed: (id: Id) => boolean): void;
}

export function createBinScope(): BinScope {
  let isTrashed: (id: Id) => boolean = () => false;
  return {
    attach(fn) {
      isTrashed = fn;
    },
    wrap(api) {
      return {
        ...api,
        getNoteMeta: (id: Id): Promise<NoteMeta> => (isTrashed(id) ? api.getBinNoteMeta(id) : api.getNoteMeta(id)),
        getPageBytes: (id: Id, page: PageRef): Promise<ArrayBuffer> =>
          isTrashed(id) ? api.getBinPageBytes(id, page) : api.getPageBytes(id, page),
        // A trashed file's transcript IS retained — the FTS index is md5-keyed and
        // trashing only tombstones (`deleted = 1`), so the recognized text with its
        // word boxes survives the delete and comes back untouched on restore. The
        // bin gets its own `/bin/note/:id/page/:n/text` route (the live one is the
        // shared ownership boundary, hardcoded `deleted = 0`), and rerouting here
        // is what lights up a trashed-note preview's on-page ovals and the OCR
        // panel — the same wrap-once discipline as `getPageBytes`.
        getPageText: (id: Id, page: PageRef): Promise<PageText> =>
          isTrashed(id) ? api.binPageText(id, page) : api.getPageText(id, page),
        // FIND-IN-A-TRASHED-NOTE REROUTES NOTHING, and that absence is
        // §1.1. In-document search is keyed by BLOB MD5 now —
        // one route, `text/<md5>`, authorized on its own terms — and a trashed
        // file's blob has the same md5 it had before it was trashed. So the bin is
        // not a scope for search at all: `getBinNoteMeta` above already hands the
        // viewer the file's `fileHash`, and the find controllers search exactly
        // that field.
        //
        // What DID need a reroute, and still does, is everything addressed by
        // `files.id` — the live reads hardcode `deleted = 0`, so a trashed id comes
        // back empty through them.
        //
        // VIEW-ONLY version history in the bin (Phase 2). A trashed file's
        // `file_history` follows it into the bin (purged only when the bin purges),
        // so its version list, per-version pages/text/raw and per-version find all
        // reroute onto the `/bin/note/:id/history/…` twins when the id is trashed.
        // The list call comes straight through this seam; the per-version reads are
        // driven by `historyScope` (composed OUTSIDE this wrapper), which calls
        // these same seam methods — so a preview of a trashed file's version hits
        // the bin twins here without either scope knowing about the other.
        noteHistory: (id: Id): Promise<FileHistory> =>
          isTrashed(id) ? api.binNoteHistory(id) : api.noteHistory(id),
        historyPageBytes: (id: Id, md5: Hash, index: number): Promise<ArrayBuffer> =>
          isTrashed(id) ? api.binHistoryPageBytes(id, md5, index) : api.historyPageBytes(id, md5, index),
        historyPageText: (id: Id, md5: Hash, index: number): Promise<PageText> =>
          isTrashed(id) ? api.binHistoryPageText(id, md5, index) : api.historyPageText(id, md5, index),
        historyRaw: (id: Id, md5: Hash): Promise<ArrayBuffer> =>
          isTrashed(id) ? api.binHistoryRaw(id, md5) : api.historyRaw(id, md5),
      };
    },
  };
}

// --- the painter -------------------------------------------------------------

/**
 * The bin-scoped raw-bytes URL for a trashed file.
 *
 * The live twin (`rawFileUrl` without the flag) points at `/file/{id}`, which
 * goes through `Files.get` and therefore 404s for anything trashed. Same
 * content-addressed `?v=` contract: null when there is no hash, because the
 * route REQUIRES one — that is what makes its year-long `immutable` response
 * honest — so a hashless entry has no addressable URL at all. A convenience over
 * `rawFileUrl(…, { bin: true })` for the callers that hold a {@link BinEntry};
 * the URL itself has exactly one author, in core/fileKind.ts.
 */
export function binFileUrl(entry: BinEntry, opts: { download?: boolean } = {}): string | null {
  return rawFileUrl(entry.id, entry.fileHash, { ...opts, bin: true });
}

export interface BinViewOptions {
  /**
   * The library's gallery. The bin paints INTO it rather than beside it, so
   * `renderGallery()` closing the bin is the shell's existing behaviour rather
   * than a hook the shell has to grow — see the file header.
   */
  gallery: HTMLElement;
  /** The topbar breadcrumb, which says "Recycle bin" while this is open. */
  crumbs: HTMLElement;
  /** Sort and the grid/list toggle: they describe a folder listing, not a bin. */
  sortWrap: HTMLElement;
  segmented: HTMLElement;
  /** The app root, which the toast and the preview overlay mount into. */
  root: HTMLElement;
  /**
   * The gallery's lazy render engine, SHARED rather than a second one.
   *
   * The bin paints into the gallery, so the gallery's engine already observes
   * the right scroll root — and `renderGallery()` calls `reset()` on it on the
   * way out, which is precisely the teardown the bin's canvases need and the one
   * this module is built never to have to own.
   */
  engine: LazyEngine;
  /**
   * Enter or leave BIN MODE, with the row count the topbar's `Empty bin` needs.
   *
   * The bin is a mode, exactly as reading is: `is-reading` hides the topbar's
   * folder controls from a class on the root, and the bin does the same to the
   * search box (searching a library you are not looking at) while adding one
   * control of its own. The shell owns both, because the elements are the
   * shell's — this seam only says which mode is on.
   *
   * `busy` is `Empty bin`'s OWN call being in flight. The control disables for
   * it as well as for an empty bin: those are two different reasons for the same
   * appearance, and both of them are "there is nothing this click can usefully
   * do" — see the controller's `inFlight`.
   */
  setMode(open: boolean, count: number, busy: boolean): void;
  /**
   * Leave the bin for the library root — what the `Library` crumb does.
   *
   * The bin is a DESTINATION, not a folder, so nothing in the topbar otherwise
   * leads out of it: the rail can take you somewhere else, but the header itself
   * was a dead end. That was survivable while the only way in was the rail row
   * you could click again; it stopped being survivable when the account page
   * grew an `Open` button that sends you here from somewhere else entirely.
   */
  onLeave(): void;
}

/**
 * The DOM half. It knows nothing about restoring or purging — every control is
 * wired to a {@link BinActions} callback it is handed — which is what lets the
 * whole of the module's behaviour be tested without a browser.
 */
export function createBinView(opts: BinViewOptions): BinView {
  const { gallery, crumbs, sortWrap, segmented, root, engine, setMode, onLeave } = opts;

  const section = el("section", { class: "bin", "aria-label": "Recycle bin" });

  // --- the confirm dialog ---
  //
  // The shared modal <dialog> (src/ui/confirm.ts) with the bin's own class set
  // (`confirm*`, `.btn`/`.is-danger`) bound in below. The invariants the bin
  // relies on — Cancel first, focused and Enter-activated; the destructive button
  // never the default; Esc dismisses without acting — live in that primitive.

  // --- the toast ---
  //
  // The bin's OWN toast, not the shell's. The shell's is a single line that
  // fades after 2.4s; an undo has to carry a second line and a control, and it
  // has to outlast reading the sentence that offers it — a notification is not
  // an undo.
  const toastMsg = el("span", { class: "bin-toast__msg" });
  const toastSub = el("span", { class: "bin-toast__sub" });
  const toastAction = el("button", { class: "bin-toast__action", type: "button", hidden: true });
  const toastEl = el(
    "div",
    { class: "bin-toast", role: "status", "aria-live": "polite" },
    el("span", { class: "bin-toast__lines" }, toastMsg, toastSub),
    toastAction,
  );
  root.append(toastEl);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function hideToast(): void {
    if (toastTimer !== undefined) clearTimeout(toastTimer);
    toastEl.classList.remove("is-shown");
  }

  // --- the preview overlay ---
  //
  // For an IMAGE or a file with no preview. A kind with a real viewer — `.note`,
  // `.spd`, `.txt` — goes to that viewer instead, and a second copy of any of
  // them here would be a second thing to keep byte-exact. What these two kinds
  // need is smaller: the evidence, the deadline, and the two decisions, in one
  // place.
  const overlay = el("div", { class: "bin-preview", role: "dialog", "aria-modal": "true", hidden: true });
  root.append(overlay);

  function closePreview(): void {
    overlay.hidden = true;
    overlay.replaceChildren();
  }

  /** The countdown rule: its remaining length IS the remaining retention. */
  function lifeEl(daysLeft: number, soon: boolean, retentionDays: number, label?: string): HTMLElement {
    const pct = Math.max(2, Math.min(100, Math.round((daysLeft / Math.max(1, retentionDays)) * 100)));
    const fill = el("div", { class: "life__fill" });
    fill.style.width = `${pct}%`;
    return el(
      "div",
      { class: soon ? "life is-soon" : "life" },
      el("div", { class: "life__track" }, fill),
      el("div", { class: "life__label", text: label ?? `${daysLeft} ${daysLeft === 1 ? "day" : "days"} left` }),
    );
  }

  /**
   * A row's tile — the REAL preview wherever there is one, through the SAME
   * thumbnail facade the library gallery paints with (render/thumbnails.ts).
   *
   * Deciding whether to restore something deleted a fortnight ago starts with
   * recognising it, and a column of identical doc glyphs answers nothing that a
   * column of names has not already answered. So:
   *
   *  - a `.note` gets a canvas painted by the shared lazy engine off the same
   *    `firstPage` ref — and therefore the same render-cache entry — the
   *    library filled; the `thumb` hint is what lets its server-extracted
   *    COVER come off `/thumbnail/{hash}` (content-addressed, so it serves
   *    trashed blobs too) before spending a client render, exactly as the
   *    gallery does. The bin-scoped page fetch is `createBinScope`'s job.
   *  - an image and every {@link FACADE_THUMB_TYPES} member — `.spd`, `.txt`,
   *    `.pdf` — get an engine-managed `<img>` the facade fills with its
   *    tier-sized WebP: a `.spd`'s extracted embedded thumbnail, a `.txt`'s
   *    rasterised snippet, a `.pdf`'s page 0 rendered client-side, an image
   *    fetched ONCE per hash and downscaled (never the raw multi-MB photo per
   *    row). The `bin: true` on the hint routes the raw-file strategies —
   *    including the PDF's byte ranges — to the bin-scoped endpoint, because
   *    the live `/file/{id}` 404s for anything trashed. A trashed PDF that
   *    will not render degrades to the facade's glyph inside the same `<img>`,
   *    which is the whole reason it goes through the facade rather than 404ing
   *    its way to a broken tile.
   *
   * THE FALLBACKS STAY HONEST, and each is a different fact:
   *  - a folder is a container, and gets the folder glyph;
   *  - a note with no renderable page — an unparseable blob, an index row that
   *    never landed — keeps the doc glyph. An empty canvas would be a promise
   *    of ink that is not coming. (For the facade kinds the glyph is the
   *    facade's own floor, so the tile degrades inside the same `<img>`.)
   */
  function thumb(entry: BinEntry): {
    node: HTMLElement;
    /** The engine slot to register, or null for a tile nothing paints into. */
    target: HTMLCanvasElement | HTMLImageElement | null;
    hint?: LazySlotInput["thumb"];
  } {
    if (entry.kind === "folder") {
      return { node: el("div", { class: "bin__thumb is-folder", html: svg(ICONS.folder, 1.7) }), target: null };
    }
    const type = (entry.fileType || "").trim().toLowerCase();
    const kind = fileKind(type);
    // `aspect` (the entry's true canvas shape) lets the shared facade crop a
    // `.spd`'s letterboxed embedded preview at transcode — the SAME cropped WebP
    // the gallery gets, so a bin-first view can't poison the cache with an
    // uncropped one. Absent for types with no letterbox to remove.
    const hint: LazySlotInput["thumb"] = {
      fileType: type || "note",
      fileHash: entry.fileHash,
      bin: true,
      aspect: entry.thumbAspect,
    };
    if (kind === "image" || FACADE_THUMB_TYPES.has(type)) {
      // `alt=""`: the row's own name already labels it, and the tile is
      // decoration on a labelled control rather than content of its own.
      const img = el("img", { loading: "lazy", decoding: "async", alt: "" }) as HTMLImageElement;
      const tile = el("div", { class: "bin__thumb is-image" }, img);
      if (!preclampAspect(tile, entry) && learnsAspect(type) && entry.fileHash) {
        // An image and a `.pdf` state no `thumbAspect`; their aspect sources are
        // the memo — which answers for every hash seen anywhere in the app
        // before — and, on a hash's first-ever view, the decoded tile itself:
        // the library row's single allowed reflow, mirrored here. Idempotent
        // when both fire (they state the same shape), and the memo WRITE is the
        // facade's (an image's dims on first decode, a PDF's page-0 box after
        // its render), so later sessions pre-clamp.
        //
        // Until either answers, a `.pdf` stands on A4 portrait rather than on
        // the CSS floor — an `<img>` with no `src` measures SQUARE (the 1×1 GIF
        // the styles substitute for the broken-image icon), which is the one
        // shape a document never is. See `provisionalAspect`.
        const provisional = provisionalAspect(type);
        if (provisional !== null) pinAspect(tile, provisional, true);
        const correct = (w: number, h: number): void => {
          if (tile.isConnected && w > 0 && h > 0) pinAspect(tile, w / h, true);
        };
        void getDims(entry.fileHash).then((dims) => {
          if (dims) correct(dims.w, dims.h);
        });
        img.addEventListener("load", () => correct(img.naturalWidth, img.naturalHeight), { once: true });
      }
      return { node: tile, target: img, hint };
    }
    if (kind === "note" && entry.firstPage) {
      const canvas = el("canvas") as HTMLCanvasElement;
      const tile = el("div", { class: "bin__thumb is-page" }, canvas);
      // A note DOES state its shape now, so the lead is its final width from
      // first paint — and a landscape page gets an honestly wide box for the
      // blit instead of being squashed into the fixed 3:4 one.
      preclampAspect(tile, entry);
      return { node: tile, target: canvas, hint };
    }
    return {
      node: el("div", { class: "bin__thumb" }, el("span", { class: "bin__thumb-mark", html: svg(ICONS.doc, 1.4) })),
      target: null,
    };
  }

  /**
   * A row's two decisions, now behind the app's ONE overflow "…" menu (the same
   * `ui/menu.ts` component the library grid and list rows use), so a trashed file
   * offers the identical controls whether it is seen as a bin row or opened in a
   * viewer. The countdown rule now owns the row's width uninterrupted.
   *
   * Restore is NEUTRAL — the safe direction, no dialog. "Delete permanently" is
   * the one red `menu__item--danger` in the app, and its confirm still travels
   * with it: the item calls `actions.purge`, which routes through the controller's
   * dialog (`purgeConfirm`), so no caller reaches the irreversible half without it.
   * The trigger names the row (a screen reader meeting a column of "Actions"
   * buttons learns nothing otherwise).
   */
  function actionsMenu(row: BinRow, actions: BinActions, busy: boolean): HTMLElement {
    return el(
      "div",
      { class: "bin__actions" },
      createMenu({
        triggerLabel: busy ? `Working on ${row.entry.name}` : `Actions for ${row.entry.name}`,
        // BOTH actions go at once, because the row has one operation in flight
        // and neither of them is available until it settles. The control stays
        // where it is rather than vanishing — a button that disappears teaches
        // nothing about why.
        disabled: busy,
        items: [
          { label: "Restore", icon: "restore", onSelect: () => actions.restore(row) },
          { label: "Delete permanently", icon: "trashX", danger: true, onSelect: () => actions.purge(row) },
        ],
      }),
    );
  }

  function rowEl(row: BinRow, retentionDays: number, actions: BinActions, busy: boolean): HTMLElement {
    const e = row.entry;
    const body = el(
      "div",
      { class: "bin__body" },
      // Device-authored name → text, never markup. Same rule the rail follows.
      el("div", { class: "bin__name", text: e.name }),
      el(
        "div",
        { class: "bin__meta" },
        // A child's path would just repeat the folder named directly above it.
        row.child ? null : el("span", { class: "bin__path", text: folderLabel(e.path, e.name) }),
        row.child ? null : el("span", { class: "bin__dot" }),
        el("span", { text: row.detail }),
        el("span", { class: "bin__dot" }),
        // The other half of the disambiguation: same name, same place, deleted
        // twice — only the time tells them apart.
        el("span", { text: row.time }),
      ),
    );

    const { node: tile, target, hint } = thumb(e);
    let lead: HTMLElement;
    if (row.openable) {
      const btn = el("button", { class: "bin__open", type: "button" }, tile, body);
      btn.addEventListener("click", () => actions.open(e));
      lead = btn;
    } else {
      lead = el("div", { class: "bin__open is-static" }, tile, body);
    }
    // Registered here rather than at paint time so the engine sees the target in
    // the same tick the row is built, exactly as `noteCard` does in library.ts.
    // `page` may honestly be absent for a facade tile (`.spd`/`.txt`/image) —
    // their strategies never touch pages.
    if (target) engine.add({ target, noteId: e.id, page: e.firstPage ?? undefined, size: "thumb", thumb: hint });

    return el(
      "div",
      {
        // `is-busy` dims the row while its own restore/purge travels; `aria-busy`
        // is the same fact for a screen reader, which cannot see the dimming.
        class: `${row.child ? "bin__row is-child" : "bin__row"}${busy ? " is-busy" : ""}`,
        ...(busy ? { "aria-busy": "true" } : {}),
      },
      lead,
      lifeEl(row.daysLeft, row.soon, retentionDays),
      actionsMenu(row, actions, busy),
    );
  }

  function emptyState(title: string, bodyText: string): HTMLElement {
    return el(
      "div",
      { class: "empty" },
      el("div", { class: "empty__mark", text: "Recycle bin" }),
      el("h3", { text: title }),
      el("p", { text: bodyText }),
    );
  }

  return {
    isMounted: () => gallery.contains(section),

    render(model, actions): void {
      // Sort and the view toggle describe a folder LISTING, and the bin's rows
      // are its own layout — neither control has anything here to order or to
      // lay out. They go by the same rule that takes them away over search
      // results, and the shell's own `renderGallery` restores them on every
      // navigation out of here.
      sortWrap.hidden = true;
      segmented.hidden = true;
      // "Library / Recycle bin", with Library a way OUT. A lone `here` crumb left
      // the header a dead end — fine when the rail row you arrived by was still
      // one click away, wrong now that Storage's `Open` sends people here from
      // the account page. Same shape the account page uses, so the two
      // destinations leave the same way.
      const home = el("button", { type: "button", text: "Library" });
      home.addEventListener("click", () => onLeave());
      crumbs.replaceChildren(
        home,
        el("span", { class: "crumbs__sep", text: "/" }),
        el("span", { class: "crumbs__here", text: "Recycle bin" }),
      );
      // The rest of the mode: the search box leaves and `Empty bin` arrives. The
      // shell owns both elements, so it is told the mode rather than reaching in
      // — see `BinViewOptions.setMode`. Told on EVERY render because the count is
      // what decides whether the control is live, and a purge changes it.
      setMode(true, model.rows.length, model.emptying);

      // `is-bin` neutralises the gallery's grid: this is a list of rows, not a
      // wall of tiles.
      gallery.className = "gallery is-bin";
      // The canvases about to be replaced are still registered with the shared
      // engine. Dropping them here is what keeps a repaint after a purge from
      // leaving the engine holding slots for rows that no longer exist.
      engine.reset();
      section.replaceChildren();

      if (model.state === "error") {
        // Deliberately NOT the empty state. "Nothing deleted" over a failed
        // listing is indistinguishable from a bin that really is empty — to
        // somebody who is at that moment deciding whether their file still
        // exists.
        section.append(emptyState("Couldn’t load the bin", "Check your connection and try again."));
        gallery.replaceChildren(section);
        return;
      }
      if (model.state === "loading" && model.rows.length === 0) {
        section.append(emptyState("Loading…", "Fetching what you’ve deleted."));
        gallery.replaceChildren(section);
        return;
      }
      if (model.rows.length === 0) {
        // U7: the absence is informative — what the bin is for, and how long
        // things last, quoted from the server rather than hardcoded here.
        section.append(emptyState("Nothing deleted", emptyStateBody(model.retentionDays)));
        gallery.replaceChildren(section);
        return;
      }

      section.append(
        el(
          "div",
          { class: "bin__head" },
          // The asymmetry (U6), once, where the consequence is visible: this is
          // the screen where someone is deciding whether a file still exists on
          // the device.
          el(
            "div",
            { class: "bin__aside" },
            el("b", { text: "Deleted files are removed from your Supernote too." }),
            document.createTextNode(
              ` Restoring one puts it back on your device at the next sync. Everything here is removed for good after ${model.retentionDays} days.`,
            ),
          ),
        ),
      );

      const busy = new Set(model.busy);
      let group: string | null = null;
      let rows: HTMLElement | null = null;
      for (const row of model.rows) {
        if (row.group !== group) {
          group = row.group;
          section.append(el("div", { class: "bin__group", text: group }));
          rows = el("div", { class: "bin__rows" });
          section.append(rows);
        }
        rows?.append(rowEl(row, model.retentionDays, actions, busy.has(row.entry.id)));
      }
      gallery.replaceChildren(section);
    },

    preview(row, retentionDays, actions): void {
      const e = row.entry;
      const src = binFileUrl(e);
      const kind = fileKind(e.fileType);
      const back = el("button", { class: "backbtn", type: "button" }, el("span", { html: svg('<path d="m15 18-6-6 6-6"/>', 1.8) }), el("span", { text: "Recycle bin" }));
      back.addEventListener("click", closePreview);

      const restore = el("button", { class: "btn", type: "button", text: "Restore", "aria-label": `Restore ${e.name}` });
      restore.addEventListener("click", () => {
        closePreview();
        actions.restore(row);
      });
      const del = el("button", { class: "btn is-danger", type: "button", text: "Delete", "aria-label": `Delete ${e.name} permanently` });
      del.addEventListener("click", () => {
        closePreview();
        actions.purge(row);
      });

      const stage =
        kind === "image" && src
          ? el("img", { class: "bin-preview__img", src, alt: e.name })
          : el(
              "div",
              { class: "empty" },
              el("div", { class: "empty__mark", text: (e.fileType || "file").toUpperCase() }),
              el("h3", { text: "No preview for this file" }),
              el("p", { text: `${(e.fileType || "file").toUpperCase()} · ${formatBytes(e.size)}. Download it if you need to look inside before deciding.` }),
              // No Export here: this file is on its way out. A download is a
              // different promise — it takes a copy of what is about to go.
              src ? el("a", { class: "btn", href: binFileUrl(e, { download: true }) ?? src, download: e.name, text: "Download" }) : null,
            );

      overlay.replaceChildren(
        el(
          "div",
          { class: "bin-preview__bar" },
          back,
          el("div", { class: "bin-preview__title" }, el("b", { text: e.name }), // Same treatment as the row's own path line: the raw server path would
          // repeat the name shown beside it and name a container the rail hides.
          el("span", { text: `${folderLabel(e.path, e.name)} · ${row.detail}` })),
          el("div", { class: "bin-preview__spacer" }),
          // The deadline stays in view while the decision is being made.
          lifeEl(row.daysLeft, row.soon, retentionDays, `${row.group} · ${row.daysLeft} days left`),
          restore,
          del,
        ),
        el("div", { class: "bin-preview__stage" }, stage),
      );
      overlay.hidden = false;
      back.focus();
    },

    confirm(spec): Promise<boolean> {
      const frees = spec.frees
        ? el("div", { class: "confirm__frees" }, document.createTextNode("Frees "), el("b", { text: spec.frees }))
        : null;
      return openDialog({
        host: root,
        classes: {
          dialog: "confirm",
          body: "confirm__body",
          actions: "confirm__actions",
          cancel: "btn",
          go: "btn is-danger",
        },
        goLabel: spec.action,
        cancelLabel: "Cancel",
        labelledBy: "bin-confirm-title",
        build: (body, { go }) => {
          // The destructive button repeats the sentence it performs, for a
          // screen reader that reaches it out of the body's context.
          go.setAttribute("aria-label", spec.action);
          body.append(el("h2", { id: "bin-confirm-title", text: spec.title }), el("p", { text: spec.body }));
          if (frees) body.append(frees);
        },
      }).done;
    },

    toast(message, o = {}): void {
      toastMsg.textContent = message;
      toastSub.textContent = o.sub ?? "";
      toastSub.hidden = !o.sub;
      toastAction.hidden = !o.undo;
      if (o.undo) {
        toastAction.textContent = "Undo";
        toastAction.onclick = () => {
          hideToast();
          o.undo?.();
        };
      } else {
        toastAction.onclick = null;
      }
      toastEl.classList.add("is-shown");
      if (toastTimer !== undefined) clearTimeout(toastTimer);
      // An undo has to outlast reading the sentence that offers it; a plain
      // report does not.
      toastTimer = setTimeout(hideToast, o.undo ? 8000 : 2600);
    },

    destroy(): void {
      hideToast();
      closePreview();
      // The confirm dialog is built per call and removes itself on close
      // (src/ui/confirm.ts), so there is no persistent node to tear down here.
      toastEl.remove();
      overlay.remove();
    },
  };
}
