import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  coverageLine,
  createNoteSearch,
  deepLinkQuery,
  noLocalSearch,
  pageSummary,
  pendingLine,
  resultsMayGrowLine,
  DEFAULT_DEBOUNCE_MS,
  MIN_GLOBAL_QUERY_LEN,
  type SearchState,
} from "../../src/pages/noteSearch";
import { rankDocuments, type LocalHit, type LocalResults, type LocalSearch } from "../../src/search/localSearch";
import { ApiError } from "../../src/api/client";

// The search controller with the DOM and the ENGINE both replaced — the same
// shape as ocrPanel.test.ts. The invariants worth a test are the two that cost
// real money if they regress: one run per PAUSE rather than per keystroke (which
// used to be a request and is now a frame — `golden-search.md` §4.6), and an
// answer that lost the race never painting over a newer one.
//
// The engine is a `LocalSearch` and nothing here knows or asks which real one it
// stands for. That is the point of the interface, and a test that faked "the
// local one" would be asserting a distinction the view is not allowed to make.

const DEBOUNCE = DEFAULT_DEBOUNCE_MS;

/** One matching DOCUMENT — the only kind of result there is now. */
function doc(fileId: number, pages: number[], updatedAt = 0): LocalHit {
  return { md5: `md5-${fileId}`, fileId, pages, updatedAt };
}

/** What a `results` state looks like once documents land. */
function painted(query: string, documents: LocalHit[]): SearchState {
  return { kind: "results", query, documents };
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
  const settle = async (index: number, documents: LocalHit[]): Promise<void> => {
    const p = pending[index];
    if (!p) throw new Error(`no pending call at ${index} (have ${pending.length})`);
    p.resolve({
      query: p.query,
      totalPages: documents.reduce((n, d) => n + d.pages.length, 0),
      documents,
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
    // THE NUMBER MOVED, AND IT WAS NOT INHERITED. 220 ms bought one backend FTS
    // query per pause; there is no backend query left to buy (§4.6). What the
    // pause buys now is frames — the worst short prefix is 37.9 ms of main
    // thread — so it is smaller, and it is emphatically not zero.
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
      // Nothing has run yet — the whole point.
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

      // Trailing whitespace is not a new question; re-issuing here would cancel
      // the run already on its way to answering exactly this one.
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
      await vi.advanceTimersByTimeAsync(DEBOUNCE - 10); // still in the quiet period
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

      // The late answer to a question no longer being asked must not repopulate
      // the results under a box the user emptied.
      expect(h.last()).toEqual({ kind: "idle" });
    });
  });

  // THE GLOBAL FLOOR. A library-wide query below `MIN_GLOBAL_QUERY_LEN` matches
  // very nearly the whole index — noise on screen, and the costliest thing the
  // engine does — so the box never fires it; it idles exactly as an empty box
  // does. (In-doc find lives in the viewers, not this controller, and is not
  // gated — see txtViewer/findInNote.)
  describe("below the global floor", () => {
    it("runs NOTHING for a 1- or 2-char query, and idles", async () => {
      expect(MIN_GLOBAL_QUERY_LEN).toBe(3);
      const h = harness();

      h.controller.setQuery("r");
      expect(h.last()).toEqual({ kind: "idle" });
      h.controller.setQuery("ro");
      expect(h.last()).toEqual({ kind: "idle" });

      // Even after the debounce window, nothing ran.
      await vi.advanceTimersByTimeAsync(DEBOUNCE * 4);
      expect(h.calls).toEqual([]);
    });

    it("fires the moment the query reaches the floor, and idles again if it drops back", async () => {
      const h = harness();

      h.controller.setQuery("ro"); // below — no run, no searching state
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.calls).toEqual([]);

      h.controller.setQuery("roa"); // at the floor — search-as-you-type resumes
      expect(h.last()).toEqual({ kind: "searching", query: "roa" });
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.calls).toEqual(["roa"]);

      // Deleting back below the floor abandons the results and idles — no stale
      // rows left standing under a query too short to have earned them.
      h.controller.setQuery("ro");
      expect(h.last()).toEqual({ kind: "idle" });
    });
  });

  // THE race. Two runs are outstanding and they come back in the WRONG order:
  // without the token guard the older, slower one lands last and wins, leaving
  // the user staring at results for a query they have moved past — permanently,
  // because nothing later is coming to correct it.
  describe("staleness", () => {
    it("an earlier SLOW answer does not overwrite a later FAST one", async () => {
      const h = harness();

      h.controller.setQuery("road");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.calls).toEqual(["road", "roadmap"]);

      // The LATER query answers first…
      await h.settle(1, [doc(2, [2])]);
      expect(h.last()).toEqual(painted("roadmap", [doc(2, [2])]));

      // …and then the earlier, slower one finally arrives. It must be dropped.
      await h.settle(0, [doc(9, [9])]);
      expect(h.last()).toEqual(painted("roadmap", [doc(2, [2])]));
      // And it must not have painted at all, not even transiently.
      expect(h.states.filter((s) => s.kind === "results" && s.query === "road")).toEqual([]);
    });

    it("ABORTS the superseded run rather than merely ignoring it", async () => {
      const h = harness();
      h.controller.setQuery("road");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.signals[0]?.aborted).toBe(false);

      // The token alone would leave the abandoned query running — and locally
      // that is main thread, not a socket: §4.6's worst prefix is 37.9 ms an
      // engine that honours the signal can hand back.
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
    // A dead session showing as "no matches" is exactly the bug class the
    // ApiFailureSink was introduced to remove. Still live with a local index:
    // the fallback engine behind the same interface is the one that can still
    // meet an expired cookie.
    it("routes UNAUTHORIZED to onSessionExpired instead of rendering an empty result", async () => {
      const h = harness();
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      await h.fail(0, new ApiError("UNAUTHORIZED", "gone", 401));

      expect(h.failures.onSessionExpired).toHaveBeenCalledTimes(1);
      // Not an error message and emphatically not an empty result set.
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

  // THE ANSWER IS WHOLE. There is no cursor, no "More results" and no floor: a
  // client holding the index has already paid for every match, so a painted
  // `results` state is everything the query found and the controller has no
  // second arm to spend.
  describe("one answer, no continuation", () => {
    it("has no loadMore to call", () => {
      const h = harness();
      expect((h.controller as Record<string, unknown>)["loadMore"]).toBeUndefined();
    });

    it("carries nothing but the query and its documents", async () => {
      const h = harness();
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      await h.settle(0, [doc(1, [0, 1, 2])]);

      const state = h.last();
      expect(state?.kind).toBe("results");
      // No `cursor`, no `usedFuzzy`, no `coverage` — each retired with the
      // server that was the only thing able to say it.
      expect(Object.keys(state ?? {}).sort()).toEqual(["documents", "kind", "query"]);
    });
  });

  // The default engine. It exists so the controller has no "nobody handed me
  // one" branch — not as a fallback, which is why it is never `ready`.
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

      // And it genuinely reset: the same query is a new question afterwards.
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.calls).toEqual(["roadmap", "roadmap"]);
    });
  });
});

