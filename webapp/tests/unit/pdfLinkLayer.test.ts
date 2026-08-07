// @vitest-environment happy-dom
//
// `pages/pdfLinkLayer.ts` — what a PDF's links become in the DOM.
//
// REAL ANCHORS ARE THE FEATURE, not an implementation detail, so this asserts
// the things an anchor gives you and a click handler on a div does not: an
// `href` the browser can preview and middle-click, `rel` on anything that opens
// a tab, and an accessible name over a raster that has no text of its own.

import { describe, it, expect, vi } from "vitest";
import { createPdfLinkLayer } from "../../src/pages/pdfLinkLayer";
import type { PdfLink } from "../../src/render/pdfLinks";

function link(over: Partial<PdfLink> = {}): PdfLink {
  return { x: 20, y: 40, w: 60, h: 10, page: -1, uri: "https://example.invalid/", ...over };
}

/** A page 200x100 pt drawn 400x200 CSS px — 2 px per point. */
const AT = {
  pagePt: { width: 200, height: 100 },
  canvas: { width: 400, height: 200 },
  hrefForPage: (p: number) => `#/note/n-1/page/${p + 1}`,
  onJump: () => {},
};

/** `AT` with a spy for the in-place jump. */
function atJumping(): typeof AT & { onJump: ReturnType<typeof vi.fn> } {
  return { ...AT, onJump: vi.fn() };
}

/** A click the way a browser sends one, with the modifiers spelled out. */
function click(a: HTMLAnchorElement, over: Partial<MouseEventInit> = {}): MouseEvent {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...over });
  a.dispatchEvent(ev);
  return ev;
}

function anchors(root: HTMLElement): HTMLAnchorElement[] {
  return Array.from(root.querySelectorAll("a"));
}

