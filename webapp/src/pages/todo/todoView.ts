// The To-Do page's painter: the title, the add form, sections and task rows.
// Knows nothing about the API; every click is a call on `TodoActions`. The
// page-level tools (status, list options, New list) live in the shell's topbar.

import { el } from "../../ui/dom";
import { createMenu, type MenuItemSpec } from "../../ui/menu";
import { appCard, appCards } from "../../ui/appCard";
import { ICONS, svg, type IconName } from "../../ui/icons";
import type { TodoSnapshot, TodoTask } from "../../api/todoTypes";
import { addTarget, cards, dateLine, dueLabel, listName, siblings, summary, viewPath, viewTitle, type TodoSection, type TodoView } from "./todoModel";

export interface TodoActions {
  /** Open another view or list. */
  show(view: TodoView): void;
  renameList(id: string): void;
  deleteList(id: string): void;
  add(title: string): void;
  /** Opens the add form's date menu. */
  addDate(trigger: HTMLElement): void;
  toggle(task: TodoTask): void;
  select(task: TodoTask | null): void;
  startRename(task: TodoTask): void;
  rename(task: TodoTask, title: string): void;
  cancelRename(task: TodoTask): void;
  move(task: TodoTask, trigger: HTMLElement): void;
  date(task: TodoTask, trigger: HTMLElement): void;
  reorder(task: TodoTask, dir: -1 | 1): void;
  /** A press on a task's grip: drag it to a new place in its list. */
  drag(task: TodoTask, row: HTMLElement, e: PointerEvent): void;
  remove(task: TodoTask): void;
  toggleSection(key: string): void;
  openNote(task: TodoTask): void;
}

export interface TodoPaint {
  snap: TodoSnapshot;
  view: TodoView;
  title: string;
  now: number;
  sections: TodoSection[];
  collapsed: ReadonlySet<string>;
  selected: string | null;
  editing: string | null;
  /** Ids hidden while their delete can still be undone. */
  hidden: ReadonlySet<string>;
  busy: boolean;
  /** The date the next added task gets; null: none. */
  addDue: number | null;
  /** A lassoed task's chip: its handwriting, and with `open` the way to its note (`todoInk.ts`). */
  chip(task: TodoTask, open?: () => void): HTMLElement | null;
}

/** Shared by every row's `aria-describedby`: what the keyboard can do. */
const ROW_HELP_ID = "todo-row-help";

const icon = (name: IconName, cls = "todo-ico"): HTMLElement => el("span", { class: cls, "aria-hidden": "true", html: svg(ICONS[name]) });

/**
 * The one sync signal: in the topbar, and only while a change made here waits
 * for the tablet (null otherwise). The last sync's time is in its tooltip.
 */
export function syncText(snap: TodoSnapshot): { short: string; long: string } | null {
  if (!snap.waiting) return null;
  const at = snap.tabletSyncedAt;
  const time = at === null ? null : new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return {
    short: "Waiting for the tablet",
    long: time === null ? "Changes here reach the tablet at its next sync." : `Changes here reach the tablet at its next sync. Its last sync was at ${time}.`,
  };
}

/**
 * The topbar's left side, the reader's title shape: the name of what is open,
 * and under it what the page holds, in the cards' words. No trail: the rail is
 * the way around, and To-Do is not in the library.
 */
export function placeTitle(snap: TodoSnapshot | null, view: TodoView, now: number): HTMLElement {
  const sum = snap?.enabled ? summary(snap, view, now) : null;
  return el(
    "div",
    { class: "todo-place" },
    el("b", { class: "todo-place__name", text: snap ? viewTitle(view, snap.lists) : "To-Do" }),
    el(
      "span",
      { class: "todo-place__sum" },
      sum ? sum.text : "To-Do",
      sum && sum.overdue > 0 ? " · " : null,
      sum && sum.overdue > 0 ? el("span", { class: "is-overdue", text: `${sum.overdue} overdue` }) : null,
    ),
  );
}

/** A list's actions, the same on its card's ⋯ and the top bar's on its page. */
export function listActions(id: string, a: Pick<TodoActions, "renameList" | "deleteList">): MenuItemSpec[] {
  return [
    { label: "Rename list", icon: "edit", onSelect: () => a.renameList(id) },
    { label: "Delete list", icon: "trash", danger: true, onSelect: () => a.deleteList(id) },
  ];
}

