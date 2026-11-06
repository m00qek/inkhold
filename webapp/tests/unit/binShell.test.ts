// The bin controller: what asks, what opens where, by-id actions and shell seams.

import { describe, it, expect, vi } from "vitest";
import { BIN_KEY, DEVICE_LINE, binFileUrl, binRows, createBin, createBinScope, type BinActions, type BinModel, type BinView, type ConfirmSpec } from "../../src/pages/bin/bin";
import { DESTINATIONS } from "../../src/pages/rail/railPlaces";
import type { Api } from "../../src/api/types";
import type { Bin, BinEntry } from "../../src/core/binTypes";

// --- fixtures ----------------------------------------------------------------
import { NOW, entry, bin, FOLDER_DELETE } from "./bin.shared";

function stubView(over: Partial<BinView> = {}): BinView & { rendered: BinModel[]; toasts: { msg: string; sub?: string; undo?: () => void }[]; confirms: ConfirmSpec[] } {
  const rendered: BinModel[] = [];
  const toasts: { msg: string; sub?: string; undo?: () => void }[] = [];
  const confirms: ConfirmSpec[] = [];
  return {
    rendered,
    toasts,
    confirms,
    render: (m) => void rendered.push(m),
    preview: vi.fn(),
    isMounted: () => true,
    confirm: async (spec) => {
      confirms.push(spec);
      return true;
    },
    toast: (msg, o) => void toasts.push({ msg, ...o }),
    destroy: vi.fn(),
    ...over,
  } as BinView & { rendered: BinModel[]; toasts: { msg: string; sub?: string; undo?: () => void }[]; confirms: ConfirmSpec[] };
}

