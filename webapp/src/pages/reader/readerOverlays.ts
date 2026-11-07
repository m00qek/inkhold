// The reader's overlays on the page: find's match ovals and the template's links.

import { el } from "../../ui/dom";
import type { WordBox } from "../../core/types";
import { dispatchApiFailure } from "../../api/client";
import { findCountIsNone, findCountText, type FindState } from "../viewer/findSession";
import { OVAL_VIEWBOX, ovalsFor } from "../findOvals";
import { binNotePageHref, notePageHref } from "../../router";
import type { ReaderCtx } from "./readerContext";

export interface ReaderOverlays {
  /** The find bar's count readout for a find state. */
  countText(state: FindState): string;
  countIsNone(state: FindState): boolean;
  /** Draws the match ovals over the page, `current` highlighted. */
  paintOvals(words: WordBox[], current: number): void;
  /** Paints the page's PDF-template links; `token` drops a stale paint. */
  paintLinks(index: number, token: number): Promise<void>;
}

export function createReaderOverlays(ctx: ReaderCtx): ReaderOverlays {
  const { st } = ctx;
  /** The shared wording (`viewer/findSession.ts`). */
  const countText = (state: FindState): string =>
    findCountText(state, "note", "There's no recognised text in this note to search.");
  const countIsNone = findCountIsNone;

  /**
   * Ovals are per-page only: their rects need `getPageText`, one request per
   * page against a server serialised on `db_lock`. Counts and badges are
   * note-wide. Always rebuilt, since positions belong to the page's size.
   */
  function paintOvals(words: WordBox[], current: number): void {
    for (const old of Array.from(ctx.pageEl.querySelectorAll(".findbox"))) old.remove();
    const m = st.meta;
    if (!m) return;
    const page = m.pages[st.pageIndex];
    if (!page) return;

    const ovals = ovalsFor(words, m.pxPerMm, page.width, ctx.pageEl.clientWidth, ctx.pageEl.clientHeight);
    // Null = unverified or mismatched mm scale: draw nothing and explain instead.
    ctx.findBar.note.hidden = ovals !== null;
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
      ctx.pageEl.append(box);
    }
  }

  /**
   * Overlay the page's links. `EXTERNALLINKINFO` rects are in device panel
   * pixels and a `.note` page is the panel, so its native dims are `pagePt` with
   * no letterbox mapping. Old links are cleared before any await; a fetch
   * failure just leaves the page without links.
   */
  async function paintLinks(index: number, token: number): Promise<void> {
    ctx.linkLayer.clear();
    const m = st.meta;
    if (!m || st.mode !== "note") return;
    const page = m.pages[index];
    if (!page) return;
    // Only notes built on an imported PDF template have a link block.
    if (page.linksHash === null) return;

    const key = `${page.index}:${page.linksHash}`;
    let links = ctx.linksByPage.get(key);
    if (links === undefined) {
      try {
        links = (await ctx.api.getPageLinks(m.id, page)).links;
      } catch (e) {
        dispatchApiFailure(ctx.failures, e, m.id, page);
        return;
      }
      ctx.linksByPage.set(key, links);
    }
    // The page turned (or the note closed) while we were fetching.
    if (token !== st.paintToken || st.pageIndex !== index || !st.open) return;
    if (links.length === 0) return;

    ctx.linkLayer.setLinks(links, {
      // Panel pixels over the page box's CSS pixels: the ink's own scale.
      pagePt: { width: page.width, height: page.height },
      canvas: { width: ctx.pageEl.clientWidth, height: ctx.pageEl.clientHeight },
      // Real routes so links are shareable; bin opens keep the bin form.
      hrefForPage: (target) => (st.fromBin ? binNotePageHref(m.id, target) : notePageHref(m.id, target)),
      // A page turn, not a reopen.
      onJump: (target) => ctx.nav.goToPage(target),
    });
  }

  return { countText, countIsNone, paintOvals, paintLinks };
}
