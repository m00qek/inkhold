// To-Do's popovers and dialogs: the Move to… and date menus a task's ⋯ leads
// to, the list menu, and the name and delete-list dialogs. Built on the app's
// shared pieces (`.menu__*` popovers, the `confirm` dialog, the rename field);
// what each choice does is the caller's.

import { el } from "../../ui/dom";
import { ICONS, svg, type IconName } from "../../ui/icons";
import { openDialog } from "../../ui/confirm";
import { clearPopover, getPortalRoot, openPopover, placePop, type OpenPopover } from "../../ui/popover";
import { dueFromInput, inputFromDue } from "./todoModel";

const DAY_MS = 86_400_000;
const DIALOG = { dialog: "confirm todo-dialog", body: "confirm__body", actions: "confirm__actions", cancel: "btn", go: "btn" };

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
  /** A name, or null when cancelled (or unchanged from `initial`). */
  askName(title: string, goLabel: string, initial: string): Promise<string | null>;
  /** True when the person confirmed deleting the list and its `tasks` tasks. */
  confirmDeleteList(name: string, tasks: number): Promise<boolean>;
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

  function askName(title: string, goLabel: string, initial: string): Promise<string | null> {
    const input = el("input", { class: "rename__field", type: "text", "aria-label": "Name", maxlength: "60", autocomplete: "off", spellcheck: "false", value: initial }) as HTMLInputElement;
    const { done } = openDialog({
      host: document.body,
      classes: DIALOG,
      goLabel,
      cancelLabel: "Cancel",
      labelledBy: "todo-dialog-title",
      build: (content, { go }) => {
        content.append(el("h2", { id: "todo-dialog-title", text: title }), input);
        const check = () => (go.disabled = input.value.trim() === "" || input.value.trim() === initial);
        input.addEventListener("input", check);
        check();
        input.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (!go.disabled) go.click();
        });
      },
    });
    // The name is what is being asked for: focus it, not Cancel.
    input.focus();
    input.select();
    return done.then((ok) => (ok && input.value.trim() !== "" ? input.value.trim() : null));
  }

  function confirmDeleteList(name: string, tasks: number): Promise<boolean> {
    return openDialog({
      host: document.body,
      classes: { ...DIALOG, go: "btn is-danger" },
      goLabel: "Delete list",
      cancelLabel: "Cancel",
      labelledBy: "todo-dialog-title",
      build: (content) =>
        content.append(
          el("h2", { id: "todo-dialog-title", text: tasks ? `Delete "${name}" and its ${tasks} task${tasks === 1 ? "" : "s"}?` : `Delete "${name}"?` }),
          el("p", { text: tasks ? "They are also removed from the tablet at its next sync. This can't be undone." : "It is also removed from the tablet at its next sync." }),
        ),
    }).done;
  }

  return { pop, close: () => closeOpen(), item, section, fileItem, sep, dateMenu, askName, confirmDeleteList };
}
