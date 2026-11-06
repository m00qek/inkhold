// The PDF outline panel: the document's table of contents, indented by depth,
// with the entry containing the current page marked. Shares the dock with the
// page index (mutually exclusive) because the two want different widths.
// Depth is shown by indent and type only; colour is reserved for the current entry.

import { el } from "../../ui/dom";
import { createSidePanel } from "../../ui/sidePanel";
import { svg, VIEWER_IC } from "../viewer/viewerIcons";
import type { PdfOutlineEntry } from "../../render/pdfWire";

/** Deepest level with its own indent and type step (the 268px track runs out at five). */
const MAX_DEPTH = 3;

export interface PdfOutlinePanel {
  /** The panel `<aside>`, also the scroll container. */
  el: HTMLElement;
  /** (Re)build the list; the current mark is dropped. */
  setEntries(entries: readonly PdfOutlineEntry[]): void;
  setCurrent(page: number): void;
  setOpen(open: boolean): void;
  clear(): void;
}

export function createPdfOutlinePanel(opts: { onPick(page: number): void; onClose?: () => void }): PdfOutlinePanel {
  const list = el("div", { class: "pdf-outline" });
  const panel = createSidePanel({
    id: "pdf-outline-panel",
    ariaLabel: "Outline",
    icon: svg(VIEWER_IC.outline, 1.7),
    label: "Outline",
    hookPrefix: "outline",
    onClose: opts.onClose,
  });
  panel.body.append(list);

  let entries: readonly PdfOutlineEntry[] = [];
  let rows: HTMLButtonElement[] = [];
  /** Index into `entries`, or -1 when no entry covers the page. */
  let current = -1;

  /**
   * Measured against the panel rather than `scrollIntoView()`, which would also
   * scroll the zoomed page's stage sideways.
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
    const depth = Math.min(entry.depth, MAX_DEPTH);
    const title = el("span", { class: "pdf-outline__t", text: entry.title });
    const row = el(
      "button",
      {
        class: `pdf-outline__row pdf-outline__row--d${depth}`,
        type: "button",
        "data-entry": String(index),
        "aria-current": "false",
        // An entry with no destination is shown disabled, not dropped.
        ...(entry.page === null ? { disabled: true } : {}),
      },
      title,
      // 1-based on screen, 0-based on the wire.
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

    /** The last entry whose page is at or before `page`; ties go to the later (more specific) entry. */
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
      // A hidden element measures 0×0, so reveal only on open.
      if (open) reveal();
    },

    clear,
  };
}
