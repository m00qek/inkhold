// The two shared viewer STEPPERS — the zoom `− [readout] +` and the page
// `‹ 12 / 1700 ›` pager. Both are toolbar `view`-slot controls that every viewer
// mounts, parameterised only by what legitimately differs (its readout class, its
// value model).

import { el } from "../ui/dom";
import { svg, VIEWER_IC } from "./viewerIcons";

/**
 * THE TWO FIT LABELS, spelled once for every viewer that shows one.
 *
 * A fit is a fit ALONG AN AXIS, and two of the viewers offer both — so the label
 * has to say which, and saying it in words ("Fit" / "Fit width") cost the readout
 * most of its width for the rarer of the two. The arrows say the same thing in
 * one glyph, and they are a MATCHED PAIR on purpose: U+21D5 and U+21D4 are the
 * same double-stroke family, so the two read as one control's two settings
 * rather than as two unrelated marks. (U+2194, the single-stroke horizontal, is
 * the near-miss — it pairs with U+2195, not with the double-stroke vertical.)
 *
 * Shared rather than re-typed per viewer for the same reason the readout's width
 * is shared (10-toolbar.css): every viewer is mounted at once and a reader steps
 * between them, so a glyph that drifted in one would show up as the control
 * changing shape between file types. The LADDERS stay with their viewers — only
 * the two words on the rungs live here.
 */
export const FIT_PAGE = "Fit ⇕";
/** Fit ACROSS only — the page fills the stage's width and may run off the bottom. */
export const FIT_WIDTH = "Fit ⇔";

/**
 * The `− [readout] +` stepper every viewer's zoom (and the `.txt` font/width)
 * controls share: a `.pager` holding two `.icon-btn`s around a readout `<span>`.
 *
 * ONLY the skeleton and the clamp-silently plumbing are shared; the VALUE MODEL
 * stays with the viewer. `onStep(dir)` performs the step — clamp, apply, persist
 * — and RETURNS the value now shown; the stepper renders it through `format`, so
 * a step that clamped at a bound returns the unchanged value and the readout does
 * not flicker. `set(v)` repaints the readout for an external reset (a new file).
 *
 * The readout keeps its PER-VIEWER class (`.zoom` / `.spd-zoom` / `.txt-zoom` /
 * `.pdf-zoom`): every viewer is mounted at once, so a shared class would make a
 * bare `.zoom` Playwright locator resolve to several elements. It is a parameter
 * here, never a constant. (It no longer buys per-viewer WIDTH: every readout
 * shares one width now — see 10-toolbar.css.)
 */
export interface ZoomStepper<V> {
  /** The `.pager` element — a toolbar `view` slot (also the thing a viewer hides). */
  el: HTMLElement;
  /** The two stepper buttons in order, for the toolbar's roving-tabindex `focus`. */
  focus: HTMLButtonElement[];
  /** Repaint the readout to show `value` (via `format`) — for external resets. */
  set(value: V): void;
}