describe("a link to another page of the same document", () => {
  // The href alone was correct and not enough. Following it dispatches the
  // route, and a second dispatch of `#/note/:id/page/:n` RE-OPENS the viewer —
  // which for a PDF tears down the MuPDF session and opens the document again.
  // A link to page 12 flashed the loading placeholder and rebuilt everything to
  // show a page the viewer already had: it read as a reload because it was one.
  it("turns the page in place instead of letting the route re-open the document", () => {
    const at = atJumping();
    const layer = createPdfLinkLayer();
    document.body.append(layer.el);
    layer.setLinks([link({ page: 11, uri: "#page=12" })], at);

    const a = anchors(layer.el)[0]!;
    const ev = click(a);

    expect(at.onJump).toHaveBeenCalledWith(11);
    // Prevented, or the browser follows the href too and we get BOTH — the jump
    // and the re-open it was meant to replace.
    expect(ev.defaultPrevented).toBe(true);
    // The href STAYS REAL. It is what makes the link shareable, focusable and
    // openable in a new tab; interception is about the plain click only.
    expect(a.getAttribute("href")).toBe("#/note/n-1/page/12");
  });

  it.each([
    ["ctrl", { ctrlKey: true }],
    ["meta", { metaKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
    ["middle button", { button: 1 }],
  ])("leaves a %s click to the browser, which is what the href is for", (_name, over) => {
    const at = atJumping();
    const layer = createPdfLinkLayer();
    document.body.append(layer.el);
    layer.setLinks([link({ page: 11, uri: "#page=12" })], at);

    const ev = click(anchors(layer.el)[0]!, over);

    // A modified click means "open this somewhere else". Swallowing it would
    // take away the one thing choosing a real anchor was for.
    expect(at.onJump).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it("never intercepts an EXTERNAL link — it is not a page of this document", () => {
    const at = atJumping();
    const layer = createPdfLinkLayer();
    document.body.append(layer.el);
    layer.setLinks([link({ page: -1, uri: "https://example.invalid/a" })], at);

    const ev = click(anchors(layer.el)[0]!);
    expect(at.onJump).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe("the PDF link layer", () => {
  it("starts empty and hidden, so it can never take a click it has no link for", () => {
    const layer = createPdfLinkLayer();
    expect(layer.el.hidden).toBe(true);
    expect(anchors(layer.el)).toHaveLength(0);
  });

  it("places each link at the raster's scale", () => {
    const layer = createPdfLinkLayer();
    layer.setLinks([link({ x: 20, y: 40, w: 60, h: 10 })], AT);
    const [a] = anchors(layer.el);
    expect(a!.style.left).toBe("40px");
    expect(a!.style.top).toBe("80px");
    expect(a!.style.width).toBe("120px");
    expect(a!.style.height).toBe("20px");
    // And the layer is the page's own box, so the numbers above mean what they
    // say relative to the page's top-left corner.
    expect(layer.el.style.left).toBe("0px");
    expect(layer.el.style.top).toBe("0px");
    expect(layer.el.style.width).toBe("400px");
    expect(layer.el.style.height).toBe("200px");
    expect(layer.el.hidden).toBe(false);
  });

  it("REPOSITIONS on a new canvas size rather than accumulating", () => {
    // What a zoom step is: the page is rastered again and this is called again,
    // with a bigger canvas and the same links. Nothing re-decodes.
    const layer = createPdfLinkLayer();
    const one = link({ x: 20, y: 40, w: 60, h: 10 });
    layer.setLinks([one], AT);
    layer.setLinks([one], { ...AT, canvas: { width: 800, height: 400 } });
    expect(anchors(layer.el)).toHaveLength(1);
    const [a] = anchors(layer.el);
    expect(a!.style.left).toBe("80px");
    expect(a!.style.width).toBe("240px");
    expect(layer.el.style.width).toBe("800px");
  });

  it("gives an internal link the page ROUTE, in this tab", () => {
    // The router already owns `#/note/:id/page/:n` and the viewer already
    // publishes it, so following a link leaves you somewhere you can share.
    const layer = createPdfLinkLayer();
    layer.setLinks([link({ page: 11, uri: "#page=12&zoom=nan,0,0" })], AT);
    const [a] = anchors(layer.el);
    expect(a!.getAttribute("href")).toBe("#/note/n-1/page/12");
    expect(a!.getAttribute("target")).toBeNull();
    expect(a!.getAttribute("rel")).toBeNull();
    expect(a!.getAttribute("aria-label")).toBe("Go to page 12");
  });

  it("gives an external link a new tab, and severs it from this one", () => {
    // `noopener` so the opened page cannot reach back through `window.opener`;
    // `noreferrer` so a document from someone else's device cannot learn where
    // it was being read.
    const layer = createPdfLinkLayer();
    layer.setLinks([link({ uri: "https://example.invalid/a" })], AT);
    const [a] = anchors(layer.el);
    expect(a!.getAttribute("href")).toBe("https://example.invalid/a");
    expect(a!.getAttribute("target")).toBe("_blank");
    expect(a!.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("LABELS every anchor — a rect over a raster has no text of its own", () => {
    // An unlabelled link is worse than no link: it reads out as its own href at
    // best and as "link" at worst.
    const layer = createPdfLinkLayer();
    layer.setLinks(
      [link({ uri: "mailto:someone@example.invalid" }), link({ page: 0, uri: "#page=1" })],
      AT,
    );
    const labels = anchors(layer.el).map((a) => a.getAttribute("aria-label"));
    expect(labels).toEqual(["mailto:someone@example.invalid", "Go to page 1"]);
    for (const a of anchors(layer.el)) expect(a.getAttribute("aria-label")).toBeTruthy();
  });

  it("produces NO ANCHOR for a scheme we will not follow", () => {
    // Not an anchor with a neutered href — the affordance would then lie about
    // where it goes. `javascript:` is the one that matters; the rule is an
    // allowlist, so `file:` and `data:` go the same way.
    const layer = createPdfLinkLayer();
    layer.setLinks(
      [
        link({ uri: "javascript:alert(1)" }),
        link({ uri: "file:///etc/passwd" }),
        link({ uri: "data:text/html,<script>x</script>" }),
      ],
      AT,
    );
    expect(anchors(layer.el)).toHaveLength(0);
    expect(layer.el.hidden).toBe(true);
    expect(layer.el.innerHTML).toBe("");
  });

  it("keeps the good links on a page that also carries a refused one", () => {
    const layer = createPdfLinkLayer();
    layer.setLinks([link({ uri: "javascript:alert(1)" }), link({ uri: "https://ok.invalid/" })], AT);
    expect(anchors(layer.el).map((a) => a.getAttribute("href"))).toEqual(["https://ok.invalid/"]);
  });

  it("skips a box that rounds away to nothing rather than leaving it in the tab order", () => {
    const layer = createPdfLinkLayer();
    layer.setLinks([link({ x: 0, y: 0, w: 0.2, h: 10 })], {
      ...AT,
      canvas: { width: 2, height: 1 }, // 0.01 px wide
    });
    expect(anchors(layer.el)).toHaveLength(0);
  });

  it("clear() takes every anchor out of the document AND out of the tab order", () => {
    // Hiding alone would leave focusable elements over the next page.
    const layer = createPdfLinkLayer();
    layer.setLinks([link()], AT);
    expect(anchors(layer.el)).toHaveLength(1);
    layer.clear();
    expect(anchors(layer.el)).toHaveLength(0);
    expect(layer.el.hidden).toBe(true);
  });
});
