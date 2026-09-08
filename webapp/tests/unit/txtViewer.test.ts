// @vitest-environment happy-dom
//
// The `.txt` viewer's RENDER + FONT-SIZE logic (src/pages/txtViewer.ts), driven
// through its injected {@link TxtSeam} so no browser network or storage is
// needed. The shared stub contract (Viewer shape, the universal toolbar zone) is
// proved in `viewerStubs.test.ts`; what is proved HERE is the real behaviour the
// stub deferred: fetch → decode → lay out text, the font-size stepper and its
// persistence, the honest error state, session-expiry routing, and — the shell
// reuses ONE instance — that a hidden or superseded load never paints stale text.

import { describe, it, expect, vi } from "vitest";
import { createTxtViewer, TxtLoadError, type TxtSeam } from "../../src/pages/txtViewer";
import type { ViewerDeps, ReaderOrigin } from "../../src/pages/viewer";
import type { NoteMeta } from "../../src/core/types";
import type { DocSearch, DocSearchResult, DocSegmentMatch } from "../../src/search/docSearch";
import { synthesizeSummary } from "../../src/pages/library";

/** An engine that answers nothing — the default for the tests that never search. */
const noDocSearch: DocSearch = {
  search: async (md5, query) => ({ query, md5, segments: [], usedFuzzy: false, expansions: [] }),
  drop: () => {},
};

function deps(over: Partial<ViewerDeps> = {}): ViewerDeps {
  return {
    api: {} as ViewerDeps["api"],
    docSearch: noDocSearch,
    renderer: {} as ViewerDeps["renderer"],
    cache: {} as ViewerDeps["cache"],
    getTheme: () => "light",
    onBack: vi.fn(),
    toast: vi.fn(),
    onSessionExpired: vi.fn(),
    onMoveToBin: vi.fn(),
    onPosition: vi.fn(),
    ...over,
  };
}

function meta(over: Partial<NoteMeta> = {}): NoteMeta {
  return {
    id: "n-1",
    name: "notes",
    pages: [],
    fileType: "txt",
    fileHash: "a".repeat(32),
    size: 2048,
    pxPerMm: null,
    ...over,
  };
}

const FOLDER: ReaderOrigin = { kind: "folder", folderPath: "Note / Files" };
const HISTORY_VERSION = { md5: "e".repeat(32), createdAt: 1_752_000_000_000 };
const HISTORY: ReaderOrigin = { kind: "history", folderPath: "Note / Files", version: HISTORY_VERSION };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush microtasks + a macrotask, so the viewer's `.then`/`.catch` has run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A seam whose every `fetchText` is a controllable deferred, with in-memory
 *  font-size AND zoom stores — the things the real seam needs a browser for. */
function fakeSeam(initialFont: number | null = null, initialZoom: number | null = null) {
  const calls: { url: string; signal: AbortSignal; d: Deferred<string> }[] = [];
  let store = initialFont;
  const saves: number[] = [];
  let zoomStore = initialZoom;
  const zoomSaves: number[] = [];
  const seam: TxtSeam = {
    fetchText: (url, signal) => {
      const d = deferred<string>();
      calls.push({ url, signal, d });
      return d.promise;
    },
    loadFontSize: () => store,
    saveFontSize: (px) => {
      store = px;
      saves.push(px);
    },
    loadZoom: () => zoomStore,
    saveZoom: (idx) => {
      zoomStore = idx;
      zoomSaves.push(idx);
    },
  };
  return { seam, calls, saves, zoomSaves, currentStore: () => store, currentZoom: () => zoomStore };
}

function mount(v: ReturnType<typeof createTxtViewer>) {
  document.body.append(v.el);
  return v;
}
const q = (v: ReturnType<typeof createTxtViewer>, sel: string) => v.el.querySelector(sel);

