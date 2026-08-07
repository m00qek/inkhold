import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { coverageLine, createNoteSearch, groupHits, pageSummary, MIN_GLOBAL_QUERY_LEN, type SearchState } from "../../src/pages/noteSearch";
import { ApiError } from "../../src/api/client";
import type { Api } from "../../src/api/types";
import type { Coverage, SearchHit, SearchResults } from "../../src/core/types";

// The search controller with the DOM and the network both replaced — the same
// shape as ocrPanel.test.ts. The two invariants worth a test are the two that
// cost real money if they regress: one request per PAUSE rather than per
// keystroke, and a response that lost the race never painting over a newer one.

const DEBOUNCE = 220;

function hit(name: string, pageIndex: number, noteId = "n-1"): SearchHit {
  return { noteId, noteName: name, pageIndex, snippet: `a <mark>${name}</mark> excerpt` };
}

/** What a `results` state looks like when nothing special happened. */
function painted(query: string, hits: SearchHit[]): SearchState {
  return { kind: "results", query, hits, usedFuzzy: false, coverage: null };
}

/** An `Api` whose `searchText` resolves only when the test says so. */
function deferredApi() {
  const calls: string[] = [];
  /** The cursor each call carried — `undefined` for a first page. Parallel to `calls`. */
  const cursors: (string | undefined)[] = [];
  const pending: { query: string; resolve: (r: SearchResults) => void; reject: (e: unknown) => void }[] = [];

  const api = {
    searchText(query: string, _limit?: number, cursor?: string): Promise<SearchResults> {
      calls.push(query);
      cursors.push(cursor);
      return new Promise<SearchResults>((resolve, reject) => pending.push({ query, resolve, reject }));
    },
  } as unknown as Api;

  /** Settle the Nth still-pending call (in call order). */
  const settle = async (
    index: number,
    hits: SearchHit[],
    extra: { usedFuzzy?: boolean; coverage?: Coverage | null; cursor?: string } = {},
  ): Promise<void> => {
    const p = pending[index];
    if (!p) throw new Error(`no pending call at ${index} (have ${pending.length})`);
    p.resolve({
      query: p.query,
      hits,
      usedFuzzy: extra.usedFuzzy ?? false,
      coverage: extra.coverage ?? null,
      cursor: extra.cursor,
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

  return { api, calls, cursors, settle, fail };
}

function harness() {
  const { api, calls, cursors, settle, fail } = deferredApi();
  const states: SearchState[] = [];
  const failures = { onSessionExpired: vi.fn(), onStalePage: vi.fn() };
  const controller = createNoteSearch({
    api,
    failures,
    debounceMs: DEBOUNCE,
    view: { setState: (s) => void states.push(s) },
  });
  const last = (): SearchState | undefined => states[states.length - 1];
  return { controller, calls, cursors, settle, fail, states, last, failures };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createNoteSearch", () => {
  describe("debounce", () => {
    it("sends ONE request for a burst of keystrokes, carrying the final query", async () => {
      const h = harness();

      for (const q of ["r", "ro", "roa", "road", "roadm", "roadma", "roadmap"]) h.controller.setQuery(q);
      // Nothing has left yet — the whole point.
      expect(h.calls).toEqual([]);

      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.calls).toEqual(["roadmap"]);
    });

    it("does not request until the quiet period has actually elapsed", async () => {
      const h = harness();
      h.controller.setQuery("roadmap");

      await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
      expect(h.calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.calls).toEqual(["roadmap"]);
    });

    it("shows the searching state immediately, so typing has feedback before the request", async () => {
      const h = harness();
      h.controller.setQuery("roadmap");
      expect(h.last()).toEqual({ kind: "searching", query: "roadmap" });
    });

    it("paints the hits when the response lands", async () => {
      const h = harness();
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      await h.settle(0, [hit("Weekly review", 4)]);
      expect(h.last()).toEqual(painted("roadmap", [hit("Weekly review", 4)]));
    });

    it("ignores an input event that does not change the effective query", async () => {
      const h = harness();
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.calls).toEqual(["roadmap"]);

      // Trailing whitespace is not a new question; re-issuing here would cancel
      // the request already on its way to answering exactly this one.
      h.controller.setQuery("roadmap ");
      h.controller.setQuery("  roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.calls).toEqual(["roadmap"]);
    });
  });

  describe("blank query", () => {
    it("short-circuits to idle without ever scheduling a request", async () => {
      const h = harness();
      h.controller.setQuery("");
      await vi.advanceTimersByTimeAsync(DEBOUNCE * 4);

      expect(h.calls).toEqual([]);
      expect(h.last()).toEqual({ kind: "idle" });
    });

    it("clearing the box cancels a debounced request that had not left yet", async () => {
      const h = harness();
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE - 10); // still in the quiet period
      h.controller.setQuery("");

      await vi.advanceTimersByTimeAsync(DEBOUNCE * 4);
      expect(h.calls).toEqual([]);
      expect(h.last()).toEqual({ kind: "idle" });
    });

    it("clearing the box drops a response that is already in flight", async () => {
      const h = harness();
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.calls).toEqual(["roadmap"]);

      h.controller.setQuery("");
      await h.settle(0, [hit("Weekly review", 4)]);

      // The late answer to a question no longer being asked must not repopulate
      // the results under a box the user emptied.
      expect(h.last()).toEqual({ kind: "idle" });
    });
  });

  // THE GLOBAL FLOOR. A library-wide query below `MIN_GLOBAL_QUERY_LEN` is broad-
  // term cost and noise, so the box never fires it — it idles exactly as an empty
  // box does. (In-doc find lives in the viewers, not this controller, and is not
  // gated — see txtViewer/findInNote.)
  describe("below the global floor", () => {
    it("issues NO request for a 1- or 2-char query, and idles", async () => {
      expect(MIN_GLOBAL_QUERY_LEN).toBe(3);
      const h = harness();

      h.controller.setQuery("r");
      expect(h.last()).toEqual({ kind: "idle" });
      h.controller.setQuery("ro");
      expect(h.last()).toEqual({ kind: "idle" });

      // Even after the debounce window, nothing left the box.
      await vi.advanceTimersByTimeAsync(DEBOUNCE * 4);
      expect(h.calls).toEqual([]);
    });

    it("fires the moment the query reaches the floor, and idles again if it drops back", async () => {
      const h = harness();

      h.controller.setQuery("ro"); // below — no request, no searching state
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.calls).toEqual([]);

      h.controller.setQuery("roa"); // at the floor — search-as-you-type resumes
      expect(h.last()).toEqual({ kind: "searching", query: "roa" });
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.calls).toEqual(["roa"]);

      // Deleting back below the floor abandons the results and idles — no stale
      // hits left standing under a query too short to have earned them.
      h.controller.setQuery("ro");
      expect(h.last()).toEqual({ kind: "idle" });
    });
  });

  // THE race. Two requests are outstanding and they come back in the WRONG
  // order: without the token guard the older, slower one lands last and wins,
  // leaving the user staring at results for a query they have moved past —
  // permanently, because nothing later is coming to correct it.
  describe("staleness", () => {
    it("an earlier SLOW response does not overwrite a later FAST one", async () => {
      const h = harness();

      h.controller.setQuery("road");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.calls).toEqual(["road", "roadmap"]);

      // The LATER query answers first…
      await h.settle(1, [hit("Roadmap note", 2)]);
      expect(h.last()).toEqual(painted("roadmap", [hit("Roadmap note", 2)]));

      // …and then the earlier, slower one finally arrives. It must be dropped.
      await h.settle(0, [hit("Road trip", 9)]);
      expect(h.last()).toEqual(painted("roadmap", [hit("Roadmap note", 2)]));
      // And it must not have painted at all, not even transiently.
      expect(h.states.filter((s) => s.kind === "results" && s.query === "road")).toEqual([]);
    });

    it("a stale FAILURE is dropped too, so it cannot bury current results", async () => {
      const h = harness();
      h.controller.setQuery("road");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      await h.settle(1, [hit("Roadmap note", 2)]);
      await h.fail(0, new ApiError("SERVER", "boom", 500));

      expect(h.last()).toEqual(painted("roadmap", [hit("Roadmap note", 2)]));
    });
  });

  describe("failures", () => {
    // A dead session showing as "no matches" is exactly the bug class the
    // ApiFailureSink was introduced to remove.
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

    it("surfaces any other failure as a distinct error state, not as zero hits", async () => {
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

  // The two fields the response has always carried and nothing ever rendered.
  // They have to reach the VIEW, not just the seam, or the banner and the
  // quantified empty state have nothing to be built on.
  describe("what the response says about itself", () => {
    it("carries usedFuzzy through to the painted state", async () => {
      const h = harness();
      h.controller.setQuery("caligrafa");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      await h.settle(0, [hit("Caligrafia", 1)], { usedFuzzy: true });

      expect(h.last()).toEqual({
        kind: "results",
        query: "caligrafa",
        hits: [hit("Caligrafia", 1)],
        usedFuzzy: true,
        coverage: null,
      });
    });

    it("carries zero-hit coverage through, and a missing one stays null", async () => {
      const h = harness();
      h.controller.setQuery("nothing");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      await h.settle(0, [], { coverage: { notes: 40, unsearchable: 12 } });
      expect(h.last()).toEqual({
        kind: "results",
        query: "nothing",
        hits: [],
        usedFuzzy: false,
        coverage: { notes: 40, unsearchable: 12 },
      });

      // Absent coverage must arrive as "not said", never as zeroes — a `0 of 0`
      // would render as a confident sentence about a library nobody counted.
      h.controller.setQuery("nothing else");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      await h.settle(1, []);
      expect(h.last()).toEqual(painted("nothing else", []));
    });
  });

  // The keyset "More": the server caps a page at 20 and never serves a total,
  // so growing the list is spending the cursor the last response carried —
  // and everything below is about spending it HONESTLY: same query, appended
  // in arrival order, dropped when stale, and never destroying what is painted.
  describe("cursor paging (loadMore)", () => {
    /** A first page of results with a cursor already painted. */
    async function paged(h: ReturnType<typeof harness>): Promise<void> {
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      await h.settle(0, [hit("Alpha", 0)], { cursor: "k1" });
    }

    it("carries the cursor into the painted state, and its absence as undefined", async () => {
      const h = harness();
      await paged(h);
      expect(h.last()).toMatchObject({ kind: "results", cursor: "k1" });

      h.controller.setQuery("roadmaps");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      await h.settle(1, [hit("Alpha", 0)]);
      const state = h.last();
      expect(state?.kind).toBe("results");
      expect(state?.kind === "results" ? state.cursor : "sentinel").toBeUndefined();
    });

    it("fetches the next page with the SAME query and the spent cursor, appending in order", async () => {
      const h = harness();
      await paged(h);

      void h.controller.loadMore();
      expect(h.calls).toEqual(["roadmap", "roadmap"]);
      expect(h.cursors).toEqual([undefined, "k1"]);

      await h.settle(1, [hit("Beta", 2, "n-2")], { cursor: "k2" });
      expect(h.last()).toMatchObject({
        kind: "results",
        query: "roadmap",
        hits: [hit("Alpha", 0), hit("Beta", 2, "n-2")],
        cursor: "k2",
      });
    });

    it("is a no-op without a cursor — a complete result set has nothing to fetch", async () => {
      const h = harness();
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      await h.settle(0, [hit("Alpha", 0)]); // no cursor: this is everything

      await h.controller.loadMore();
      expect(h.calls).toEqual(["roadmap"]);
    });

    it("ignores a second click while a page is in flight — no duplicate request", async () => {
      const h = harness();
      await paged(h);

      void h.controller.loadMore();
      void h.controller.loadMore();
      expect(h.calls).toEqual(["roadmap", "roadmap"]); // one page fetch, not two
    });

    it("a page returning no cursor exhausts the stream", async () => {
      const h = harness();
      await paged(h);
      void h.controller.loadMore();
      await h.settle(1, [hit("Beta", 2, "n-2")]); // last page: no cursor

      const state = h.last();
      expect(state?.kind).toBe("results");
      expect(state?.kind === "results" ? state.cursor : "sentinel").toBeUndefined();
    });

    it("keeps the FIRST page's usedFuzzy and coverage — paging is one search, not many", async () => {
      const h = harness();
      h.controller.setQuery("caligrafa");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      await h.settle(0, [hit("Caligrafia", 1)], { usedFuzzy: true, cursor: "k1" });

      void h.controller.loadMore();
      // A later page reporting `false` is the transport talking; the search
      // that produced these hits was approximate when it ran.
      await h.settle(1, [hit("Caligrafia", 3)], { usedFuzzy: false });
      expect(h.last()).toMatchObject({ kind: "results", usedFuzzy: true, coverage: null });
    });

    it("drops a stale page after a new keystroke — never mixes two searches", async () => {
      const h = harness();
      await paged(h);
      void h.controller.loadMore();

      h.controller.setQuery("roadmaps"); // supersedes the walk mid-flight
      await h.settle(1, [hit("Stale", 9, "n-9")], { cursor: "k2" });

      // The stale page painted nothing: the current state is still the new
      // query's "searching", and no results state ever contained the stale hit.
      expect(h.last()).toEqual({ kind: "searching", query: "roadmaps" });
      expect(
        h.states.some((s) => s.kind === "results" && s.hits.some((x) => x.noteId === "n-9")),
      ).toBe(false);
    });

    it("cannot resume a stream that reset() ended", async () => {
      const h = harness();
      await paged(h);
      h.controller.reset();

      await h.controller.loadMore();
      expect(h.calls).toEqual(["roadmap"]); // nothing pageable is on screen
      expect(h.last()).toEqual({ kind: "idle" });
    });

    it("a failed page leaves the painted results standing — never an error screen over real hits", async () => {
      const h = harness();
      await paged(h);
      const before = h.last();

      void h.controller.loadMore();
      await h.fail(1, new ApiError("NETWORK", "offline", 0));

      expect(h.last()).toBe(before); // nothing new painted, nothing destroyed
      expect(h.states.some((s) => s.kind === "error")).toBe(false);

      // …and the retry is a fresh request with the same cursor.
      void h.controller.loadMore();
      expect(h.cursors).toEqual([undefined, "k1", "k1"]);
    });

    it("routes UNAUTHORIZED from a page fetch to the session sink", async () => {
      const h = harness();
      await paged(h);

      void h.controller.loadMore();
      await h.fail(1, new ApiError("UNAUTHORIZED", "gone", 401));

      expect(h.failures.onSessionExpired).toHaveBeenCalledTimes(1);
      expect(h.states.some((s) => s.kind === "error")).toBe(false);
    });
  });

  // Ranking is per PAGE, so a verbose note used to produce a row per matching
  // page and push everything else out of the limit's window.
  describe("groupHits", () => {
    it("collapses a note's pages into one entry, keeping every page", () => {
      const grouped = groupHits([hit("Aurora", 0), hit("Aurora", 3), hit("Aurora", 5)]);

      expect(grouped).toHaveLength(1);
      expect(grouped[0]!.noteId).toBe("n-1");
      expect(grouped[0]!.pages.map((p) => p.pageIndex)).toEqual([0, 3, 5]);
    });

    it("keeps the server's ranking: a note takes the position of its best page", () => {
      const grouped = groupHits([
        hit("Aurora", 2, "n-a"),
        hit("Beta", 0, "n-b"),
        hit("Aurora", 7, "n-a"),
        hit("Gamma", 1, "n-c"),
      ]);

      expect(grouped.map((g) => g.noteId)).toEqual(["n-a", "n-b", "n-c"]);
      expect(grouped[0]!.pages.map((p) => p.pageIndex)).toEqual([2, 7]);
    });

    it("collapses a repeated page rather than counting it twice", () => {
      const grouped = groupHits([hit("Aurora", 4), hit("Aurora", 4)]);
      expect(grouped[0]!.pages).toHaveLength(1);
    });

    it("has nothing to say about no hits", () => {
      expect(groupHits([])).toEqual([]);
    });

    it("carries the group's KIND — absent/0 is a note, 1 is a .txt", () => {
      const noteGroup = groupHits([hit("Aurora", 0)]);
      expect(noteGroup[0]!.kind).toBe(0); // absent kind reads as a note page

      const txtHit: SearchHit = { noteId: "t-1", noteName: "readme", pageIndex: 2, snippet: "x", kind: 1 };
      const txtGroup = groupHits([txtHit]);
      expect(txtGroup[0]!.kind).toBe(1);
    });

    it("reads an unknown kind tolerantly as a note (not a txt)", () => {
      const weird: SearchHit = { noteId: "x", noteName: "x", pageIndex: 0, snippet: "x", kind: 9 };
      expect(groupHits([weird])[0]!.kind).toBe(0);
    });
  });

  // The result row's quiet metadata — what replaced the strip of page chips.
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

    // Global search names DOCUMENTS: one hit per note, so a group of one is the
    // ordinary case. "Matches on 1 page" would ride nearly every row, and for a
    // notebook the query reached on three hundred pages it would state a reach
    // the row does not know. The claim moves to find-in-note, which does.
    it("says nothing for a single-page group, because it would not be true", () => {
      expect(pageSummary(1)).toBeNull();
      expect(pageSummary(1, 1)).toBeNull();
    });

    // IT COUNTS PAGES, NOT MATCHES, and that is the load-bearing part. The
    // library-wide route returns one row per matching page with an excerpt and no
    // tally; only the note-scoped route find uses carries `matches`. A row
    // claiming "3 matches" beside a find counter reading "1 of 9" for the same
    // query would be a second source of truth for one number — so the row says
    // what it knows and leaves the tally to the one place that has it.
    it("never claims a match count it was not given", () => {
      for (const n of [3, 12]) expect(pageSummary(n)).not.toMatch(/match(es)? /);
    });

    it("switches the unit for a .txt: paragraphs, not pages", () => {
      expect(pageSummary(3, 1)).toBe("Matches in 3 paragraphs");
      expect(pageSummary(0, 1)).toBeNull();
    });
  });

  // The empty state's second sentence. `12 of your 40 notes have no recognised
  // text` is the difference between "it is not there" and "it might be there and
  // I cannot see it".
  describe("coverageLine", () => {
    it("quantifies when the server counted", () => {
      expect(coverageLine({ notes: 40, unsearchable: 12 })).toBe(
        "12 of your 40 notes have no recognised text, so they cannot be searched by their handwriting.",
      );
    });

    // ABSENT IS NOT ZERO. A server that did not send the field said nothing; a
    // fabricated "0 of your 0 notes" would be a confident claim about a library
    // nobody counted, which is worse than saying less.
    it("degrades to the unquantified sentence when the server did not say", () => {
      expect(coverageLine(null)).toBe("Only notes recognised on the device are searchable.");
    });

    it("degrades when there is nothing to warn about", () => {
      // Everything is findable, so making the reader do arithmetic to learn that
      // the answer is "no" buys nothing.
      expect(coverageLine({ notes: 40, unsearchable: 0 })).toBe("Only notes recognised on the device are searchable.");
      expect(coverageLine({ notes: 0, unsearchable: 0 })).toBe("Only notes recognised on the device are searchable.");
    });
  });

  describe("reset", () => {
    it("cancels a pending request, orphans an in-flight one, and goes idle", async () => {
      const h = harness();
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      h.controller.reset();
      expect(h.last()).toEqual({ kind: "idle" });

      await h.settle(0, [hit("Weekly review", 4)]);
      expect(h.last()).toEqual({ kind: "idle" });

      // And it genuinely reset: the same query is a new question afterwards.
      h.controller.setQuery("roadmap");
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(h.calls).toEqual(["roadmap", "roadmap"]);
    });
  });
});
