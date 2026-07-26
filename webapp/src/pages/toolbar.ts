// The viewer toolbar, shared across file types — the skeleton every viewer's bar
// is painted from, split out of the reader the same way rail.ts is split out of
// the library: the controls are DATA ({@link ToolbarSpec}), and one painter turns
// them into a semantic `role="toolbar"` with two zones. The reader is its first
// consumer; a `.spd`/`.txt`/image viewer plugs in by handing a different `view`
// array and the SAME `file` array (see `docs/scratch/toolbar.md`).
//
// THE CORE IDEA, AS STRUCTURE. Two `role="group"`s divided by a decorative
// divider: the LEFT/`view` zone is contextual — "how do I look at *this*" — and
// varies per file type; the RIGHT/`file` zone is universal — "what do I do with
// the *file*" — and is the same controls in the same order in every viewer, so
// "how I download" is muscle memory regardless of what is open. The divider is
// what makes the right zone land in a predictable spot however wide the left zone
// grows; it is a CSS rule (`.toolbar__sep`), `aria-hidden`, and never a literal
// `|` glyph — a pipe would be read aloud and would drift with the font.
//
// WHY DATA AND A PAINTER, not a bag of `el()` calls per viewer. The right zone is
// invariant by contract, and a contract a painter enforces cannot be forgotten by
// the next viewer: adding "Move to bin" beside Download is a line in the `file`
// array, and it then appears in the same place in every viewer that shares it. A
// per-viewer hand-built bar is how the universal actions quietly drift apart.
//
// WHAT THIS FILE DOES NOT OWN. The controls' own behaviour — a menu's popup, a
// stepper's `−`/`+` wiring, a toggle's controller — belongs to the consumer, so a
// rich control is handed in pre-built as a {@link ToolbarCustom}. The painter
// only PLACES it, gives the bar its semantics, and runs the roving tabindex over
// every focusable it was told about. It never reaches inside a control.

import { el } from "../ui/dom";

/**
 * A control the painter BUILDS from data — the common case, and the one a new
 * viewer reaches for first. `pressed` present makes it an `aria-pressed` toggle
 * (find, recognised-text); absent leaves it a plain button.
 */
export interface ToolbarButton {
  kind: "button";
  /** Stable handle for {@link Toolbar.control} and for tests. Never shown. */
  key: string;
  /** The accessible name (`aria-label`), and the visible text unless `iconOnly`. */
  label: string;
  /** A full `<svg>…</svg>` leading glyph, or omitted for a text-only control. */
  icon?: string;
  /** Tooltip. Defaults to `label` for an icon-only control, which must carry one. */
  title?: string;
  /**
   * Icon with no visible text — the collapsed end of the width lever the
   * responsive pass will drive (`toolbar.md`: icon+label ⟷ icon-only is a width
   * lever, not a taste). The `aria-label` stays either way, so the control keeps
   * its name when the words are gone.
   */
  iconOnly?: boolean;
  disabled?: boolean;
  /** Present → a toggle; the boolean is the initial `aria-pressed` state. */
  pressed?: boolean;
  onClick?: (btn: HTMLButtonElement) => void;
}

/**
 * A pre-built control the painter only PLACES — a composite the consumer owns and
 * wires (a pager cluster, the zoom slot, a menu trigger + its popup).
 */
export interface ToolbarCustom {
  kind: "custom";
  key: string;
  el: HTMLElement;
  /**
   * The focusable descendants that join the roving tabindex, in tab order. A
   * readout-only cluster (a value with no control of its own) passes `[]`; a
   * single-button control passes `[theButton]`. Defaults to `[]` — a custom
   * control is opaque, so the painter cannot guess what inside it takes focus.
   */
  focus?: HTMLElement[];
}

export type ToolbarControl = ToolbarButton | ToolbarCustom;

/** A leading element (navigation, a title) that sits OUTSIDE the two zones. */
export interface ToolbarLeading {
  el: HTMLElement;
  /** Its focusable descendants, joined to the roving tabindex ahead of the zones. */
  focus?: HTMLElement[];
}

export interface ToolbarSpec {
  /** Names the toolbar landmark — `role="toolbar"` `aria-label`. */
  label: string;
  /** The contextual (left) zone's group label — "how do I look at this". */
  viewLabel: string;
  /** The universal (right) zone's group label — "what do I do with the file". */
  fileLabel: string;
  /** Extra class on the container, for a consumer's own placement (grid, tests). */
  className?: string;
  /**
   * Navigation OUTSIDE the zones — the reader's Back button and its title block.
   * A leading control is still part of the bar's single tab stop: its focusables
   * lead the roving order. The reader's Back is here, not in a zone, because it
   * answers neither "how do I look at this" nor "what do I do with the file".
   */
  leading?: ToolbarLeading[];
  /** Contextual view controls. Varies by file type; painted in the order given. */
  view: ToolbarControl[];
  /** Universal file actions. Invariant across viewers; painted in the order given. */
  file: ToolbarControl[];
}

export interface Toolbar {
  /** The `role="toolbar"` container, mounted by the consumer. */
  el: HTMLElement;
  /**
   * The rendered element for a control `key` — the `<button>` for a `button`, the
   * handed-in `el` for a `custom`. Undefined for an unknown key. A consumer that
   * builds a control declaratively fetches it here to wire or update later.
   */
  control(key: string): HTMLElement | undefined;
}

