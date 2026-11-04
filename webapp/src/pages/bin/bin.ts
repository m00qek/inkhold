// The recycle bin: a soft-delete tier with restore. Everything that decides
// what is on screen (order, nesting, countdown, copy) is data behind a
// `BinView` seam; `createBinView` is the DOM half. It paints into the gallery
// element, so the shell's next `renderGallery()` closes it without a teardown
// hook, and it is a topbar mode (search hidden, `Empty bin` shown).

import { formatBytes, hasDedicatedViewer } from "../../core/fileKind";
// Images carry no `thumbAspect`; the dims memo is their aspect source.
import type { Api } from "../../api/types";
import type { Bin, BinEntry, Trashed } from "../../core/binTypes";
import type { Id } from "../../core/types";
import { DEVICE_LINE, plural, type BinRow, binRows, type ConfirmSpec, purgeConfirm, emptyConfirm, restoreMessage, trashMessage } from "./binCopy";
export { DEVICE_LINE, groupLabel, binRows, purgeConfirm, emptyConfirm, restoreMessage, trashMessage, folderLabel, emptyStateBody } from "./binCopy";
export type { BinRow, ConfirmSpec } from "./binCopy";
export { createBinScope, binFileUrl, createBinView } from "./binView";
export type { BinScope, BinViewOptions } from "./binView";

export const BIN_KEY = "bin";

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