describe("txt viewer — render", () => {
  it("fetches the INLINE raw url (no download flag) and lays the decoded text out", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    await v.open(synthesizeSummary(meta({ id: "n-1", fileHash: "b".repeat(32) })), Promise.resolve(meta({ id: "n-1", fileHash: "b".repeat(32) })), 0, FOLDER, "");

    // The fetch target is the versioned raw url WITHOUT `download=1`.
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(`/file/n-1?v=${"b".repeat(32)}`);
    // Loading state until the bytes land.
    expect(q(v, ".viewer__placeholder")).not.toBeNull();
    expect(q(v, ".txt__sheet")).toBeNull();

    f.calls[0]!.d.resolve("Line one\n  indented\nLine three");
    await flush();

    const pre = q(v, ".txt__sheet")!;
    expect(pre).not.toBeNull();
    // Line breaks + whitespace preserved verbatim; textContent, never innerHTML.
    expect(pre.textContent).toBe("Line one\n  indented\nLine three");
    expect(q(v, ".viewer__placeholder")).toBeNull();
    v.destroy();
  });

  it("in a HISTORY preview: fetches the version's raw bytes, shows the banner + Versions, hides Move to bin", async () => {
    const onVersions = vi.fn();
    const onRestoreVersion = vi.fn();
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps({ onVersions, onRestoreVersion }), f.seam));
    await v.open(synthesizeSummary(meta({ id: "n-1", fileHash: "b".repeat(32) })), Promise.resolve(meta({ id: "n-1", fileHash: "b".repeat(32) })), 0, HISTORY, "");

    // NOT the live `/file/:id?v=` (which serves the current blob) — the
    // version-scoped history raw route, keyed by the version's md5.
    expect(f.calls[0]!.url).toBe(`/api/controlplane/note/n-1/history/${"e".repeat(32)}/raw`);

    // The read-only version chrome: the banner is up, Move to bin is gone, and the
    // Versions control (to reopen the list) is shown.
    const banner = q(v, ".version-banner") as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("not the current note");
    expect((v.el.querySelector('button[aria-label="Move to bin"]') as HTMLElement).hidden).toBe(true);
    const versions = v.el.querySelector('button[aria-label="Version history"]') as HTMLElement;
    expect(versions.hidden).toBe(false);

    // Versions reopens the shared list; the banner's Restore routes to the shared
    // restore path via `onRestoreVersion`.
    versions.click();
    expect(onVersions).toHaveBeenCalledOnce();
    (banner.querySelector(".version-banner__restore") as HTMLElement).click();
    expect(onRestoreVersion).toHaveBeenCalledWith(expect.objectContaining({ id: "n-1" }), HISTORY_VERSION);
    v.destroy();
  });

  it("renders device text as TEXT, never markup (no injection)", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    f.calls[0]!.d.resolve("<img src=x onerror=alert(1)> & <b>bold</b>");
    await flush();
    const pre = q(v, ".txt__sheet")!;
    expect(pre.querySelector("img")).toBeNull();
    expect(pre.querySelector("b")).toBeNull();
    expect(pre.textContent).toContain("<img src=x onerror=alert(1)>");
    v.destroy();
  });

  it("shows an honest error state when the fetch fails (no throw)", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    f.calls[0]!.d.reject(new TxtLoadError(500));
    await flush();

    expect(q(v, ".txt__sheet")).toBeNull();
    const ph = q(v, ".viewer__placeholder")!;
    expect(ph.textContent).toContain("read this file");
    // Download stays offered — the original is still there to save.
    expect((q(v, '[aria-label="Download"]') as HTMLAnchorElement).hidden).toBe(false);
    v.destroy();
  });

  it("routes a 401/403 to the shell's re-auth, not the error state", async () => {
    const onSessionExpired = vi.fn();
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps({ onSessionExpired }), f.seam));
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    f.calls[0]!.d.reject(new TxtLoadError(401));
    await flush();
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    v.destroy();
  });

  it("with no content hash, reads as unreadable without a fetch", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    await v.open(synthesizeSummary(meta({ fileHash: null })), Promise.resolve(meta({ fileHash: null })), 0, FOLDER, "");
    expect(f.calls).toHaveLength(0);
    expect(q(v, ".viewer__placeholder")!.textContent).toContain("read this file");
    v.destroy();
  });
});

