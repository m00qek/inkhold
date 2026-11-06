// A bar's controls as one "⋯" menu. Where a bar has no room (a phone), its
// controls go behind ⋯; this turns them into menu rows, in the bar's order:
//
// - a divider in the bar (`.tools__sep`, `.toolbar__sep`) or a new group
//   (`role="group"`) starts a new group in the menu, a divider between;
// - a `<select>` becomes its options, the chosen one ticked (Sort);
// - a group of `aria-pressed` buttons becomes those buttons, the pressed one
//   ticked (Grid / List);
// - a button that opens a menu of its own brings that menu's rows in: rows
//   registered for it with `setMenuRows`, else the rows of its in-page menu
//   (`.menu__pop`). A short menu joins this one; a long one (more than
//   {@link SUBMENU_AT} items, a viewer's Download) is one row that opens its
//   rows in the same sheet, a row back at their top;
// - any other button is a row with its icon and its name.
//
// A row only forwards to its control (a click, or a `change` on a select), so
// what the control does stays the control's.

import { el } from "./dom";
import { ICONS, svg } from "./icons";
import { clearPopover, getPortalRoot, openPopover, placePop, type OpenPopover } from "./popover";

export type BarRow =
  | { kind: "section"; title: string }
  | { kind: "sep" }
  /** A long menu of its own, opened in place of this one. */
  | { kind: "sub"; label: string; icon?: string; rows: BarRow[] }
  | {
      kind: "item";
      label: string;
      /** Inner SVG markup for the leading glyph. */
      icon?: string;
      /** Right-aligned detail, e.g. a file extension. */
      ext?: string;
      danger?: boolean;
      disabled?: boolean;
      /** A choice: ticked when true (`menuitemradio`). */
      checked?: boolean;
      /** With `checked`: an on/off of its own (`menuitemcheckbox`), not one of a set. */
      toggle?: boolean;
      onSelect(): void;
    };

/** A menu of more items than this is a row of its own, not joined in. */
export const SUBMENU_AT = 4;

/** A menu button's rows, joined in when short, behind one row when long. */
function menuOf(button: HTMLElement, rows: BarRow[]): BarRow[] {
  if (rows.filter((r) => r.kind === "item").length > SUBMENU_AT) {
    return [{ kind: "sub", label: nameOf(button), icon: iconOf(button), rows }];
  }
  return rows[0]?.kind === "section" ? rows : [{ kind: "section", title: nameOf(button) }, ...rows];
}

const provided = new WeakMap<HTMLElement, () => BarRow[]>();

/** The rows a menu button stands for when its bar folds into ⋯. */
export function setMenuRows(button: HTMLElement, rows: () => BarRow[]): void {
  provided.set(button, rows);
}

const shown = (e: Element): boolean => e instanceof HTMLElement && !e.hidden;

/** Words for a control: its short label, else its accessible name (not its
 *  tooltip, which may carry a shortcut: "Find in this file (Ctrl+F)"). */
function nameOf(b: HTMLElement): string {
  const label = b.querySelector(".topbar__action-label, .segmented__label, .btn__label, span:not([class*='mark']):not(:empty)");
  return (label?.textContent || b.getAttribute("aria-label") || b.textContent || b.getAttribute("title") || "").trim();
}
function iconOf(b: HTMLElement): string | undefined {
  return b.querySelector("svg")?.innerHTML;
}

/** Rows of an in-page menu (`.menu__pop` beside its trigger), in order. */
function menuRowsOf(button: HTMLElement): BarRow[] {
  const pop = button.closest(".menu")?.querySelector(".menu__pop");
  if (!pop) return [];
  const rows: BarRow[] = [];
  for (const n of pop.querySelectorAll<HTMLElement>(".menu__head, .menu__section, .menu__sep, .menu__item")) {
    if (n.hidden) continue;
    if (n.matches(".menu__sep")) rows.push({ kind: "sep" });
    else if (!n.matches(".menu__item")) rows.push({ kind: "section", title: (n.textContent ?? "").trim() });
    else {
      const kbd = n.querySelector("kbd");
      const words = Array.from(n.querySelectorAll(":scope > span")).map((s) => s.textContent ?? "").join(" ").trim();
      rows.push({
        kind: "item",
        label: words || (n.textContent ?? "").replace(kbd?.textContent ?? "", "").trim(),
        icon: n.querySelector(".menu__item-mark svg")?.innerHTML,
        ext: kbd?.textContent ?? undefined,
        danger: n.classList.contains("menu__item--danger"),
        disabled: (n as HTMLButtonElement).disabled,
        onSelect: () => n.click(),
      });
    }
  }
  return rows;
}

