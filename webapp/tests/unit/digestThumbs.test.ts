// @vitest-environment happy-dom
// A digest's source page, small: which digests have one, the page it shows,
// a page the file no longer has, and a refresh that redraws only a changed file.

import { describe, it, expect, vi } from "vitest";
import { createDigestThumbs } from "../../src/pages/digest/digestThumbs";
import type { Digest } from "../../src/api/digestTypes";
import type { NoteMeta } from "../../src/core/types";

const digest = (path: string, page: number | null, fileId: string | null = "9"): Digest => ({
  id: "1", text: "x", comment: null, categoryUid: "", author: null, createdAt: 1, modifiedAt: 1, note: null, waiting: false,
  source: { kind: "document", path, fileId, page, changed: false },
});

const meta = (fileType: string, pages: number): NoteMeta =>
  ({ id: "9", name: "a", fileType, fileHash: "h", size: 1, annotationsId: null, pages: Array.from({ length: pages }, (_, i) => ({ index: i, hash: `p${i}` })) }) as unknown as NoteMeta;

function setup(first: NoteMeta) {
  let m = first;
  const getNoteMeta = vi.fn(async () => m);
  const getThumbnail = vi.fn(async () => new Blob(["png"]));
  const thumbs = createDigestThumbs({ api: { getNoteMeta }, thumbnails: { getThumbnail } as never });
  return { thumbs, getNoteMeta, getThumbnail, becomes: (next: NoteMeta) => void (m = next) };
}

/** A holder on the page, as the panel puts it there. */
function placed(h: HTMLElement | null): HTMLElement {
  document.body.append(h!);
  return h!;
}

describe("a digest's source page", () => {
  it("only for a PDF or a note in the library", () => {
    const { thumbs } = setup(meta("pdf", 3));
    expect(thumbs.holder(digest("Document/a.pdf", 1), "t")).not.toBeNull();
    expect(thumbs.holder(digest("Document/book.epub", 4), "t")).toBeNull();
    expect(thumbs.holder(digest("Document/a.pdf", 1, null), "t")).toBeNull();
  });

  it("draws the digest's own page of a PDF", async () => {
    const { thumbs, getThumbnail } = setup(meta("pdf", 3));
    const h = placed(thumbs.holder(digest("Document/a.pdf", 2), "t"));
    await vi.waitFor(() => expect(h.querySelector("img")).not.toBeNull());
    expect(getThumbnail).toHaveBeenCalledWith({ fileHash: "h", fileId: "9", pdfPage: 1 }, "pdf");
  });

  it("a page the file no longer has shows nothing, never another page", async () => {
    const { thumbs, getThumbnail } = setup(meta("pdf", 2));
    const h = placed(thumbs.holder(digest("Document/a.pdf", 5), "t"));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.querySelector("img")).toBeNull();
    expect(getThumbnail).not.toHaveBeenCalled();
  });

  it("drawn once; a refresh keeps an unchanged file's picture, shown at once", async () => {
    const { thumbs, getNoteMeta, getThumbnail } = setup(meta("note", 2));
    const d = digest("Note/n.note", 1);
    const h = placed(thumbs.holder(d, "t"));
    await vi.waitFor(() => expect(h.querySelector("img")).not.toBeNull());
    // A repaint shows it at once.
    expect(thumbs.holder(d, "t")!.querySelector("img")).not.toBeNull();
    thumbs.refresh();
    const again = placed(thumbs.holder(d, "t"));
    expect(again.querySelector("img")).not.toBeNull();
    await vi.waitFor(() => expect(getNoteMeta).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(getThumbnail).toHaveBeenCalledTimes(1);
    expect(again.querySelector("img")).not.toBeNull();
  });

  it("a changed file's page is drawn again after a refresh; the old picture shows until then", async () => {
    const { thumbs, getThumbnail, becomes } = setup(meta("pdf", 3));
    const d = digest("Document/a.pdf", 2);
    const h = placed(thumbs.holder(d, "t"));
    await vi.waitFor(() => expect(h.querySelector("img")).not.toBeNull());
    const before = h.querySelector("img")!.getAttribute("src");
    becomes({ ...meta("pdf", 3), fileHash: "h2" } as NoteMeta);
    thumbs.refresh();
    const again = placed(thumbs.holder(d, "t"));
    expect(again.querySelector("img")!.getAttribute("src")).toBe(before);
    await vi.waitFor(() => expect(getThumbnail).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(again.querySelector("img")!.getAttribute("src")).not.toBe(before));
    expect(getThumbnail).toHaveBeenLastCalledWith({ fileHash: "h2", fileId: "9", pdfPage: 1 }, "pdf");
  });

  it("a changed file without the page any more empties the picture", async () => {
    const { thumbs, becomes } = setup(meta("pdf", 3));
    const d = digest("Document/a.pdf", 3);
    const h = placed(thumbs.holder(d, "t"));
    await vi.waitFor(() => expect(h.querySelector("img")).not.toBeNull());
    becomes({ ...meta("pdf", 1), fileHash: "h2" } as NoteMeta);
    thumbs.refresh();
    const again = placed(thumbs.holder(d, "t"));
    await vi.waitFor(() => expect(again.querySelector("img")).toBeNull());
    expect(again.classList.contains("has-thumb")).toBe(false);
  });
});
