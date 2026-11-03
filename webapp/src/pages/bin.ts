// The recycle bin: a soft-delete tier with restore. Everything that decides
// what is on screen (order, nesting, countdown, copy) is data behind a
// `BinView` seam; `createBinView` is the DOM half. It paints into the gallery
// element, so the shell's next `renderGallery()` closes it without a teardown
// hook, and it is a topbar mode (search hidden, `Empty bin` shown).

import { el } from "../ui/dom";
import { openDialog } from "../ui/confirm";
import { learnsAspect, pinAspect, provisionalAspect } from "../ui/tileAspect";
import { ICONS, svg } from "../ui/icons";
import { createMenu } from "../ui/menu";
import { labelPathSegments } from "./rail";
import { FACADE_THUMB_TYPES } from "./galleryCards";
import { fileKind, formatBytes, hasDedicatedViewer, rawFileUrl } from "../core/fileKind";
// Images carry no `thumbAspect`; the dims memo is their aspect source.
import { getDims } from "../cache/dimsMemo";
import type { Api } from "../api/types";
import type { LazyEngine, LazySlotInput } from "../render/lazy";
import type { Bin, BinEntry, Restored, Trashed } from "../core/binTypes";
import type { Hash, Id, PageRef, PageText } from "../core/types";
import type { FileHistory } from "../core/types";
import type { NoteMeta } from "../core/types";

export const BIN_KEY = "bin";

const DAY_MS = 24 * 60 * 60 * 1000;

const SOON_DAYS = 5;

/** False when the entry states no shape; the caller may use the dims memo. */
function preclampAspect(tile: HTMLElement, entry: BinEntry): boolean {
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

function plural(n: number, one: string): string {
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

// ---- the seams ----

export interface BinModel {
  state: "loading" | "ready" | "error";
  rows: BinRow[];
  retentionDays: number;
  totalBytes: number;
  /** Ids with a restore or purge in flight; their rows are busy and inert. */
  busy: readonly Id[];
  emptying: boolean;
}

export interface ToastOpts {
  sub?: string;
  /** Its presence holds the toast long enough to use. */
  undo?: () => void;
}

/** Passed on every render, so view and controller needn't reference each other. */
export interface BinActions {
  open(entry: BinEntry): void;
  restore(row: BinRow): void;
  purge(row: BinRow): void;
  // No `empty` here: it's the topbar's `Empty bin` (`BinController.empty`).
}

export interface BinView {
  render(model: BinModel, actions: BinActions): void;
  /** For images and files with no preview; kinds with a real viewer go there. */
  preview(row: BinRow, retentionDays: number, actions: BinActions): void;
  isMounted(): boolean;
  confirm(spec: ConfirmSpec): Promise<boolean>;
  toast(message: string, opts?: ToastOpts): void;
  destroy(): void;
}

export interface BinDeps {
  api: Api;
  view: BinView;
  /**
  * The shell routes it (so Back and reload work) with a `"bin"` origin, which
  * makes the viewer's Back land here and swaps its actions to Restore / Delete.
  */
  onOpen(entry: BinEntry): void;
  onChanged(mutated: boolean): void;
  /** True means a dead session was handled; paint no error of our own. */
  handled(e: unknown): boolean;
}

export interface BinController {
  open(): void;
  /**
  * Resolves once a listing is in hand, without painting, for a cold
  * `#/bin/note/:id` deep link. Reuses the boot-time fetch.
  */
  ensureLoaded(): Promise<void>;
  /** Exposed for the topbar control; the confirm travels with it. */
  empty(): void;
  /** Derived from mounting, never a second copy of state. */
  isOpen(): boolean;
  count(): number;
  /** Trashed notes must be read through the bin-scoped routes (`createBinScope`). */
  isTrashed(id: Id): boolean;
  pathOf(id: Id): string | null;
  /** So a viewer opened from the bin paints the same countdown as the row. */
  retentionOf(id: Id): { daysLeft: number; soon: boolean; retentionDays: number } | null;
  trash(entry: { id: Id; name: string; kind: "folder" | "note" }): Promise<void>;
  /** True only when the entry came back, so the viewer knows to leave. */
  restore(id: Id): Promise<boolean>;
  /** Confirm included; true only when the entry is really gone. */
  purge(id: Id): Promise<boolean>;
  destroy(): void;
}

// ---- the controller ----

export function createBin(deps: BinDeps): BinController {
  const { api, view } = deps;

  let bin: Bin | null = null;
  let state: BinModel["state"] = "loading";
  /** Bumped per refresh; a stale response is discarded, not painted. */
  let token = 0;

  /**
  * Entries whose restore or purge is in flight. A repeat click is a no-op and
  * the pending row is painted busy; otherwise a slow-link double click reports
  * "Couldn't restore" for an operation that succeeded. Released on both arms
  * and held across the following refresh.
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
    // Kinds with a real viewer are routed by the shell with a `"bin"` origin;
    // images and unknown types get this module's preview panel.
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

  function rowFor(id: Id): BinRow | null {
    return (bin ? binRows(bin) : []).find((r) => r.entry.id === id) ?? null;
  }

  /**
  * A signature of what a render would paint; an unchanged one skips the
  * repaint, which would otherwise detach an open row menu.
  */
  function renderKey(m: BinModel): string {
    return JSON.stringify([
      m.state,
      m.retentionDays,
      m.totalBytes,
      // Busy flags are painted, so they're part of the signature.
      m.busy,
      m.emptying,
      m.rows.map((r) => [r.entry.id, r.child, r.daysLeft, r.soon, r.detail, r.openable]),
    ]);
  }
  let lastRenderKey: string | null = null;

  /** Unconditional: on open the section may need re-mounting. */
  function renderNow(m: BinModel): void {
    view.render(m, actions);
    lastRenderKey = renderKey(m);
  }

  function paint(): void {
    if (!view.isMounted()) return;
    const m = model();
    if (renderKey(m) === lastRenderKey) return;
    renderNow(m);
  }

  async function refresh(mutated = false): Promise<void> {
    const mine = ++token;
    // A retry out of `error` shows as loading. Not out of `ready`: a refresh after
    // a restore must not blank a good list; rows show their own busy state.
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
      // Distinct from an empty bin: the reader is deciding whether a file still exists.
      state = "error";
    }
    paint();
    // `mutated` separates a badge change from a library change, so the boot
    // listing doesn't make the shell refetch a folder.
    deps.onChanged(mutated);
  }

  // One listing at start-up for the rail badge, then one per change; no polling.
  // Kept so `ensureLoaded` can await it.
  let firstLoad: Promise<void> | null = refresh();

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

  async function purge(row: BinRow): Promise<boolean> {
    const id = row.entry.id;
    if (inFlight.has(id)) return false;
    // The row isn't marked busy for the confirm; nothing has been agreed yet.
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
      // Also set here because `renderNow` runs before `refresh` does.
      if (state === "error") state = "loading";
      // Paint what's in hand first (the count was fetched for the badge); the
      // recorded signature lets the identical refresh skip its repaint.
      renderNow(model());
      void refresh();
    },

    async ensureLoaded(): Promise<void> {
      if (bin) return; // already have a listing
      // Await the boot fetch; if it failed, fetch once more.
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
    retentionOf: (id) => {
      const row = rowFor(id);
      return row ? { daysLeft: row.daysLeft, soon: row.soon, retentionDays: bin?.retentionDays ?? 30 } : null;
    },

    // Same internal path as the row actions, so a viewer can't bypass the
    // confirm. An unknown id is a quiet false.
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
      // No confirmation: reversible, so it acts and offers undo. The device line is
      // said every time.
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
      // Orphans any in-flight listing on teardown.
      token++;
      view.destroy();
    },
  };
}

