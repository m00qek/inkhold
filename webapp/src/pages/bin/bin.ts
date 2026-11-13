// The recycle bin: a soft-delete tier with restore, for files and, while the
// server keeps them, digests. Everything that decides what is on screen
// (order, nesting, countdown, copy) is data behind a `BinView` seam;
// `createBinView` is the DOM half. It paints into the gallery element, so the
// shell's next `renderGallery()` closes it without a teardown hook, and it is
// a topbar mode (search hidden, `Empty bin` shown).

import { formatBytes, hasDedicatedViewer } from "../../core/fileKind";
// Images carry no `thumbAspect`; the dims memo is their aspect source.
import type { Api } from "../../api/types";
import type { Bin, BinEntry, Restored, Trashed } from "../../core/binTypes";
import type { Id } from "../../core/types";
import type { DigestBin } from "../../api/digestTypes";
import { ApiError } from "../../api/errors";
import {
  DEVICE_LINE, plural, type BinItem, binItems, type BinRow, binRows, type ConfirmSpec, type DigestBinRow, digestBinRows, digestName,
  purgeConfirm, purgeDigestConfirm, emptyConfirm, restoreDigestMessage, restoreMessage, trashMessage,
} from "./binCopy";
export { DEVICE_LINE, groupLabel, binRows, binItems, digestBinRows, purgeConfirm, purgeDigestConfirm, emptyConfirm, restoreMessage, trashMessage, folderLabel, emptyStateBody } from "./binCopy";
export type { BinItem, BinRow, ConfirmSpec, DigestBinRow } from "./binCopy";
export { createBinScope, binFileUrl, createBinView } from "./binView";
export type { BinScope, BinViewOptions } from "./binView";

export const BIN_KEY = "bin";

// ---- the seams ----

export interface BinModel {
  state: "loading" | "ready" | "error";
  /** Files and digests, the latest deleted first. */
  items: BinItem[];
  /** The server keeps digests: the bin speaks of them too. */
  digestsOn: boolean;
  retentionDays: number;
  totalBytes: number;
  /** Rows with a restore or purge in flight (`busyKey`); busy and inert. */
  busy: readonly string[];
  emptying: boolean;
}

