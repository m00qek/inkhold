// The reader's feature controllers, configured: transcript panel, find in note, downloads and the filmstrip engine.

import { createLazyEngine } from "../../render/lazy";
import { createOcrController, type OcrState } from "../ocrPanel";
import { createFindController } from "../findInNote";
import { createReaderExports } from "./readerExports";
import { sidePanelState } from "../../ui/sidePanel";
import type { ReaderCtx } from "./readerContext";
import { revealIn } from "../../ui/dom";

const OCR_MESSAGE: Record<Exclude<OcrState["kind"], "text">, string> = {
  loading: "Loading recognized text…",
  empty: "No recognized text on this page.",
  error: "Couldn't load the recognized text. Change page to try again.",
};

/** Builds the transcript panel, find in note, the Export menu and the filmstrip engine onto `ctx`. */
export function installReaderFeatures(ctx: ReaderCtx): void {
  const { st } = ctx;
  ctx.ocr = createOcrController({
    api: ctx.api,
    failures: ctx.failures,
    view: {
      setOpen(isOpen) {
        ctx.ocrPanel.setOpen(isOpen);
        ctx.buttons.ocrToggle.setAttribute("aria-pressed", String(isOpen));
      },
      setToggleEnabled(enabled) {
        ctx.buttons.ocrToggle.disabled = !enabled;
        ctx.buttons.ocrToggle.title = enabled ? "Recognized text" : "This page has no recognized text";
      },
      setState(state) {
        if (state.kind === "text") {
          // textContent: device content, never markup; `pre-wrap` keeps line breaks.
          ctx.ocrPanel.body.textContent = state.text;
          return;
        }
        ctx.ocrPanel.body.replaceChildren(sidePanelState(state.kind, OCR_MESSAGE[state.kind]));
      },
      // The panel changes the stage width, so the page is re-measured.
      relayout: () => void ctx.paint.showPage(st.pageIndex),
    },
  });

  ctx.find = createFindController({
    api: ctx.api,
    docs: ctx.deps.docSearch,
    failures: ctx.failures,
    view: {
      setOpen(isOpen) {
        ctx.root.classList.toggle("is-finding", isOpen);
        ctx.findBar.toggle.setAttribute("aria-pressed", String(isOpen));
      },
      setState(state) {
        ctx.findBar.count.textContent = ctx.overlays.countText(state);
        ctx.findBar.count.classList.toggle("is-none", ctx.overlays.countIsNone(state));
        // Only a settled result can be approximate.
        ctx.findBar.fuzzy.hidden = !(state.kind === "settled" && state.fuzzy);
        ctx.findBar.ask.hidden = state.kind !== "fuzzyPrompt";
        if (state.kind === "idle" || state.kind === "unrecognised") ctx.findBar.note.hidden = true;
      },
      setPageMatches: ctx.overlays.paintOvals,
      revealCurrent() {
        const oval = ctx.pageEl.querySelector(".findbox.is-current");
        if (oval) revealIn(oval, ctx.stage);
      },
      // The strip holds the counts, so they survive its rebuilds.
      setPageCounts: (counts) => ctx.pageIndexPanel.setBadges(counts),
      showPage: (index) => ctx.nav.goToPage(index),
      setStepEnabled(enabled) {
        ctx.findBar.prev.disabled = !enabled;
        ctx.findBar.next.disabled = !enabled;
      },
      focusField() {
        ctx.findBar.input.focus();
        ctx.findBar.input.select();
      },
    },
  });

  // --- the Export menu ------------------------------------------------------
  // Reads page and stack through getters; both change on every page turn.
  ctx.downloads = createReaderExports({
    api: ctx.api,
    renderer: ctx.renderer,
    menu: ctx.exportMenu,
    toast: ctx.deps.toast,
    meta: () => st.meta,
    currentPage: ctx.currentPage,
    layers: ctx.noteLayerCtl,
    // Only the focused page's stack (the previous one survives until the new one commits).
    liveStack: () => (st.mode === "note" && ctx.panels.stackIsCurrent() ? ctx.noteLayerCtl.stack() : null),
  });

  ctx.filmEngine = createLazyEngine({
    api: ctx.api,
    renderer: ctx.renderer,
    cache: ctx.cache,
    getTheme: ctx.getTheme,
    // The panel is the scroll container, so it must be the observer root.
    root: ctx.pageIndexPanel.el,
    failures: ctx.failures,
  });
}