/** The landing page: a card per list, saying how much is open and late, with the first few tasks. */
export function overview(p: TodoPaint, a: TodoActions): HTMLElement {
  const items = cards(p.snap, p.now).map((c) => {
    const id = c.view.kind === "list" ? c.view.id : null;
    // Every card has its ⋯, like a note card; the Inbox's is there but disabled,
    // since the tablet's Inbox can't be renamed or deleted.
    const menu = createMenu({
      triggerLabel: id === null ? `${c.name} can't be renamed or deleted` : `Actions for ${c.name}`,
      wrapClass: "card__menu",
      disabled: id === null,
      items: id === null ? [] : listActions(id, a),
    });
    return appCard({
      kind: "todo-card",
      name: c.name,
      icon: c.view.kind === "inbox" ? "inbox" : "list",
      href: `#/todo/${viewPath(c.view)}`,
      onOpen: () => a.show(c.view),
      counts: [
        el("span", { text: c.open === 0 ? "Nothing to do" : `${c.open} to do` }),
        c.overdue > 0 ? el("span", { class: "is-overdue", text: `${c.overdue} overdue` }) : null,
      ],
      peek: c.peek.map((t) => [el("span", { class: "todo-card__task", text: t.title }), p.chip(t)]),
      more: c.open - c.peek.length,
      menu,
    });
  });
  return appCards("Lists", items);
}

export function addForm(p: TodoPaint, a: TodoActions): HTMLElement | null {
  const target = addTarget(p.view, p.now);
  if (!target) return null;
  // Always say where it lands: All and Planned add to the Inbox.
  const placeholder = `Add a task to ${listName(p.snap, target.listId)}`;
  const title = el("input", { id: "todo-add-title", type: "text", placeholder, "aria-label": "New task", maxlength: "200", autocomplete: "off" }) as HTMLInputElement;
  const date = el(
    "button",
    {
      class: "todo-add__date" + (p.addDue !== null ? " is-set" : ""),
      type: "button",
      id: "todo-add-date",
      "aria-haspopup": "menu",
      "aria-label": p.addDue === null ? "Add a due date" : `Due ${dueLabel(p.addDue, p.now)}; change the date`,
      title: p.addDue === null ? "Add a due date" : "Change the date",
    },
    icon("calendar"),
    p.addDue !== null ? el("span", { text: dueLabel(p.addDue, p.now) }) : null,
  );
  date.addEventListener("click", (e) => {
    e.stopPropagation();
    a.addDate(date);
  });
  const add = el("button", { class: "btn todo-add__go", type: "submit", text: "Add", disabled: true }) as HTMLButtonElement;
  title.addEventListener("input", () => (add.disabled = title.value.trim() === "" || p.busy));
  const form = el("form", { class: "todo-add" }, title, date, add);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (title.value.trim() !== "") a.add(title.value);
  });
  return form;
}

function emptyText(v: TodoView): [string, string] {
  switch (v.kind) {
    case "overview": return ["", ""];
    case "inbox": return ["Nothing in the Inbox", "Tasks you add without a list land here, on the tablet too."];
    case "planned": return ["No dates set", "Give a task a date and it shows up here, by when it is due."];
    case "completed": return ["Nothing completed yet", "Tick a task off and it moves here, newest first."];
    case "all": return ["No to-dos yet", "Add one above."];
    case "list": return ["This list is empty", "Add a task above."];
  }
}