function rowsOfControl(c: HTMLElement): BarRow[] {
  if (!shown(c) || c.getAttribute("role") === "status") return [];
  const select = c.matches("select") ? (c as HTMLSelectElement) : c.querySelector("select");
  if (select) {
    const title = (select.getAttribute("aria-label") ?? "").replace(/\s+\w+$/, "") || "Choose";
    return [
      { kind: "section", title },
      ...Array.from(select.options).map<BarRow>((o) => ({
        kind: "item",
        label: o.text,
        checked: o.selected,
        onSelect: () => {
          select.value = o.value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        },
      })),
    ];
  }
  const pressed = Array.from(c.querySelectorAll<HTMLElement>("button[aria-pressed]"));
  if (c.getAttribute("role") === "group" && pressed.length > 1 && pressed.length === c.querySelectorAll("button").length) {
    return [
      { kind: "section", title: c.getAttribute("aria-label") ?? "View" },
      ...pressed.filter(shown).map<BarRow>((b) => ({
        kind: "item",
        label: nameOf(b),
        icon: iconOf(b),
        checked: b.getAttribute("aria-pressed") === "true",
        onSelect: () => b.click(),
      })),
    ];
  }
  // A download is a link (`<a download>`); it reads as a row like a button.
  const button = c.matches("button, a[href]") ? c : c.matches(".menu") ? c.querySelector<HTMLElement>(":scope > button") : null;
  if (button) {
    if (!shown(button)) return [];
    const own = provided.get(button);
    if (own) {
      const rows = own();
      return rows.filter((r) => r.kind === "item").length > SUBMENU_AT ? menuOf(button, rows) : rows;
    }
    if (button.getAttribute("aria-haspopup")) {
      const rows = menuRowsOf(button);
      if (rows.length > 0) return menuOf(button, rows);
    }
    // A tool that can't act here (greyed on a bar, to keep its place) has no
    // place in a menu.
    if ((button as HTMLButtonElement).disabled) return [];
    const pressed = button.getAttribute("aria-pressed");
    return [
      {
        kind: "item",
        label: nameOf(button),
        icon: iconOf(button),
        danger: button.classList.contains("is-danger"),
        // A panel or mode switch: ticked while on.
        ...(pressed !== null ? { checked: pressed === "true", toggle: true } : {}),
        onSelect: () => button.click(),
      },
    ];
  }
  // A container of controls (a toolbar group, a wrapper): its children.
  return Array.from(c.children).flatMap((k) => (k instanceof HTMLElement ? rowsOfControl(k) : []));
}

/** A bar's visible controls as menu rows; groups split at its dividers. */
export function barRows(bar: HTMLElement): BarRow[] {
  return rowsOf(Array.from(bar.children));
}

/** `barRows` over a chosen list of a bar's controls, in that order. */
export function rowsOf(controls: Element[]): BarRow[] {
  const groups: BarRow[][] = [[]];
  for (const c of controls) {
    if (!(c instanceof HTMLElement)) continue;
    if (c.matches(".tools__sep, .toolbar__sep")) {
      groups.push([]);
      continue;
    }
    const rows = rowsOfControl(c);
    if (rows.length === 0) continue;
    // A choice (it opens with its section) or a whole group stands apart.
    if (rows[0]?.kind === "section" || c.getAttribute("role") === "group") groups.push(rows, []);
    else groups[groups.length - 1]!.push(...rows);
  }
  return groups.filter((g) => g.length > 0).flatMap((g, i) => (i === 0 ? g : [{ kind: "sep" } as BarRow, ...g]));
}

/**
 * One row per action: a bar can offer one twice (Version history on the bar
 * and in a bin file's own menu), which folded together reads as clutter. The
 * first stays; a section or divider left with nothing under it goes too.
 *
 * A name alone is not an action: "PDF document" under "This page — current
 * view" and under "Original view" are two files. So a row repeats only one
 * of the same name in the same section, or one outside any section (the
 * file's own action, which a section's copy of it adds nothing to).
 */
export function onceEach(rows: BarRow[]): BarRow[] {
  const plain = new Set<string>();
  const inSection = new Set<string>();
  let section: string | null = null;
  const kept = rows.filter((r) => {
    if (r.kind === "section") section = r.title;
    if (r.kind === "sep") section = null;
    if (r.kind !== "item" || r.checked !== undefined) return true;
    const key = `${section ?? ""}\u0000${r.label}`;
    if (plain.has(r.label) || inSection.has(key)) return false;
    if (section === null) plain.add(r.label);
    inSection.add(key);
    return true;
  });
  // A heading with no rows under it, then dividers doubled up or at an end.
  const headed = kept.filter((r, i) => r.kind !== "section" || (kept[i + 1] !== undefined && kept[i + 1]!.kind !== "sep" && kept[i + 1]!.kind !== "section"));
  return headed.filter((r, i, all) => r.kind !== "sep" || (i > 0 && i < all.length - 1 && all[i + 1]!.kind !== "sep"));
}

