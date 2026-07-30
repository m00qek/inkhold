// The app's ONE overflow menu — the "⋯" trigger plus its floating popover.
//
// This is the single component behind every per-item action set: the library
// gallery's grid cards AND its list rows (library.ts), and the recycle bin's
// rows (bin.ts). Before it, the grid card wired its own trigger/popover inline
// while the list and bin carried bare labelled buttons; three surfaces spoke
// three vocabularies. They speak one now, and it is built here exactly once.
//
// It draws entirely from the EXISTING design-system classes — `.card__more` for
// the trigger, `.menu` / `.menu__pop` / `.menu__item` (+ `--lead`, `--danger`)
// for the popover — so nothing visual is invented; this module is only the
// behaviour that binds them: open/close, `aria-expanded`, one menu open at a
// time, outside-click and Escape (which returns focus to the trigger), and
// arrow/Home/End roving between the items. The reader keeps its own export menu
// (a different, page-scoped vocabulary); everything else routes through here.

import { el } from "./dom";
import { ICONS, svg } from "./icons";
import { getPortalRoot, placePop, openPopover, clearPopover, closeOpenPopover, type OpenPopover } from "./popover";

/** The trigger's three filled dots — filled, so it takes no stroke width. */
const MORE_GLYPH =
  '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';

export interface MenuItemSpec {
  /** The visible label. Also the accessible name unless `html` supplies one. */
  label: string;
  /**
   * A LEADING glyph from the shared icon set (`ui/icons.ts`). Rendered before
   * the label as one left cluster (`.menu__item--lead`). The glyph inherits the
   * row's colour, which is what paints a danger item's mark red with its text.
   */
  icon?: keyof typeof ICONS;
  /**
   * Raw inner HTML instead of a plain label — for the Download row's
   * `<span>Download</span><kbd>.pdf</kbd>`, laid out by the item's default
   * space-between. Mutually exclusive with `icon`.
   */
  html?: string;
  /** The ONE red variant — reserved for "Delete permanently", never elsewhere. */
  danger?: boolean;
  /** What the row does. The menu is already closed by the time this runs. */
  onSelect: () => void;
}

/**
 * A titled group of rows. EVERY section carries a `title` — the menu is sectioned
 * and titled by construction (a mono eyebrow `.menu__section`, `--ink-faint`), so
 * a caller cannot render a headerless group. A menu with a downloads group and an
 * actions group is two sections (`DOWNLOAD`, `ACTIONS`); a plain menu is one.
 */
export interface MenuSection {
  /** The non-interactive eyebrow header for this group — e.g. `DOWNLOAD`. */
  title: string;
  /** The rows, top to bottom. `null` entries are skipped (e.g. an absent export
   *  for a file with no page data), so callers can build inline. */
  items: (MenuItemSpec | null)[];
}

/** The one generic section title — a menu that is "just actions" says so. */
export const DEFAULT_SECTION_TITLE = "ACTIONS";

export interface MenuSpec {
  /** Accessible name + tooltip for the ⋯ trigger. NAMES THE ROW it acts on, so a
   *  screen reader meeting a column of "Actions" buttons knows which it is on. */
  triggerLabel: string;
  /** An extra class on the `.menu` wrapper — the gallery card adds `card__menu`
   *  for its absolute-over-the-tile positioning (see 04-library-gallery.css). */
  wrapClass?: string;
  /**
   * The rows as one or more TITLED {@link MenuSection}s. Prefer this whenever a
   * menu has more than one group (Download + Actions). Mutually exclusive with
   * {@link MenuSpec.items}; when both are present, `sections` wins.
   */
  sections?: MenuSection[];
  /**
   * The rows as one flat group — the common single-group menu. Wrapped in ONE
   * section titled {@link MenuSpec.title} (default `ACTIONS`), so even a flat
   * menu renders a header: the "always a title" rule holds for every caller,
   * not just the ones that opt into `sections`.
   */
  items?: (MenuItemSpec | null)[];
  /** The flat group's title, when {@link MenuSpec.items} is used. Defaults to
   *  {@link DEFAULT_SECTION_TITLE} (`ACTIONS`). Ignored when `sections` is given. */
  title?: string;
  /**
   * Render the ⋯ trigger DISABLED — the thing this menu acts on has work in
   * flight, so none of its actions is available until that settles (the recycle
   * bin's rows, while a restore or a purge travels).
   *
   * WHOLE-MENU rather than per item, because that is the shape of the fact: it
   * is the ROW that is busy, not one of its choices. A disabled `<button>` is
   * inert to the pointer and to the keyboard for free, and it stays in place —
   * a control that vanishes while an operation runs teaches nothing about why.
   */
  disabled?: boolean;
}

