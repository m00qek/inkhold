// The shared viewer steppers: zoom `− [readout] +` and the `‹ 12 / 1700 ›` pager.

import { el } from "../../ui/dom";
import { svg, VIEWER_IC } from "./viewerIcons";

/**
 * Fit labels shared by every viewer. U+21D5/U+21D4 are a matched double-stroke
 * pair (U+2194 is single-stroke and would not match).
 */
export const FIT_PAGE = "Fit ⇕";
/** Fit across only; the page may run off the bottom. */
export const FIT_WIDTH = "Fit ⇔";

/**
 * `onStep(dir)` clamps, applies and persists, and returns the value now shown,
 * so a clamped step does not flicker. The readout class is per viewer because
 * every viewer is mounted at once and a shared class breaks strict e2e locators.
 */
export interface ZoomStepper<V> {
  el: HTMLElement;
  focus: HTMLButtonElement[];
  set(value: V): void;
  /** A readout off the ladder (a pinch's factor of Fit), until the next `set` or step. */
  show(text: string): void;
}

export function createZoomStepper<V>(opts: {
  readoutClass: string;
  initial: V;
  format: (value: V) => string;
  onStep: (dir: 1 | -1) => V;
  labels?: { out: string; in: string };
}): ZoomStepper<V> {
  const out = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": opts.labels?.out ?? "Zoom out",
    html: svg(VIEWER_IC.minus, 1.8),
  }) as HTMLButtonElement;
  const plus = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": opts.labels?.in ?? "Zoom in",
    html: svg(VIEWER_IC.plus, 1.8),
  }) as HTMLButtonElement;
  const readout = el("span", { class: opts.readoutClass, text: opts.format(opts.initial) });
  const pager = el("div", { class: "pager" }, out, readout, plus);
  const set = (value: V): void => void (readout.textContent = opts.format(value));
  out.addEventListener("click", () => set(opts.onStep(-1)));
  plus.addEventListener("click", () => set(opts.onStep(1)));
  const show = (text: string): void => void (readout.textContent = text);
  return { el: pager, focus: [out, plus], set, show };
}

/**
 * The page pager. The readout is itself the input (`12 / 1700`), so commit parses
 * the leading integer.
 */
export interface Pager {
  el: HTMLElement;
  /** Previous, field, Next: the field is in the toolbar's roving order. */
  focus: HTMLElement[];
  /** 0-based `index` of `count`; `count <= 0` shows an em dash and disables both buttons. */
  set(index: number, count: number): void;
}

export function createPager(opts: {
  /** Per viewer, for the same strict-locator reason as `ZoomStepper`. */
  readoutClass: string;
  onGo: (index: number) => void;
  labels?: { prev: string; next: string };
}): Pager {
  const prevLabel = opts.labels?.prev ?? "Previous page";
  const nextLabel = opts.labels?.next ?? "Next page";
  const prev = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": prevLabel,
    title: prevLabel,
    html: svg(VIEWER_IC.prev, 1.9),
  }) as HTMLButtonElement;
  const next = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": nextLabel,
    title: nextLabel,
    html: svg(VIEWER_IC.next, 1.9),
  }) as HTMLButtonElement;
  // A control must not be a status region, so the live region is separate.
  const live = el("span", { class: "pager__live", role: "status" });
  const readout = el("input", {
    class: opts.readoutClass,
    type: "text",
    // Not `type="number"`: the value carries the total, and spinners would be a second pager.
    inputMode: "numeric",
    autocomplete: "off",
    "aria-label": "Page",
  }) as HTMLInputElement;

  let at = 0;
  let of = 0;
  prev.addEventListener("click", () => opts.onGo(at - 1));
  next.addEventListener("click", () => opts.onGo(at + 1));

  /** Also the revert path. `size` tracks content since an `<input>` does not size to its value. */
  function render(): void {
    readout.value = of > 0 ? `${at + 1} / ${of}` : "—";
    readout.size = Math.max(1, readout.value.length);
  }

  /** Out of range clamps rather than refuses, so the reader and PDF viewer agree. */
  function commit(): void {
    const typed = parseInt(readout.value, 10);
    if (of > 0 && Number.isFinite(typed)) {
      opts.onGo(Math.max(0, Math.min(of - 1, typed - 1)));
    }
    // After `onGo`, so the field shows where the viewer actually landed.
    render();
    readout.blur();
  }

  // Select on focus so typing replaces the value; the mouseup guard stops the
  // browser collapsing that selection on the focusing click's release.
  let justFocused = false;
  readout.addEventListener("focus", () => {
    justFocused = true;
    readout.select();
  });
  readout.addEventListener("mouseup", (e) => {
    if (!justFocused) return;
    justFocused = false;
    e.preventDefault();
  });
  readout.addEventListener("blur", () => {
    justFocused = false;
    render();
  });

  readout.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === "Escape") {
      // Stopped, or the viewer's document-level Escape would close the document.
      e.stopPropagation();
      render();
      readout.blur();
      return;
    }
    // The toolbar roves on arrows; keep the caret's key until it reaches an edge,
    // then let it rejoin the roving order.
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const from = readout.selectionStart ?? 0;
      const to = readout.selectionEnd ?? 0;
      const atEdge =
        from === to && (e.key === "ArrowLeft" ? from === 0 : from === readout.value.length);
      if (!atEdge) e.stopPropagation();
    }
  });

  render();

  return {
    el: el("div", { class: "pager" }, prev, readout, next, live),
    focus: [prev, readout, next],
    set(index, count) {
      at = index;
      of = count;
      // Skip the paint while the user is editing, or a late raster clears their
      // typing; state is still updated and rendered on commit/blur.
      if (document.activeElement !== readout) render();
      live.textContent = of > 0 ? `Page ${at + 1} of ${of}` : "";
      prev.disabled = of <= 0 || at <= 0;
      next.disabled = of <= 0 || at >= of - 1;
    },
  };
}
