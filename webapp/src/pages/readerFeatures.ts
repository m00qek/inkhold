// The reader's feature controllers, configured: transcript panel, find in note, downloads and the filmstrip engine.

import type { PageRef } from "../core/types";
import { createLazyEngine, type LazyEngine } from "../render/lazy";
import { type ApiFailureSink } from "../api/client";
import { createOcrController, type OcrState } from "./ocrPanel";
import { createFindController } from "./findInNote";
import { createReaderExports } from "./readerExports";
import { createFindBarView } from "./readerBars";
import { createViewerExportMenu } from "./viewerExportMenu";
import { createSidePanel, sidePanelState } from "../ui/sidePanel";
import { createPageIndex } from "./pageIndex";
import { createNoteLayersController } from "./noteLayers";
import type { ReaderState } from "./readerState";
import { createReaderOverlays } from "./readerOverlays";
import { createReaderNav } from "./readerNav";
import { createReaderPanels } from "./readerPanels";
import { createReaderPaint } from "./readerPaint";
import { type ReaderDeps } from "./reader";

export interface ReaderFeaturesParts {
  deps: ReaderDeps;
  currentPage: () => PageRef | undefined;
  api: () => ReaderDeps["api"];
  renderer: () => ReaderDeps["renderer"];
  cache: () => ReaderDeps["cache"];
  getTheme: () => ReaderDeps["getTheme"];
  noteLayerCtl: () => ReturnType<typeof createNoteLayersController>;
  ocrPanel: () => ReturnType<typeof createSidePanel>;
  ocrBody: () => ReturnType<typeof createSidePanel>["body"];
  pageIndexPanel: () => ReturnType<typeof createPageIndex>;
  exportMenu: () => ReturnType<typeof createViewerExportMenu>;
  ocrToggle: () => HTMLButtonElement;
  findToggle: () => ReturnType<typeof createFindBarView>["toggle"];
  findInput: () => ReturnType<typeof createFindBarView>["input"];
  findCount: () => ReturnType<typeof createFindBarView>["count"];
  findNote: () => ReturnType<typeof createFindBarView>["note"];
  findFuzzy: () => ReturnType<typeof createFindBarView>["fuzzy"];
  findAsk: () => ReturnType<typeof createFindBarView>["ask"];
  findPrev: () => ReturnType<typeof createFindBarView>["prev"];
  findNext: () => ReturnType<typeof createFindBarView>["next"];
  root: () => HTMLElement;
  showPage: () => ReturnType<typeof createReaderPaint>["showPage"];
  stackIsCurrent: () => ReturnType<typeof createReaderPanels>["stackIsCurrent"];
  goToPage: () => ReturnType<typeof createReaderNav>["goToPage"];
  countText: () => ReturnType<typeof createReaderOverlays>["countText"];
  countIsNone: () => ReturnType<typeof createReaderOverlays>["countIsNone"];
  paintOvals: () => ReturnType<typeof createReaderOverlays>["paintOvals"];
  failures: () => ApiFailureSink;
  OCR_MESSAGE: () => Record<Exclude<OcrState["kind"], "text">, string>;
}

export function createReaderFeatures(st: ReaderState, p: ReaderFeaturesParts) {
  const ocr = createOcrController({
    api: p.api(),
    failures: p.failures(),
    view: {
      setOpen(isOpen) {
        p.ocrPanel().setOpen(isOpen);
        p.ocrToggle().setAttribute("aria-pressed", String(isOpen));
      },
      setToggleEnabled(enabled) {
        p.ocrToggle().disabled = !enabled;
        p.ocrToggle().title = enabled ? "Recognized text" : "This page has no recognized text";
      },
      setState(state) {
        if (state.kind === "text") {
          // textContent: device content, never markup; `pre-wrap` keeps line breaks.
          p.ocrBody().textContent = state.text;
          return;
        }
        p.ocrBody().replaceChildren(sidePanelState(state.kind, p.OCR_MESSAGE()[state.kind]));
      },
      // The panel changes the stage width, so the page is re-measured.
      relayout: () => void p.showPage()(st.pageIndex),
    },
  });

  const find = createFindController({
    api: p.api(),
    docs: p.deps.docSearch,
    failures: p.failures(),
    view: {
      setOpen(isOpen) {
        p.root().classList.toggle("is-finding", isOpen);
        p.findToggle().setAttribute("aria-pressed", String(isOpen));
      },
      setState(state) {
        p.findCount().textContent = p.countText()(state);
        p.findCount().classList.toggle("is-none", p.countIsNone()(state));
        // Only a settled result can be approximate.
        p.findFuzzy().hidden = !(state.kind === "settled" && state.fuzzy);
        p.findAsk().hidden = state.kind !== "fuzzyPrompt";
        if (state.kind === "idle" || state.kind === "unrecognised") p.findNote().hidden = true;
      },
      setPageMatches: p.paintOvals(),
      // The strip holds the counts, so they survive its rebuilds.
      setPageCounts: (counts) => p.pageIndexPanel().setBadges(counts),
      showPage: (index) => p.goToPage()(index),
      setStepEnabled(enabled) {
        p.findPrev().disabled = !enabled;
        p.findNext().disabled = !enabled;
      },
      focusField() {
        p.findInput().focus();
        p.findInput().select();
      },
    },
  });

  // --- the Export menu ------------------------------------------------------
  // Reads page and stack through getters; both change on every page turn.
  const downloads = createReaderExports({
    api: p.api(),
    renderer: p.renderer(),
    menu: p.exportMenu(),
    toast: p.deps.toast,
    meta: () => st.meta,
    currentPage: p.currentPage,
    layers: p.noteLayerCtl(),
    // Only the focused page's stack (the previous one survives until the new one commits).
    liveStack: () => (st.mode === "note" && p.stackIsCurrent()() ? p.noteLayerCtl().stack() : null),
  });

  const filmEngine: LazyEngine = createLazyEngine({
    api: p.api(),
    renderer: p.renderer(),
    cache: p.cache(),
    getTheme: p.getTheme(),
    // The panel is the scroll container, so it must be the observer root.
    root: p.pageIndexPanel().el,
    failures: p.failures(),
  });

  return { ocr, find, downloads, filmEngine };
}
