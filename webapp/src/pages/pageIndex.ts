// The page index: a virtualised thumbnail filmstrip shared by the reader and the
// PDF viewer, with the paint as a parameter. Rows leaving the window are unmounted
// and their canvas zeroed, so a 1,700-page document never holds 1,700 canvases.

import { el } from "../ui/dom";
import { createSidePanel } from "../ui/sidePanel";
import { VirtualList } from "../ui/virtualList";
import { svg, VIEWER_IC } from "./viewer/viewerIcons";

/** Fixed row height, px (`--preview-h-filmstrip`); the virtual scroll math depends on it. */
const ROW_H = 124;

export interface PageIndexRow {
  readonly index: number;
  readonly el: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  setLoading(on: boolean): void;
  setAspect(aspect: number): void;
}

export interface PageIndexOptions {
  id: string;
  /** Extra hook class, since the shared `.filmstrip` classes match every mounted viewer. */
  stripHook?: string;
  onPick(index: number): void;
  /**
   * Start the row's paint. Must tolerate being superseded: a late paint drops its
   * pixels rather than draw into a canvas now standing for another page.
   */
  mount(row: PageIndexRow): void;
  /** Release whatever the caller holds; the strip zeroes the canvas afterwards. */
  unmount(row: PageIndexRow): void;
  /** Reserved shape (width ÷ height) before painting, so the strip does not reflow; `null` for the CSS default. */
  aspect?(index: number): number | null;
  loading?(index: number): boolean;
  /** Accessible-name word for an inked page: "written" (note) or "annotated" (PDF). */
  inkWord?: string;
}

export interface PageIndex {
  /** The panel `<aside>`, also the scroll container. */
  readonly el: HTMLElement;
  setPages(count: number): void;
  setCurrent(index: number): void;
  /** Held, so rows built later carry their badge. */
  setBadges(counts: ReadonlyMap<number, number>): void;
  /**
   * A missing entry means "not looked at yet". All-or-nothing: unless the map
   * covers every page, no row draws a stroke, so a half-filled rail cannot imply
   * unexamined pages are empty.
   */
  setInk(ink: ReadonlyMap<number, boolean>): void;
  /** The row's canvas if it is in the rendered window (the reader's blur-up source). */
  thumbCanvas(index: number): HTMLCanvasElement | null;
  refresh(): void;
  setOpen(open: boolean): void;
  clear(): void;
  destroy(): void;
}

export function createPageIndex(opts: PageIndexOptions): PageIndex {
  const strip = el("div", { class: `filmstrip${opts.stripHook ? ` ${opts.stripHook}` : ""}` });
  const panel = createSidePanel({
    id: opts.id,
    ariaLabel: "Pages",
    icon: svg(VIEWER_IC.pages, 1.7),
    label: "Pages",
    hookPrefix: "pages",
  });
  panel.body.append(strip);

  let list: VirtualList | null = null;
  let total = 0;
  let current = 0;
  let badges: ReadonlyMap<number, number> = new Map();
  let ink: ReadonlyMap<number, boolean> = new Map();
  const inkWord = opts.inkWord ?? "written";
  const rows = new Map<number, PageIndexRow>();

  function applyBadge(row: PageIndexRow): void {
    row.el.querySelector(".filmstrip__hits")?.remove();
    const n = badges.get(row.index);
    if (!n) return;
    const label = `${n} ${n === 1 ? "match" : "matches"} on page ${row.index + 1}`;
    row.el.append(el("span", { class: "filmstrip__hits", text: String(n), title: label }));
  }

  /**
   * Only ever a positive claim: `false` and unknown look and are named alike. The
   * stroke is a `::before`, so the fact reaches screen readers as a word in the name.
   */
  function applyInk(row: PageIndexRow): void {
    const known = total > 0 && ink.size >= total;
    const inked = known && ink.get(row.index) === true;
    row.el.classList.toggle("filmstrip__page--inked", inked);
    row.el.setAttribute("aria-label", inked ? `Page ${row.index + 1}, ${inkWord}` : `Page ${row.index + 1}`);
  }

  function buildRow(index: number): HTMLElement {
    const canvas = el("canvas");
    // Empty means 0×0: a fresh 300×150 canvas reads as painted to every check.
    canvas.width = 0;
    canvas.height = 0;
    const thumb = el("div", { class: "filmstrip__thumb" }, canvas);
    if (opts.loading?.(index)) thumb.classList.add("is-loading");
    const btn = el(
      "button",
      {
        class: "filmstrip__page",
        type: "button",
        "data-page": String(index),
        "aria-current": String(index === current),
        "aria-label": `Page ${index + 1}`,
      },
      thumb,
      el("span", { class: "filmstrip__num", text: String(index + 1) }),
    );
    const row: PageIndexRow = {
      index,
      el: btn,
      canvas,
      setLoading: (on) => thumb.classList.toggle("is-loading", on),
      setAspect: (aspect) => {
        if (aspect > 0) btn.style.setProperty("--thumb-aspect", String(aspect));
      },
    };
    const reserved = opts.aspect?.(index) ?? null;
    if (reserved !== null) row.setAspect(reserved);
    btn.addEventListener("click", () => opts.onPick(index));
    rows.set(index, row);
    applyBadge(row);
    applyInk(row);
    opts.mount(row);
    return btn;
  }

  /** `unmount` first, then zero the canvas, which is what frees its backing store. */
  function dropRow(index: number): void {
    const row = rows.get(index);
    if (!row) return;
    rows.delete(index);
    opts.unmount(row);
    row.canvas.width = 0;
    row.canvas.height = 0;
  }

  function clear(): void {
    if (list) {
      list.destroy(); // recycles (and so unmounts) every row it holds
      list = null;
    }
    for (const index of [...rows.keys()]) dropRow(index);
    total = 0;
    strip.replaceChildren();
    // `VirtualList.destroy` empties its host (the panel body), so re-insert the rail.
    panel.body.replaceChildren(strip);
  }

  return {
    el: panel.el,

    setPages(count: number): void {
      clear();
      total = Math.max(0, count);
      if (total === 0) return;
      current = Math.min(current, total - 1);
      list = new VirtualList({
        scrollContainer: panel.el,
        hostContainer: panel.body,
        contentContainer: strip,
        totalItems: total,
        itemHeight: ROW_H,
        renderItem: buildRow,
        recycleItem: (index) => dropRow(index),
        overscan: 1,
      });
    },

    setCurrent(index: number): void {
      current = index;
      for (const [i, row] of rows) row.el.setAttribute("aria-current", String(i === index));
      // The list scrolls, since the target row may not be built yet.
      list?.scrollIntoView(index);
    },

    setBadges(counts: ReadonlyMap<number, number>): void {
      badges = counts;
      for (const row of rows.values()) applyBadge(row);
    },

    setInk(next: ReadonlyMap<number, boolean>): void {
      ink = next;
      for (const row of rows.values()) applyInk(row);
    },

    thumbCanvas(index: number): HTMLCanvasElement | null {
      return rows.get(index)?.canvas ?? null;
    },

    refresh(): void {
      list?.refresh();
    },

    setOpen(open: boolean): void {
      panel.setOpen(open);
      // A hidden panel measured 0×0; re-measure on reveal.
      if (open) list?.refresh();
    },

    clear,

    destroy(): void {
      clear();
    },
  };
}
