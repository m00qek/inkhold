// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFindSession,
  findCountText,
  type FindHit,
  type FindState,
  type FindSurface,
} from "../../src/pages/viewer/findSession";
import { DocumentTextPending, DocumentTextUnavailable, type DocSearch, type DocSearchResult } from "../../src/search/docSearch";

const MD5 = "a".repeat(32);

function answer(over: Partial<DocSearchResult> = {}): DocSearchResult {
  return {
    query: "q",
    md5: MD5,
    segments: [{ segment: 1, offset: null, length: null, matches: 2, terms: ["budget"] }],
    usedFuzzy: false,
    expansions: [],
    textless: false,
    extent: 3,
    ...over,
  };
}

/** A surface that records what it was told, and a session over a fake search. */
function setup(search: DocSearch["search"], opts: Partial<Parameters<typeof createFindSession>[0]> = {}) {
  const states: FindState[] = [];
  const hits: (readonly FindHit[])[] = [];
  const reveals: boolean[] = [];
  const surface: FindSurface = {
    setOpen: () => {},
    setState: (s) => void states.push(s),
    setStepEnabled: () => {},
    focusField: () => {},
    setHits: (h) => void hits.push(h),
    showSegment: (segment) => session.setPage(segment),
    paint: async (_segment, ask) => {
      reveals.push(ask.reveal);
      return 1;
    },
    clearMarks: () => {},
  };
  const docs: DocSearch = { search: vi.fn(search), drop: vi.fn() };
  const session = createFindSession({ docs, failures: { onSessionExpired: vi.fn() }, surface, debounceMs: 0, ...opts });
  session.setDocument(MD5);
  session.open();
  return { session, states, hits, reveals, docs, last: () => states[states.length - 1] };
}

const settle = () => vi.advanceTimersByTimeAsync(1);

afterEach(() => vi.useRealTimers());

describe("the find session says the true thing when there is nothing to count", () => {
  it("a document the server has not indexed yet is 'still being indexed', and is asked again on its own", async () => {
    vi.useFakeTimers();
    let ready = false;
    const t = setup(async () => {
      if (!ready) throw new DocumentTextPending(MD5);
      return answer();
    }, { pendingRetryMs: 1000 });
    t.session.setQuery("budget");
    await settle();
    expect(t.last()).toEqual({ kind: "pending" });
    expect(findCountText(t.last()!, "file", "")).toBe("This file is still being indexed — matches will appear on their own.");

    ready = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.last()).toMatchObject({ kind: "settled", at: 0, total: 2 });
  });

  it("stops asking once the bar closes", async () => {
    vi.useFakeTimers();
    const t = setup(async () => {
      throw new DocumentTextPending(MD5);
    }, { pendingRetryMs: 1000 });
    t.session.setQuery("budget");
    await settle();
    const asked = vi.mocked(t.docs.search).mock.calls.length;
    t.session.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.mocked(t.docs.search).mock.calls.length).toBe(asked);
  });

  it("a plain 404 is an error, never 'No matches' and never 'still being indexed'", async () => {
    vi.useFakeTimers();
    const t = setup(async () => {
      throw new DocumentTextUnavailable(MD5);
    });
    t.session.setQuery("budget");
    await settle();
    expect(t.last()).toEqual({ kind: "error" });
  });

  it("a document with no text at all says so, not 'No matches'", async () => {
    vi.useFakeTimers();
    const t = setup(async () => answer({ segments: [], textless: true }));
    t.session.setQuery("budget");
    await settle();
    expect(t.last()).toEqual({ kind: "textless" });
    expect(findCountText(t.last()!, "file", "No text to search.")).toBe("No text to search.");
  });

  it("a PDF cut at the extraction cap says which pages it searched", async () => {
    vi.useFakeTimers();
    const t = setup(async () => answer({ extent: 7200 }), { extractsUpTo: 5000 });
    t.session.setQuery("budget");
    await settle();
    expect(t.last()).toEqual({ kind: "settled", at: 0, total: 2, fuzzy: false, partial: 5000 });
    expect(findCountText(t.last()!, "file", "")).toBe("1 of 2 · first 5,000 pages");
    expect(findCountText({ kind: "empty", partial: 5000 }, "file", "")).toBe("No matches in the first 5,000 pages");
  });

  it("a document within the cap is searched whole", async () => {
    vi.useFakeTimers();
    const t = setup(async () => answer({ extent: 4999 }), { extractsUpTo: 5000 });
    t.session.setQuery("budget");
    await settle();
    expect(t.last()).toMatchObject({ kind: "settled", partial: null });
  });
});

describe("the find session counts what the surface can show", () => {
  it("leaves out hits the surface cannot place, from the count and the steps", async () => {
    vi.useFakeTimers();
    const t = setup(
      async () =>
        answer({
          segments: [
            { segment: 0, offset: null, length: null, matches: 9, terms: ["x"] },
            { segment: 2, offset: 10, length: 5, matches: 1, terms: ["x"] },
          ],
        }),
      { placeable: (h) => h.offset !== null },
    );
    t.session.setQuery("x");
    await settle();
    expect(t.last()).toMatchObject({ kind: "settled", at: 0, total: 1 });
    expect(t.session.currentSegment()).toBe(2);
  });

  it("searches at once when the document arrives, without waiting for typing to pause", async () => {
    vi.useFakeTimers();
    const t = setup(async () => answer(), { debounceMs: 10_000 });
    t.session.setDocument(null);
    t.session.setQuery("budget");
    expect(t.docs.search).not.toHaveBeenCalled();
    t.session.setDocument(MD5);
    await settle();
    expect(t.docs.search).toHaveBeenCalledTimes(1);
  });
});

describe("the find session brings the current match into view only when find moves", () => {
  it("a landing and a step reveal; a plain repaint (a zoom, a re-render) never scrolls", async () => {
    vi.useFakeTimers();
    const t = setup(async () => answer());
    t.session.setPage(1);
    t.session.setQuery("budget");
    await settle();
    expect(t.reveals.at(-1)).toBe(true); // landed on page 1's first match
    t.session.repaint();
    await settle();
    expect(t.reveals.at(-1)).toBe(false);
    t.session.step(1);
    await settle();
    expect(t.reveals.at(-1)).toBe(true);
  });
});
