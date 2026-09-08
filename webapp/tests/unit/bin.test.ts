import { describe, it, expect, vi } from "vitest";
import {
  BIN_KEY,
  DEVICE_LINE,
  binFileUrl,
  binRows,
  createBin,
  createBinScope,
  emptyConfirm,
  emptyStateBody,
  folderLabel,
  groupLabel,
  purgeConfirm,
  restoreMessage,
  trashMessage,
  type BinActions,
  type BinModel,
  type BinView,
  type ConfirmSpec,
} from "../../src/pages/bin";
import { DESTINATIONS } from "../../src/pages/rail";
import type { Api } from "../../src/api/types";
import type { Bin, BinEntry } from "../../src/core/binTypes";

// The bin with the DOM injected, the same way rail.ts and noteSearch.ts are
// tested. What is worth pinning here is not the markup — it is the two things a
// silent regression would cost a user something real:
//
//   - the ARITHMETIC behind every destructive sentence: the fanout a purge
//     declares, and the bytes it promises back. A folder's bytes are its
//     children's and the children are rows in the same list, so a total that
//     sums folders too is silently double the truth, in the one dialog whose
//     whole job is to be believed;
//   - WHICH OPERATIONS ASK. Trash must never open a dialog and purge must never
//     skip one — that asymmetry is the entire protection model, and it is
//     invisible from the markup.

// --- fixtures ----------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
/** A fixed "now" so the countdown and the date headings are deterministic. */
const NOW = new Date("2026-07-20T14:00:00Z").getTime();

function entry(over: Partial<BinEntry> & Pick<BinEntry, "id" | "name">): BinEntry {
  return {
    kind: "note",
    path: "Note",
    deletedAt: NOW,
    size: 0,
    parentId: null,
    isRoot: true,
    fileType: "note",
    fileHash: `${over.id}-md5`,
    // Nothing renderable by default. The row's thumbnail is a DOM concern and
    // these are the data tests; the "real ink, not the placeholder glyph" claim
    // is the e2e suite's, where there is a renderer to make it with.
    firstPage: null,
    ...over,
  };
}

function bin(entries: BinEntry[], over: Partial<Bin> = {}): Bin {
  return {
    entries,
    // The SERVER's figure, which sums files only — the client never re-derives
    // it, and these tests assert on what the server said.
    totalBytes: entries.reduce((n, e) => n + e.size, 0),
    retentionDays: 30,
    syncVersion: 1,
    ...over,
  };
}

/** A folder deleted with the two notes inside it — the mockup's own fixture. */
const FOLDER_DELETE = bin([
  entry({ id: "f", name: "nested_to_remove", kind: "folder", fileType: "", fileHash: null, size: 0 }),
  entry({ id: "a", name: "one.note", parentId: "f", isRoot: false, size: 1000, path: "Note / nested_to_remove" }),
  entry({ id: "b", name: "two.note", parentId: "f", isRoot: false, size: 2000, path: "Note / nested_to_remove" }),
]);

// --- ordering and nesting (U2) ------------------------------------------------