export function body(p: TodoPaint, a: TodoActions): HTMLElement {
  const parts: HTMLElement[] = [];
  const visible = (sec: TodoSection) => sec.tasks.filter((t) => !p.hidden.has(t.id));
  for (const sec of p.sections) {
    const tasks = visible(sec);
    if (tasks.length === 0) continue;
    // A list's own rows say which list they are, so a drag can land in another.
    const listAttr = sec.reorderable ? { "data-list": sec.reorderable.listId ?? "" } : {};
    if (sec.label === null) {
      parts.push(el("div", { class: "todo-group", role: "list", ...listAttr }, ...tasks.map((t) => row(t, sec, p, a))));
      continue;
    }
    const folded = p.collapsed.has(sec.key) !== (sec.collapsedByDefault === true);
    const head = el(
      "button",
      { class: "todo-group__head" + (sec.overdue ? " is-overdue" : ""), type: "button", "aria-expanded": String(!folded) },
      icon("chevron", "todo-group__chev"),
      el("span", { text: sec.label }),
      el("span", { class: "todo-group__n", text: String(tasks.length) }),
    );
    head.addEventListener("click", () => a.toggleSection(sec.key));
    parts.push(el("section", { class: "todo-group", "aria-label": sec.label }, head, folded ? null : el("div", { role: "list", ...listAttr }, ...tasks.map((t) => row(t, sec, p, a)))));
  }
  // Empty means nothing open: a folded "Completed" below doesn't count.
  const open = p.sections.filter((sec) => !sec.collapsedByDefault).reduce((n, sec) => n + visible(sec).length, 0);
  if (open === 0) {
    const [h, text] = emptyText(p.view);
    parts.unshift(el("div", { class: "todo-empty" }, el("p", { class: "todo-empty__title", text: h }), el("p", { text })));
  }
  return el("div", { class: "todo-body" }, ...parts);
}

function row(t: TodoTask, sec: TodoSection, p: TodoPaint, a: TodoActions): HTMLElement {
  const selected = p.selected === t.id;
  // A 32px target around the 22px ring the eye sees.
  const check = el(
    "button",
    { class: "todo-check", type: "button", "aria-pressed": String(t.done), "aria-label": `${t.done ? "Mark as not done" : "Mark as done"}: ${t.title}`, disabled: p.busy },
    el("span", { class: "todo-check__ring", "aria-hidden": "true", html: svg(ICONS.tick, 2.4) }),
  );
  check.addEventListener("click", (e) => {
    e.stopPropagation();
    a.toggle(t);
  });

  let title: HTMLElement;
  if (p.editing === t.id) {
    const input = el("input", { class: "todo-title-edit", id: `todo-edit-${t.id}`, type: "text", value: t.title, "aria-label": "Task name", maxlength: "200" }) as HTMLInputElement;
    let settled = false;
    const settle = (save: boolean) => {
      if (settled) return;
      settled = true;
      if (save) a.rename(t, input.value);
      else a.cancelRename(t);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); settle(true); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); settle(false); }
    });
    input.addEventListener("blur", () => settle(true));
    title = input;
  } else {
    title = el("span", { class: "todo-title" }, el("span", { text: t.title }), el("span", { class: "todo-strike", "aria-hidden": "true" }));
  }

  // The note is reached by the chip at the row's edge, so the line under the title doesn't name it.
  const meta = taskMeta(t, p.snap, p.now, { showList: sec.showList, underOverdue: sec.overdue === true, noteShown: true });
  const main = el("div", { class: "todo-row__main" }, title, meta);
  const r = el(
    "div",
    {
      class: "todo-row" + (t.done ? " is-done" : "") + (selected ? " is-selected" : ""),
      role: "listitem",
      tabindex: "0",
      "aria-describedby": ROW_HELP_ID,
      "aria-current": selected ? "true" : null,
      "data-id": t.id,
    },
    check,
    main,
    p.chip(t, () => a.openNote(t)),
    rowMenu(t, sec, p, a),
  );
  // Where the list's own order is on screen, a grip to drag the task by. Move
  // up and down in the ⋯ and Alt+↑/↓ do the same without a pointer.
  if (sec.reorderable !== undefined && !t.done && p.editing !== t.id) {
    const grip = el("span", { class: "todo-grip", "aria-hidden": "true", title: "Drag to reorder", html: svg(ICONS.grip) });
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || p.busy) return;
      e.preventDefault();
      a.drag(t, r, e);
    });
    r.prepend(grip);
  }
  // Clicking a selected row keeps it selected; Escape or a click elsewhere lets go.
  r.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".card__menu, .todo-title-edit, a")) return;
    if (!selected) a.select(t);
  });
  r.addEventListener("keydown", (e) => {
    if (e.target !== r || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    a.select(t);
  });
  return r;
}