/** Normalise either spelling to titled sections; empty groups fall away. */
function sectionsOf(spec: MenuSpec): { title: string; items: MenuItemSpec[] }[] {
  const raw =
    spec.sections && spec.sections.length > 0
      ? spec.sections
      : [{ title: spec.title ?? DEFAULT_SECTION_TITLE, items: spec.items ?? [] }];
  return raw
    .map((s) => ({ title: s.title, items: s.items.filter((it): it is MenuItemSpec => it != null) }))
    .filter((s) => s.items.length > 0);
}

/**
 * Close whatever popover is open, if any (the ⋯ menu or the version menu — they
 * share ONE registry now, in `ui/popover.ts`). For a surface about to REPLACE the
 * DOM a menu lives in (the gallery repaints on every navigation and sync bump):
 * without it, the registry would keep pointing at a detached node. Kept exported
 * from here for the callers that already import it; delegates to the shell.
 */
export function closeOpenMenu(): void {
  closeOpenPopover();
}

/**
 * Build a "⋯" overflow menu. Returns the `.menu` wrapper, ready to append; all
 * behaviour is wired internally.
 */
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

  // The item BUTTONS in document order — the roving-tabindex universe, flattened
  // across every section (the headers are non-interactive and never join it).
  const items: HTMLButtonElement[] = [];
  // The popover's children, in order: each section a `.menu__section` header then
  // its rows, sections divided by a `.menu__sep` (the same divider the export
  // menus use). A single-section menu carries its one header and no divider.
  const popChildren: HTMLElement[] = [];
  const sections = sectionsOf(spec);
  sections.forEach((section, s) => {
    if (s > 0) popChildren.push(el("div", { class: "menu__sep", "aria-hidden": "true" }));
    // A non-interactive eyebrow label. `role="presentation"` keeps it out of the
    // menu's semantics — inside a `role="menu"`, only the rows are `menuitem`s.
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

  // `--float` marks THIS (the shared component's) pop as the portaled, viewport-
  // fixed variant — distinct from the reader/spd export menus, which reuse the
  // plain `.menu__pop` (absolute, anchored in-flow) and never portal.
  const pop = el("div", { class: "menu__pop menu__pop--float", role: "menu" }, ...popChildren);
  const menu = el("div", { class: "menu" + (spec.wrapClass ? ` ${spec.wrapClass}` : "") }, trigger, pop);

  // This menu's registration in the shared open-popover registry. A click on the
  // wrapper (its trigger) OR the portaled pop is "inside" and must not dismiss.
  const self: OpenPopover = {
    trigger,
    contains: (t) => menu.contains(t) || pop.contains(t),
    close,
  };

  function isOpen(): boolean {
    return menu.classList.contains("is-open");
  }
  function open(): void {
    // `is-open` stays on the WRAPPER — the trigger's open-state styling
    // (`.card__menu.is-open .card__more`) keys off it, and it survives the portal.
    menu.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
    // Portal + position: move the pop to the body root, reveal it, then anchor it
    // to the trigger's rect. Escapes every ancestor overflow/transform/stacking.
    getPortalRoot().appendChild(pop);
    pop.classList.add("is-open");
    placePop(trigger, pop);
    // Register as THE open popover — this closes any prior one (the ⋯ menu and the
    // version menu are one-at-a-time together now).
    openPopover(self);
  }
  function close(): void {
    menu.classList.remove("is-open");
    trigger.setAttribute("aria-expanded", "false");
    // Return the pop to the wrapper and hide it, so it travels with the menu when
    // the surface repaints (no orphan left in the body root) and re-opens clean.
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
    // A keyboard activation (Enter/Space report `detail === 0`) lands focus on
    // the first item so the popover is operable at once; a mouse click leaves
    // focus on the trigger, and arrow keys still rove (the handler is on the
    // wrapper, which the trigger is inside).
    if (e.detail === 0) items[0]?.focus();
  });

  // Roving arrow/Home/End. Bound to BOTH the trigger and the pop: when open the
  // pop is portaled out of the wrapper, so an item's keydown bubbles to the pop,
  // not the `.menu` — the trigger keeps the closed-state "ArrowDown opens" and the
  // mouse-opened "focus still on trigger" cases; the pop keeps the item roving.
  function onArrowKeys(e: KeyboardEvent): void {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    if (!isOpen()) {
      // Arrow-down on the closed trigger opens it, landing on the first item.
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