function stubApi(over: Partial<Api> = {}): Api {
  return {
    listBin: async () => FOLDER_DELETE,
    trashEntry: async (id) => ({ id, name: "a.note", isFolder: false, entries: 1 }),
    restoreEntry: async () => ({ name: "a.note", renamed: false, ancestors: 0, descendants: 0 }),
    purgeEntry: async () => undefined,
    emptyBin: async () => 3,
    ...over,
  } as unknown as Api;
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("what asks, and what does not", () => {
  it("trashes with NO dialog, and offers the reverse plus the device line", async () => {
    const view = stubView();
    const controller = createBin({ api: stubApi(), view, onOpen: vi.fn(), onChanged: vi.fn(), handled: () => false });
    await settle();

    await controller.trash({ id: "n1", name: "a.note", kind: "note" });

    expect(view.confirms).toHaveLength(0);
    const last = view.toasts.at(-1)!;
    expect(last.msg).toBe("Moved a.note to Recycle bin");
    expect(last.sub).toBe(DEVICE_LINE);
    expect(typeof last.undo).toBe("function");
  });

  it("purges only after the destructive button is chosen", async () => {
    const purgeEntry = vi.fn(async () => undefined);
    const view = stubView({ confirm: async () => false });
    const controller = createBin({ api: stubApi({ purgeEntry }), view, onOpen: vi.fn(), onChanged: vi.fn(), handled: () => false });
    await settle();

    const actions = captureActions(controller, view);
    actions.purge(binRows(FOLDER_DELETE, NOW)[1]!);
    await settle();

    expect(purgeEntry).not.toHaveBeenCalled();
  });

  it("empties only after the destructive button is chosen, and quotes the freed total", async () => {
    const emptyBin = vi.fn(async () => 3);
    const view = stubView();
    const controller = createBin({ api: stubApi({ emptyBin }), view, onOpen: vi.fn(), onChanged: vi.fn(), handled: () => false });
    await settle();

    controller.empty();
    await settle();

    expect(view.confirms.at(-1)!.title).toBe("Delete all 3 items permanently?");
    expect(emptyBin).toHaveBeenCalled();
    expect(view.toasts.at(-1)!.msg).toContain("2.9 KB freed");
  });

  it("does not paint its own failure over a dead session", async () => {
    const view = stubView();
    createBin({
      api: stubApi({ listBin: async () => Promise.reject(new Error("401")) }),
      view,
      onOpen: vi.fn(),
      onChanged: vi.fn(),
      handled: () => true,
    });
    await settle();

    expect(view.rendered.every((m) => m.state !== "error")).toBe(true);
  });

  it("distinguishes a failed listing from an empty bin", async () => {
    const view = stubView();
    const controller = createBin({
      api: stubApi({ listBin: async () => Promise.reject(new Error("boom")) }),
      view,
      onOpen: vi.fn(),
      onChanged: vi.fn(),
      handled: () => false,
    });
    await settle();
    controller.open();
    await settle();

    expect(view.rendered.at(-1)!.state).toBe("error");
  });
});

// --- what opens where ---------------------------------------------------------

describe("what opens where", () => {
  const MIXED = bin([
    entry({ id: "n", name: "a.note" }),
    entry({ id: "s", name: "sketch.spd", fileType: "spd" }),
    entry({ id: "t", name: "readme.txt", fileType: "txt" }),
    entry({ id: "i", name: "shot.png", fileType: "png" }),
    entry({ id: "p", name: "manual.pdf", fileType: "pdf" }),
  ]);

  it("routes every kind with a real viewer through the shell, and only those", async () => {
    const onOpen = vi.fn();
    const view = stubView();
    const controller = createBin({
      api: stubApi({ listBin: async () => MIXED }),
      view,
      onOpen,
      onChanged: vi.fn(),
      handled: () => false,
    });
    await settle();
    const actions = captureActions(controller, view);
    const of = (id: string) => MIXED.entries.find((e) => e.id === id)!;

    // Routed by the shell for every kind in `hasDedicatedViewer`, `.pdf` included.
    for (const id of ["n", "s", "t", "p"]) actions.open(of(id));
    expect(onOpen).toHaveBeenCalledTimes(4);
    expect(view.preview).not.toHaveBeenCalled();

    actions.open(of("i"));
    expect(view.preview).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(4);
  });
});

// --- the viewers' by-id actions ------------------------------------------------

describe("the viewers' by-id restore and purge", () => {
  it("restore(id) goes through the one toast-and-refresh path and reports success", async () => {
    const restoreEntry = vi.fn(async () => ({ name: "one.note", renamed: false, ancestors: 0, descendants: 0 }));
    const onChanged = vi.fn();
    const view = stubView();
    const controller = createBin({ api: stubApi({ restoreEntry }), view, onOpen: vi.fn(), onChanged, handled: () => false });
    await settle();

    await expect(controller.restore("a")).resolves.toBe(true);
    expect(restoreEntry).toHaveBeenCalledWith("a");
    expect(view.toasts.at(-1)!.msg).toContain("Restored");
    expect(onChanged).toHaveBeenCalledWith(true);
  });

  it("restore(id) of an id the bin does not hold acts on nothing", async () => {
    const restoreEntry = vi.fn();
    const controller = createBin({
      api: stubApi({ restoreEntry }),
      view: stubView(),
      onOpen: vi.fn(),
      onChanged: vi.fn(),
      handled: () => false,
    });
    await settle();
    await expect(controller.restore("nope")).resolves.toBe(false);
    expect(restoreEntry).not.toHaveBeenCalled();
  });

  it("purge(id) cannot skip the confirm — a cancel destroys nothing and reports so", async () => {
    const purgeEntry = vi.fn(async () => undefined);
    const view = stubView({ confirm: async () => false });
    const controller = createBin({ api: stubApi({ purgeEntry }), view, onOpen: vi.fn(), onChanged: vi.fn(), handled: () => false });
    await settle();

    await expect(controller.purge("a")).resolves.toBe(false);
    expect(purgeEntry).not.toHaveBeenCalled();
  });

  it("purge(id) with the confirm accepted purges, names the entry, and reports success", async () => {
    const purgeEntry = vi.fn(async () => undefined);
    const view = stubView();
    const controller = createBin({ api: stubApi({ purgeEntry }), view, onOpen: vi.fn(), onChanged: vi.fn(), handled: () => false });
    await settle();

    await expect(controller.purge("a")).resolves.toBe(true);
    expect(view.confirms.at(-1)!.title).toBe("Delete one.note permanently?");
    expect(purgeEntry).toHaveBeenCalledWith("a");
  });

  it("a failed restore reports false and says so, rather than leaving silently", async () => {
    const view = stubView();
    const controller = createBin({
      api: stubApi({ restoreEntry: async () => Promise.reject(new Error("boom")) }),
      view,
      onOpen: vi.fn(),
      onChanged: vi.fn(),
      handled: () => false,
    });
    await settle();
    await expect(controller.restore("a")).resolves.toBe(false);
    expect(view.toasts.at(-1)!.msg).toContain("Couldn’t restore");
  });
});

function captureActions(controller: ReturnType<typeof createBin>, view: ReturnType<typeof stubView>): BinActions {
  let captured: BinActions | null = null;
  const render = view.render.bind(view);
  view.render = (m, a) => {
    captured = a;
    render(m, a);
  };
  controller.open();
  if (!captured) throw new Error("the view was never rendered");
  return captured;
}

// --- the shell seams ----------------------------------------------------------

describe("shell seams", () => {
  it("registers exactly one rail destination, under the bin key", () => {
    const rows = DESTINATIONS.filter((d) => d.key === BIN_KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("Recycle bin");
    expect(rows[0]!.adminOnly).toBeUndefined();
  });

  it("reports the count and the deleted-from path the reader's subtitle needs", async () => {
    const controller = createBin({ api: stubApi(), view: stubView(), onOpen: vi.fn(), onChanged: vi.fn(), handled: () => false });
    await settle();
    expect(controller.count()).toBe(3);
    expect(controller.isTrashed("a")).toBe(true);
    expect(controller.isTrashed("nope")).toBe(false);
    expect(controller.pathOf("a")).toBe("Note / nested_to_remove");
  });

  it("routes only a TRASHED id through the bin-scoped endpoints", async () => {
    const live = {
      meta: vi.fn(async () => ({}) as never),
      bytes: vi.fn(async () => new ArrayBuffer(0)),
      text: vi.fn(async () => ({ text: "live", words: [] })),
    };
    const trashed = {
      meta: vi.fn(async () => ({}) as never),
      bytes: vi.fn(async () => new ArrayBuffer(0)),
      text: vi.fn(async () => ({ text: "trashed", words: [{ text: "t", xMm: 0, yMm: 0, wMm: 1, hMm: 1 }] })),
    };
    const api = {
      getNoteMeta: live.meta,
      getPageBytes: live.bytes,
      getPageText: live.text,
      getBinNoteMeta: trashed.meta,
      getBinPageBytes: trashed.bytes,
      binPageText: trashed.text,
    } as unknown as Api;

    const scope = createBinScope();
    const wrapped = scope.wrap(api);
    await wrapped.getNoteMeta("a");
    expect(live.meta).toHaveBeenCalledTimes(1);

    scope.attach((id) => id === "a");
    await wrapped.getNoteMeta("a");
    await wrapped.getNoteMeta("b");
    expect(trashed.meta).toHaveBeenCalledWith("a");
    expect(live.meta).toHaveBeenCalledTimes(2);

    const page = { index: 0, hash: "h", width: 1, height: 1, textHash: "t" };
    await wrapped.getPageBytes("a", page);
    expect(trashed.bytes).toHaveBeenCalled();

    // Trashed transcripts are retained, so page-text reroutes to the bin route.
    expect(await wrapped.getPageText("a", page)).toEqual({
      text: "trashed",
      words: [{ text: "t", xMm: 0, yMm: 0, wMm: 1, hMm: 1 }],
    });
    expect(trashed.text).toHaveBeenCalledWith("a", page);
    expect(await wrapped.getPageText("b", page)).toEqual({ text: "live", words: [] });
  });

  it("reroutes the whole history family for a trashed id", async () => {
    const live = {
      noteHistory: vi.fn(async () => ({ id: "x", versions: [] })),
      historyPageBytes: vi.fn(async () => new ArrayBuffer(0)),
      historyPageText: vi.fn(async () => ({ text: "live", words: [] })),
      historyRaw: vi.fn(async () => new ArrayBuffer(0)),
    };
    const trashed = {
      binNoteHistory: vi.fn(async () => ({ id: "a", versions: [{ md5: "v1", size: 1, createdAt: 1, current: true, pageCount: 2 }] })),
      binHistoryPageBytes: vi.fn(async () => new ArrayBuffer(0)),
      binHistoryPageText: vi.fn(async () => ({ text: "trashed-version", words: [] })),
      binHistoryRaw: vi.fn(async () => new ArrayBuffer(0)),
    };
    const api = {
      noteHistory: live.noteHistory,
      historyPageBytes: live.historyPageBytes,
      historyPageText: live.historyPageText,
      historyRaw: live.historyRaw,
      binNoteHistory: trashed.binNoteHistory,
      binHistoryPageBytes: trashed.binHistoryPageBytes,
      binHistoryPageText: trashed.binHistoryPageText,
      binHistoryRaw: trashed.binHistoryRaw,
    } as unknown as Api;

    const scope = createBinScope();
    const wrapped = scope.wrap(api);
    scope.attach((id) => id === "a");

    await wrapped.noteHistory("a");
    expect(trashed.binNoteHistory).toHaveBeenCalledWith("a");
    await wrapped.historyPageBytes("a", "v1", 0);
    expect(trashed.binHistoryPageBytes).toHaveBeenCalledWith("a", "v1", 0);
    expect(await wrapped.historyPageText("a", "v1", 0)).toEqual({ text: "trashed-version", words: [] });
    await wrapped.historyRaw("a", "v1");
    expect(trashed.binHistoryRaw).toHaveBeenCalledWith("a", "v1");

    await wrapped.noteHistory("b");
    expect(live.noteHistory).toHaveBeenCalledWith("b");
    await wrapped.historyPageText("b", "v1", 0);
    expect(live.historyPageText).toHaveBeenCalled();
  });

  // Search is keyed by blob md5, which a trashed file keeps, so the wrapper must
  // not reroute or add any search-named member.
  it("wraps NOTHING whose name is about searching — §1.1's collapse", () => {
    const api = {
      searchAnything: vi.fn(),
      binSearchAnything: vi.fn(),
      getNoteMeta: vi.fn(),
      getBinNoteMeta: vi.fn(),
    } as unknown as Api;

    const scope = createBinScope();
    const wrapped = scope.wrap(api);
    scope.attach(() => true);

    const source = api as unknown as Record<string, unknown>;
    const seen = wrapped as unknown as Record<string, unknown>;
    for (const name of new Set([...Object.keys(source), ...Object.keys(seen)])) {
      if (!/search/i.test(name)) continue;
      expect(seen[name]).toBe(source[name]);
    }
    expect(wrapped.getNoteMeta).not.toBe(api.getNoteMeta);
  });

  it("builds a content-addressed URL on the bin's own file route, or none at all", () => {
    const e = entry({ id: "7", name: "shot.png", fileType: "png", fileHash: "abc" });
    expect(binFileUrl(e)).toBe("/api/controlplane/bin/file/7?v=abc");
    expect(binFileUrl(e, { download: true })).toBe("/api/controlplane/bin/file/7?v=abc&download=1");
    // The route requires `?v=`, so a hashless entry has no URL.
    expect(binFileUrl({ ...e, fileHash: null })).toBeNull();
  });
});