describe("txt viewer — font size", () => {
  const smaller = (v: ReturnType<typeof createTxtViewer>) =>
    q(v, '[aria-label="Smaller text"]') as HTMLButtonElement;
  const larger = (v: ReturnType<typeof createTxtViewer>) =>
    q(v, '[aria-label="Larger text"]') as HTMLButtonElement;
  const label = (v: ReturnType<typeof createTxtViewer>) => q(v, ".pager .zoom")!;

  it("defaults to 16px and steps the label + persists on each change", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    expect(label(v).textContent).toBe("16px");

    larger(v).click();
    expect(label(v).textContent).toBe("18px");
    smaller(v).click();
    smaller(v).click();
    expect(label(v).textContent).toBe("14px");
    // Every change is persisted through the seam.
    expect(f.saves).toEqual([18, 16, 14]);
    v.destroy();
  });

  it("applies the size to the live text and to text opened later", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    f.calls[0]!.d.resolve("hello");
    await flush();

    const pre = q(v, ".txt__sheet") as HTMLPreElement;
    expect(pre.style.fontSize).toBe("16px");
    larger(v).click();
    expect(pre.style.fontSize).toBe("18px");
    v.destroy();
  });

  it("clamps at the 10–32px bounds and does not persist a no-op", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    for (let i = 0; i < 20; i++) larger(v).click();
    expect(label(v).textContent).toBe("32px");
    const savesAtMax = f.saves.length;
    larger(v).click(); // already at the ceiling — a no-op, not another save
    expect(f.saves.length).toBe(savesAtMax);

    for (let i = 0; i < 40; i++) smaller(v).click();
    expect(label(v).textContent).toBe("10px");
    v.destroy();
  });

  it("restores the persisted size on construction (survives a reload)", async () => {
    const f = fakeSeam(24); // as if a prior session had stored 24px
    const v = mount(createTxtViewer(deps(), f.seam));
    expect(label(v).textContent).toBe("24px");
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    f.calls[0]!.d.resolve("hi");
    await flush();
    expect((q(v, ".txt__sheet") as HTMLPreElement).style.fontSize).toBe("24px");
    v.destroy();
  });

  it("clamps an out-of-range persisted value into bounds", async () => {
    const v = mount(createTxtViewer(deps(), fakeSeam(9999).seam));
    expect(q(v, ".pager .zoom")!.textContent).toBe("32px");
    v.destroy();
  });
});

describe("txt viewer — zoom (reading column, distinct from font size)", () => {
  const zoomOut = (v: ReturnType<typeof createTxtViewer>) => q(v, '[aria-label="Zoom out"]') as HTMLButtonElement;
  const zoomIn = (v: ReturnType<typeof createTxtViewer>) => q(v, '[aria-label="Zoom in"]') as HTMLButtonElement;
  // The zoom readout wears `.txt-zoom` (NOT the font stepper's `.zoom`), so the
  // two `.pager`s in the one toolbar stay individually addressable.
  const zoomLabel = (v: ReturnType<typeof createTxtViewer>) => q(v, ".pager .txt-zoom")!;

  it("renders as a `−` [Fit] `+` control in the view zone, defaulting to Fit", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    expect(zoomOut(v)).not.toBeNull();
    expect(zoomIn(v)).not.toBeNull();
    expect(zoomLabel(v).textContent).toBe("Fit");
    v.destroy();
  });

  it("steps the label and persists on each change, clamping silently at Fit", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));

    zoomIn(v).click();
    expect(zoomLabel(v).textContent).toBe("125%");
    zoomIn(v).click();
    expect(zoomLabel(v).textContent).toBe("150%");
    zoomOut(v).click();
    expect(zoomLabel(v).textContent).toBe("125%");
    expect(f.zoomSaves).toEqual([1, 2, 1]);

    // Fit is the floor: stepping out from it is a no-op, not another save.
    zoomOut(v).click(); // → Fit
    const at = f.zoomSaves.length;
    zoomOut(v).click(); // already Fit
    expect(zoomLabel(v).textContent).toBe("Fit");
    expect(f.zoomSaves.length).toBe(at);
    v.destroy();
  });

  it("scales the reading COLUMN via --txt-zoom, on the live text and text opened later", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    f.calls[0]!.d.resolve("hello");
    await flush();

    const pre = q(v, ".txt__sheet") as HTMLPreElement;
    // Fit is factor 1; a step widens the column to 1.25×.
    expect(pre.style.getPropertyValue("--txt-zoom")).toBe("1");
    zoomIn(v).click();
    expect(pre.style.getPropertyValue("--txt-zoom")).toBe("1.25");
    v.destroy();
  });

  it("restores the persisted zoom on construction (survives a reload)", async () => {
    const f = fakeSeam(null, 2); // as if a prior session had stored step 2 (150%)
    const v = mount(createTxtViewer(deps(), f.seam));
    expect(zoomLabel(v).textContent).toBe("150%");
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    f.calls[0]!.d.resolve("hi");
    await flush();
    expect((q(v, ".txt__sheet") as HTMLPreElement).style.getPropertyValue("--txt-zoom")).toBe("1.5");
    v.destroy();
  });

  it("zoom and font size are INDEPENDENT knobs — one moves without disturbing the other", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    f.calls[0]!.d.resolve("body");
    await flush();
    const pre = q(v, ".txt__sheet") as HTMLPreElement;

    // Zooming leaves the font size alone (glyphs unchanged, column wider).
    (q(v, '[aria-label="Zoom in"]') as HTMLButtonElement).click();
    expect(pre.style.getPropertyValue("--txt-zoom")).toBe("1.25");
    expect(pre.style.fontSize).toBe("16px");
    expect(q(v, ".pager .zoom")!.textContent).toBe("16px"); // font readout untouched

    // Resizing the font leaves the zoom alone (glyphs bigger, column unchanged).
    (q(v, '[aria-label="Larger text"]') as HTMLButtonElement).click();
    expect(pre.style.fontSize).toBe("18px");
    expect(pre.style.getPropertyValue("--txt-zoom")).toBe("1.25");
    expect(zoomLabel(v).textContent).toBe("125%"); // zoom readout untouched
    v.destroy();
  });
});

