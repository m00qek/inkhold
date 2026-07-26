import { describe, it, expect, vi } from "vitest";
import { createOcrController, type OcrState, type OcrView } from "../../src/pages/ocrPanel";
import { ApiError, type ApiFailureSink } from "../../src/api/client";
import type { Api } from "../../src/api/types";
import type { PageRef, PageText } from "../../src/core/types";

// The recognized-text panel's logic with the DOM injected, the same way the lazy
// engine is tested: the load-bearing invariants here are that the transcript is
// fetched ONLY while the panel is open, that a fast page flip can't paint the
// wrong page's text, and that failures reach the sink instead of a bare catch.

const flush = () => new Promise((r) => setTimeout(r, 0));

function page(index: number, textHash: string | null): PageRef {
  return { index, hash: `h${index}`.repeat(8), width: 1404, height: 1872, textHash };
}

// The Api returns `{ text, words }` on one call — the panel only ever reads
// `text`, and these helpers keep that fact visible rather than hidden in a mock.
const said = (text: string) => ({ text, words: [] });

function build(getPageText = vi.fn(async () => said("line one\nline two"))) {
  const api = { listFolder: vi.fn(), getNoteMeta: vi.fn(), getPageBytes: vi.fn(), getPageText } as unknown as Api;
  const states: OcrState[] = [];
  const view = {
    setOpen: vi.fn(),
    setToggleEnabled: vi.fn(),
    setState: vi.fn((s: OcrState) => void states.push(s)),
    relayout: vi.fn(),
  } satisfies OcrView;
  const failures: ApiFailureSink = { onSessionExpired: vi.fn(), onStalePage: vi.fn() };
  const ocr = createOcrController({ api, view, failures });
  return { ocr, api, view, states, failures, getPageText };
}

const kinds = (states: OcrState[]) => states.map((s) => s.kind);