describe("bin rows", () => {
  it("keeps a trashed subtree together, children nested under their parent", () => {
    const rows = binRows(FOLDER_DELETE, NOW);
    expect(rows.map((r) => r.entry.id)).toEqual(["f", "a", "b"]);
    expect(rows.map((r) => r.child)).toEqual([false, true, true]);
  });

  it("gives a whole subtree its ROOT's date heading, never one per child", () => {
    // A child tombstoned a second past midnight would otherwise split the group
    // its parent is in — for one user action, sent as three requests.
    const split = bin([
      entry({ id: "f", name: "folder", kind: "folder", fileType: "", fileHash: null, deletedAt: NOW }),
      entry({ id: "a", name: "one.note", parentId: "f", isRoot: false, deletedAt: NOW - 2 * DAY }),
    ]);
    const rows = binRows(split, NOW);
    expect(rows.map((r) => r.group)).toEqual(["Deleted today", "Deleted today"]);
  });

  it("promotes an orphan rather than dropping it", () => {
    // The parent was purged (or restored) while this listing was in flight. A
    // lost row is far worse than a flush one.
    const orphan = bin([entry({ id: "a", name: "one.note", parentId: "gone", isRoot: false })]);
    const rows = binRows(orphan, NOW);
    expect(rows.map((r) => r.entry.id)).toEqual(["a"]);
    expect(rows[0]!.child).toBe(false);
  });

  it("makes a folder unopenable and a file openable", () => {
    // A folder has nothing to open — its contents are already listed beneath it
    // — so it must not be rendered as a control that promises a view.
    const rows = binRows(FOLDER_DELETE, NOW);
    expect(rows.map((r) => r.openable)).toEqual([false, true, true]);
  });

  it("counts the fanout and the bytes over the SUBTREE, not the row", () => {
    const [folder, a] = binRows(FOLDER_DELETE, NOW);
    expect(folder!.fanout).toBe(3);
    // The folder itself weighs 0; its bytes are its children's, counted once.
    expect(folder!.bytes).toBe(3000);
    expect(a!.fanout).toBe(1);
    expect(a!.bytes).toBe(1000);
  });

  it("counts down from the server's retention window and reddens near the end", () => {
    const rows = binRows(
      bin(
        [
          entry({ id: "fresh", name: "fresh.note", deletedAt: NOW }),
          entry({ id: "old", name: "old.note", deletedAt: NOW - 26 * DAY }),
        ],
        { retentionDays: 30 },
      ),
      NOW,
    );
    expect(rows.map((r) => r.daysLeft)).toEqual([30, 4]);
    expect(rows.map((r) => r.soon)).toEqual([false, true]);
  });

  it("names the size and type of a file, and the contents of a folder", () => {
    const rows = binRows(FOLDER_DELETE, NOW);
    expect(rows[0]!.detail).toBe("folder · 2 items");
    expect(rows[1]!.detail).toBe("NOTE · 1000 B");
  });
});

describe("group headings", () => {
  it("counts CALENDAR days, so 23:50 is yesterday at 00:10 and not today", () => {
    const late = new Date("2026-07-19T23:50:00").getTime();
    const early = new Date("2026-07-20T00:10:00").getTime();
    expect(groupLabel(late, early)).toBe("Deleted yesterday");
  });

  it("says today, yesterday, then a count", () => {
    const now = new Date("2026-07-20T12:00:00").getTime();
    expect(groupLabel(new Date("2026-07-20T09:00:00").getTime(), now)).toBe("Deleted today");
    expect(groupLabel(new Date("2026-07-19T09:00:00").getTime(), now)).toBe("Deleted yesterday");
    expect(groupLabel(new Date("2026-07-14T09:00:00").getTime(), now)).toBe("Deleted 6 days ago");
  });
});

// --- the sentences (U3, U4, U6, U7) -------------------------------------------

describe("confirmation copy", () => {
  it("names the object and the act, and the button repeats it", () => {
    const row = binRows(bin([entry({ id: "a", name: "download_test.note", size: 2_202_009 })]), NOW)[0]!;
    const spec = purgeConfirm(row);
    expect(spec.title).toBe("Delete download_test.note permanently?");
    expect(spec.action).toBe("Delete permanently");
    // Never "Are you sure?" — the sentence read is the sentence performed.
    expect(spec.body).not.toMatch(/sure/i);
  });

  it("declares the fanout only when the operation exceeds the selection", () => {
    const [folder, child] = binRows(FOLDER_DELETE, NOW);
    expect(purgeConfirm(folder!).body).toContain("Deletes the folder and the 2 items inside it");
    // One row destroys one row: a sentence explaining that would be noise.
    expect(purgeConfirm(child!).body).toBe("This can’t be undone.");
  });

  it("states the space freed, because purge is the only moment it comes back", () => {
    const row = binRows(bin([entry({ id: "a", name: "a.note", size: 2_202_009 })]), NOW)[0]!;
    expect(purgeConfirm(row).frees).toBe("2.1 MB");
  });

  it("never double-counts a folder with its contents in the empty-bin total", () => {
    // THE bug this shape rules out: the folder row weighs 0, so summing every
    // row is the same number as summing the files.
    const spec = emptyConfirm(FOLDER_DELETE);
    expect(spec.frees).toBe("2.9 KB");
    expect(spec.title).toBe("Delete all 3 items permanently?");
    expect(spec.action).toBe("Empty bin");
  });
});

