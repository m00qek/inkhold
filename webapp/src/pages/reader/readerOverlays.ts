// The reader's overlays on the page: find's match ovals and the template's links.

import { el } from "../../ui/dom";
import type { WordBox } from "../../core/types";
import { dispatchApiFailure, type ApiFailureSink } from "../../api/client";
import { type FindState } from "../findInNote";
import { OVAL_VIEWBOX, ovalsFor } from "../findOvals";
import { createLinkLayer } from "../linkLayer";
import type { PdfLink } from "../../core/types";
import { binNotePageHref, notePageHref } from "../../router";
import type { ReaderState } from "./readerState";

import type { ReaderDeps } from "./reader";

export interface ReaderOverlaysParts {
  goToPage: (index: number) => void;
  api: () => ReaderDeps["api"];
  findNote: () => HTMLElement;
  linkLayer: () => ReturnType<typeof createLinkLayer>;
  pageEl: () => HTMLElement;
  failures: () => ApiFailureSink;
  linksByPage: () => Map<string, readonly PdfLink[]>;
}

export function createReaderOverlays(st: ReaderState, p: ReaderOverlaysParts) {
  /**
   * `unrecognised` must not say "No matches" (no search happened over ink the
   * device never recognised), and `counting` shows no total until it is final.
   */
  function countText(state: FindState): string {
    switch (state.kind) {
      case "idle":
        return "";
      case "unrecognised":
        return "Not recognised on the device";
      case "counting": {
        const n = state.recognisedPages;
        const here = state.onThisPage > 0 ? `${state.onThisPage} on this page · ` : "";
        // null: the page list is still the skeleton, so the count is unknown.
        if (n === null) return `${here}searching…`;
        return `${here}searching ${n} ${n === 1 ? "page" : "pages"}…`;
      }
      case "settled":
        return `${state.at + 1} of ${state.total}`;
      case "fuzzyPrompt":
        return "No matches";
      case "empty":
        return "No matches";
      case "error":
        return "Couldn't search this note. Keep typing to retry.";
    }
  }

  /** The dimmer treatment: every state that is not a live count of matches. */
  function countIsNone(state: FindState): boolean {
    return state.kind !== "settled" && state.kind !== "idle";
  }

  /**
   * Ovals are per-page only: their rects need `getPageText`, one request per
   * page against a server serialised on `db_lock`. Counts and badges are
   * note-wide. Always rebuilt, since positions belong to the page's size.
   */
  function paintOvals(words: WordBox[], current: number): void {
    for (const old of Array.from(p.pageEl().querySelectorAll(".findbox"))) old.remove();
    const m = st.meta;
    if (!m) return;
    const page = m.pages[st.pageIndex];
    if (!page) return;

    const ovals = ovalsFor(words, m.pxPerMm, page.width, p.pageEl().clientWidth, p.pageEl().clientHeight);
    // Null = unverified or mismatched mm scale: draw nothing and explain instead.
    p.findNote().hidden = ovals !== null;
    if (ovals === null) return;

    for (const [i, oval] of ovals.entries()) {
      const box = el("div", {
        class: i === current ? "findbox is-current" : "findbox",
        html: `<svg viewBox="${OVAL_VIEWBOX}" preserveAspectRatio="none" aria-hidden="true"><path d="${oval.path}"/></svg>`,
      });
      box.style.left = `${oval.left}px`;
      box.style.top = `${oval.top}px`;
      box.style.width = `${oval.width}px`;
      box.style.height = `${oval.height}px`;
      box.style.transform = `rotate(${oval.rotateDeg}deg)`;
      p.pageEl().append(box);
    }
  }

  /**
   * Overlay the page's links. `EXTERNALLINKINFO` rects are in device panel
   * pixels and a `.note` page is the panel, so its native dims are `pagePt` with
   * no letterbox mapping. Old links are cleared before any await; a fetch
   * failure just leaves the page without links.
   */
  async function paintLinks(index: number, token: number): Promise<void> {
    p.linkLayer().clear();
    const m = st.meta;
    if (!m || st.mode !== "note") return;
    const page = m.pages[index];
    if (!page) return;
    // Only notes built on an imported PDF template have a link block.
    if (page.linksHash === null) return;

    const key = `${page.index}:${page.linksHash}`;
    let links = p.linksByPage().get(key);
    if (links === undefined) {
      try {
        links = (await p.api().getPageLinks(m.id, page)).links;
      } catch (e) {
        dispatchApiFailure(p.failures(), e, m.id, page);
        return;
      }
      p.linksByPage().set(key, links);
    }
    // The page turned (or the note closed) while we were fetching.
    if (token !== st.paintToken || st.pageIndex !== index || !st.open) return;
    if (links.length === 0) return;

    p.linkLayer().setLinks(links, {
      // Panel pixels over the page box's CSS pixels: the ink's own scale.
      pagePt: { width: page.width, height: page.height },
      canvas: { width: p.pageEl().clientWidth, height: p.pageEl().clientHeight },
      // Real routes so links are shareable; bin opens keep the bin form.
      hrefForPage: (target) => (st.fromBin ? binNotePageHref(m.id, target) : notePageHref(m.id, target)),
      // A page turn, not a reopen.
      onJump: (target) => p.goToPage(target),
    });
  }

  return { countText, countIsNone, paintOvals, paintLinks };
}