// ---- the bin-scoped read seam ----

/**
* Routes reads for a trashed id through the bin's own endpoints. The server's
* `Files.get` hardcodes `deleted = 0` and stays the ownership boundary, so the
* bin has parallel routes; wrapping the shell's `Api` keeps the reader, lazy
* engine and exporter unaware. `attach` is late because the bin controller is
* built after the reader.
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
        // Trashing only tombstones, so the md5-keyed transcript survives; the bin has
        // its own text route.
        getPageText: (id: Id, page: PageRef): Promise<PageText> =>
          isTrashed(id) ? api.binPageText(id, page) : api.getPageText(id, page),
        // In-note find needs no reroute: it is keyed by blob md5, which a trashed file
        // keeps. Version history follows a file into the bin and is view-only there;
        // `historyScope` composes outside this wrapper and hits these same methods.
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

// ---- the painter ----

/**
* The live `/file/{id}` 404s for trashed files. Null without a hash: the route
* requires `?v=`, which is what makes its `immutable` response honest.
*/
export function binFileUrl(entry: BinEntry, opts: { download?: boolean } = {}): string | null {
  return rawFileUrl(entry.id, entry.fileHash, { ...opts, bin: true });
}

export interface BinViewOptions {
  /** The bin paints into it, so `renderGallery()` closes the bin. */
  gallery: HTMLElement;
  crumbs: HTMLElement;
  sortWrap: HTMLElement;
  segmented: HTMLElement;
  root: HTMLElement;
  /** Shared with the gallery; its `reset()` on the way out is the bin's teardown. */
  engine: LazyEngine;
  /** `busy` is `Empty bin`'s own call in flight. */
  setMode(open: boolean, count: number, busy: boolean): void;
  /** Leave for the library root (the `Library` crumb); the header is otherwise a dead end. */
  onLeave(): void;
}