// THE ONE ORDERING. Pinned here, in the consumer's own suite, because every
// renderer downstream refuses to re-sort and that refusal is only correct if
// this holds: §4.1 folds ranking and the match count into the same number, so
// there is nothing to reflow into when anything else loads.
describe("rankDocuments, as the view relies on it", () => {
  it("ranks by matching pages, then by recency", () => {
    const few = doc(1, [0], 900);
    const many = doc(2, [0, 1, 2], 100);
    const alsoFew = doc(3, [7], 500);

    expect(rankDocuments([few, many, alsoFew]).map((d) => d.fileId)).toEqual([2, 1, 3]);
  });
});

// What the deep link carries, now that nothing marks anything.
describe("deepLinkQuery", () => {
  // THE DECISION: what they typed. The alternative was to guess an expansion the
  // row does not have — `LocalHit` carries no matched term — and inventing one
  // is worse than handing the viewer's find the same string the box holds.
  it("is the typed query, verbatim", () => {
    expect(deepLinkQuery("reunaio")).toBe("reunaio");
    expect(deepLinkQuery("jean valjean")).toBe("jean valjean");
    expect(deepLinkQuery("")).toBe("");
  });
});

// The result row's quiet metadata — what replaced first the strip of page chips
// and then the excerpt.
describe("pageSummary", () => {
  it("gets its plural right", () => {
    expect(pageSummary(2)).toBe("Matches on 2 pages");
    expect(pageSummary(20)).toBe("Matches on 20 pages");
  });

  // A name-only match. "Matches on 0 pages" would make the reader parse a
  // number to learn that the marked title above was the whole answer.
  it("says nothing when no page matched", () => {
    expect(pageSummary(0)).toBeNull();
    expect(pageSummary(-1)).toBeNull();
  });

  // IT SPEAKS FOR ONE PAGE NOW, and the change is the point of the rework. The
  // old silence-below-two existed because the server returned one hit per
  // document and counted only what was inside the fetched window, so "1" was
  // both the ordinary case and a claim the row could not stand behind. A
  // document's `pages` is every page that matched, so one is a fact.
  it("says so for a single page, because it is now true", () => {
    expect(pageSummary(1)).toBe("Matches on 1 page");
    expect(pageSummary(1, 1)).toBe("Matches in 1 paragraph");
  });

  // IT COUNTS PAGES, NOT MATCHES, and that is the load-bearing part. A page
  // either matched or did not; there is no per-page tally to build a match count
  // from. A row claiming "3 matches" beside a find counter reading "1 of 9" for
  // the same query would be a second source of truth for one number — so the row
  // says what it knows and leaves the tally to the one place that has it.
  it("never claims a match count it was not given", () => {
    for (const n of [1, 3, 12]) expect(pageSummary(n)).not.toMatch(/match(es)? /);
  });

  it("switches the unit for a .txt: paragraphs, not pages", () => {
    expect(pageSummary(3, 1)).toBe("Matches in 3 paragraphs");
    expect(pageSummary(0, 1)).toBeNull();
  });
});