export function createZoomStepper<V>(opts: {
  /** The readout `<span>`'s class — kept per-viewer (see the interface docs). */
  readoutClass: string;
  /** The value the readout shows before any step. */
  initial: V;
  /** Render a value as the readout's text. */
  format: (value: V) => string;
  /** Perform a step in `dir` (clamp/apply/persist) and return the value now shown. */
  onStep: (dir: 1 | -1) => V;
  /** The stepper buttons' `aria-label`s. Default "Zoom out"/"Zoom in". */
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
  return { el: pager, focus: [out, plus], set };
}

/**
 * THE PAGE PAGER — `‹ 12 / 1700 ›`, the control both paged viewers carry.
 * `10-toolbar.css` states the rule it keeps: "one readout, one position, in
 * every viewer".
 *
 * THE READOUT IS THE FIELD, rather than a separate "go to page" box: the counter
 * was already a field in every respect but one. So the whole `12 / 1700` string
 * is the input's value — not a number box beside a total — which is why it looks
 * identical at rest and why the commit path parses the LEADING integer: whether
 * someone selects all and types `500` or edits the `12` into `125` in place, the
 * first number in the box is the page they meant.
 */
export interface Pager {
  /** The `.pager` element — a toolbar `view` slot. */
  el: HTMLElement;
  /**
   * The three controls in order — Previous, the page field, Next — for the
   * toolbar's roving-tabindex `focus`. The field is IN the roving order rather
   * than a second tab stop hiding inside a bar that is meant to be one; see the
   * arrow-key note in the body for how it stays a text field anyway.
   */
  focus: HTMLElement[];
  /**
   * Show `index` of `count` (both 0-based/absolute; the readout is 1-based) and
   * re-bound the buttons. `count <= 0` is "no document yet" — an em dash and
   * both buttons dead, which is what a viewer shows before its first page.
   */
  set(index: number, count: number): void;
}

export function createPager(opts: {
  /**
   * The readout field's class, and it is REQUIRED for the reason
   * {@link ZoomStepper} gives about its own: every viewer is mounted at once, so
   * one class across two of them makes `locator(".pager__count")` resolve to two
   * elements and fail on strict mode — sharing it was tried and broke 65 e2e
   * tests. The reader keeps `.pager__count`; the PDF viewer takes
   * `.pdf-pager__count`, styled alongside it in `10-toolbar.css`.
   */
  readoutClass: string;
  /** Go to this 0-based page. The component never moves on its own. */
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
  // A CONTROL MUST NOT ANNOUNCE ITSELF AS A STATUS REGION, so the live region
  // and the field are two elements. The region is worded for a listener rather
  // than a glance: "Page 12 of 1700", not "12 / 1700".
  const live = el("span", { class: "pager__live", role: "status" });
  const readout = el("input", {
    class: opts.readoutClass,
    type: "text",
    // Not `type="number"`: the value carries the total as well, and the spinner
    // arrows would be a second, worse pager sitting inside the first.
    inputMode: "numeric",
    autocomplete: "off",
    "aria-label": "Page",
  }) as HTMLInputElement;

  // The component's own idea of where it is, so the buttons know what ±1 means
  // without the caller wiring two handlers to its private page state.
  let at = 0;
  let of = 0;
  prev.addEventListener("click", () => opts.onGo(at - 1));
  next.addEventListener("click", () => opts.onGo(at + 1));

  /**
   * Paint the field from the component's state — which doubles as the revert, so
   * every way out of an edit that is not a commit ends here.
   *
   * `size` tracks the content because an `<input>` does not size to its value:
   * left at the default it would be twenty characters wide, and pinned at a
   * fixed width a four-digit book would clip. The CSS min-width still holds the
   * slot steady for short counts.
   */
  function render(): void {
    readout.value = of > 0 ? `${at + 1} / ${of}` : "—";
    readout.size = Math.max(1, readout.value.length);
  }

  /**
   * OUT OF RANGE CLAMPS, it does not refuse: `9999` in a 1,700-page document is
   * unambiguous, and the reader's `showPage` clamps anyway while the PDF viewer's
   * `go` silently drops the jump — clamping here is what makes the two agree.
   */
  function commit(): void {
    const typed = parseInt(readout.value, 10);
    if (of > 0 && Number.isFinite(typed)) {
      opts.onGo(Math.max(0, Math.min(of - 1, typed - 1)));
    }
    // AFTER `onGo`, so the field shows where the viewer actually landed rather
    // than what was typed — including when the viewer declined to move at all.
    render();
    readout.blur();
  }

  // Selecting on focus makes typing REPLACE `12 / 1700` instead of landing in the
  // middle of it. The mouseup guard is the standard companion: the browser
  // collapses that selection to the click point on the release that followed the
  // click which caused the focus, so the first click would undo it.
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
      // STOPPED, or the edit is not what gets thrown away: both viewers close on
      // a document-level Escape, so an un-stopped one would take the document
      // with it. Blurring hands the keys back to the page, where a second Escape
      // means what it always did.
      e.stopPropagation();
      render();
      readout.blur();
      return;
    }
    // The toolbar roves on the arrows (`toolbar.ts`), which would leave this
    // field with a caret that cannot move; claiming them outright would instead
    // make it a wall in the middle of the bar's arrow chain. So the caret keeps
    // the key while it has somewhere to go and hands it back at the edges —
    // arrowing off the end of the number rejoins the roving order.
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
      // AN EDIT IN PROGRESS OUTRANKS AN ARRIVING PAINT. `set` is called from the
      // viewer's own render, which lands whenever the raster finishes, so
      // without this guard a reader typing a page number while the previous page
      // is still drawing has the field cleared from under them mid-keystroke —
      // likeliest on exactly the documents where jumping by number is worth
      // doing. Only the PAINT is skipped, never the state: `at`/`of` are updated
      // above, and `commit` and the blur handler render on the way out, so the
      // field cannot be left stale.
      if (document.activeElement !== readout) render();
      live.textContent = of > 0 ? `Page ${at + 1} of ${of}` : "";
      prev.disabled = of <= 0 || at <= 0;
      next.disabled = of <= 0 || at >= of - 1;
    },
  };
}