/**
 * The line under a task's title: its date (red when late), its list where the
 * view mixes lists, and the notebook it came from (unless a chip already shows it).
 * Shared by the rows and the search results. Null when there is nothing to say.
 */
export function taskMeta(
  t: TodoTask,
  snap: TodoSnapshot,
  now: number,
  opts: { showList: boolean; underOverdue?: boolean; noteShown?: boolean },
): HTMLElement | null {
  const meta: HTMLElement[] = [];
  const date = dateLine(t, now, opts.underOverdue);
  if (date) meta.push(el("span", { class: date.late ? "is-overdue" : "", text: date.text }));
  if (opts.showList) meta.push(el("span", { text: listName(snap, t.listId) }));
  if (t.link) {
    if (!opts.noteShown) meta.push(el("span", { text: `From ${t.link.name}, page ${t.link.page}` }));
  } else if (t.linked) {
    meta.push(el("span", { text: "From a notebook page" }));
  }
  return meta.length ? el("div", { class: "todo-meta" }, ...meta) : null;
}

/**
 * Each task's ⋯, the note cards' menu: everything that can be done to it.
 * Move and Date open their own menus from the same ⋯.
 */
function rowMenu(t: TodoTask, sec: TodoSection, p: TodoPaint, a: TodoActions): HTMLElement {
  const sib = siblings(p.snap, t);
  const i = sib.findIndex((x) => x.id === t.id);
  // Up and down only where the list's own order is what is on screen.
  const ordered = sec.reorderable !== undefined && !t.done;
  // Move to… and the date open from the ⋯ itself, once the menu has closed.
  const wrap: { el: HTMLElement | null } = { el: null };
  const trigger = (): HTMLElement => wrap.el?.querySelector<HTMLElement>(".card__more") ?? wrap.el!;
  wrap.el = createMenu({
    triggerLabel: `Actions for ${t.title}`,
    wrapClass: "card__menu todo-row__menu",
    disabled: p.busy,
    items: [
      { label: "Rename", icon: "edit", onSelect: () => a.startRename(t) },
      { label: "Move to…", icon: "move", onSelect: () => a.move(t, trigger()) },
      { label: t.due === null ? "Add a date…" : "Change the date…", icon: "calendar", onSelect: () => a.date(t, trigger()) },
      ordered && i > 0 ? { label: "Move up", icon: "up", onSelect: () => a.reorder(t, -1) } : null,
      ordered && i >= 0 && i < sib.length - 1 ? { label: "Move down", icon: "down", onSelect: () => a.reorder(t, 1) } : null,
      { label: "Delete", icon: "trash", danger: true, onSelect: () => a.remove(t) },
    ],
  });
  return wrap.el;
}

/** Folded behind its summary: there for whoever wants it, quiet for everyone else. */
export function keysHint(p: TodoPaint): HTMLElement {
  const k = (keys: string[], what: string) => el("li", {}, ...keys.map((x) => el("kbd", { text: x })), el("span", { text: what }));
  const items = [k(["N"], "new task"), k(["↑", "↓"], "select"), k(["X"], "done"), k(["E"], "rename"), k(["M"], "move"), k(["D"], "date")];
  if (p.view.kind !== "planned" && p.view.kind !== "completed") items.push(k(["Alt", "↑↓"], "reorder"));
  items.push(k(["Delete"], "delete"), k(["Esc"], "let go"));
  return el("details", { class: "todo-keys" }, el("summary", { text: "Keyboard shortcuts" }), el("ul", {}, ...items));
}

/** Read out with every row, so the shortcuts are found without the details. */
export function rowHelp(): HTMLElement {
  return el("p", { id: ROW_HELP_ID, class: "todo-sr", text: "Enter selects the task. Then X completes it, E renames, M moves, D sets the date, Delete deletes." });
}

export function notice(title: string, text: string, retry: (() => void) | null): HTMLElement {
  const b = retry ? el("button", { class: "btn", type: "button", text: "Try again" }) : null;
  b?.addEventListener("click", () => retry!());
  return el("div", { class: "todo-empty" }, el("p", { class: "todo-empty__title", text: title }), el("p", { text }), b);
}
