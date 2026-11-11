// @vitest-environment happy-dom
// A digest's source page, small: which digests have one, the page it shows,
// a page the file no longer has, and starting over when the digests change.

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

function setup(m: NoteMeta) {
  const getNoteMeta = vi.fn(async () => m);
  const getThumbnail = vi.fn(async () => new Blob(["png"]));
  return { thumbs: createDigestThumbs({ api: { getNoteMeta }, thumbnails: { getThumbnail } as never }), getNoteMeta, getThumbnail };
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

  it("drawn once; after forget, read and drawn again", async () => {
    const { thumbs, getNoteMeta, getThumbnail } = setup(meta("note", 2));
    const d = digest("Note/n.note", 1);
    const h = placed(thumbs.holder(d, "t"));
    await vi.waitFor(() => expect(h.querySelector("img")).not.toBeNull());
    // A repaint shows it at once.
    expect(thumbs.holder(d, "t")!.querySelector("img")).not.toBeNull();
    expect(getThumbnail).toHaveBeenCalledTimes(1);
    thumbs.forget();
    expect(thumbs.holder(d, "t")!.querySelector("img")).toBeNull();
    await vi.waitFor(() => expect(getThumbnail).toHaveBeenCalledTimes(2));
    expect(getNoteMeta).toHaveBeenCalledTimes(2);
  });
});
