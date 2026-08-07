// `render/pdfLinks.ts` — the payload's shape, the scheme allowlist and where a
// link's rect lands, at the numbers.
//
// The allowlist is the one that matters most. It is enforced TWICE — once in
// `pdf_shim.c`, so the payload never carries a uri we will not follow, and again
// here, because this side is the last thing between a string out of a synced
// file and an `href` a browser will navigate. Only this copy stands between a
// hostile document and the DOM, so it is asserted on its own rather than through
// the decoder.

import { describe, it, expect } from "vitest";
import {
  linkLabel,
  linkTarget,
  parsePageLinks,
  placeLink,
  type PdfLink,
} from "../../src/render/pdfLinks";

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
    // A viewer that cannot list a page's links is still a viewer, so every one
    // of these costs the LAYER and never the page.
    expect(parsePageLinks("")).toEqual([]);
    expect(parsePageLinks("not json")).toEqual([]);
    expect(parsePageLinks("[")).toEqual([]);
    expect(parsePageLinks('{"x":1}')).toEqual([]);
    expect(parsePageLinks("[]")).toEqual([]);
  });

  it("drops a record that is not a usable rect", () => {
    const good = '{"x":1,"y":2,"w":3,"h":4,"page":-1,"uri":"https://a.invalid/"}';
    const cases = [
      '{"x":1,"y":2,"w":0,"h":4,"page":-1,"uri":"https://a.invalid/"}', // no width
      '{"x":1,"y":2,"w":3,"h":-4,"page":-1,"uri":"https://a.invalid/"}', // negative height
      '{"x":null,"y":2,"w":3,"h":4,"page":-1,"uri":"https://a.invalid/"}', // no x
      '{"y":2,"w":3,"h":4,"page":-1,"uri":"https://a.invalid/"}', // missing x
      '{"x":1,"y":2,"w":3,"h":4,"page":1.5,"uri":"https://a.invalid/"}', // half a page
      '{"x":1,"y":2,"w":3,"h":4,"page":-1,"uri":""}', // nowhere to go
      '{"x":1,"y":2,"w":3,"h":4,"page":-1}', // no uri at all
      "null",
      "7",
    ];
    for (const bad of cases) {
      // The good record beside it must survive: one malformed entry is not a
      // reason to throw the page's other links away.
      expect(parsePageLinks(`[${bad},${good}]`), bad).toHaveLength(1);
    }
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
    // A REFUSAL IS NOT A LINK WITH A DEAD HREF. `null` is what makes the caller
    // render no element at all; anything else here would be an affordance over
    // a target we will not open.
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
    // `page >= 0` means the decoder resolved an internal destination, and that
    // is what we act on — the uri beside it is MuPDF's own `#page=…` spelling
    // and is not an address in this app.
    expect(linkTarget(link({ page: 11, uri: "#page=12&zoom=nan,0,0" }))).toEqual({
      kind: "page",
      page: 11,
    });
    expect(linkTarget(link({ page: 0, uri: "#page=1" }))).toEqual({ kind: "page", page: 0 });
  });
});

describe("linkLabel", () => {
  it("names an internal link by the page a human would call it", () => {
    // One-based, like the pager and the route: page 11 is "page 12".
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
    // 200pt drawn 400px wide is 2 px per pt, and nothing else: no letterbox, no
    // offset. This is the whole client-side transform.
    expect(placeLink(link({ x: 20, y: 40, w: 60, h: 10 }), { width: 200, height: 100 }, { width: 400, height: 200 }))
      .toEqual({ left: 40, top: 80, width: 120, height: 20 });
  });

  it("is IDENTITY at 1:1, so the decoder's points are already the answer", () => {
    expect(placeLink(link({ x: 7, y: 9, w: 3, h: 4 }), { width: 200, height: 100 }, { width: 200, height: 100 }))
      .toEqual({ left: 7, top: 9, width: 3, height: 4 });
  });

  it("takes the scale from WIDTH alone, so a rounded canvas cannot skew it", () => {
    // MuPDF rounds a raster to whole pixels, so a page's two ratios can differ
    // in the last decimal. Deriving y from the height would then stretch every
    // box on the page vertically by that error; deriving both from width does
    // not — the same reasoning `placePanelOverPage` states about its own `k`.
    const box = placeLink(
      link({ x: 0, y: 50, w: 100, h: 50 }),
      { width: 200, height: 100 },
      { width: 400, height: 201 }, // a page whose height rounded UP by a pixel
    );
    expect(box).toEqual({ left: 0, top: 100, width: 200, height: 100 });
  });

  it("answers with a zero box for a degenerate page or canvas", () => {
    // Better than an `Infinity` reaching a style property — the same posture
    // `markExportMatrix` takes.
    const zero = { left: 0, top: 0, width: 0, height: 0 };
    expect(placeLink(link(), { width: 0, height: 100 }, { width: 400, height: 200 })).toEqual(zero);
    expect(placeLink(link(), { width: 200, height: 100 }, { width: 0, height: 0 })).toEqual(zero);
  });
});
