// A viewer's Digests: its toolbar opener and its panel (`digestDocPanel.ts`).
// The opener is there for every document that can have digests while the
// server keeps them, dimmed with the reason when none come from this one, so
// the bar keeps its shape; while the server keeps none, or for a file that
// can't have any (an image), it is not there at all. Where the panel docks is
// the viewer's business.

import { ICONS } from "../../ui/icons";
import { closeWith } from "../../ui/sidePanel";
import type { Id } from "../../core/types";
import type { ViewerDigests } from "../viewer/viewer";
import { contextualOpener, type ContextualOpener } from "../viewer/viewerControls";
import { createDigestDocPanel, type DigestDocPanel } from "./digestDocPanel";

export interface DigestViewerPanel {
  opener: ContextualOpener;
  panel: DigestDocPanel;
  /** The document's digests, not awaited; `stale()` is true once another open took over. */
  load(fileId: Id, page: number, stale: () => boolean): void;
  setCurrent(page: number): void;
  /** Whether the open file is one that can have digests; false hides the opener. */
  setApplicable(on: boolean): void;
  /** Forgets the document: an empty panel, the opener dimmed. */
  reset(): void;
}

export interface DigestViewerPanelDeps {
  /** The panel's id, which the opener controls. */
  id: string;
  /** Absent: no Digests at all. */
  source: ViewerDigests | undefined;
  onPick(page: number): void;
  /** There is nothing to show: shut the panel if it is open. */
  onNone(): void;
}

export function createDigestViewerPanel(deps: DigestViewerPanelDeps): DigestViewerPanel {
  const opener = contextualOpener({
    icon: ICONS.digest,
    label: "Digests",
    reason: "none were taken from this document",
    attrs: { "aria-pressed": "false", "aria-controls": deps.id },
  });
  const panel = createDigestDocPanel({
    id: deps.id,
    // Without a source the panel never opens, so it never draws a note.
    ink: deps.source?.ink ?? { picture: async () => null, holder: () => null },
    onPick: (page) => deps.onPick(page),
    onClose: closeWith(opener.el),
  });
  /** The server keeps digests, as last heard: the opener is there from the first frame. */
  let kept = deps.source?.kept() ?? false;
  let applicable = true;
  /** The page on screen now, which may have turned while the digests loaded. */
  let lastPage = 0;
  const sync = () => void (opener.el.hidden = !(kept && applicable));
  sync();

  function none(): void {
    opener.setAvailable(false);
    deps.onNone();
  }

  return {
    opener,
    panel,
    load(fileId, page, stale) {
      lastPage = page;
      const source = deps.source;
      if (!source) return;
      void source.of(fileId).then(
        (digests) => {
          if (stale()) return;
          kept = digests !== null;
          sync();
          panel.setDigests(digests ?? []);
          panel.setCurrent(lastPage);
          if (digests !== null && digests.length > 0) opener.setAvailable(true);
          else none();
        },
        () => {
          if (!stale()) none();
        },
      );
    },
    setCurrent(page) {
      lastPage = page;
      panel.setCurrent(page);
    },
    setApplicable(on) {
      applicable = on;
      sync();
      if (!on) none();
    },
    reset() {
      kept = deps.source?.kept() ?? false;
      sync();
      panel.clear();
      none();
    },
  };
}