/** A row's key among the busy: a file's id, a digest's prefixed, since the two number apart. */
export function busyKey(item: BinItem): string {
  return item.kind === "file" ? `f:${item.row.entry.id}` : `d:${item.row.digest.id}`;
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
  restoreDigest(row: DigestBinRow): void;
  purgeDigest(row: DigestBinRow): void;
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
  /** A digest came out of the bin: the Digest page reads again. */
  onDigestsChanged(): void;
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
  /** Something went to the bin elsewhere (a digest from the Digest page): read it again. */
  refresh(): void;
  /** Derived from mounting, never a second copy of state. */
  isOpen(): boolean;
  count(): number;
  /** Trashed notes must be read through the bin-scoped routes (`createBinScope`). */
  isTrashed(id: Id): boolean;
  pathOf(id: Id): string | null;
  /** So a viewer opened from the bin paints the same countdown as the row. */
  retentionOf(id: Id): { daysLeft: number; soon: boolean; retentionDays: number } | null;
  trash(entry: { id: Id; name: string; kind: "folder" | "note" }): Promise<void>;
  /** A digest to the bin, as a file goes: no confirmation, the device line, and Undo. True when it went. */
  trashDigest(digest: { id: string; text: string }): Promise<boolean>;
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
  let digests: DigestBin | null = null;
  /** The last digest listing failed: what shows may be stale, and Empty bin leaves digests alone. */
  let digestsUnlisted = false;
  let state: BinModel["state"] = "loading";
  /** Bumped per refresh; a stale response is discarded, not painted. */
  let token = 0;

  /**
  * Entries whose restore or purge is in flight. A repeat click is a no-op and
  * the pending row is painted busy; otherwise a slow-link double click reports
  * "Couldn't restore" for an operation that succeeded. Released on both arms
  * and held across the following refresh.
  */
  const inFlight = new Set<string>();
  let emptying = false;

  const digestRows = (): DigestBinRow[] => (digests?.enabled ? digestBinRows(digests) : []);
  const digestCount = (): number => (digests?.enabled ? digests.digests.length : 0);

  function model(): BinModel {
    return {
      state,
      items: binItems(bin ? binRows(bin) : [], digestRows()),
      digestsOn: digests?.enabled === true,
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
    restoreDigest: (row) => void restoreDigest(row),
    purgeDigest: (row) => void purgeDigest(row),
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
      m.digestsOn,
      m.items.map((i) => (i.kind === "file" ? [i.row.entry.id, i.row.child, i.row.daysLeft, i.row.soon, i.row.detail, i.row.openable] : [`d:${i.row.digest.id}`, i.row.daysLeft, i.row.soon, i.row.detail])),
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
      // The files are the bin's own; the digests come beside them. A failed
      // digest listing keeps the last one on screen, never takes the files with it.
      const [files, digestsRead] = await Promise.allSettled([api.listBin(), api.digestBin()]);
      if (mine !== token) return;
      if (files.status === "rejected") throw files.reason;
      bin = files.value;
      digestsUnlisted = digestsRead.status === "rejected";
      if (digestsRead.status === "fulfilled") digests = digestsRead.value;
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

  /**
   * A row's restore or permanent delete, files' and digests' alike: one at a
   * time per row (`inFlight`), after the confirm when there is one (the row is
   * not marked busy while it is open: nothing has been agreed yet), its result
   * said, and the bin read again. True only when it went through.
   */
  async function act(key: string, o: {
    confirm?: ConfirmSpec;
    call: () => Promise<unknown>;
    /** What went through, in words; given the call's answer. */
    done: (answer: unknown) => string;
    failed: (e: unknown) => string;
    /** A file came or went: the library refetches. */
    mutated: boolean;
    after?: () => void;
  }): Promise<boolean> {
    if (inFlight.has(key)) return false; // already travelling — see `inFlight`
    if (o.confirm && !(await view.confirm(o.confirm))) return false;
    if (inFlight.has(key)) return false; // something else started while it was open
    inFlight.add(key);
    paint(); // the click that was made becomes visible
    let ok = false;
    try {
      try {
        view.toast(o.done(await o.call()));
        ok = true;
        o.after?.();
      } catch (e) {
        if (deps.handled(e)) return false;
        view.toast(o.failed(e));
      }
      await refresh(o.mutated);
    } finally {
      inFlight.delete(key);
      paint();
    }
    return ok;
  }

  const restore = (row: BinRow): Promise<boolean> =>
    act(busyKey({ kind: "file", row }), {
      call: () => api.restoreEntry(row.entry.id),
      done: (r) => restoreMessage(r as Restored),
      failed: () => `Couldn’t restore ${row.entry.name}. Try again.`,
      mutated: true,
    });

  const purge = (row: BinRow): Promise<boolean> =>
    act(busyKey({ kind: "file", row }), {
      confirm: purgeConfirm(row),
      call: () => api.purgeEntry(row.entry.id),
      done: () => (row.bytes > 0 ? `Deleted ${row.entry.name} — ${formatBytes(row.bytes)} freed` : `Deleted ${row.entry.name}`),
      failed: () => `Couldn’t delete ${row.entry.name}. Try again.`,
      mutated: true,
    });

  /** A digest back where it was; the Digest page reads again. */
  const restoreDigest = (row: DigestBinRow): Promise<boolean> =>
    act(busyKey({ kind: "digest", row }), {
      call: () => api.digestRestore(row.digest.id),
      done: () => restoreDigestMessage(row.restoresTo),
      failed: (e) =>
        e instanceof ApiError && e.code === "BACK_ALREADY"
          ? "Your Supernote sent this digest back already: it is in Digest."
          : `Couldn’t restore ${digestName(row.digest.text)}. Try again.`,
      mutated: false,
      after: deps.onDigestsChanged,
    });

  const purgeDigest = (row: DigestBinRow): Promise<boolean> =>
    act(busyKey({ kind: "digest", row }), {
      confirm: purgeDigestConfirm(row),
      call: () => api.digestPurge(row.digest.id),
      done: () => `Deleted ${digestName(row.digest.text)}`,
      failed: () => `Couldn’t delete ${digestName(row.digest.text)}. Try again.`,
      mutated: false,
    });

  /**
   * To the bin, a file or a digest: no confirmation, since it can be undone, so
   * it acts and offers Undo, with the device line said every time. Null when it
   * did not go (the person was told).
   */
  async function toBin<T>(o: {
    call: () => Promise<T>;
    name: string;
    moved: (t: T) => string;
    undo: (t: T) => Promise<string>;
    mutated: boolean;
  }): Promise<T | null> {
    let done: T;
    try {
      done = await o.call();
    } catch (e) {
      if (!deps.handled(e)) view.toast(`Couldn’t delete ${o.name}. Try again.`);
      return null;
    }
    view.toast(o.moved(done), {
      sub: DEVICE_LINE,
      undo: () => {
        void (async () => {
          try {
            view.toast(await o.undo(done));
          } catch (e) {
            if (deps.handled(e)) return;
            view.toast(`Couldn’t put ${o.name} back. It is in the Recycle bin.`);
          }
          await refresh(o.mutated);
        })();
      },
    });
    return done;
  }

  async function empty(): Promise<void> {
    if (emptying) return; // one at a time — see `inFlight`
    if (!bin) return;
    // Only digests just listed go: the server takes none it was not asked for.
    const withDigests = !digestsUnlisted;
    if (bin.entries.length + (withDigests ? digestCount() : 0) === 0) {
      if (!withDigests) view.toast("Couldn’t list the digests. Try again.");
      return;
    }
    const freed = bin.totalBytes;
    if (!(await view.confirm(emptyConfirm(bin, withDigests ? digestCount() : 0, !withDigests)))) return;
    if (emptying) return;
    emptying = true;
    paint();
    try {
      try {
        const n = await api.emptyBin(withDigests);
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
    refresh: () => void refresh(false),
    isOpen: () => view.isMounted(),
    count: () => (bin?.entries.length ?? 0) + digestCount(),
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
      const done = await toBin({
        call: () => api.trashEntry(entry.id),
        name: entry.name,
        moved: (t: Trashed) => trashMessage(t),
        undo: async (t: Trashed) => restoreMessage(await api.restoreEntry(t.id)),
        mutated: true,
      });
      if (done) await refresh(true);
    },

    async trashDigest(digest): Promise<boolean> {
      const name = digestName(digest.text);
      const done = await toBin({
        call: () => api.digestDelete(digest.id),
        name,
        moved: () => `Moved ${name} to Recycle bin`,
        undo: async () => {
          await api.digestRestore(digest.id);
          deps.onDigestsChanged();
          return `Restored ${name} — back on your Supernote at the next sync`;
        },
        mutated: false,
      });
      if (done === null) return false;
      // The count catches up on its own: the person is not kept waiting for it.
      void refresh(false);
      return true;
    },

    destroy(): void {
      // Orphans any in-flight listing on teardown.
      token++;
      view.destroy();
    },
  };
}
