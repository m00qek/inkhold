import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  coverageLine,
  createNoteSearch,
  deepLinkQuery,
  expansionNotice,
  noLocalSearch,
  pageSummary,
  pendingLine,
  resultsMayGrowLine,
  DEFAULT_DEBOUNCE_MS,
  MIN_GLOBAL_QUERY_LEN,
  type ExpansionPart,
  type SearchState,
} from "../../src/pages/noteSearch";
import { rankDocuments, type Expansion, type LocalHit, type LocalResults, type LocalSearch } from "../../src/search/localSearch";
import { ApiError } from "../../src/api/client";

// The search controller with the DOM and the engine replaced.

const DEBOUNCE = DEFAULT_DEBOUNCE_MS;

function doc(fileId: number, pages: number[], updatedAt = 0): LocalHit {
  return { md5: `md5-${fileId}`, fileId, pages, updatedAt };
}

function painted(query: string, documents: LocalHit[], expansions: Expansion[] = []): SearchState {
  return { kind: "results", query, documents, expansions };
}

/** A `LocalSearch` whose answers arrive only when the test says so. */
function deferredSearch() {
  const calls: string[] = [];
  /** The signal each call carried, parallel to `calls` — the abort is asserted on. */
  const signals: (AbortSignal | undefined)[] = [];
  const pending: { query: string; resolve: (r: LocalResults) => void; reject: (e: unknown) => void }[] = [];

  const engine: LocalSearch = {
    ready: true,
    search(query: string, signal?: AbortSignal): Promise<LocalResults> {
      calls.push(query);
      signals.push(signal);
      return new Promise<LocalResults>((resolve, reject) => pending.push({ query, resolve, reject }));
    },
  };

  /** Settle the Nth still-pending call (in call order). */
  const settle = async (index: number, documents: LocalHit[], expansions: Expansion[] = []): Promise<void> => {
    const p = pending[index];
    if (!p) throw new Error(`no pending call at ${index} (have ${pending.length})`);
    p.resolve({
      query: p.query,
      totalPages: documents.reduce((n, d) => n + d.pages.length, 0),
      documents,
      expansions,
    });
    await Promise.resolve();
    await Promise.resolve();
  };
  const fail = async (index: number, e: unknown): Promise<void> => {
    const p = pending[index];
    if (!p) throw new Error(`no pending call at ${index}`);
    p.reject(e);
    await Promise.resolve();
    await Promise.resolve();
  };

  return { engine, calls, signals, settle, fail };
}

