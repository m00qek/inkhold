// The "Page text" panel controller, with the DOM injected as an
// {@link OcrView}. The transcript is lazy: fetched only while the panel is open
// on a page whose `textHash` is non-null, never on note-open.

import { dispatchApiFailure, type ApiFailureSink } from "../api/client";
import type { Api } from "../api/types";
import type { Hash, Id, PageRef } from "../core/types";

/** Loading, failed and genuinely empty stay distinct so a broken panel is not mistaken for an empty one. */
export type OcrState =
  | { kind: "loading" }
  | { kind: "text"; text: string }
  | { kind: "empty" }
  | { kind: "error"; message: string };

export interface OcrView {
  setOpen(open: boolean): void;
  setToggleEnabled(enabled: boolean): void;
  setState(state: OcrState): void;
  /** The stage width changed; the reader re-runs `showPage` to resize the canvas. */
  relayout(): void;
}

export interface OcrDeps {
  api: Api;
  view: OcrView;
  /** Where UNAUTHORIZED / STALE_PAGE go; never swallowed here. */
  failures: ApiFailureSink;
}

export interface OcrController {
  isOpen(): boolean;
  toggle(): void;
  setPage(noteId: Id | null, page: PageRef | undefined): void;
  reset(): void;
}

export function createOcrController({ api, view, failures }: OcrDeps): OcrController {
  let open = false;
  let noteId: Id | null = null;
  let page: PageRef | undefined;

  /**
   * Transcript painted or in flight, keyed on `textHash` (a device re-recognition
   * changes it without touching strokes). Cleared on failure so revisiting retries.
   */
  let shownKey: string | null = null;
  const keyOf = (p: PageRef): string => p.textHash ?? `none:${p.index}`;

  let token = 0;

  const cache = new Map<Hash, string>();

  function paint(text: string): void {
    view.setState(text.trim() === "" ? { kind: "empty" } : { kind: "text", text });
  }

  async function load(id: Id, p: PageRef, textHash: Hash): Promise<void> {
    shownKey = keyOf(p);
    const cached = cache.get(textHash);
    if (cached !== undefined) {
      paint(cached);
      return;
    }

    const mine = ++token;
    view.setState({ kind: "loading" });
    try {
      const { text } = await api.getPageText(id, p);
      if (mine !== token || !open || noteId !== id || page?.textHash !== textHash) return;
      cache.set(textHash, text);
      paint(text);
    } catch (e) {
      if (mine !== token || !open || noteId !== id || page?.textHash !== textHash) return;
      shownKey = null; // let a later visit retry
      if (dispatchApiFailure(failures, e, id, p)) return;
      view.setState({ kind: "error", message: "Couldn't load the page text." });
    }
  }

  function refresh(): void {
    if (!open) return;
    const p = page;
    if (!p || noteId === null) {
      shownKey = null;
      view.setState({ kind: "empty" });
      return;
    }
    if (p.textHash === null) {
      shownKey = keyOf(p);
      view.setState({ kind: "empty" });
      return;
    }
    if (shownKey === keyOf(p)) return;
    void load(noteId, p, p.textHash);
  }

  /** Stays enabled while open so the panel is always closable. */
  function syncToggle(): void {
    view.setToggleEnabled(open || page?.textHash != null);
  }

  return {
    isOpen: () => open,

    toggle(): void {
      if (!open && page?.textHash == null) return; // disabled; nothing to open
      open = !open;
      view.setOpen(open);
      syncToggle();
      refresh();
      view.relayout();
    },

    setPage(id: Id | null, p: PageRef | undefined): void {
      if (id !== noteId) cache.clear();
      noteId = id;
      page = p;
      syncToggle();
      refresh();
    },

    reset(): void {
      open = false;
      noteId = null;
      page = undefined;
      shownKey = null;
      token++; // orphan any in-flight fetch from the previous note
      cache.clear();
      view.setOpen(false);
      syncToggle();
      // Clear the body, or an orphaned fetch leaves "Loading…" showing.
      view.setState({ kind: "empty" });
    },
  };
}
