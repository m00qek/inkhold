// The PAGE INDEX — the filmstrip a viewer docks beside its page: one thumbnail
// per page, click to jump, the current page marked, and (where a viewer has
// something to say about it) a per-page badge.
//
// ONE COMPONENT, TWO VIEWERS. The `.note` reader and the PDF viewer had a strip
// each: the same markup, the same `.filmstrip*` classes, the same highlight and
// the same click-to-jump, written twice. They differ in exactly ONE thing — the
// PAINT. A `.note` page goes through `NoteRenderer`/`LazyEngine`; a PDF page comes
// from the worker's `PdfSession`. So the paint is the parameter and everything
// else lives here.
//
// WHY THIS IS VIRTUALISED, AND WHY THAT IS THE POINT. A strip is a row per page,
// and a page is a canvas. Build them all up front and a 1,700-page document holds
// 1,700 canvases: at a ~120px thumbnail that is tens of megabytes of backing
// store that nothing ever releases, in a tab a phone may kill for it. So the rows
// are a `VirtualList` window (`src/ui/virtualList.ts`) — the DOM cost is a
// viewport, not a document — and a row that leaves the window is UNMOUNTED: its
// paint is cancelled by the caller's `unmount` and its canvas is resized to 0×0,
// which is the one call that actually frees a canvas's pixels.
//
// HOOK CLASSES. The `.filmstrip*` classes carry the LOOK and are deliberately
// shared, which means a bare `.filmstrip` selector matches every viewer that
// mounts one at once. A caller that needs to select its own strip passes
// `stripHook` for an additional namespace class (`pdf-filmstrip`) — the same
// shared-appearance / feature-hook split `createSidePanel`'s `hookPrefix` makes.

import { el } from "../ui/dom";
import { createSidePanel } from "../ui/sidePanel";
import { VirtualList } from "../ui/virtualList";
import { svg, VIEWER_IC } from "./viewerChrome";

/**
 * The fixed row height, in px — `--preview-h-filmstrip` (the thumbnail's
 * `--preview-h-panel` plus its number and gap). A vertical strip lives on a
 * FIXED item height: it is what keeps the virtual scroll math exact, and it is
 * why a row reserves its shape through `--thumb-aspect` (a WIDTH) rather than by
 * growing.
 */
const ROW_H = 124;

/** One row of the strip, as the paint sees it. */
export interface PageIndexRow {
  /** 0-based page index. */
  readonly index: number;
  /** The `.filmstrip__page` button. */
  readonly el: HTMLElement;
  /** The thumbnail canvas — where the paint goes. */
  readonly canvas: HTMLCanvasElement;
  /** Toggle the row's loading treatment (`.is-loading` on the thumb). */
  setLoading(on: boolean): void;
  /** Reserve or correct the row's shape (width ÷ height). */
  setAspect(aspect: number): void;
}

export interface PageIndexOptions {
  /** `id` for the panel `<aside>` — an opener's `aria-controls` target. */
  id: string;
  /**
   * An extra hook class on the `.filmstrip` rail (e.g. `"pdf-filmstrip"`), so a
   * caller can select ITS strip while the look stays on the shared classes.
   */
  stripHook?: string;
  /** The user picked a page. */
  onPick(index: number): void;
  /**
   * A row entered the window: START ITS PAINT. Free to be async — nothing here
   * awaits it — but it MUST tolerate being superseded: the row may be unmounted
   * (see {@link unmount}) or the whole strip rebuilt before the pixels land, and
   * a paint that finishes late must drop them rather than draw into a canvas
   * that now stands for another page.
   */
  mount(row: PageIndexRow): void;
  /**
   * The row left the window, or the strip was cleared. Cancel or forget the
   * paint. The canvas is zeroed by the strip immediately afterwards, so this
   * only has to release whatever the CALLER holds (an engine slot, a queue
   * entry, a decoded bitmap).
   */
  unmount(row: PageIndexRow): void;
  /**
   * The row's reserved shape (width ÷ height), or `null` to leave the
   * stylesheet's own default. Reserved BEFORE anything paints, so the strip does
   * not reflow under the pointer as thumbnails land; a viewer that only learns a
   * page's real size when its thumbnail resolves corrects it with
   * {@link PageIndexRow.setAspect} and answers the corrected value here after
   * (rows are rebuilt as they scroll back in).
   */
  aspect?(index: number): number | null;
  /** The row starts in the loading treatment. */
  loading?(index: number): boolean;
}