describe("result copy", () => {
  it("reports what restore ACTUALLY did, not what was asked", () => {
    expect(restoreMessage({ name: "BuJo (2).note", renamed: true, ancestors: 2, descendants: 0 })).toBe(
      "Restored as BuJo (2).note · also restored 2 folders — back on your Supernote at the next sync",
    );
    expect(restoreMessage({ name: "folder", renamed: false, ancestors: 0, descendants: 3 })).toBe(
      "Restored folder · with the 3 items inside it — back on your Supernote at the next sync",
    );
  });

  it("states the trash fanout, and nothing extra when there is none", () => {
    expect(trashMessage({ id: "1", name: "a.note", isFolder: false, entries: 1 })).toBe("Moved a.note to Recycle bin");
    expect(trashMessage({ id: "1", name: "folder", isFolder: true, entries: 3 })).toBe(
      "Moved folder and the 2 items inside it to Recycle bin",
    );
  });

  it("quotes the server's retention window in the empty state, never a copy of it", () => {
    expect(emptyStateBody(14)).toContain("14 days");
  });
});

// --- where the row says the entry used to live --------------------------------
//
// The server's `path` is the full path INCLUDING the entry's own name, so the
// row used to repeat the name printed directly above it AND name `NOTE`, a
// container every other surface in the app flattens away. The flattening half is
// the rail's (`labelPathSegments`, tested in rail.test.ts); what is tested here
// is the strip, and the one case where stripping is wrong.

describe("the folder a trashed entry came from", () => {
  it("strips the entry's own name and names the folder the way the rail does", () => {
    expect(folderLabel("/NOTE/Note/deep.note", "deep.note")).toBe("Note");
    expect(folderLabel("/NOTE/Note/nested_to_remove/one.note", "one.note")).toBe("Note / nested_to_remove");
  });

  it("keeps a parent that happens to share the entry's name", () => {
    // Only the TRAILING segment is the entry's own. A folder deleted from inside
    // a same-named parent must not lose the parent as well — one `pop`, never a
    // filter over every segment.
    expect(folderLabel("/NOTE/Note/Work/Work", "Work")).toBe("Note / Work");
  });

  it("says Library rather than nothing when the entry sat at the root", () => {
    expect(folderLabel("/loose.note", "loose.note")).toBe("Library");
    // A root-level CONTAINER strips to the root too, because that is exactly
    // where the rail puts its contents.
    expect(folderLabel("/NOTE", "NOTE")).toBe("Library");
  });

  it("survives a path the strip does not apply to", () => {
    // Defensive rather than expected: if the server ever stopped appending the
    // name, the line degrades to naming one folder too many — not to a crash.
    expect(folderLabel("/NOTE/Note", "deep.note")).toBe("Note");
    expect(folderLabel("", "deep.note")).toBe("Library");
  });
});

// --- what asks and what does not (U4) -----------------------------------------

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

/** Let the controller's construction-time listing settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("what asks, and what does not", () => {
  it("trashes with NO dialog, and offers the reverse plus the device line", async () => {
    const view = stubView();
    const controller = createBin({ api: stubApi(), view, onOpen: vi.fn(), onChanged: vi.fn(), handled: () => false });
    await settle();

    await controller.trash({ id: "n1", name: "a.note", kind: "note" });

    // The whole protection model: a confirm spent on the frequent, safe action
    // is what trains people to dismiss the rare, final one.
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

    // Through the CONTROLLER, because that is where the control now calls from:
    // `Empty bin` moved to the topbar, which the bin's painter does not own. The
    // confirm travelling with it is the whole point of the method.
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
      handled: () => true, // the shell owns it
    });
    await settle();

    // `error` would put "Couldn't load the bin" over a shell on its way out.
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

    // "Nothing deleted" over a failed listing is indistinguishable from a bin
    // that really is empty — to somebody deciding whether their file still exists.
    expect(view.rendered.at(-1)!.state).toBe("error");
  });
});

// --- what opens where ---------------------------------------------------------

describe("what opens where", () => {
  /** One of every openable kind: four with a real viewer, one without. */
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

    // Every kind with a viewer of its own — `hasDedicatedViewer`, the set
    // `library.viewerFor` dispatches on — is routed by the SHELL: Back, a reload
    // and history behave, and the viewer gets the `"bin"` origin.
    //
    // `.pdf` IS ONE OF THEM, and this test used to say otherwise. It listed the
    // pdf beside the png as a kind "with no real viewer", which was true when it
    // was written and stopped being true the day the PDF viewer shipped — so the
    // test went on asserting that a trashed PDF falls into the preview panel,
    // where it could be neither restored nor deleted. The bin's own membership
    // check had drifted from `viewerFor` in exactly the same way; both now ask
    // `hasDedicatedViewer`.
    for (const id of ["n", "s", "t", "p"]) actions.open(of(id));
    expect(onOpen).toHaveBeenCalledTimes(4);
    expect(view.preview).not.toHaveBeenCalled();

    // An image still has none. Not an oversight: a trashed image is the "is this
    // the screenshot I meant?" question, which the bin's own preview panel — with
    // the decision controls and the deadline right there — answers better than a
    // full viewer would.
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
    // The viewer's caller relies on the same `onChanged` the row action fires —
    // the rail badge and the folder behind the bin refresh either way.
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
    // The SAME `ConfirmSpec` a row click builds — the dialog names the object.
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

