// @vitest-environment happy-dom
// The txt viewer: find and the abort hazard.

import { describe, it, expect, vi } from "vitest";
import { createTxtViewer } from "../../src/pages/txtViewer";
import type { ViewerDeps } from "../../src/pages/viewer";
import type { DocSearch, DocSearchResult, DocSegmentMatch } from "../../src/search/docSearch";
import { synthesizeSummary } from "../../src/pages/library";
import { deps, meta, FOLDER, HISTORY, flush, fakeSeam, mount, q } from "./txtViewer.shared";

describe("txt viewer — find", () => {
  // Alpha in para 0; "zephyrine" in paragraphs 1 and 2 (byte = char, all ASCII).
  const BODY = "Alpha here.\n\nThe zephyrine tea.\n\nMore zephyrine, brighter.";
  const ZEPH: DocSegmentMatch[] = [
    { segment: 1, offset: 13, length: 18, matches: 1, terms: ["zephyrine"] },
    { segment: 2, offset: 33, length: 25, matches: 1, terms: ["zephyrine"] },
  ];

  /** A viewer whose engine answers `segments`; `usedFuzzy` marks a held fallback,
   *  `hold` leaves the query unresolved. */
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
    await v.open(synthesizeSummary(meta({ id: "n-r" })), Promise.resolve(meta({ id: "n-r" })), 1, FOLDER, "zephyrine");
    f.calls[0]!.d.resolve(BODY);
    await flush();
    await flush();

    // The query goes to the blob (`fileHash`), not the file id.
    expect((q(v, ".txtbar") as HTMLElement).hidden).toBe(false);
    expect((q(v, ".txtbar input") as HTMLInputElement).value).toBe("zephyrine");
    expect(search).toHaveBeenCalledWith("a".repeat(32), "zephyrine", expect.any(AbortSignal));

    const paras = v.el.querySelectorAll(".txt__match");
    expect(paras).toHaveLength(2);
    expect(v.el.querySelectorAll(".txt__sheet mark")).toHaveLength(2);

    expect(q(v, ".txtbar__count")!.textContent).toBe("2 matches in 2 paragraphs");

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
    btn(v, "Next match").click();
    expect(current()).toBe(0);
    btn(v, "Previous match").click();
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
    expect(q(v, ".txt__sheet")!.textContent).toBe(BODY);
    v.destroy();
  });

  it("opening WITHOUT a query leaves find closed (no bar, no request)", async () => {
    const { v, f, search } = findViewer();
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    f.calls[0]!.d.resolve(BODY);
    await flush();
    expect((q(v, ".txtbar") as HTMLElement).hidden).toBe(true);
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
    // The 4th arg is the version md5, undefined on a live open.
    expect(onPosition).toHaveBeenLastCalledWith("n-p", 2, "zephyrine", undefined);
    v.destroy();
  });

  it("in a HISTORY preview: the URL sync rides the version md5 (addressable version)", async () => {
    const onPosition = vi.fn();
    const version = { md5: "e".repeat(32), createdAt: 1_752_000_000_000 };
    const { v, f } = findViewer(ZEPH, { onPosition });
    await v.open(synthesizeSummary(meta({ id: "n-p" })), Promise.resolve(meta({ id: "n-p" })), 0, { kind: "history", folderPath: "Note / Files", version }, "zephyrine");
    expect(onPosition).toHaveBeenLastCalledWith("n-p", 0, "zephyrine", version.md5);
    f.calls[0]!.d.resolve(BODY);
    await flush();
    await flush();
    expect(onPosition).toHaveBeenLastCalledWith("n-p", 1, "zephyrine", version.md5);
    v.destroy();
  });

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

  // A segment without a byte range cannot be placed; marking from byte 0 would be wrong.
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
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "zephyryne");
    f.calls[0]!.d.resolve(BODY);
    await flush();
    await flush();

    expect(q(v, ".txtbar__count")!.textContent).toBe("No matches");
    expect(v.el.querySelectorAll(".txt__sheet mark")).toHaveLength(0);
    const ask = q(v, ".txtbar__ask") as HTMLButtonElement;
    expect(ask.hidden).toBe(false);

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

    f.calls[0]!.d.resolve("A text");
    await flush();
    expect(q(v, ".txt__sheet")).toBeNull();

    f.calls[1]!.d.resolve("B text");
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