function harness() {
  const { engine, calls, signals, settle, fail } = deferredSearch();
  const states: SearchState[] = [];
  const failures = { onSessionExpired: vi.fn(), onStalePage: vi.fn() };
  const controller = createNoteSearch({
    search: engine,
    failures,
    debounceMs: DEBOUNCE,
    view: { setState: (s) => void states.push(s) },
  });
  const last = (): SearchState | undefined => states[states.length - 1];
  return { controller, calls, signals, settle, fail, states, last, failures };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createNoteSearch", () => {
  describe("debounce", () => {
    // The debounce buys main-thread frames now (worst short prefix 37.9 ms): smaller, not zero.
    it("defaults to a debounce well under the 220 ms a round trip once bought", () => {
      expect(DEFAULT_DEBOUNCE_MS).toBeGreaterThan(0);
      expect(DEFAULT_DEBOUNCE_MS).toBeLessThan(220);
    });

    it("uses that default when the caller does not say", async () => {
      const { engine, calls } = deferredSearch();
      const controller = createNoteSearch({
        search: engine,
        failures: { onSessionExpired: vi.fn(), onStalePage: vi.fn() },
        view: { setState: () => {} },
      });
      controller.setQuery("roadmap");

      await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS - 1);
      expect(calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toEqual(["roadmap"]);
    });

    it("runs ONE query for a burst of keystrokes, carrying the final one", async () => {
      const h = harness();

      for (const q of ["r", "ro", "roa", "road", "roadm", "roadma", "roadmap"]) h.controller.setQuery(q);
      expect(h.calls).toEqual([]);

      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.calls).toEqual(["roadmap"]);
    });

    it("does not run until the quiet period has actually elapsed", async () => {
      const h = harness();
      h.controller.setQuery("roadmap");

      await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
      expect(h.calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.calls).toEqual(["roadmap"]);
    });

    it("shows the searching state immediately, so typing has feedback before the run", async () => {
      const h = harness();
      h.controller.setQuery("roadmap");
      expect(h.last()).toEqual({ kind: "searching", query: "roadmap" });
    });

    it("paints the documents when the engine answers", async () => {
      const h = harness();
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      await h.settle(0, [doc(7, [4, 9])]);
      expect(h.last()).toEqual(painted("roadmap", [doc(7, [4, 9])]));
    });

    it("ignores an input event that does not change the effective query", async () => {
      const h = harness();
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.calls).toEqual(["roadmap"]);

      // Trailing whitespace is not a new question; re-issuing would cancel the run.
      h.controller.setQuery("roadmap ");
      h.controller.setQuery("  roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.calls).toEqual(["roadmap"]);
    });
  });

  describe("blank query", () => {
    it("short-circuits to idle without ever scheduling a run", async () => {
      const h = harness();
      h.controller.setQuery("");
      await vi.advanceTimersByTimeAsync(DEBOUNCE * 4);

      expect(h.calls).toEqual([]);
      expect(h.last()).toEqual({ kind: "idle" });
    });

    it("clearing the box cancels a debounced run that had not started yet", async () => {
      const h = harness();
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE - 10);
      h.controller.setQuery("");

      await vi.advanceTimersByTimeAsync(DEBOUNCE * 4);
      expect(h.calls).toEqual([]);
      expect(h.last()).toEqual({ kind: "idle" });
    });

    it("clearing the box drops an answer that is already in flight", async () => {
      const h = harness();
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.calls).toEqual(["roadmap"]);

      h.controller.setQuery("");
      await h.settle(0, [doc(7, [4])]);

      expect(h.last()).toEqual({ kind: "idle" });
    });
  });

  // Below `MIN_GLOBAL_QUERY_LEN` a global query matches nearly everything; never run it.
  describe("below the global floor", () => {
    it("runs NOTHING for a 1- or 2-char query, and idles", async () => {
      expect(MIN_GLOBAL_QUERY_LEN).toBe(3);
      const h = harness();

      h.controller.setQuery("r");
      expect(h.last()).toEqual({ kind: "idle" });
      h.controller.setQuery("ro");
      expect(h.last()).toEqual({ kind: "idle" });

      await vi.advanceTimersByTimeAsync(DEBOUNCE * 4);
      expect(h.calls).toEqual([]);
    });

    it("fires the moment the query reaches the floor, and idles again if it drops back", async () => {
      const h = harness();

      h.controller.setQuery("ro");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.calls).toEqual([]);

      h.controller.setQuery("roa");
      expect(h.last()).toEqual({ kind: "searching", query: "roa" });
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.calls).toEqual(["roa"]);

      h.controller.setQuery("ro");
      expect(h.last()).toEqual({ kind: "idle" });
    });
  });

  // Out-of-order answers: the older, slower one must not win.
  describe("staleness", () => {
    it("an earlier SLOW answer does not overwrite a later FAST one", async () => {
      const h = harness();

      h.controller.setQuery("road");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.calls).toEqual(["road", "roadmap"]);

      await h.settle(1, [doc(2, [2])]);
      expect(h.last()).toEqual(painted("roadmap", [doc(2, [2])]));

      await h.settle(0, [doc(9, [9])]);
      expect(h.last()).toEqual(painted("roadmap", [doc(2, [2])]));
      expect(h.states.filter((s) => s.kind === "results" && s.query === "road")).toEqual([]);
    });

    it("ABORTS the superseded run rather than merely ignoring it", async () => {
      const h = harness();
      h.controller.setQuery("road");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.signals[0]?.aborted).toBe(false);

      // The token alone would leave the abandoned query burning main thread.
      h.controller.setQuery("roadmap");
      expect(h.signals[0]?.aborted).toBe(true);
    });

    it("a stale FAILURE is dropped too, so it cannot bury current results", async () => {
      const h = harness();
      h.controller.setQuery("road");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      await h.settle(1, [doc(2, [2])]);
      await h.fail(0, new ApiError("SERVER", "boom", 500));

      expect(h.last()).toEqual(painted("roadmap", [doc(2, [2])]));
    });
  });

  describe("failures", () => {
    it("routes UNAUTHORIZED to onSessionExpired instead of rendering an empty result", async () => {
      const h = harness();
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      await h.fail(0, new ApiError("UNAUTHORIZED", "gone", 401));

      expect(h.failures.onSessionExpired).toHaveBeenCalledTimes(1);
      expect(h.last()).toEqual({ kind: "searching", query: "roadmap" });
      expect(h.states.some((s) => s.kind === "results")).toBe(false);
    });

    it("surfaces any other failure as a distinct error state, not as zero results", async () => {
      const h = harness();
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      await h.fail(0, new ApiError("NETWORK", "offline", 0));

      expect(h.failures.onSessionExpired).not.toHaveBeenCalled();
      expect(h.last()).toEqual({ kind: "error", query: "roadmap" });
    });

    it("retries on the next keystroke after a failure", async () => {
      const h = harness();
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      await h.fail(0, new ApiError("NETWORK", "offline", 0));

      h.controller.setQuery("roadmaps");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.calls).toEqual(["roadmap", "roadmaps"]);
    });
  });

  describe("one answer, no continuation", () => {
    it("has no loadMore to call", () => {
      const h = harness();
      expect((h.controller as Record<string, unknown>)["loadMore"]).toBeUndefined();
    });

    it("carries nothing but the query, its documents and what was substituted", async () => {
      const h = harness();
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      await h.settle(0, [doc(1, [0, 1, 2])]);

      const state = h.last();
      expect(state?.kind).toBe("results");
      expect(Object.keys(state ?? {}).sort()).toEqual(["documents", "expansions", "kind", "query"]);
    });

    it("substitutes nothing when the query as typed answered", async () => {
      const h = harness();
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      await h.settle(0, [doc(1, [0])]);

      expect(h.last()).toEqual(painted("roadmap", [doc(1, [0])]));
    });

    it("passes the ladder's substitution through to the view unchanged", async () => {
      const h = harness();
      h.controller.setQuery("valjaen");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      await h.settle(0, [doc(1, [0])], [{ typed: "valjaen", matched: "valjean" }]);

      expect(h.last()).toEqual(painted("valjaen", [doc(1, [0])], [{ typed: "valjaen", matched: "valjean" }]));
    });
  });

  // The default engine, so the controller has no "no engine" branch; never `ready`.
  describe("noLocalSearch", () => {
    it("is never ready and answers every query with nothing", async () => {
      expect(noLocalSearch.ready).toBe(false);
      await expect(noLocalSearch.search("anything")).resolves.toEqual({
        query: "anything",
        totalPages: 0,
        documents: [],
        expansions: [],
      });
    });
  });

  describe("reset", () => {
    it("cancels a pending run, orphans an in-flight one, and goes idle", async () => {
      const h = harness();
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      h.controller.reset();
      expect(h.last()).toEqual({ kind: "idle" });

      await h.settle(0, [doc(7, [4])]);
      expect(h.last()).toEqual({ kind: "idle" });

      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.calls).toEqual(["roadmap", "roadmap"]);
    });
  });
});