export interface PageIndex {
  /** The panel `<aside>`. Mount it; it is also the strip's SCROLL container. */
  readonly el: HTMLElement;
  /** (Re)build the strip for a document of `count` pages, all unpainted. */
  setPages(count: number): void;
  /** Move the `aria-current` mark and scroll that row into view. */
  setCurrent(index: number): void;
  /**
   * Per-page counts to badge (`.filmstrip__hits`). Held, not just applied: rows
   * built later — by a scroll, or by a rebuild — carry the badge they are due.
   */
  setBadges(counts: ReadonlyMap<number, number>): void;
  /**
   * The row's thumbnail canvas IF that row is inside the rendered window — the
   * reader's blur-up source. `null` for a page whose row does not currently
   * exist, which is the normal case for a jump across a long document.
   */
  thumbCanvas(index: number): HTMLCanvasElement | null;
  /** Re-measure the window (after a resize, or after the panel is revealed). */
  refresh(): void;
  setOpen(open: boolean): void;
  /** Drop every row (each is unmounted). The strip stays usable. */
  clear(): void;
  /** Tear down for good. */
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
  /** The rows inside the virtual window, by index. Mirrors the list's own set. */
  const rows = new Map<number, PageIndexRow>();

  /**
   * The badge, rewritten from scratch. Removing first is what makes this safe to
   * call on a row that already carries one — a count that dropped to zero has to
   * take the badge away, not leave a stale number sitting on the page.
   */
  function applyBadge(row: PageIndexRow): void {
    row.el.querySelector(".filmstrip__hits")?.remove();
    const n = badges.get(row.index);
    if (!n) return;
    const label = `${n} ${n === 1 ? "match" : "matches"} on page ${row.index + 1}`;
    row.el.append(el("span", { class: "filmstrip__hits", text: String(n), title: label }));
  }

  function buildRow(index: number): HTMLElement {
    const canvas = el("canvas");
    // EMPTY MEANS 0×0. A fresh canvas is 300×150 with nothing drawn on it, which
    // reads to every "has this row been painted?" test in the app as a real
    // bitmap — and the reader's blur-up believed it, blitting a transparent
    // rectangle over the page instead of falling back to the ruled sheet. A
    // recycled row is zeroed for the same reason (see `dropRow`); a new one
    // starts there.
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
    opts.mount(row);
    return btn;
  }

  /**
   * A row leaving the window. `unmount` first (the caller may still want to read
   * the canvas), THEN zero the canvas: setting `width`/`height` to 0 is what
   * actually frees a canvas's backing store. Dropping the element alone leaves
   * the pixels to a garbage collector that has no idea they are megabytes.
   */
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
    // `VirtualList.destroy` empties its host, and the host is the panel body —
    // so the rail itself has to go back in for the next `setPages`.
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
      // The LIST scrolls, not the element: the target row may not exist yet (a
      // deep link or a find step lands well outside the window), and only the
      // list knows where a row that has not been built would be.
      list?.scrollIntoView(index);
    },

    setBadges(counts: ReadonlyMap<number, number>): void {
      badges = counts;
      for (const row of rows.values()) applyBadge(row);
    },

    thumbCanvas(index: number): HTMLCanvasElement | null {
      return rows.get(index)?.canvas ?? null;
    },

    refresh(): void {
      list?.refresh();
    },

    setOpen(open: boolean): void {
      panel.setOpen(open);
      // A hidden panel measures 0×0, so the window it computed while shut is a
      // guess. Re-measure on the way in — nothing else fires a scroll event.
      if (open) list?.refresh();
    },

    clear,

    destroy(): void {
      clear();
    },
  };
}
