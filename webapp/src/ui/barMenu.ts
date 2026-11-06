// A bar's controls as one "⋯" menu. Where a bar has no room (a phone), its
// controls go behind ⋯; this turns them into menu rows, in the bar's order:
//
// - a divider in the bar (`.tools__sep`, `.toolbar__sep`) or a new group
//   (`role="group"`) starts a new group in the menu, a divider between;
// - a `<select>` becomes its options, the chosen one ticked (Sort);
// - a group of `aria-pressed` buttons becomes those buttons, the pressed one
//   ticked (Grid / List);
// - a button that opens a menu of its own brings that menu's rows in, so
//   there is never a menu inside a menu: rows registered for it with
//   `setMenuRows`, else the rows of its in-page menu (`.menu__pop`);
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
    if (own) return own();
    if (button.getAttribute("aria-haspopup")) {
      const rows = menuRowsOf(button);
      if (rows.length > 0) return rows[0]?.kind === "section" ? rows : [{ kind: "section", title: nameOf(button) }, ...rows];
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

let closeOpen: () => void = () => {};

/** Opens `rows` as a menu under `trigger` (a sheet along the bottom on a phone). */
export function openBarMenu(trigger: HTMLElement, rows: BarRow[]): void {
  closeOpen();
  const items: HTMLButtonElement[] = [];
  const children = rows.map((r) => {
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
      const glyph = r.icon ? `<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${r.icon}</svg>` : "";
      b.append(el("span", { class: "menu__item-mark", html: glyph }));
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
  });
  const box = el("div", { class: "menu__pop menu__pop--float is-open", role: "menu" }, ...children);
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