// The empty state's second sentence.
describe("coverageLine", () => {
  // IT STOPPED BEING ABLE TO COUNT. `12 of your 40 notes have no recognised
  // text` rode a zero-hit server response, and §4.3 leaves no server
  // interpreting a query — so there is no response for it to ride. Degrading to
  // the unquantified sentence is the same call the old `null` branch made: say
  // less rather than assert "0 of your 0 notes" about a library nobody counted.
  it("says the one thing it can still stand behind", () => {
    expect(coverageLine()).toBe("Only notes recognised on the device are searchable.");
  });
});

// The two sentences pending-ness adds, and the one property that matters most
// about them: they are a DIFFERENT claim from the coverage sentence above.
// `unsearchable` is permanent and `pending` resolves itself, so a UI that merged
// them would tell somebody their half-minute-old upload is permanently
// unsearchable — and, worse, tell them to stop waiting for the text that is
// about to arrive.
describe("pendingLine and resultsMayGrowLine", () => {
  it("says how much is still coming, over an empty result", () => {
    expect(pendingLine(3)).toBe("3 documents are still being indexed — matches in them will appear on their own.");
    expect(pendingLine(1)).toBe("1 document is still being indexed — matches in them will appear on their own.");
  });

  // THIS DID NOT RETIRE WITH THE CURSOR. "More results" said the ANSWER was cut
  // short; this says the CORPUS is not finished. A document still being derived
  // is not in the manifest, so it is not in the index, so it cannot match — and
  // no amount of holding the whole index repairs that.
  it("qualifies a NON-EMPTY page more quietly, because completeness is the only claim to repair", () => {
    expect(resultsMayGrowLine(2)).toBe("More may appear — 2 documents are still being indexed.");
    expect(resultsMayGrowLine(1)).toBe("More may appear — 1 document is still being indexed.");
  });

  // Silence is the ordinary case. A line that appeared over a fully indexed
  // library would be permanent furniture saying nothing.
  it("says nothing at all when nothing is outstanding", () => {
    expect(pendingLine(0)).toBeNull();
    expect(resultsMayGrowLine(0)).toBeNull();
    expect(pendingLine(-1)).toBeNull();
    expect(resultsMayGrowLine(-1)).toBeNull();
  });

  // The two sentences must not be able to collapse into each other: the empty
  // state explains an absence, the results line qualifies a presence.
  it("does not say the same thing twice", () => {
    expect(pendingLine(3)).not.toBe(resultsMayGrowLine(3));
  });

  // …and neither of them is the coverage sentence, which is about text that
  // will never exist.
  it("is a different sentence from the unsearchable one", () => {
    expect(coverageLine()).not.toContain("still being indexed");
    expect(pendingLine(3)).not.toContain("recognised");
  });
});
