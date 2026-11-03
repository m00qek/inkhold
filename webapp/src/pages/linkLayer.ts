// A PDF's own links as real `<a>` elements over the page (focus, middle-click,
// screen readers), positioned after the raster lands and stacked above the ink.

import { el } from "../ui/dom";
import type { Size } from "../render/markGeometry";
import { linkLabel, linkTarget, placeLink } from "../render/pdfWire";
import type { PdfLink } from "../core/types";

export interface LinkLayer {
  /** Mount in `.pdf-stage`, after the ink. */
  el: HTMLElement;
  /** `hrefForPage` maps a 0-based page to a shareable route. */
  setLinks(
    links: readonly PdfLink[],
    at: {
      pagePt: Size;
      canvas: Size;
      hrefForPage: (page: number) => string;
      /**
       * In-document jump. Following the href would re-dispatch the route and
       * re-open the viewer (reloading the MuPDF session), so it goes through the
       * pager's path instead.
       */
      onJump: (page: number) => void;
    },
  ): void;
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
        // A refused target (allowlist; `javascript:`, `file:`, `data:`) gets no element.
        const target = linkTarget(link);
        if (!target) continue;
        const box = placeLink(link, at.pagePt, at.canvas);
        if (box.width < 1 || box.height < 1) continue;

        const a = el("a", {
          href: target.kind === "page" ? at.hrefForPage(target.page) : target.href,
          // The page is a raster, so the anchor needs a label.
          "aria-label": linkLabel(target),
          ...(target.kind === "external"
            ? // External only; `noreferrer` so a shared document cannot learn where it is read.
              { target: "_blank", rel: "noopener noreferrer" }
            : {}),
        }) as HTMLAnchorElement;
        if (target.kind === "page") {
          const to = target.page;
          a.addEventListener("click", (ev) => {
            // Modified and non-primary clicks belong to the browser.
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
      // Sized explicitly, not `inset: 0`: the stage also holds the oversized `.mark` host.
      host.style.left = "0";
      host.style.top = "0";
      host.style.width = `${at.canvas.width}px`;
      host.style.height = `${at.canvas.height}px`;
      host.hidden = false;
    },
  };
}
