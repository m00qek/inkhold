// The To-Do page's painter: the title, the add form, sections and task rows.
// Knows nothing about the API; every click is a call on `TodoActions`. The
// page-level tools (status, list options, New list) live in the shell's topbar.

import { el } from "../../ui/dom";
import { ICONS, svg, type IconName } from "../../ui/icons";
import type { TodoSnapshot, TodoTask } from "../../api/todoTypes";
import { addTarget, dueLabel, listName, siblings, type TodoSection, type TodoView } from "./todoModel";

export interface TodoActions {
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
}

/** Shared by every row's `aria-describedby`: what the keyboard can do. */
export const ROW_HELP_ID = "todo-row-help";

const icon = (name: IconName, cls = "todo-ico"): HTMLElement => el("span", { class: cls, "aria-hidden": "true", html: svg(ICONS[name]) });

/** The topbar status line's words. */
export function syncText(snap: TodoSnapshot): string {
  const at = snap.tabletSyncedAt;
  const time = at === null ? null : new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (snap.waiting) return "Changes reach the tablet at its next sync";
  return at === null ? "No tablet has synced these yet" : `On the tablet as of ${time}`;
}

export function header(p: TodoPaint): HTMLElement {
  return el("header", { class: "todo-head" }, el("h1", { id: "todo-title", text: p.title }));
}

export function addForm(p: TodoPaint, a: TodoActions): HTMLElement | null {
  if (!addTarget(p.view, p.now)) return null;
  const placeholder = p.view.kind === "list" ? `Add a task to ${p.title}` : "Add a task";
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
    case "inbox": return ["Nothing in the Inbox", "Tasks you add without a list land here, on the tablet too."];
    case "planned": return ["No dates set", "Give a task a date and it shows up here, by when it is due."];
    case "completed": return ["Nothing completed yet", "Tick a task off and it moves here, newest first."];
    case "all": return ["No to-dos yet", "Add one above. It reaches the tablet at its next sync."];
    case "list": return ["This list is empty", "Add a task above. It reaches the tablet at its next sync."];
  }
}

export function body(p: TodoPaint, a: TodoActions): HTMLElement {
  const parts: HTMLElement[] = [];
  const visible = (sec: TodoSection) => sec.tasks.filter((t) => !p.hidden.has(t.id));
  for (const sec of p.sections) {
    const tasks = visible(sec);
    if (tasks.length === 0) continue;
    if (sec.label === null) {
      parts.push(el("div", { class: "todo-group", role: "list" }, ...tasks.map((t) => row(t, sec, p, a))));
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
    parts.push(el("section", { class: "todo-group", "aria-label": sec.label }, head, folded ? null : el("div", { role: "list" }, ...tasks.map((t) => row(t, sec, p, a)))));
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

  const meta: HTMLElement[] = [];
  if (t.due !== null && !t.done) {
    const label = dueLabel(t.due, p.now);
    const late = t.due < p.now && label !== "Today";
    // Under the "Overdue" heading the word is said once, by the heading.
    meta.push(el("span", { class: late ? "is-overdue" : "", text: late && !sec.overdue ? `Overdue, ${label}` : label }));
  }
  if (t.done && t.completedAt !== null) {
    const when = dueLabel(t.completedAt, p.now);
    meta.push(el("span", { text: `Done ${when === "Today" || when === "Yesterday" ? when.toLowerCase() : when}` }));
  }
  if (sec.showList) meta.push(el("span", { text: listName(p.snap, t.listId) }));
  if (t.link) {
    const link = el("a", { class: "todo-meta__note", href: "#", text: `From ${t.link.name}, page ${t.link.page}` });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      a.openNote(t);
    });
    meta.push(link);
  } else if (t.linked) {
    meta.push(el("span", { text: "From a notebook page" }));
  }
  if (t.waiting) meta.push(el("span", { class: "todo-meta__wait", text: "Waiting for the tablet" }));

  const main = el("div", { class: "todo-row__main" }, title, meta.length ? el("div", { class: "todo-meta" }, ...meta) : null);
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
    selected ? actions(t, sec, p, a) : null,
  );
  // Clicking a selected row keeps it selected; Escape or a click elsewhere lets go.
  r.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".todo-actions, .todo-title-edit, a")) return;
    if (!selected) a.select(t);
  });
  r.addEventListener("keydown", (e) => {
    if (e.target !== r || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    a.select(t);
  });
  return r;
}

function actions(t: TodoTask, sec: TodoSection, p: TodoPaint, a: TodoActions): HTMLElement {
  const sib = siblings(p.snap, t);
  const i = sib.findIndex((x) => x.id === t.id);
  const btn = (name: IconName, label: string, key: string, run: (b: HTMLElement) => void, opts: { disabled?: boolean; danger?: boolean; iconOnly?: boolean } = {}) => {
    const b = el(
      "button",
      { class: "todo-act" + (opts.danger ? " is-danger" : ""), type: "button", disabled: opts.disabled === true || p.busy, "aria-label": label, title: `${label} (${key})` },
      icon(name),
      opts.iconOnly ? null : el("span", { text: label }),
    );
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      run(b);
    });
    return b;
  };
  // Up and down only where the list's own order is what is on screen.
  const ordered = sec.reorderable !== undefined && !t.done;
  return el(
    "div",
    { class: "todo-actions", role: "toolbar", "aria-label": `Actions for ${t.title}` },
    btn("edit", "Rename", "E", () => a.startRename(t)),
    btn("move", "Move", "M", (b) => a.move(t, b)),
    btn("calendar", "Date", "D", (b) => a.date(t, b)),
    ordered ? btn("up", "Move up", "Alt+↑", () => a.reorder(t, -1), { disabled: i <= 0, iconOnly: true }) : null,
    ordered ? btn("down", "Move down", "Alt+↓", () => a.reorder(t, 1), { disabled: i < 0 || i >= sib.length - 1, iconOnly: true }) : null,
    btn("trash", "Delete", "Delete", () => a.remove(t), { danger: true }),
  );
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