describe("recognized-text panel", () => {
  it("does NOT fetch the transcript when a note is merely opened", async () => {
    const t = build();
    t.ocr.reset();
    t.ocr.setPage("n1", page(0, "t0".repeat(16)));
    await flush();

    // The whole point of `textHash` living on the page list: the toggle can be
    // enabled without anyone asking the server for text.
    expect(t.getPageText).not.toHaveBeenCalled();
    expect(t.view.setToggleEnabled).toHaveBeenLastCalledWith(true);
    expect(t.ocr.isOpen()).toBe(false);
  });

  it("fetches once the panel opens, and paints the transcript", async () => {
    const t = build();
    t.ocr.setPage("n1", page(0, "t0".repeat(16)));
    t.ocr.toggle();
    await flush();

    expect(t.getPageText).toHaveBeenCalledTimes(1);
    expect(t.view.setOpen).toHaveBeenLastCalledWith(true);
    expect(kinds(t.states)).toEqual(["loading", "text"]);
    expect(t.states.at(-1)).toEqual({ kind: "text", text: "line one\nline two" });
  });

  it("re-lays out the stage after toggling, in both directions", () => {
    const t = build();
    t.ocr.setPage("n1", page(0, "t0".repeat(16)));
    t.ocr.toggle();
    expect(t.view.relayout).toHaveBeenCalledTimes(1);
    t.ocr.toggle();
    expect(t.view.relayout).toHaveBeenCalledTimes(2);
  });

  it("offers no toggle for a page with no recognition, and opens nothing if clicked", () => {
    const t = build();
    t.ocr.setPage("n1", page(2, null));

    expect(t.view.setToggleEnabled).toHaveBeenLastCalledWith(false);
    t.ocr.toggle();
    expect(t.ocr.isOpen()).toBe(false);
    expect(t.getPageText).not.toHaveBeenCalled();
  });

  it("shows the empty state — not an error — when an open panel reaches a page with none", async () => {
    const t = build();
    t.ocr.setPage("n1", page(0, "t0".repeat(16)));
    t.ocr.toggle();
    await flush();

    t.ocr.setPage("n1", page(2, null));
    await flush();

    expect(t.states.at(-1)).toEqual({ kind: "empty" });
    expect(t.getPageText).toHaveBeenCalledTimes(1); // no speculative fetch
    // Still pressable, so an open panel is always closable.
    expect(t.view.setToggleEnabled).toHaveBeenLastCalledWith(true);
  });

  it("treats an empty transcript from the server as the empty state", async () => {
    const t = build(vi.fn(async () => said("   \n  ")));
    t.ocr.setPage("n1", page(0, "t0".repeat(16)));
    t.ocr.toggle();
    await flush();
    expect(t.states.at(-1)).toEqual({ kind: "empty" });
  });

  it("refills on page change while open, and caches so paging back doesn't refetch", async () => {
    const texts = ["page one text", "page two text"];
    let call = 0;
    const t = build(vi.fn(async () => said(texts[call++]!)));

    t.ocr.setPage("n1", page(0, "t0".repeat(16)));
    t.ocr.toggle();
    await flush();
    expect(t.states.at(-1)).toEqual({ kind: "text", text: "page one text" });

    t.ocr.setPage("n1", page(1, "t1".repeat(16)));
    await flush();
    expect(t.states.at(-1)).toEqual({ kind: "text", text: "page two text" });

    t.ocr.setPage("n1", page(0, "t0".repeat(16)));
    await flush();
    expect(t.states.at(-1)).toEqual({ kind: "text", text: "page one text" });
    expect(t.getPageText).toHaveBeenCalledTimes(2); // the third was cached
  });

  it("never paints page N's text under page M when pages are flipped fast", async () => {
    // Page 0 resolves LATE, after we have already moved to page 1.
    const resolvers: Array<(v: PageText) => void> = [];
    const t = build(vi.fn(() => new Promise<PageText>((r) => void resolvers.push(r))));

    t.ocr.setPage("n1", page(0, "t0".repeat(16)));
    t.ocr.toggle();
    await flush();
    t.ocr.setPage("n1", page(1, "t1".repeat(16)));
    await flush();

    resolvers[1]!(said("page two text")); // the current page lands first
    await flush();
    resolvers[0]!(said("page one text")); // the superseded page lands late
    await flush();

    expect(t.states.at(-1)).toEqual({ kind: "text", text: "page two text" });
  });

  it("routes an expired session to the sink instead of freezing the panel", async () => {
    const t = build(
      vi.fn(async () => {
        throw new ApiError("UNAUTHORIZED", "gone", 401);
      }),
    );
    t.ocr.setPage("n1", page(0, "t0".repeat(16)));
    t.ocr.toggle();
    await flush();

    expect(t.failures.onSessionExpired).toHaveBeenCalledTimes(1);
    // The shell is re-authenticating; the panel must not also claim a local error.
    expect(kinds(t.states)).toEqual(["loading"]);
  });

  it("routes STALE_PAGE to the sink so the note metadata is refetched", async () => {
    const p = page(0, "t0".repeat(16));
    const t = build(
      vi.fn(async () => {
        throw new ApiError("STALE_PAGE", "stale", 404);
      }),
    );
    t.ocr.setPage("n1", p);
    t.ocr.toggle();
    await flush();

    expect(t.failures.onStalePage).toHaveBeenCalledWith("n1", p);
  });

  it("surfaces a recoverable message for other failures, and retries on the next visit", async () => {
    let attempts = 0;
    const t = build(
      vi.fn(async () => {
        if (attempts++ === 0) throw new ApiError("NETWORK", "offline", 0);
        return said("recovered text");
      }),
    );
    t.ocr.setPage("n1", page(0, "t0".repeat(16)));
    t.ocr.toggle();
    await flush();

    expect(t.states.at(-1)?.kind).toBe("error");
    expect(t.failures.onSessionExpired).not.toHaveBeenCalled();

    // Page away and back: the failed hash was not marked as shown, so it retries.
    t.ocr.setPage("n1", page(1, "t1".repeat(16)));
    await flush();
    t.ocr.setPage("n1", page(0, "t0".repeat(16)));
    await flush();
    expect(t.states.at(-1)).toEqual({ kind: "text", text: "recovered text" });
  });

  it("resets to closed and drops the cache when another note opens", async () => {
    const t = build();
    t.ocr.setPage("n1", page(0, "t0".repeat(16)));
    t.ocr.toggle();
    await flush();
    expect(t.ocr.isOpen()).toBe(true);

    t.ocr.reset();
    expect(t.ocr.isOpen()).toBe(false);
    expect(t.view.setOpen).toHaveBeenLastCalledWith(false);

    // Same textHash, different note: the cache must not survive the reset.
    t.ocr.setPage("n2", page(0, "t0".repeat(16)));
    t.ocr.toggle();
    await flush();
    expect(t.getPageText).toHaveBeenCalledTimes(2);
  });

  it("does not repaint or refetch when the same page is re-announced (a zoom step)", async () => {
    const t = build();
    const p = page(0, "t0".repeat(16));
    t.ocr.setPage("n1", p);
    t.ocr.toggle();
    await flush();
    const before = t.states.length;

    t.ocr.setPage("n1", p);
    t.ocr.setPage("n1", p);
    await flush();

    expect(t.getPageText).toHaveBeenCalledTimes(1);
    expect(t.states).toHaveLength(before);
  });

  // The bug the textHash key exists to prevent: recognition run on-device gives
  // the page a NEW textHash while its stroke hash is untouched. The panel must
  // treat that as a different transcript and refetch.
  it("refetches when recognition changes even though the page content hash does not", async () => {
    const t = build();
    const before: PageRef = { index: 0, hash: "same".repeat(8), width: 1404, height: 1872, textHash: null };
    const after: PageRef = { ...before, textHash: "t0".repeat(16) };

    t.ocr.setPage("n1", before);
    t.ocr.toggle();
    await flush();
    expect(t.ocr.isOpen()).toBe(false); // nothing to open yet
    expect(t.getPageText).not.toHaveBeenCalled();

    // A STALE_PAGE-driven metadata refetch brings the recognition in.
    t.ocr.setPage("n1", after);
    expect(t.view.setToggleEnabled).toHaveBeenLastCalledWith(true);
    t.ocr.toggle();
    await flush();

    expect(t.getPageText).toHaveBeenCalledTimes(1);
    expect(t.states.at(-1)).toEqual({ kind: "text", text: "line one\nline two" });
  });
});