/** The arrow/Home/End keys the roving tabindex claims. */
const ROVING_KEYS = new Set(["ArrowRight", "ArrowLeft", "Home", "End"]);

export function createToolbar(spec: ToolbarSpec): Toolbar {
  const controls = new Map<string, HTMLElement>();
  /** Every focusable in the bar, in tab order — the roving tabindex's universe. */
  const focusables: HTMLElement[] = [];

  /** Build a declarative control, or place a custom one, recording both. */
  function render(control: ToolbarControl): HTMLElement {
    if (control.kind === "custom") {
      controls.set(control.key, control.el);
      for (const f of control.focus ?? []) focusables.push(f);
      return control.el;
    }
    const btn = el("button", {
      class: "btn",
      type: "button",
      // The accessible name. For an icon+label control the visible text carries
      // it too; the attribute is what an icon-ONLY control has instead of words.
      "aria-label": control.label,
      title: control.title ?? control.label,
      // Icon + label, icon only, or text only. The label is dropped from the
      // markup for `iconOnly`, never from the `aria-label` above.
      ...(control.icon
        ? { html: control.icon + (control.iconOnly ? "" : control.label) }
        : { text: control.label }),
      ...(control.pressed !== undefined ? { "aria-pressed": String(control.pressed) } : {}),
      ...(control.disabled ? { disabled: true } : {}),
    }) as HTMLButtonElement;
    if (control.onClick) {
      const handler = control.onClick;
      btn.addEventListener("click", () => handler(btn));
    }
    controls.set(control.key, btn);
    focusables.push(btn);
    return btn;
  }

  /** A `role="group"` zone. Empty controls still render an (empty) group so the
   *  two-zone shape — and the divider between — is stable across file types. */
  function zone(cls: string, ariaLabel: string, items: ToolbarControl[]): HTMLElement {
    return el(
      "div",
      { class: cls, role: "group", "aria-label": ariaLabel },
      ...items.map(render),
    );
  }

  const root = el("div", {
    class: spec.className ? `toolbar ${spec.className}` : "toolbar",
    role: "toolbar",
    "aria-label": spec.label,
  });

  for (const lead of spec.leading ?? []) {
    root.append(lead.el);
    for (const f of lead.focus ?? []) focusables.push(f);
  }
  // The spacer pushes the two zones to the trailing edge, leaving the leading
  // navigation at the start — the reader's long-standing layout, now named for
  // reuse rather than as `.reader__spacer`.
  root.append(el("span", { class: "toolbar__spacer" }));
  root.append(zone("toolbar__group", spec.viewLabel, spec.view));
  // Decorative only: a CSS divider, hidden from assistive tech, carrying no text.
  // `toolbar.md` is emphatic that this is not an ornament and not a `|` — it is
  // the load-bearing landmark that keeps the universal zone in a predictable spot.
  root.append(el("span", { class: "toolbar__sep", "aria-hidden": "true" }));
  root.append(zone("toolbar__group toolbar__group--file", spec.fileLabel, spec.file));

  // --- roving tabindex ------------------------------------------------------
  //
  // The whole bar is ONE tab stop; arrow keys move between controls inside it.
  // Exactly one focusable holds `tabindex="0"` at a time (the rest are `-1`), so
  // Tab enters the bar once and Shift+Tab leaves it, rather than the user tabbing
  // through a dozen controls to get past the header.
  //
  // The handler STOPS the event once it acts, so a consumer that also listens for
  // arrow keys (the reader pages with them) does not double-handle a keystroke
  // that was moving toolbar focus. It acts only when focus is on one of the
  // bar's own controls — a keystroke in a menu popup or a find field, which are
  // descendants but not registered focusables, is left alone.
  for (const [i, f] of focusables.entries()) f.tabIndex = i === 0 ? 0 : -1;

  /** The focusables that can actually take focus right now (not hidden/disabled). */
  function usable(): HTMLElement[] {
    return focusables.filter((f) => !f.hidden && !(f as HTMLButtonElement).disabled);
  }

  function activate(next: HTMLElement): void {
    for (const f of focusables) f.tabIndex = f === next ? 0 : -1;
    next.focus();
  }

  root.addEventListener("keydown", (e) => {
    if (!ROVING_KEYS.has(e.key)) return;
    const target = e.target as HTMLElement;
    if (!focusables.includes(target)) return; // a popup/field descendant — not ours
    const list = usable();
    const at = list.indexOf(target);
    if (at === -1) return;
    e.preventDefault();
    e.stopPropagation();
    let to = at;
    if (e.key === "ArrowRight") to = (at + 1) % list.length;
    else if (e.key === "ArrowLeft") to = (at - 1 + list.length) % list.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = list.length - 1;
    const next = list[to];
    if (next) activate(next);
  });

  // Roving follows focus: a click (or the consumer calling `.focus()` on a
  // control — the reader focuses Back on open) makes that control the one tab
  // stop, so Tab out and back returns to where the user last was.
  root.addEventListener("focusin", (e) => {
    const target = e.target as HTMLElement;
    if (!focusables.includes(target)) return;
    for (const f of focusables) f.tabIndex = f === target ? 0 : -1;
  });

  return {
    el: root,
    control: (key) => controls.get(key),
  };
}