// Renderers downstream never re-sort, which is only correct if this holds.
describe("rankDocuments, as the view relies on it", () => {
  it("ranks by matching pages, then by recency", () => {
    const few = doc(1, [0], 900);
    const many = doc(2, [0, 1, 2], 100);
    const alsoFew = doc(3, [7], 500);

    expect(rankDocuments([few, many, alsoFew]).map((d) => d.fileId)).toEqual([2, 1, 3]);
  });
});

describe("expansionNotice", () => {
  const say = (parts: ExpansionPart[] | null): string | null => (parts ? parts.map((p) => p.text).join("") : null);
  const words = (parts: ExpansionPart[] | null): string[] =>
    (parts ?? []).filter((p) => p.matched).map((p) => p.text);

  it("says nothing when the query as typed is what answered", () => {
    expect(expansionNotice([])).toBeNull();
  });

  it("names the word searched and the word typed", () => {
    const parts = expansionNotice([{ typed: "valjaen", matched: "valjean" }]);
    expect(say(parts)).toBe("Matched valjean instead of “valjaen”.");
    expect(words(parts)).toEqual(["valjean"]);
  });

  // `valjen` reaches `valen` and `valjean` as alternatives, so "or" within a group.
  it("offers both readings of a genuine distance tie, as alternatives", () => {
    const parts = expansionNotice([
      { typed: "valjen", matched: "valen" },
      { typed: "valjen", matched: "valjean" },
    ]);
    expect(say(parts)).toBe("Matched valen or valjean instead of “valjen”.");
    expect(words(parts)).toEqual(["valen", "valjean"]);
  });

  it("keeps the pairing when more than one token was corrected", () => {
    expect(
      say(
        expansionNotice([
          { typed: "valjen", matched: "valen" },
          { typed: "valjen", matched: "valjean" },
          { typed: "reuniao", matched: "reunião" },
        ]),
      ),
    ).toBe("Matched valen or valjean instead of “valjen”, and reunião instead of “reuniao”.");
  });

  it("reports only the token that was substituted, not the whole query", () => {
    expect(say(expansionNotice([{ typed: "cosete", matched: "cosette" }]))).toBe(
      "Matched cosette instead of “cosete”.",
    );
  });

  it("says a repeated substitution once", () => {
    expect(
      say(
        expansionNotice([
          { typed: "valjaen", matched: "valjean" },
          { typed: "valjaen", matched: "valjean" },
        ]),
      ),
    ).toBe("Matched valjean instead of “valjaen”.");
  });

  // Parts, not a string: both halves are device-authored and become text nodes.
  it("keeps the word as a part rather than as markup", () => {
    const parts = expansionNotice([{ typed: "<b>x</b>", matched: "<i>y</i>" }]) ?? [];
    expect(parts.some((p) => p.matched && p.text === "<i>y</i>")).toBe(true);
    expect(parts.map((p) => p.text).join("")).toContain("<b>x</b>");
  });
});

