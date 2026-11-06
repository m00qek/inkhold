// The viewer toolbar painter. Controls are data ({@link ToolbarSpec}); the bar is
// a `role="toolbar"` with a per-file-type `view` zone and a universal `file` zone
// (same controls, same order, in every viewer) split by a CSS divider.

import { el } from "../ui/dom";
import { ICONS, svg } from "../ui/icons";
import { PHONE_QUERY } from "../ui/breakpoints";
import { barMenuOpenFrom, barRows, openBarMenu, rowsOf, type BarRow } from "../ui/barMenu";
import { closeOpenPopover } from "../ui/popover";

/** A control built from data; `pressed` present makes it an `aria-pressed` toggle. */
export interface ToolbarButton {
  kind: "button";
  /** Stable handle for {@link Toolbar.control} and tests. */
  key: string;
  label: string;
  icon?: string;
  title?: string;
  /** Icon with no visible text; the `aria-label` stays. */
  iconOnly?: boolean;
  disabled?: boolean;
  pressed?: boolean;
  /** On a phone, moves from the bar into ⋯ (an occasional tool). */
  fold?: boolean;
  onClick?: (btn: HTMLButtonElement) => void;
}

/** A pre-built control the painter only places. */
export interface ToolbarCustom {
  kind: "custom";
  key: string;
  el: HTMLElement;
  /** Focusables joining the roving tabindex, in order. Defaults to `[]`. */
  focus?: HTMLElement[];
  /** On a phone, moves from the bar into ⋯ (an occasional tool). */
  fold?: boolean;
}

export type ToolbarControl = ToolbarButton | ToolbarCustom;

/** A leading element (Back, title) outside the two zones. */
export interface ToolbarLeading {
  el: HTMLElement;
  focus?: HTMLElement[];
}

export interface ToolbarSpec {
  label: string;
  viewLabel: string;
  fileLabel: string;
  className?: string;
  leading?: ToolbarLeading[];
  view: ToolbarControl[];
  file: ToolbarControl[];
}

export interface Toolbar {
  el: HTMLElement;
  control(key: string): HTMLElement | undefined;
}

const ROVING_KEYS = new Set(["ArrowRight", "ArrowLeft", "Home", "End"]);

export function createToolbar(spec: ToolbarSpec): Toolbar {
  const controls = new Map<string, HTMLElement>();
  /** The view zone's occasional tools, which a phone keeps behind ⋯. */
  const folded: (HTMLElement | null)[] = [];
  const focusables: HTMLElement[] = [];

  function render(control: ToolbarControl): HTMLElement {
    if (control.fold) folded.push(control.kind === "custom" ? control.el : null);
    if (control.kind === "custom") {
      if (control.fold) control.el.dataset["fold"] = "";
      controls.set(control.key, control.el);
      for (const f of control.focus ?? []) focusables.push(f);
      return control.el;
    }
    const btn = el("button", {
      class: "btn",
      type: "button",
      "aria-label": control.label,
      title: control.title ?? control.label,
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
    if (control.fold) {
      btn.dataset["fold"] = "";
      folded[folded.length - 1] = btn;
    }
    controls.set(control.key, btn);
    focusables.push(btn);
    return btn;
  }

  /** An empty zone still renders, so the divider stays put across file types. */
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
  root.append(el("span", { class: "toolbar__spacer" }));
  root.append(zone("toolbar__group", spec.viewLabel, spec.view));
  // Decorative CSS divider, never a `|` glyph (it would be read aloud).
  root.append(el("span", { class: "toolbar__sep", "aria-hidden": "true" }));
  const fileZone = zone("toolbar__group toolbar__group--file", spec.fileLabel, spec.file);
  root.append(fileZone);

  // On a phone the occasional tools (`fold`) and the file's zone go behind
  // ⋯: one menu, a View group then the file's, its own menus' rows brought
  // in (`ui/barMenu.ts`). The bar keeps what reading uses. Wider, no ⋯.
  const more = el("button", {
    class: "btn toolbar__more",
    type: "button",
    "aria-label": "More",
    title: "More",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    hidden: true,
    html: svg(ICONS.more, 1.8),
  }) as HTMLButtonElement;
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    if (barMenuOpenFrom(more)) closeOpenPopover();
    else {
      const view = rowsOf(folded.filter((f): f is HTMLElement => f !== null));
      const file = barRows(fileZone);
      const rows: BarRow[] = [...(view.length > 0 ? [{ kind: "section", title: "View" } as BarRow, ...view] : [])];
      if (rows.length > 0 && file.length > 0) rows.push({ kind: "sep" });
      openBarMenu(more, [...rows, ...file]);
    }
  });
  root.append(more);
  focusables.push(more);
  const phone = window.matchMedia(PHONE_QUERY);
  const fold = () => {
    fileZone.hidden = phone.matches;
    more.hidden = !phone.matches;
  };
  phone.addEventListener("change", fold);
  fold();

  // ---- roving tabindex ----
  // The bar is one tab stop. The handler stops the event once it acts so a
  // consumer's own arrow handling (reader paging) does not double-fire, and it
  // ignores descendants that are not registered focusables (popups, find fields).
  for (const [i, f] of focusables.entries()) f.tabIndex = i === 0 ? 0 : -1;

  function usable(): HTMLElement[] {
    // Not inside a hidden zone either (the file zone, folded on a phone).
    return focusables.filter(
      (f) => !f.hidden && !f.closest("[hidden]") && !(phone.matches && f.closest("[data-fold]")) && !(f as HTMLButtonElement).disabled,
    );
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

  // Roving follows focus, so Tab out and back returns to the last control.
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
