// The shared "⋯" overflow menu (trigger + floating popover) behind every
// per-item action set: gallery cards and rows, and bin rows. Behaviour only;
// the look is the existing `.card__more` / `.menu*` classes.

import { el } from "./dom";
import { ICONS, svg } from "./icons";
import { getPortalRoot, placePop, openPopover, clearPopover, closeOpenPopover, type OpenPopover } from "./popover";

const MORE_GLYPH =
  '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';

export interface MenuItemSpec {
  label: string;
  /** A leading glyph; it inherits the row colour (red on a danger item). */
  icon?: keyof typeof ICONS;
  /** Raw inner HTML instead of a label (e.g. `<span>Download</span><kbd>.pdf</kbd>`). Excludes `icon`. */
  html?: string;
  /** Reserved for "Delete permanently". */
  danger?: boolean;
  /** The menu is already closed when this runs. */
  onSelect: () => void;
}

/** A titled group of rows; every section has a title by construction. */
export interface MenuSection {
  title: string;
  /** `null` entries are skipped so callers can build inline. */
  items: (MenuItemSpec | null)[];
}

export const DEFAULT_SECTION_TITLE = "ACTIONS";

export interface MenuSpec {
  /** Accessible name of the ⋯ trigger; names the row it acts on. */
  triggerLabel: string;
  wrapClass?: string;
  /** Titled groups; wins over `items` when both are given. */
  sections?: MenuSection[];
  /** One flat group, wrapped in a section titled `title` (default `ACTIONS`). */
  items?: (MenuItemSpec | null)[];
  title?: string;
  /** Disable the whole trigger while the row has work in flight. */
  disabled?: boolean;
}

function sectionsOf(spec: MenuSpec): { title: string; items: MenuItemSpec[] }[] {
  const raw =
    spec.sections && spec.sections.length > 0
      ? spec.sections
      : [{ title: spec.title ?? DEFAULT_SECTION_TITLE, items: spec.items ?? [] }];
  return raw
    .map((s) => ({ title: s.title, items: s.items.filter((it): it is MenuItemSpec => it != null) }))
    .filter((s) => s.items.length > 0);
}

/** Close any open popover; delegates to the shared `ui/popover.ts` registry. */
export function closeOpenMenu(): void {
  closeOpenPopover();
}

export function createMenu(spec: MenuSpec): HTMLElement {
  const trigger = el("button", {
    class: "card__more",
    type: "button",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    "aria-label": spec.triggerLabel,
    title: spec.triggerLabel,
    html: MORE_GLYPH,
  }) as HTMLButtonElement;
  trigger.disabled = spec.disabled === true;

  const items: HTMLButtonElement[] = [];
  const popChildren: HTMLElement[] = [];
  const sections = sectionsOf(spec);
  sections.forEach((section, s) => {
    if (s > 0) popChildren.push(el("div", { class: "menu__sep", "aria-hidden": "true" }));
    popChildren.push(el("div", { class: "menu__section", role: "presentation", text: section.title }));
    for (const it of section.items) {
      const cls =
        "menu__item" + (it.icon ? " menu__item--lead" : "") + (it.danger ? " menu__item--danger" : "");
      const btn = el("button", { class: cls, type: "button", role: "menuitem" }) as HTMLButtonElement;
      if (it.icon) {
        btn.append(
          el("span", { class: "menu__item-mark", html: svg(ICONS[it.icon]) }),
          el("span", { text: it.label }),
        );
      } else if (it.html) {
        btn.innerHTML = it.html;
      } else {
        btn.textContent = it.label;
      }
      const run = it.onSelect;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        close();
        run();
      });
      items.push(btn);
      popChildren.push(btn);
    }
  });

  // `--float` is the portaled, viewport-fixed variant; the reader's export menus
  // use plain in-flow `.menu__pop`.
  const pop = el("div", { class: "menu__pop menu__pop--float", role: "menu" }, ...popChildren);
  const menu = el("div", { class: "menu" + (spec.wrapClass ? ` ${spec.wrapClass}` : "") }, trigger, pop);

  const self: OpenPopover = {
    trigger,
    contains: (t) => menu.contains(t) || pop.contains(t),
    close,
    pop,
  };

  function isOpen(): boolean {
    return menu.classList.contains("is-open");
  }
  function open(): void {
    // `is-open` stays on the wrapper so trigger styling survives the portal.
    menu.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
    getPortalRoot().appendChild(pop);
    pop.classList.add("is-open");
    placePop(trigger, pop);
    openPopover(self);
  }
  function close(): void {
    menu.classList.remove("is-open");
    trigger.setAttribute("aria-expanded", "false");
    // Return the pop to the wrapper so a repaint leaves no orphan in the portal.
    pop.classList.remove("is-open");
    pop.style.left = "";
    pop.style.top = "";
    menu.appendChild(pop);
    clearPopover(self);
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation(); // don't let the document handler close what we just opened
    if (isOpen()) {
      close();
      return;
    }
    open();
    // Keyboard activation (`detail === 0`) focuses the first item.
    if (e.detail === 0) items[0]?.focus();
  });

  // Bound to both trigger and pop, since the open pop is portaled out of the wrapper.
  function onArrowKeys(e: KeyboardEvent): void {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    if (!isOpen()) {

      if (e.key === "ArrowDown" && document.activeElement === trigger) {
        e.preventDefault();
        open();
        items[0]?.focus();
      }
      return;
    }
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    let to: number;
    if (e.key === "ArrowDown") to = at < 0 ? 0 : (at + 1) % items.length;
    else if (e.key === "ArrowUp") to = at <= 0 ? items.length - 1 : at - 1;
    else if (e.key === "Home") to = 0;
    else to = items.length - 1;
    e.preventDefault();
    items[to]?.focus();
  }
  trigger.addEventListener("keydown", onArrowKeys);
  pop.addEventListener("keydown", onArrowKeys);

  return menu;
}