export function createBinView(opts: BinViewOptions): BinView {
  const { gallery, crumbs, sortWrap, segmented, root, engine, setMode, onLeave } = opts;

  const section = el("section", { class: "bin", "aria-label": "Recycle bin" });

  // ---- the confirm dialog ----
  // Shared `ui/confirm.ts`: Cancel first and default, Esc dismisses.

  // ---- the toast ----
  // The bin's own: an undo needs a second line and a control, and must outlast
  // the shell's 2.4 s toast.
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

  // ---- the preview overlay ----
  // For images and files with no preview only.
  const overlay = el("div", { class: "bin-preview", role: "dialog", "aria-modal": "true", hidden: true });
  root.append(overlay);

  function closePreview(): void {
    overlay.hidden = true;
    overlay.replaceChildren();
  }

  /** Its remaining length is the remaining retention. */
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
  * A row's tile, through the same facade and render-cache entries as the
  * gallery. `bin: true` on the hint routes raw-file strategies (including PDF
  * byte ranges) to the bin endpoint. Folders get the folder glyph, notes with
  * no renderable page the doc glyph.
  */
  function thumb(entry: BinEntry): {
    node: HTMLElement;
    target: HTMLCanvasElement | HTMLImageElement | null;
    hint?: LazySlotInput["thumb"];
  } {
    if (entry.kind === "folder") {
      return { node: el("div", { class: "bin__thumb is-folder", html: svg(ICONS.folder, 1.7) }), target: null };
    }
    const type = (entry.fileType || "").trim().toLowerCase();
    const kind = fileKind(type);
    // Same cropped `.spd` WebP as the gallery, so a bin-first view can't cache an uncropped one.
    const hint: LazySlotInput["thumb"] = {
      fileType: type || "note",
      fileHash: entry.fileHash,
      bin: true,
      aspect: entry.thumbAspect,
    };
    if (kind === "image" || FACADE_THUMB_TYPES.has(type)) {
      const img = el("img", { loading: "lazy", decoding: "async", alt: "" }) as HTMLImageElement;
      const tile = el("div", { class: "bin__thumb is-image" }, img);
      if (!preclampAspect(tile, entry) && learnsAspect(type) && entry.fileHash) {
        // Until the memo or the decoded tile answers, a `.pdf` stands on A4: an
        // `<img>` with no `src` measures square.
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
      preclampAspect(tile, entry);
      return { node: tile, target: canvas, hint };
    }
    return {
      node: el("div", { class: "bin__thumb" }, el("span", { class: "bin__thumb-mark", html: svg(ICONS.doc, 1.4) })),
      target: null,
    };
  }

  /**
  * The shared overflow menu. Restore is neutral; "Delete permanently" is the
  * app's one danger item and routes through `purgeConfirm`.
  */
  function actionsMenu(row: BinRow, actions: BinActions, busy: boolean): HTMLElement {
    return el(
      "div",
      { class: "bin__actions" },
      createMenu({
        triggerLabel: busy ? `Working on ${row.entry.name}` : `Actions for ${row.entry.name}`,
        // Both actions disable while one is in flight; the control stays visible.
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
      el("div", { class: "bin__name", text: e.name }),
      el(
        "div",
        { class: "bin__meta" },
        // A child's path would repeat the folder above it.
        row.child ? null : el("span", { class: "bin__path", text: folderLabel(e.path, e.name) }),
        row.child ? null : el("span", { class: "bin__dot" }),
        el("span", { text: row.detail }),
        el("span", { class: "bin__dot" }),
        // Same name, same place, deleted twice: only the time tells them apart.
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
    // `page` may be absent for facade tiles; their strategies never touch pages.
    if (target) engine.add({ target, noteId: e.id, page: e.firstPage ?? undefined, size: "thumb", thumb: hint });

    return el(
      "div",
      {
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
      // Sort and view describe a folder listing; `renderGallery` restores them.
      sortWrap.hidden = true;
      segmented.hidden = true;
      // Library is a way out: the account page's `Open` sends people here directly.
      const home = el("button", { type: "button", text: "Library" });
      home.addEventListener("click", () => onLeave());
      crumbs.replaceChildren(
        home,
        el("span", { class: "crumbs__sep", text: "/" }),
        el("span", { class: "crumbs__here", text: "Recycle bin" }),
      );
      // Told every render: the count decides whether `Empty bin` is live.
      setMode(true, model.rows.length, model.emptying);

      gallery.className = "gallery is-bin";
      // Drop slots for rows about to be replaced.
      engine.reset();
      section.replaceChildren();

      if (model.state === "error") {
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
        // Retention quoted from the server.
        section.append(emptyState("Nothing deleted", emptyStateBody(model.retentionDays)));
        gallery.replaceChildren(section);
        return;
      }

      section.append(
        el(
          "div",
          { class: "bin__head" },
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
              // No Export: a download takes a copy of what is about to go.
              src ? el("a", { class: "btn", href: binFileUrl(e, { download: true }) ?? src, download: e.name, text: "Download" }) : null,
            );

      overlay.replaceChildren(
        el(
          "div",
          { class: "bin-preview__bar" },
          back,
          el("div", { class: "bin-preview__title" }, el("b", { text: e.name }),
          el("span", { text: `${folderLabel(e.path, e.name)} · ${row.detail}` })),
          el("div", { class: "bin-preview__spacer" }),
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
      toastTimer = setTimeout(hideToast, o.undo ? 8000 : 2600);
    },

    destroy(): void {
      hideToast();
      closePreview();
      toastEl.remove();
      overlay.remove();
    },
  };
}
