// @vitest-environment happy-dom

import { describe, it, expect, vi } from "vitest";
import { createLinkLayer } from "../../src/pages/linkLayer";
import type { PdfLink } from "../../src/render/pdfWire";

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

function atJumping(): typeof AT & { onJump: ReturnType<typeof vi.fn> } {
  return { ...AT, onJump: vi.fn() };
}

function click(a: HTMLAnchorElement, over: Partial<MouseEventInit> = {}): MouseEvent {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...over });
  a.dispatchEvent(ev);
  return ev;
}

function anchors(root: HTMLElement): HTMLAnchorElement[] {
  return Array.from(root.querySelectorAll("a"));
}

describe("a link to another page of the same document", () => {
  // Regression: following the href re-dispatched the route, which re-opened the PDF.
  it("turns the page in place instead of letting the route re-open the document", () => {
    const at = atJumping();
    const layer = createLinkLayer();
    document.body.append(layer.el);
    layer.setLinks([link({ page: 11, uri: "#page=12" })], at);

    const a = anchors(layer.el)[0]!;
    const ev = click(a);

    expect(at.onJump).toHaveBeenCalledWith(11);
    expect(ev.defaultPrevented).toBe(true);
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
    const layer = createLinkLayer();
    document.body.append(layer.el);
    layer.setLinks([link({ page: 11, uri: "#page=12" })], at);

    const ev = click(anchors(layer.el)[0]!, over);

    expect(at.onJump).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it("never intercepts an EXTERNAL link — it is not a page of this document", () => {
    const at = atJumping();
    const layer = createLinkLayer();
    document.body.append(layer.el);
    layer.setLinks([link({ page: -1, uri: "https://example.invalid/a" })], at);

    const ev = click(anchors(layer.el)[0]!);
    expect(at.onJump).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe("the PDF link layer", () => {
  it("starts empty and hidden, so it can never take a click it has no link for", () => {
    const layer = createLinkLayer();
    expect(layer.el.hidden).toBe(true);
    expect(anchors(layer.el)).toHaveLength(0);
  });

  it("places each link at the raster's scale", () => {
    const layer = createLinkLayer();
    layer.setLinks([link({ x: 20, y: 40, w: 60, h: 10 })], AT);
    const [a] = anchors(layer.el);
    expect(a!.style.left).toBe("40px");
    expect(a!.style.top).toBe("80px");
    expect(a!.style.width).toBe("120px");
    expect(a!.style.height).toBe("20px");
    expect(layer.el.style.left).toBe("0px");
    expect(layer.el.style.top).toBe("0px");
    expect(layer.el.style.width).toBe("400px");
    expect(layer.el.style.height).toBe("200px");
    expect(layer.el.hidden).toBe(false);
  });

  it("REPOSITIONS on a new canvas size rather than accumulating", () => {
    const layer = createLinkLayer();
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
    const layer = createLinkLayer();
    layer.setLinks([link({ page: 11, uri: "#page=12&zoom=nan,0,0" })], AT);
    const [a] = anchors(layer.el);
    expect(a!.getAttribute("href")).toBe("#/note/n-1/page/12");
    expect(a!.getAttribute("target")).toBeNull();
    expect(a!.getAttribute("rel")).toBeNull();
    expect(a!.getAttribute("aria-label")).toBe("Go to page 12");
  });

  it("gives an external link a new tab, and severs it from this one", () => {
    // `noopener` blocks `window.opener`; `noreferrer` hides where it was read.
    const layer = createLinkLayer();
    layer.setLinks([link({ uri: "https://example.invalid/a" })], AT);
    const [a] = anchors(layer.el);
    expect(a!.getAttribute("href")).toBe("https://example.invalid/a");
    expect(a!.getAttribute("target")).toBe("_blank");
    expect(a!.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("LABELS every anchor — a rect over a raster has no text of its own", () => {
    const layer = createLinkLayer();
    layer.setLinks(
      [link({ uri: "mailto:someone@example.invalid" }), link({ page: 0, uri: "#page=1" })],
      AT,
    );
    const labels = anchors(layer.el).map((a) => a.getAttribute("aria-label"));
    expect(labels).toEqual(["mailto:someone@example.invalid", "Go to page 1"]);
    for (const a of anchors(layer.el)) expect(a.getAttribute("aria-label")).toBeTruthy();
  });

  it("produces NO ANCHOR for a scheme we will not follow", () => {
    // An allowlist: `javascript:`, `file:` and `data:` get no anchor at all.
    const layer = createLinkLayer();
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
    const layer = createLinkLayer();
    layer.setLinks([link({ uri: "javascript:alert(1)" }), link({ uri: "https://ok.invalid/" })], AT);
    expect(anchors(layer.el).map((a) => a.getAttribute("href"))).toEqual(["https://ok.invalid/"]);
  });

  it("skips a box that rounds away to nothing rather than leaving it in the tab order", () => {
    const layer = createLinkLayer();
    layer.setLinks([link({ x: 0, y: 0, w: 0.2, h: 10 })], {
      ...AT,
      canvas: { width: 2, height: 1 },
    });
    expect(anchors(layer.el)).toHaveLength(0);
  });

  it("clear() takes every anchor out of the document AND out of the tab order", () => {
    // Hiding alone would leave focusable elements over the next page.
    const layer = createLinkLayer();
    layer.setLinks([link()], AT);
    expect(anchors(layer.el)).toHaveLength(1);
    layer.clear();
    expect(anchors(layer.el)).toHaveLength(0);
    expect(layer.el.hidden).toBe(true);
  });
});