describe("txt viewer — find", () => {
  // Alpha in para 0; "zephyrine" in paragraphs 1 and 2 (byte = char, all ASCII).
  const BODY = "Alpha here.\n\nThe zephyrine tea.\n\nMore zephyrine, brighter.";
  // The `.txt` case is the ONE where the ordinal is not the address: `o`/`l` are
  // the paragraph's byte range in the raw blob, and `byteToCharMap` is what turns
  // them into the UTF-16 indices the viewer holds. Byte = char here (all ASCII),
  // which is exactly why `byteToCharMap`'s own multi-byte behaviour is pinned in
  // `txtFind.test.ts` rather than smuggled in here.
  const ZEPH: DocSegmentMatch[] = [
    { segment: 1, offset: 13, length: 18, matches: 1, terms: ["zephyrine"] },
    { segment: 2, offset: 33, length: 25, matches: 1, terms: ["zephyrine"] },
  ];

  /**
   * A viewer whose in-document engine answers `segments` for any query.
   * `opts.usedFuzzy` marks the answer a typo-tolerant fallback, which is the
   * opt-in gate; `opts.hold` leaves the query unresolved so a test can read the
   * counter while the text is still being fetched and indexed.
   */
  function findViewer(
    segments: DocSegmentMatch[] = ZEPH,
    over: Partial<ViewerDeps> = {},
    opts: { usedFuzzy?: boolean; hold?: boolean } = {},
  ) {
    let land!: () => void;
    const search = vi.fn(async (md5: string, query: string): Promise<DocSearchResult> => {
      const answer: DocSearchResult = {
        query,
        md5,
        segments,
        usedFuzzy: opts.usedFuzzy ?? false,
        expansions: opts.usedFuzzy ? [{ typed: query, matched: "zephyrine" }] : [],
      };
      if (!opts.hold) return answer;
      return new Promise<DocSearchResult>((resolve) => {
        land = () => resolve(answer);
      });
    });
    const docSearch: DocSearch = { search, drop: vi.fn() };
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps({ docSearch, ...over }), f.seam));
    return { v, f, search, land: () => land() };
  }

  const btn = (v: ReturnType<typeof createTxtViewer>, name: string) =>
    v.el.querySelector(`[aria-label="${name}"]`) as HTMLButtonElement;

  it("the toolbar find button is present and ENABLED for a .txt", async () => {
    const { v } = findViewer();
    const find = btn(v, "Find in this file");
    expect(find).not.toBeNull();
    expect(find.disabled).toBe(false);
    v.destroy();
  });

  it("a ?q= deep link opens find, marks matches, and lands on the target paragraph", async () => {
    const { v, f, search } = findViewer();
    // page = 1 → the paragraph ordinal the library hit routed with.
    await v.open(synthesizeSummary(meta({ id: "n-r" })), Promise.resolve(meta({ id: "n-r" })), 1, FOLDER, "zephyrine");
    f.calls[0]!.d.resolve(BODY);
    await flush();
    await flush();

    // The bar is open and pre-filled, and the query went to the BLOB — `fileHash`,
    // not the file id. That is the whole of 's collapse:
    // one md5-keyed route, so history and the bin reach it with no reroute.
    expect((q(v, ".txtbar") as HTMLElement).hidden).toBe(false);
    expect((q(v, ".txtbar input") as HTMLInputElement).value).toBe("zephyrine");
    expect(search).toHaveBeenCalledWith("a".repeat(32), "zephyrine", expect.any(AbortSignal));

    // Both paragraphs are wrapped and their word marked.
    const paras = v.el.querySelectorAll(".txt__match");
    expect(paras).toHaveLength(2);
    expect(v.el.querySelectorAll(".txt__sheet mark")).toHaveLength(2);

    // EXACT count, in-document scope.
    expect(q(v, ".txtbar__count")!.textContent).toBe("2 matches in 2 paragraphs");

    // Landed on the TARGET (ordinal 1 → the first matching paragraph).
    expect(paras[0]!.classList.contains("is-current")).toBe(true);
    expect(paras[1]!.classList.contains("is-current")).toBe(false);
    v.destroy();
  });

  it("next/prev JUMP between matching paragraphs, wrapping around", async () => {
    const { v, f } = findViewer();
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 1, FOLDER, "zephyrine");
    f.calls[0]!.d.resolve(BODY);
    await flush();
    await flush();

    const paras = () => v.el.querySelectorAll(".txt__match");
    const current = () => [...paras()].findIndex((p) => p.classList.contains("is-current"));
    expect(current()).toBe(0);

    btn(v, "Next match").click();
    expect(current()).toBe(1);
    btn(v, "Next match").click(); // wraps
    expect(current()).toBe(0);
    btn(v, "Previous match").click(); // wraps back
    expect(current()).toBe(1);
    v.destroy();
  });

  it("a query with no matches reads 'No matches' and leaves the text unmarked", async () => {
    const { v, f } = findViewer([]);
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "absent");
    f.calls[0]!.d.resolve(BODY);
    await flush();
    await flush();
    expect(q(v, ".txtbar__count")!.textContent).toBe("No matches");
    expect(v.el.querySelectorAll(".txt__sheet mark")).toHaveLength(0);
    // The whole text is still there, just unmarked.
    expect(q(v, ".txt__sheet")!.textContent).toBe(BODY);
    v.destroy();
  });

  it("opening WITHOUT a query leaves find closed (no bar, no request)", async () => {
    const { v, f, search } = findViewer();
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    f.calls[0]!.d.resolve(BODY);
    await flush();
    expect((q(v, ".txtbar") as HTMLElement).hidden).toBe(true);
    // §4.1: OPENING A FILE TO READ IT FETCHES NO TEXT INDEX. The `.txt` blob is
    // already on screen; the search record is a separate, larger fetch that only
    // a find pays for.
    expect(search).not.toHaveBeenCalled();
    v.destroy();
  });

  it("reports the landed paragraph + query up to the shell (addressable ?q=)", async () => {
    const onPosition = vi.fn();
    const { v, f } = findViewer(ZEPH, { onPosition });
    await v.open(synthesizeSummary(meta({ id: "n-p" })), Promise.resolve(meta({ id: "n-p" })), 2, FOLDER, "zephyrine");
    f.calls[0]!.d.resolve(BODY);
    await flush();
    await flush();
    // Landed on ordinal 2 (the target), with the query — what a reload restores.
    // The 4th arg is the version md5, undefined on a live (non-preview) open.
    expect(onPosition).toHaveBeenLastCalledWith("n-p", 2, "zephyrine", undefined);
    v.destroy();
  });

  it("in a HISTORY preview: the URL sync rides the version md5 (addressable version)", async () => {
    // Opening a `.txt` version preview must publish the `#/note/:id/version/:short`
    // form, not the bare note URL — the shell's `onPosition` keys off the version
    // md5 (its 4th arg) to write the version address. A plain preview (no `?q=`)
    // publishes it from the open-end sync; here we also drive find to show the
    // landed paragraph keeps riding the same version md5.
    const onPosition = vi.fn();
    const version = { md5: "e".repeat(32), createdAt: 1_752_000_000_000 };
    const { v, f } = findViewer(ZEPH, { onPosition });
    await v.open(synthesizeSummary(meta({ id: "n-p" })), Promise.resolve(meta({ id: "n-p" })), 0, { kind: "history", folderPath: "Note / Files", version }, "zephyrine");
    // The open-end sync already carried the version md5 (before any text arrived).
    expect(onPosition).toHaveBeenLastCalledWith("n-p", 0, "zephyrine", version.md5);
    f.calls[0]!.d.resolve(BODY);
    await flush();
    await flush();
    // Once find lands (on the first match, ordinal 1, since the panel opened at the
    // start), the position still rides the version md5 — the address stays pinned.
    expect(onPosition).toHaveBeenLastCalledWith("n-p", 1, "zephyrine", version.md5);
    v.destroy();
  });

  // THERE IS NO FLOOR ANY MORE. The old counter drained a server keyset and read
  // "1+ match in 1+ paragraph" until the last batch; a local index answers in one
  // call, so the counter has exactly two things to say — "Searching…" while the
  // text is being fetched and indexed, and then the exact "N in M".
  it("says 'Searching…' with NO number until the answer lands, then the exact count", async () => {
    const { v, f, land } = findViewer(ZEPH, {}, { hold: true });
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 1, FOLDER, "zephyrine");
    f.calls[0]!.d.resolve(BODY);
    await flush();

    expect(q(v, ".txtbar__count")!.textContent).toBe("Searching…");
    expect(v.el.querySelectorAll(".txt__match")).toHaveLength(0);

    land();
    await flush();
    expect(q(v, ".txtbar__count")!.textContent).toBe("2 matches in 2 paragraphs");
    expect(v.el.querySelectorAll(".txt__match")).toHaveLength(2);
    v.destroy();
  });

  // A `.note` or `.pdf` segment has no byte range because its ordinal IS the
  // address. If one ever reached the `.txt` path it could not be placed in the
  // string, and marking it from byte 0 would highlight the top of the file.
  it("drops a segment that carries no byte range rather than marking from byte 0", async () => {
    const mixed: DocSegmentMatch[] = [
      { segment: 0, offset: null, length: null, matches: 9, terms: ["zephyrine"] },
      ZEPH[0]!,
    ];
    const { v, f } = findViewer(mixed);
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 1, FOLDER, "zephyrine");
    f.calls[0]!.d.resolve(BODY);
    await flush();
    await flush();
    expect(v.el.querySelectorAll(".txt__match")).toHaveLength(1);
    expect(q(v, ".txtbar__count")!.textContent).toBe("1 match in 1 paragraph");
    v.destroy();
  });

  it("manual fuzzy is OPT-IN: offers 'Search similar', reveals the held result on click", async () => {
    const { v, f, search } = findViewer(ZEPH, {}, { usedFuzzy: true });
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "zephyryne"); // a typo absent from the file
    f.calls[0]!.d.resolve(BODY);
    await flush();
    await flush();

    // The exact search is empty and the fuzzy result is HELD, not shown: no marks,
    // "No matches", and the affordance offering to search similar.
    expect(q(v, ".txtbar__count")!.textContent).toBe("No matches");
    expect(v.el.querySelectorAll(".txt__sheet mark")).toHaveLength(0);
    const ask = q(v, ".txtbar__ask") as HTMLButtonElement;
    expect(ask.hidden).toBe(false);

    // Opt in → the held fuzzy result is revealed, with nothing asked again: the
    // ladder ran inside the one query and its answer was merely held.
    const calls = search.mock.calls.length;
    ask.click();
    await flush();
    expect(search.mock.calls.length).toBe(calls);
    expect(v.el.querySelectorAll(".txt__match")).toHaveLength(2);
    expect(q(v, ".txtbar__count")!.textContent).toBe("2 matches in 2 paragraphs");
    expect(ask.hidden).toBe(true);
    v.destroy();
  });
});