/** The actions object the controller hands the view on every render. */
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
    // Not admin-gated: a household member's own bin is their own data.
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
    // Before `attach`, nothing is trashed — a wrapper that guessed would send
    // every live read to a route that answers 404 for all of them.
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

    // A trashed file's transcript IS retained (md5-keyed index, `deleted = 1`),
    // so page-text reroutes to the bin's own route rather than degrading to
    // empty — that is what draws a trashed-note preview's ovals. A LIVE id still
    // goes to the live route untouched.
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

    // Every call reroutes to its bin twin for a trashed id.
    await wrapped.noteHistory("a");
    expect(trashed.binNoteHistory).toHaveBeenCalledWith("a");
    await wrapped.historyPageBytes("a", "v1", 0);
    expect(trashed.binHistoryPageBytes).toHaveBeenCalledWith("a", "v1", 0);
    expect(await wrapped.historyPageText("a", "v1", 0)).toEqual({ text: "trashed-version", words: [] });
    await wrapped.historyRaw("a", "v1");
    expect(trashed.binHistoryRaw).toHaveBeenCalledWith("a", "v1");

    // …and a LIVE id passes straight through to the live history routes.
    await wrapped.noteHistory("b");
    expect(live.noteHistory).toHaveBeenCalledWith("b");
    await wrapped.historyPageText("b", "v1", 0);
    expect(live.historyPageText).toHaveBeenCalled();
  });

  // THE SCOPE HAS NO SEARCH IN IT ANY MORE, and that absence is the assertion.
  //
  // `golden-search.md` §1.1 collapsed the five in-document search routes to one
  // keyed by BLOB MD5 — "history and bin are not special: they are other md5s".
  // A trashed file's blob keeps the md5 it had before it was trashed, and
  // `getBinNoteMeta` (rerouted above) already hands the viewer that `fileHash`,
  // so find-in-a-trashed-note needs no reroute at all: the same controller, the
  // same engine, a different md5.
  //
  // Written as a property of the WRAPPER rather than of one method name — the
  // seam carries no search method to name any more, so the guard is stated
  // against a HYPOTHETICAL one: hand the wrapper a search-named member and it
  // must come back the same function object, and the wrapper must not grow one
  // of its own. A reroute reintroduced under any spelling fails here.
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
      // Passed through by the spread, i.e. the SAME function object — the
      // wrapper does not intercept it, and invents nothing under that name.
      expect(seen[name]).toBe(source[name]);
    }
    // And the one that carries the md5 IS still rerouted, because that is what
    // makes the no-search-reroute rule work.
    expect(wrapped.getNoteMeta).not.toBe(api.getNoteMeta);
  });

  it("builds a content-addressed URL on the bin's own file route, or none at all", () => {
    const e = entry({ id: "7", name: "shot.png", fileType: "png", fileHash: "abc" });
    expect(binFileUrl(e)).toBe("/api/controlplane/bin/file/7?v=abc");
    expect(binFileUrl(e, { download: true })).toBe("/api/controlplane/bin/file/7?v=abc&download=1");
    // The route REQUIRES `?v=` — that is what makes its immutable response
    // honest — so a hashless entry has no addressable URL rather than a
    // guaranteed 404.
    expect(binFileUrl({ ...e, fileHash: null })).toBeNull();
  });
});
