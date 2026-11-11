// @vitest-environment happy-dom
// A viewer's Digests: when its opener is there, dimmed or live; the rows on
// the page on screen, even one turned to while they loaded; an answer for a
// document no longer open.

import { describe, it, expect, vi } from "vitest";
import { createDigestViewerPanel } from "../../src/pages/digest/digestViewerPanel";
import type { ViewerDigests } from "../../src/pages/viewer/viewer";
import type { Digest } from "../../src/api/digestTypes";

const digest = (id: string, page: number | null): Digest => ({
  id, text: `passage ${id}`, comment: null, categoryUid: "", author: null, createdAt: 1, modifiedAt: 1, note: null, waiting: false,
  source: { kind: "document", path: "Document/a.pdf", fileId: "57", page, changed: false },
});

function source(answer: () => Promise<Digest[] | null>, kept = true): ViewerDigests {
  return { of: answer, kept: () => kept, ink: { picture: async () => null, holder: () => null } };
}

describe("a viewer's Digests", () => {
  it("lists a document's digests and marks those on the page on screen; a row turns the page", async () => {
    const picked: number[] = [];
    const v = createDigestViewerPanel({ id: "p", source: source(async () => [digest("1", 1), digest("2", 3), digest("3", 3)]), onPick: (p) => picked.push(p), onNone: () => {} });
    expect(v.opener.el.hidden).toBe(false);
    v.load("57", 2, () => false);
    await vi.waitFor(() => expect(v.opener.el.disabled).toBe(false));
    expect(v.panel.el.querySelectorAll(".digest-doc__row.is-current")).toHaveLength(2);
    v.setCurrent(0);
    expect([...v.panel.el.querySelectorAll(".digest-doc__row.is-current")].map((r) => r.textContent)).toEqual([expect.stringContaining("passage 1")]);
    v.panel.el.querySelectorAll<HTMLButtonElement>(".digest-doc__go")[1]!.click();
    expect(picked).toEqual([2]);
  });

  it("marks the page turned to while the digests loaded, not the one they were asked on", async () => {
    let resolve: (d: Digest[]) => void = () => {};
    const v = createDigestViewerPanel({ id: "p", source: source(() => new Promise((r) => (resolve = r))), onPick: () => {}, onNone: () => {} });
    v.load("57", 0, () => false);
    v.setCurrent(2);
    resolve([digest("1", 1), digest("2", 3)]);
    await vi.waitFor(() => expect(v.panel.el.querySelectorAll(".digest-doc__row")).toHaveLength(2));
    expect([...v.panel.el.querySelectorAll(".digest-doc__row.is-current")].map((r) => r.textContent)).toEqual([expect.stringContaining("passage 2")]);
  });

  it("a document with none dims the opener and shuts the panel; one that can't have any hides it", async () => {
    const onNone = vi.fn();
    const v = createDigestViewerPanel({ id: "p", source: source(async () => []), onPick: () => {}, onNone });
    v.load("57", 0, () => false);
    await vi.waitFor(() => expect(onNone).toHaveBeenCalled());
    expect(v.opener.el.disabled).toBe(true);
    expect(v.opener.el.getAttribute("aria-label")).toBe("Digests — none were taken from this document");
    v.setApplicable(false);
    expect(v.opener.el.hidden).toBe(true);
    v.setApplicable(true);
    expect(v.opener.el.hidden).toBe(false);
  });

  it("is not there while the server keeps no digests, nor without a source at all", async () => {
    const off = createDigestViewerPanel({ id: "p", source: source(async () => null, false), onPick: () => {}, onNone: () => {} });
    expect(off.opener.el.hidden).toBe(true);
    off.load("57", 0, () => false);
    await new Promise((r) => setTimeout(r, 0));
    expect(off.opener.el.hidden).toBe(true);
    expect(createDigestViewerPanel({ id: "q", source: undefined, onPick: () => {}, onNone: () => {} }).opener.el.hidden).toBe(true);
  });

  it("an answer for a document no longer open is dropped", async () => {
    let resolve: (d: Digest[]) => void = () => {};
    const v = createDigestViewerPanel({ id: "p", source: source(() => new Promise((r) => (resolve = r))), onPick: () => {}, onNone: () => {} });
    let stale = false;
    v.load("57", 0, () => stale);
    stale = true;
    resolve([digest("1", 1)]);
    await new Promise((r) => setTimeout(r, 0));
    expect(v.panel.el.querySelectorAll(".digest-doc__row")).toHaveLength(0);
  });
});
