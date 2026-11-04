import { describe, it, expect } from "vitest";
import { pdfPageThumbKey, pdfThumbKey } from "../../src/pages/pdf/pdfThumbStrip";
import type { Hash, PageRef } from "../../src/core/types";

// A colliding key would serve the wrong picture from IndexedDB indefinitely.

function ref(over: Partial<PageRef> = {}): PageRef {
  return {
    index: 3,
    sourcePage: 12,
    hash: "inkhash" as Hash,
    width: 1404,
    height: 1872,
    textHash: null,
    ...over,
  } as PageRef;
}

describe("the bare page's key", () => {
  it("names the document's md5 and the page, in the live theme", () => {
    expect(pdfPageThumbKey("docmd5", 7, "light")).toEqual({
      hash: "docmd5:p7",
      size: "thumb",
      theme: "light",
    });
  });

  it("is the PERSISTENT tier's size, which is what makes it survive a reload", () => {
    expect(pdfPageThumbKey("docmd5", 0, "dark").size).toBe("thumb");
  });

  it("separates the two themes, so `evictTheme` can account for these entries", () => {
    expect(pdfPageThumbKey("docmd5", 7, "light").hash).toBe(
      pdfPageThumbKey("docmd5", 7, "dark").hash,
    );
    expect(pdfPageThumbKey("docmd5", 7, "light")).not.toEqual(
      pdfPageThumbKey("docmd5", 7, "dark"),
    );
  });

  it("separates two documents and two pages", () => {
    expect(pdfPageThumbKey("a", 1, "light").hash).not.toBe(pdfPageThumbKey("b", 1, "light").hash);
    expect(pdfPageThumbKey("a", 1, "light").hash).not.toBe(pdfPageThumbKey("a", 2, "light").hash);
  });
});

describe("the composite key", () => {
  it("is the bare key when the page carries no ink", () => {
    expect(pdfThumbKey("docmd5", 7, "light", undefined, null)).toEqual(
      pdfPageThumbKey("docmd5", 7, "light"),
    );
  });

  it("names BOTH blobs when it does — the picture depends on two", () => {
    const k = pdfThumbKey("docmd5", 7, "light", ref(), null);
    expect(k.hash).toBe("docmd5:p7+inkhash");
    expect(k.hash).not.toBe(pdfPageThumbKey("docmd5", 7, "light").hash);
  });

  it("moves when the handwriting does, which is the whole point", () => {
    const before = pdfThumbKey("docmd5", 7, "light", ref({ hash: "old" as Hash }), null);
    const after = pdfThumbKey("docmd5", 7, "light", ref({ hash: "new" as Hash }), null);
    expect(before.hash).not.toBe(after.hash);
  });

  it("is SALTED by the previewed version, so a preview cannot be served live ink", () => {
    // `ref` is always the live mark page; under a preview the version md5 names the bytes.
    const live = pdfThumbKey("docmd5", 7, "light", ref(), null);
    const preview = pdfThumbKey("docmd5", 7, "light", ref(), "versionmd5");
    expect(live.hash).toBe("docmd5:p7+inkhash");
    expect(preview.hash).toBe("docmd5:p7+versionmd5:3");
    expect(preview.hash).not.toBe(live.hash);
  });

  it("separates two versions of the same page under preview", () => {
    const a = pdfThumbKey("docmd5", 7, "light", ref(), "v1");
    const b = pdfThumbKey("docmd5", 7, "light", ref(), "v2");
    expect(a.hash).not.toBe(b.hash);
  });

  it("separates two mark pages of one version — the salt carries the page index", () => {
    const p2 = pdfThumbKey("docmd5", 2, "light", ref({ index: 0 }), "v1");
    const p9 = pdfThumbKey("docmd5", 9, "light", ref({ index: 1 }), "v1");
    expect(p2.hash).toBe("docmd5:p2+v1:0");
    expect(p9.hash).toBe("docmd5:p9+v1:1");
  });
});
