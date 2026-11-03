// The allowlist is enforced in `pdf_shim.c` and again here, the last gate before an `href`.

import { describe, it, expect } from "vitest";
import {
  linkLabel,
  linkTarget,
  parsePageLinks,
  placeLink,
  type PdfLink,
} from "../../src/render/pdfWire";

function link(over: Partial<PdfLink> = {}): PdfLink {
  return { x: 10, y: 20, w: 30, h: 40, page: -1, uri: "https://example.invalid/", ...over };
}

describe("parsePageLinks", () => {
  it("reads the decoder's records", () => {
    const links = parsePageLinks(
      '[{"x":72,"y":118.5,"w":180,"h":12,"page":11,"uri":"#page=12"},' +
        '{"x":0,"y":0,"w":10,"h":10,"page":-1,"uri":"https://a.invalid/"}]',
    );
    expect(links).toEqual([
      { x: 72, y: 118.5, w: 180, h: 12, page: 11, uri: "#page=12" },
      { x: 0, y: 0, w: 10, h: 10, page: -1, uri: "https://a.invalid/" },
    ]);
  });

  it("answers with nothing for a payload that is not an array of links", () => {
    // Every one of these costs the link layer, never the page.
    expect(parsePageLinks("")).toEqual([]);
    expect(parsePageLinks("not json")).toEqual([]);
    expect(parsePageLinks("[")).toEqual([]);
    expect(parsePageLinks('{"x":1}')).toEqual([]);
    expect(parsePageLinks("[]")).toEqual([]);
  });

  it("drops a record with nothing to draw or nowhere to go", () => {
    const good = '{"x":1,"y":2,"w":3,"h":4,"page":-1,"uri":"https://a.invalid/"}';
    const cases = [
      '{"x":1,"y":2,"w":0,"h":4,"page":-1,"uri":"https://a.invalid/"}',
      '{"x":1,"y":2,"w":3,"h":-4,"page":-1,"uri":"https://a.invalid/"}',
      '{"x":1,"y":2,"w":3,"h":4,"page":-1,"uri":""}',
      '{"x":1,"y":2,"w":3,"h":4,"page":-1}',
      "null",
      "7",
    ];
    for (const bad of cases) {
      expect(parsePageLinks(`[${bad},${good}]`), bad).toHaveLength(1);
    }
  });

  it("no longer re-checks the SHAPE of a record our own shim wrote (§2.7)", () => {
    // Shim-shaped defects (non-numeric coords, fractional `page`) are admitted on purpose;
    // the ABI test catches them first.
    expect(
      parsePageLinks('[{"y":2,"w":3,"h":4,"page":1.5,"uri":"https://a.invalid/"}]'),
    ).toHaveLength(1);
  });
});

describe("linkTarget — the scheme allowlist", () => {
  it("follows http, https and mailto", () => {
    for (const uri of [
      "https://example.invalid/a?b=c#d",
      "http://example.invalid/",
      "mailto:someone@example.invalid",
      "HTTPS://EXAMPLE.INVALID/", // a scheme is case-insensitive
      "MailTo:someone@example.invalid",
    ]) {
      expect(linkTarget(link({ uri })), uri).toEqual({ kind: "external", href: uri });
    }
  });

  it("refuses everything else, and `javascript:` above all", () => {
    // `null` renders no element, never a dead href.
    for (const uri of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "  javascript:alert(1)", // a browser trims before parsing the scheme
      "\njavascript:alert(1)",
      "javascript://example.invalid/%0aalert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>x</script>",
      "vbscript:msgbox(1)",
      "about:blank",
      "ftp://example.invalid/",
      "http:example.invalid", // no `//` — not a link to a site
      "//example.invalid/",
      "example.invalid",
      "#page=3", // an unresolved internal uri is not an external one either
    ]) {
      expect(linkTarget(link({ uri })), uri).toBeNull();
    }
  });

  it("takes the resolved page over the uri whenever there is one", () => {
    // `page >= 0` is a resolved internal destination; the uri is MuPDF's `#page=…`.
    expect(linkTarget(link({ page: 11, uri: "#page=12&zoom=nan,0,0" }))).toEqual({
      kind: "page",
      page: 11,
    });
    expect(linkTarget(link({ page: 0, uri: "#page=1" }))).toEqual({ kind: "page", page: 0 });
  });
});

describe("linkLabel", () => {
  it("names an internal link by the page a human would call it", () => {
    // One-based, like the pager and the route.
    expect(linkLabel({ kind: "page", page: 11 })).toBe("Go to page 12");
    expect(linkLabel({ kind: "page", page: 0 })).toBe("Go to page 1");
  });

  it("names an external link by where it goes", () => {
    expect(linkLabel({ kind: "external", href: "https://a.invalid/b" })).toBe(
      "https://a.invalid/b",
    );
  });
});

describe("placeLink", () => {
  it("scales the page's points into the raster's CSS pixels", () => {
    expect(placeLink(link({ x: 20, y: 40, w: 60, h: 10 }), { width: 200, height: 100 }, { width: 400, height: 200 }))
      .toEqual({ left: 40, top: 80, width: 120, height: 20 });
  });

  it("is IDENTITY at 1:1, so the decoder's points are already the answer", () => {
    expect(placeLink(link({ x: 7, y: 9, w: 3, h: 4 }), { width: 200, height: 100 }, { width: 200, height: 100 }))
      .toEqual({ left: 7, top: 9, width: 3, height: 4 });
  });

  it("takes the scale from WIDTH alone, so a rounded canvas cannot skew it", () => {
    // MuPDF rounds rasters to whole pixels, so both axes scale from the width.
    const box = placeLink(
      link({ x: 0, y: 50, w: 100, h: 50 }),
      { width: 200, height: 100 },
      { width: 400, height: 201 },
    );
    expect(box).toEqual({ left: 0, top: 100, width: 200, height: 100 });
  });

  it("answers with a zero box for a degenerate page or canvas", () => {
    const zero = { left: 0, top: 0, width: 0, height: 0 };
    expect(placeLink(link(), { width: 0, height: 100 }, { width: 400, height: 200 })).toEqual(zero);
    expect(placeLink(link(), { width: 200, height: 100 }, { width: 0, height: 0 })).toEqual(zero);
  });
});
