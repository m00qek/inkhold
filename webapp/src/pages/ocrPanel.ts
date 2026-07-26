// The "Recognized text" panel's brain, split out of reader.ts the same way the
// lazy engine is split out of the gallery: all of the fetch/race/state logic with
// the DOM injected as an {@link OcrView}, so it is exercisable on plain Node
// while reader.ts keeps only the wiring.
//
// The whole point of this controller is that the transcript is LAZY.
// `PageRef.textHash` tells the toolbar whether to offer the panel at all (non-null
// = this page has recognition); the text itself is fetched only once the panel is
// actually open on that page, and never on note-open.

import { dispatchApiFailure, type ApiFailureSink } from "../api/client";
import type { Api } from "../api/types";
import type { Hash, Id, PageRef } from "../core/types";

/**
 * The three states the panel body can be in beyond showing a transcript. They are
 * deliberately distinct: "we're fetching", "the fetch failed and you can retry by
 * paging", and "this page genuinely has nothing" are three different things to a
 * reader, and collapsing them into one blank body is how a broken panel gets
 * mistaken for an empty one.
 */
export type OcrState =
  | { kind: "loading" }
  | { kind: "text"; text: string }
  | { kind: "empty" }
  | { kind: "error"; message: string };

export interface OcrView {
  /** Show/hide the aside and set the toggle's `aria-pressed`. */
  setOpen(open: boolean): void;
  /** Whether the toggle can be pressed right now (see `toggle()` for the rule). */
  setToggleEnabled(enabled: boolean): void;
  /** Paint the panel body. */
  setState(state: OcrState): void;
  /**
   * The panel appeared or disappeared, so the stage the page canvas is sized
   * against just changed width. The reader answers this by re-running `showPage`,
   * which re-measures and repaints — without it the canvas keeps its old size and
   * either overflows or leaves a gap.
   */
  relayout(): void;
}

export interface OcrDeps {
  api: Api;
  view: OcrView;
  /** Where UNAUTHORIZED / STALE_PAGE go. Never swallow them here. */
  failures: ApiFailureSink;
}

export interface OcrController {
  isOpen(): boolean;
  /** Flip the panel. No-op when the toggle is currently disabled. */
  toggle(): void;
  /**
   * The reader moved to a page (or refetched metadata). Updates the toggle's
   * enabled state and, when the panel is open, refills the body for the new page.
   */
  setPage(noteId: Id | null, page: PageRef | undefined): void;
  /** A different note opened: close the panel and drop the per-note text cache. */
  reset(): void;
}

export function createOcrController({ api, view, failures }: OcrDeps): OcrController {
  let open = false;
  let noteId: Id | null = null;
  let page: PageRef | undefined;

  /**
   * Identifies the transcript currently painted OR in flight, so a zoom step
   * (which also re-runs showPage) doesn't re-request text we already have.
   * Keyed on `textHash`, not the page content hash — a device-side recognition
   * run gives the page a new textHash while leaving its strokes alone, and that
   * has to read as "refetch". Pages with no recognition get a per-index sentinel
   * so they still de-duplicate against themselves. Cleared on failure so paging
   * away and back retries.
   */
  let shownKey: string | null = null;
  const keyOf = (p: PageRef): string => p.textHash ?? `none:${p.index}`;

  /** Bumped per fetch; a stale response whose token lost the race is dropped. */
  let token = 0;

  /** Per-note transcript cache, keyed by textHash so it turns over with it. */
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
      // Opening the panel and then paging fast must never paint page N's text
      // under page M — same guard style the reader uses for its own paints.
      if (mine !== token || !open || noteId !== id || page?.textHash !== textHash) return;
      cache.set(textHash, text);
      paint(text);
    } catch (e) {
      if (mine !== token || !open || noteId !== id || page?.textHash !== textHash) return;
      shownKey = null; // let a later visit retry
      // A dead session or a stale `?v=` is not a panel problem — it belongs to the
      // shell / the note metadata. Anything else stays a recoverable panel message.
      if (dispatchApiFailure(failures, e, id, p)) return;
      view.setState({ kind: "error", message: "Couldn't load the recognized text." });
    }
  }

  /** Bring the body in line with the current page. Cheap and idempotent. */
  function refresh(): void {
    if (!open) return;
    const p = page;
    if (!p || noteId === null) {
      shownKey = null;
      view.setState({ kind: "empty" });
      return;
    }
    // A null textHash is why no speculative fetch happens here.
    if (p.textHash === null) {
      shownKey = keyOf(p);
      view.setState({ kind: "empty" });
      return;
    }
    if (shownKey === keyOf(p)) return;
    void load(noteId, p, p.textHash);
  }

  /**
   * The toggle is offered when this page has recognition — EXCEPT while the panel
   * is open, where it must stay pressable so an open panel is always closable,
   * even after paging onto a page with none.
   */
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
      // Last, and always: the stage just changed width in both directions.
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
      // Clear the body too. Without this, a reset that lands while a fetch is in
      // flight orphans that fetch (the token moved) and leaves the panel showing
      // the previous note's "Loading…" forever — the next open would repaint it,
      // but until then the panel is lying about what it is doing.
      view.setState({ kind: "empty" });
    },
  };
}
