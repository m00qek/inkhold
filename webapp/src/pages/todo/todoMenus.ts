// To-Do's popovers: the Move to… and date menus a task's ⋯ leads to. Built on
// the app's shared `.menu__*` popovers; what each choice does is the caller's.
// The list's name and delete dialogs are the apps' shared ones (`ui/nameDialog.ts`).

import { el } from "../../ui/dom";
import { ICONS, svg, type IconName } from "../../ui/icons";
import { clearPopover, getPortalRoot, openPopover, placePop, type OpenPopover } from "../../ui/popover";
import { dueFromInput, inputFromDue } from "./todoModel";

const DAY_MS = 86_400_000;

export interface TodoMenus {
  /** A popover under `trigger`; a menu reached from a task's ⋯ leads with Back to it. */
  pop(trigger: HTMLElement, items: HTMLElement[]): void;
  /** Closes the open popover, if any. */
  close(): void;
  item(label: string, icon: IconName, onSelect: () => void, danger?: boolean): HTMLElement;
  section(title: string): HTMLElement;
  /** A download row, the reader's: the format's name, its extension on the right. */
  fileItem(label: string, ext: string, onSelect: () => void): HTMLElement;
  sep(): HTMLElement;
  /** Today, Tomorrow, a picked day, and "No date" when there is one. */
  dateMenu(trigger: HTMLElement, current: number | null, set: (due: number | null) => void): void;
}

export function createTodoMenus(): TodoMenus {
  let closeOpen: () => void = () => {};

  const sep = () => el("div", { class: "menu__sep", "aria-hidden": "true" });
  const section = (title: string) => el("div", { class: "menu__section", role: "presentation", text: title });

  function item(label: string, icon: IconName, onSelect: () => void, danger = false): HTMLElement {
    const b = el(
      "button",
      { class: "menu__item menu__item--lead" + (danger ? " menu__item--danger" : ""), type: "button", role: "menuitem" },
      el("span", { class: "menu__item-mark", html: svg(ICONS[icon]) }),
      el("span", { text: label }),
    );
    b.addEventListener("click", () => {
      closeOpen();
      onSelect();
    });
    return b;
  }

  function fileItem(label: string, ext: string, onSelect: () => void): HTMLElement {
    const b = el("button", { class: "menu__item", type: "button", role: "menuitem" }, el("span", { text: label }), el("kbd", { text: ext }));
    b.addEventListener("click", () => {
      closeOpen();
      onSelect();
    });
    return b;
  }

  /** Back to the ⋯ menu a submenu came from: the ⋯ trigger, clicked again. */
  function backTo(trigger: HTMLElement): HTMLElement[] {
    if (!trigger.classList.contains("card__more")) return [];
    const b = el(
      "button",
      { class: "menu__item menu__item--lead todo-pop__back", type: "button", role: "menuitem" },
      el("span", { class: "menu__item-mark", html: svg(ICONS.chevron) }),
      el("span", { text: "Back" }),
    );
    b.addEventListener("click", () => {
      closeOpen();
      trigger.click();
    });
    return [b, sep()];
  }

  function pop(trigger: HTMLElement, items: HTMLElement[]): void {
    closeOpen();
    const box = el("div", { class: "menu__pop menu__pop--float is-open todo-pop", role: "menu" }, ...backTo(trigger), ...items);
    const self: OpenPopover = {
      trigger,
      contains: (t) => box.contains(t) || trigger.contains(t),
      pop: box,
      close: () => {
        box.remove();
        clearPopover(self);
        trigger.setAttribute("aria-expanded", "false");
        closeOpen = () => {};
      },
    };
    getPortalRoot().append(box);
    placePop(trigger, box);
    openPopover(self);
    trigger.setAttribute("aria-expanded", "true");
    box.querySelector<HTMLElement>("button, input")?.focus();
    box.addEventListener("click", (e) => e.stopPropagation());
    closeOpen = self.close;
  }

  function dateMenu(trigger: HTMLElement, current: number | null, set: (due: number | null) => void): void {
    const input = el("input", { class: "todo-pop__date", type: "date", "aria-label": "Pick a day", value: current === null ? "" : inputFromDue(current) }) as HTMLInputElement;
    input.addEventListener("change", () => {
      const due = dueFromInput(input.value);
      if (due === null) return;
      closeOpen();
      set(due);
    });
    const day = (offset: number) => dueFromInput(inputFromDue(Date.now() + offset * DAY_MS));
    pop(trigger, [
      section("DUE"),
      item("Today", "calendar", () => set(day(0))),
      item("Tomorrow", "calendar", () => set(day(1))),
      input,
      ...(current !== null ? [sep(), item("No date", "trash", () => set(null))] : []),
    ]);
  }

  return { pop, close: () => closeOpen(), item, section, fileItem, sep, dateMenu };
}