describe("txt viewer — lifecycle / abort hazard (one reused instance)", () => {
  it("hide() aborts the in-flight load; a late resolve never paints", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    v.hide();
    expect(f.calls[0]!.signal.aborted).toBe(true);

    f.calls[0]!.d.resolve("stale text");
    await flush();
    expect(q(v, ".txt__sheet")).toBeNull();
    v.destroy();
  });

  it("a superseding open() aborts the prior load; only the newest text paints", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    await v.open(synthesizeSummary(meta({ id: "n-a", name: "A" })), Promise.resolve(meta({ id: "n-a", name: "A" })), 0, FOLDER, "");
    await v.open(synthesizeSummary(meta({ id: "n-b", name: "B" })), Promise.resolve(meta({ id: "n-b", name: "B" })), 0, FOLDER, "");
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.signal.aborted).toBe(true);

    f.calls[0]!.d.resolve("A text"); // the stale one lands first…
    await flush();
    expect(q(v, ".txt__sheet")).toBeNull();

    f.calls[1]!.d.resolve("B text"); // …the current one wins
    await flush();
    expect(q(v, ".txt__sheet")!.textContent).toBe("B text");
    v.destroy();
  });

  it("destroy() aborts the in-flight load", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    v.destroy();
    expect(f.calls[0]!.signal.aborted).toBe(true);
    f.calls[0]!.d.resolve("late");
    await flush();
    expect(q(v, ".txt__sheet")).toBeNull();
  });
});
