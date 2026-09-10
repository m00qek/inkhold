// The OUTLINE panel — the document's own table of contents, docked beside the
// page: one row per entry, indented by depth, click to jump, and the entry you
// are inside marked as you page.
//
// A SEPARATE PANEL FROM THE PAGE INDEX, not tabs inside one, because the two
// want different track widths: a filmstrip is happiest at `--panel-w-narrow`
// (180px) and a wrapped outline title is unreadable there. They share the DOCK
// instead and the viewer keeps them mutually exclusive, since two navigation
// panels open at once would leave the page a sliver.
//
// DEPTH IS INDENT PLUS TYPE, NEVER COLOUR. Colour is reserved for STATE here
// (the current entry, and its accent stroke in the gutter); tint the depths and
// there is nothing left to say "you are here" with. See `20-pdf-viewer.css`.

import { el } from "../ui/dom";
import { createSidePanel } from "../ui/sidePanel";
import { svg, VIEWER_IC } from "./viewerIcons";
import type { PdfOutlineEntry } from "../render/pdfWire";

/**
 * The deepest level that gets its own indent step and type treatment; anything
 * below it is drawn as this one.
 *
 * At `--sp-3` (12px) a level, the indent runs out of the 268px track at five
 * levels. The clamp is on the INDENT and the TYPE both, so a level-6 entry
 * reads as "deeper than a chapter" rather than as a column of single
 * characters.
 */
const MAX_DEPTH = 3;

export interface PdfOutlinePanel {
  /** The panel `<aside>`. Mount it; it is also the list's SCROLL container. */
  el: HTMLElement;
  /** (Re)build the list. The current mark is dropped — set it again after. */
  setEntries(entries: readonly PdfOutlineEntry[]): void;
  /** Move the current mark to the entry that covers this 0-based page. */
  setCurrent(page: number): void;
  setOpen(open: boolean): void;
  /** Drop every row. The panel stays usable. */
  clear(): void;
}

export function createPdfOutlinePanel(opts: { onPick(page: number): void }): PdfOutlinePanel {
  const list = el("div", { class: "pdf-outline" });
  const panel = createSidePanel({
    id: "pdf-outline-panel",
    ariaLabel: "Outline",
    icon: svg(VIEWER_IC.outline, 1.7),
    label: "Outline",
    hookPrefix: "outline",
  });
  panel.body.append(list);

  let entries: readonly PdfOutlineEntry[] = [];
  /** One button per entry, index-aligned with `entries`. */
  let rows: HTMLButtonElement[] = [];
  /** Index into `entries`, or -1 for "no entry covers the current page". */
  let current = -1;

  /**
   * Scroll the marked row into view, if it is out of it.
   *
   * Measured rather than `scrollIntoView()`, and against the PANEL's own box:
   * `scrollIntoView` walks every scrollable ancestor, and the panel is a flex
   * child of a stage that itself scrolls a zoomed page — so revealing a row 300
   * entries down would also drag the page sideways under the reader.
   */
  function reveal(): void {
    const row = current >= 0 ? rows[current] : undefined;
    if (!row) return;
    const box = panel.el;
    const r = row.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.top < b.top) box.scrollTop += r.top - b.top;
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
  }

  function mark(): void {
    for (const [i, row] of rows.entries()) {
      row.setAttribute("aria-current", String(i === current));
    }
  }

  function buildRow(entry: PdfOutlineEntry, index: number): HTMLButtonElement {
    // The indent is a custom property because it is arithmetic (`--sp-3` per
    // step); the TYPE is a class because it is not — it steps down a scale that
    // already exists and stops.
    const depth = Math.min(entry.depth, MAX_DEPTH);
    const title = el("span", { class: "pdf-outline__t", text: entry.title });
    const row = el(
      "button",
      {
        class: `pdf-outline__row pdf-outline__row--d${depth}`,
        type: "button",
        "data-entry": String(index),
        "aria-current": "false",
        // AN ENTRY WITH NO DESTINATION IS INERT, not absent. It is still a line
        // its author wrote in the table of contents, and a row that silently did
        // nothing when pressed would be worse than one that says it cannot.
        ...(entry.page === null ? { disabled: true } : {}),
      },
      title,
      // 1-BASED ON SCREEN, 0-based on the wire. `p` is the index `go()` takes;
      // the number beside a heading is the one printed on the page.
      entry.page === null
        ? null
        : el("span", { class: "pdf-outline__p", text: String(entry.page + 1) }),
    ) as HTMLButtonElement;
    row.style.setProperty("--depth", String(depth));
    if (entry.page !== null) {
      const page = entry.page;
      row.addEventListener("click", () => opts.onPick(page));
    }
    return row;
  }

  function clear(): void {
    entries = [];
    rows = [];
    current = -1;
    list.replaceChildren();
  }

  return {
    el: panel.el,

    setEntries(next: readonly PdfOutlineEntry[]): void {
      clear();
      entries = next;
      rows = next.map(buildRow);
      list.append(...rows);
    },

    /**
     * THE ENTRY WITH THE GREATEST `page` AT OR BEFORE `page` — the entry the
     * reader is INSIDE, which is why this takes a page rather than an index:
     * the mark tracks paging and arrow keys as faithfully as it tracks a click.
     *
     * Ties go to the LAST entry at that page — a Part and its first Chapter
     * beginning on one page means the Chapter, the more precise answer. An
     * entry with `page === null` names no place and can never be current.
     */
    setCurrent(page: number): void {
      let best = -1;
      let bestPage = -1;
      for (const [i, entry] of entries.entries()) {
        if (entry.page === null || entry.page > page) continue;
        if (entry.page >= bestPage) {
          bestPage = entry.page;
          best = i;
        }
      }
      current = best;
      mark();
    },

    setOpen(open: boolean): void {
      panel.setOpen(open);
      // A hidden element measures 0×0, so this can only be done on the way IN.
      if (open) reveal();
    },

    clear,
  };
}