let closeOpen: () => void = () => {};

/** Opens `rows` as a menu under `trigger` (a sheet along the bottom on a phone). */
export function openBarMenu(trigger: HTMLElement, rows: BarRow[]): void {
  closeOpen();
  let items: HTMLButtonElement[] = [];
  const box = el("div", { class: "menu__pop menu__pop--float is-open", role: "menu" });

  const glyphOf = (icon: string): string =>
    `<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>`;

  /** A row that moves within the sheet: into a long menu, or back out of it. */
  function stepRow(label: string, icon: string | undefined, into: boolean, go: () => void): HTMLButtonElement {
    const b = el("button", {
      class: "menu__item menu__item--lead" + (into ? "" : " menu__item--back"),
      type: "button",
      role: "menuitem",
      ...(into ? { "aria-haspopup": "menu" } : {}),
    }) as HTMLButtonElement;
    b.append(el("span", { class: "menu__item-mark", html: into ? (icon ? glyphOf(icon) : "") : svg(ICONS.chevronLeft, 1.8) }));
    b.append(el("span", { text: label }));
    if (into) b.append(el("span", { class: "menu__item-check", html: svg(ICONS.chevronRight, 1.8) }));
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      go();
    });
    return b;
  }

  /** Fill the sheet with `list`; inside a long menu, a row back to `parent` first. */
  function fill(list: BarRow[], parent?: { label: string; rows: BarRow[] }): void {
    items = [];
    const nodes: HTMLElement[] = [];
    if (parent) {
      const back = stepRow(parent.label, undefined, false, () => fill(parent.rows));
      items.push(back);
      nodes.push(back, el("div", { class: "menu__sep", "aria-hidden": "true" }));
    }
    for (const r of list) {
      if (r.kind === "sub") {
        const b = stepRow(r.label, r.icon, true, () => fill(r.rows, { label: r.label, rows: list }));
        items.push(b);
        nodes.push(b);
        continue;
      }
      nodes.push(rowEl(r));
    }
    box.replaceChildren(...nodes);
    items.find((i) => !i.disabled)?.focus();
  }

  function rowEl(r: Exclude<BarRow, { kind: "sub" }>): HTMLElement {
    if (r.kind === "sep") return el("div", { class: "menu__sep", "aria-hidden": "true" });
    if (r.kind === "section") return el("div", { class: "menu__section", role: "presentation", text: r.title });
    const choice = r.checked !== undefined;
    const b = el("button", {
      class: "menu__item" + (r.icon || choice ? " menu__item--lead" : "") + (r.danger ? " menu__item--danger" : ""),
      type: "button",
      role: choice ? (r.toggle ? "menuitemcheckbox" : "menuitemradio") : "menuitem",
      ...(choice ? { "aria-checked": String(r.checked) } : {}),
      ...(r.disabled ? { disabled: true } : {}),
    }) as HTMLButtonElement;
    if (r.icon || choice) {
      // A choice without an icon keeps the column, so its words line up.
      b.append(el("span", { class: "menu__item-mark", html: r.icon ? glyphOf(r.icon) : "" }));
    }
    b.append(el("span", { text: r.label }));
    if (r.ext) b.append(el("kbd", { text: r.ext }));
    // The chosen one: a tick at the row's end (`aria-checked` says it too).
    if (r.checked) b.append(el("span", { class: "menu__item-check", html: svg(ICONS.tick, 2) }));
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      close();
      r.onSelect();
    });
    items.push(b);
    return b;
  }

  const self: OpenPopover = {
    trigger,
    contains: (t) => box.contains(t) || trigger.contains(t),
    close,
    pop: box,
  };
  function close(): void {
    box.remove();
    clearPopover(self);
    trigger.setAttribute("aria-expanded", "false");
    closeOpen = () => {};
  }
  box.addEventListener("keydown", (e) => {
    const usable = items.filter((i) => !i.disabled);
    if (usable.length === 0) return;
    const at = usable.indexOf(document.activeElement as HTMLButtonElement);
    let to: number;
    if (e.key === "ArrowDown") to = (at + 1) % usable.length;
    else if (e.key === "ArrowUp") to = at <= 0 ? usable.length - 1 : at - 1;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = usable.length - 1;
    else return;
    e.preventDefault();
    usable[to]?.focus();
  });
  getPortalRoot().append(box);
  fill(onceEach(rows));
  placePop(trigger, box);
  openPopover(self);
  trigger.setAttribute("aria-expanded", "true");
  items.find((i) => !i.disabled)?.focus();
  closeOpen = close;
}

/** Whether the menu from `trigger` is open (a second press closes it). */
export function barMenuOpenFrom(trigger: HTMLElement): boolean {
  return trigger.getAttribute("aria-expanded") === "true";
}
