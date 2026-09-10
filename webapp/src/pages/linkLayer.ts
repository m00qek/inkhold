// The PDF's own links, as real anchors over the page.
//
// A positioned layer inside `.pdf-stage`, the same shape as the `.mark` overlay
// (`pdfViewer.ts`, `paintMark`) and repositioned by the same trigger — after the
// raster lands, from the canvas's real size — so zoom and panel toggles are free.
//
// REAL `<a>` ELEMENTS, NOT CLICK HANDLERS ON BOXES. An anchor brings keyboard
// focus, the browser's own status-bar preview of where it goes, middle-click and
// right-click-open-in-new-tab, and screen-reader treatment. A `div` with an
// `onclick` has none of those, and someone will expect every one of them.
//
// ABOVE THE INK, deliberately. `.pdf-mark` is `pointer-events: none` so ink can
// never eat a click — but a link UNDER a scribble is exactly the case that
// occurs, because people annotate around the things they care about.

import { el } from "../ui/dom";
import type { Size } from "../render/markGeometry";
import { linkLabel, linkTarget, placeLink } from "../render/pdfWire";
import type { PdfLink } from "../core/types";

export interface LinkLayer {
  /** The host element. Mount it in `.pdf-stage`, AFTER the ink. */
  el: HTMLElement;
  /**
   * Put `links` over a page of `pagePt` points drawn at `canvas` CSS pixels.
   *
   * `hrefForPage` turns a 0-based target page into an address. The viewer owns
   * it because only the viewer knows WHICH document is open and whether it is
   * open from the recycle bin — and following a link has to leave you somewhere
   * you could share, which means a real route and not a scroll.
   */
  setLinks(
    links: readonly PdfLink[],
    at: {
      pagePt: Size;
      canvas: Size;
      hrefForPage: (page: number) => string;
      /**
       * Jump to a page of THIS document, in place.
       *
       * The href alone is correct and is not enough: following it dispatches
       * `#/note/:id/page/:n`, and a second dispatch of that route RE-OPENS the
       * viewer, which for a PDF tears down the MuPDF session and loads the
       * document again to show a page the viewer already had. A link to another
       * page of the document you are reading IS a page turn, so it goes through
       * the same path the pager and the arrow keys use.
       */
      onJump: (page: number) => void;
    },
  ): void;
  /** Take the layer down: no links, nothing focusable, nothing to hit. */
  clear(): void;
}

export function createLinkLayer(): LinkLayer {
  const host = el("div", { class: "pdf-links", hidden: true });

  function clear(): void {
    host.replaceChildren();
    host.hidden = true;
  }

  return {
    el: host,
    clear,
    setLinks(links, at) {
      const anchors: HTMLAnchorElement[] = [];
      for (const link of links) {
        // A LINK WE WILL NOT FOLLOW BECOMES NO ELEMENT AT ALL — never an anchor
        // with a neutered href, which would be an affordance over a target we
        // refuse to open. `javascript:` is the one that matters; the rule is an
        // allowlist, so `file:` and `data:` go the same way.
        const target = linkTarget(link);
        if (!target) continue;
        const box = placeLink(link, at.pagePt, at.canvas);
        // A box that rounds away to nothing is not a hit area; skip it rather
        // than leave a zero-sized anchor in the tab order.
        if (box.width < 1 || box.height < 1) continue;

        const a = el("a", {
          href: target.kind === "page" ? at.hrefForPage(target.page) : target.href,
          // The page is a raster, so the anchor has no text of its own: without
          // this it is an unlabelled link, which is worse than no link.
          "aria-label": linkLabel(target),
          ...(target.kind === "external"
            ? // `noopener` so the opened tab cannot reach back through
              // `window.opener`, `noreferrer` so a document from someone else's
              // device cannot learn where it was being read. External only: an
              // internal link is a route in this app and belongs in this tab.
              { target: "_blank", rel: "noopener noreferrer" }
            : {}),
        }) as HTMLAnchorElement;
        if (target.kind === "page") {
          const to = target.page;
          a.addEventListener("click", (ev) => {
            // MODIFIED CLICKS BELONG TO THE BROWSER: Ctrl/Cmd/Shift/Alt and any
            // non-primary button mean "open this somewhere else", and the href
            // is real precisely so that works.
            if (ev.defaultPrevented) return;
            if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;

            ev.preventDefault();
            at.onJump(to);
          });
        }
        const st = a.style;
        st.left = `${box.left}px`;
        st.top = `${box.top}px`;
        st.width = `${box.width}px`;
        st.height = `${box.height}px`;
        anchors.push(a);
      }
      if (anchors.length === 0) {
        clear();
        return;
      }
      host.replaceChildren(...anchors);
      // The layer is the page's own box, so a rect in page space is a rect
      // here. Set explicitly rather than by `inset: 0`, because the stage also
      // holds the oversized `.mark` host and nothing guarantees the two agree.
      host.style.left = "0";
      host.style.top = "0";
      host.style.width = `${at.canvas.width}px`;
      host.style.height = `${at.canvas.height}px`;
      host.hidden = false;
    },
  };
}
