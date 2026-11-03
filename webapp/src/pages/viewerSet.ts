// The shell's viewers, mounted once beside each other; exactly one paints at a time.

import { createReader, type Reader } from "./reader";
import { createSpdViewer } from "./spdViewer";
import { createTxtViewer } from "./txtViewer";
import { createPdfViewer } from "./pdfViewer";
import type { Viewer, ViewerDeps } from "./viewer";

export interface ViewerSet {
  reader: Reader;
  /**
   * By server-verified `fileType`; the reader is the default. Membership must
   * match `hasDedicatedViewer` (core/fileKind.ts), which the bin uses.
   */
  viewerFor(fileType: string): Viewer;
  /** `v.open()` shows `v.el`; this only hides the prior viewer and the gallery. */
  activate(v: Viewer): void;
  /** Hides the open viewer, if any, and brings the gallery back. */
  hideActive(): void;
  active(): Viewer | null;
  destroy(): void;
}

export function createViewerSet(deps: ViewerDeps, content: HTMLElement, gallery: HTMLElement): ViewerSet {
  const reader = createReader(deps);
  const spd = createSpdViewer(deps);
  const txt = createTxtViewer(deps);
  const pdf = createPdfViewer(deps);
  content.append(reader.el, spd.el, txt.el, pdf.el);
  let activeViewer: Viewer | null = null;

  return {
    reader,
    viewerFor(fileType) {
      switch ((fileType || "").toLowerCase()) {
        case "spd":
          return spd;
        case "txt":
          return txt;
        // A `.mark` doesn't come here: it parses as a note and the reader paints it.
        case "pdf":
          return pdf;
        default:
          return reader; // note, image, and every other kind
      }
    },
    activate(v) {
      if (activeViewer && activeViewer !== v) activeViewer.hide();
      activeViewer = v;
      // Hide the gallery, not just cover it: IntersectionObserver ignores occlusion,
      // so tiles (expensive for PDFs) kept rendering behind the viewer.
      gallery.hidden = true;
    },
    hideActive() {
      if (activeViewer) {
        activeViewer.hide();
        activeViewer = null;
      }
      gallery.hidden = false;
    },
    active: () => activeViewer,
    destroy() {
      reader.destroy();
      spd.destroy();
      txt.destroy();
    },
  };
}