describe("deepLinkQuery", () => {
  // The row carries the corrected term: viewers gate fuzzy answers behind an opt-in.
  it("carries the word that was searched, not the one that was typed", () => {
    expect(deepLinkQuery("valjaen", [{ typed: "valjaen", matched: "valjean" }])).toBe("valjean");
  });

  it("is the typed query, verbatim, when nothing was substituted", () => {
    expect(deepLinkQuery("reunaio")).toBe("reunaio");
    expect(deepLinkQuery("jean valjean", [])).toBe("jean valjean");
    expect(deepLinkQuery("")).toBe("");
  });

  it("substitutes only the tokens the ladder corrected, in place", () => {
    expect(deepLinkQuery("jean valjaen", [{ typed: "valjaen", matched: "valjean" }])).toBe("jean valjean");
  });

  // A tie is not resolved here; picking one would invent a fact.
  it("leaves an ambiguous token alone rather than guessing between two readings", () => {
    expect(
      deepLinkQuery("valjen", [
        { typed: "valjen", matched: "valen" },
        { typed: "valjen", matched: "valjean" },
      ]),
    ).toBe("valjen");
  });

  it("preserves the query's own spacing", () => {
    expect(deepLinkQuery("  jean   valjaen ", [{ typed: "valjaen", matched: "valjean" }])).toBe(
      "  jean   valjean ",
    );
  });
});

describe("pageSummary", () => {
  it("gets its plural right", () => {
    expect(pageSummary(2)).toBe("Matches on 2 pages");
    expect(pageSummary(20)).toBe("Matches on 20 pages");
  });

  it("says nothing when no page matched", () => {
    expect(pageSummary(0)).toBeNull();
    expect(pageSummary(-1)).toBeNull();
  });

  it("says so for a single page, because it is now true", () => {
    expect(pageSummary(1)).toBe("Matches on 1 page");
    expect(pageSummary(1, 1)).toBe("Matches in 1 paragraph");
  });

  // Pages, not matches: there is no per-page tally to count from.
  it("never claims a match count it was not given", () => {
    for (const n of [1, 3, 12]) expect(pageSummary(n)).not.toMatch(/match(es)? /);
  });

  it("switches the unit for a .txt: paragraphs, not pages", () => {
    expect(pageSummary(3, 1)).toBe("Matches in 3 paragraphs");
    expect(pageSummary(0, 1)).toBeNull();
  });
});

describe("coverageLine", () => {
  it("says the one thing it can still stand behind", () => {
    expect(coverageLine()).toBe("Only notes recognised on the device are searchable.");
  });
});

// `unsearchable` is permanent and `pending` transient; they must never merge.
describe("pendingLine and resultsMayGrowLine", () => {
  it("says how much is still coming, over an empty result", () => {
    expect(pendingLine(3)).toBe("3 documents are still being indexed — matches in them will appear on their own.");
    expect(pendingLine(1)).toBe("1 document is still being indexed — matches in them will appear on their own.");
  });

  // A document still deriving is not in the manifest, so it cannot match yet.
  it("qualifies a NON-EMPTY page more quietly, because completeness is the only claim to repair", () => {
    expect(resultsMayGrowLine(2)).toBe("More may appear — 2 documents are still being indexed.");
    expect(resultsMayGrowLine(1)).toBe("More may appear — 1 document is still being indexed.");
  });

  it("says nothing at all when nothing is outstanding", () => {
    expect(pendingLine(0)).toBeNull();
    expect(resultsMayGrowLine(0)).toBeNull();
    expect(pendingLine(-1)).toBeNull();
    expect(resultsMayGrowLine(-1)).toBeNull();
  });

  it("does not say the same thing twice", () => {
    expect(pendingLine(3)).not.toBe(resultsMayGrowLine(3));
  });

  it("is a different sentence from the unsearchable one", () => {
    expect(coverageLine()).not.toContain("still being indexed");
    expect(pendingLine(3)).not.toContain("recognised");
  });
});
