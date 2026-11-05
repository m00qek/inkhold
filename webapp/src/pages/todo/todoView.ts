// The To-Do page's painter: header, the add form, sections and task rows.
// Knows nothing about the API; every click is a call on `TodoActions`.

import { el } from "../../ui/dom";
import { ICONS, svg, type IconName } from "../../ui/icons";
import { createMenu } from "../../ui/menu";
import type { TodoSnapshot, TodoTask } from "../../api/todoTypes";
import { addTarget, dueLabel, inputFromDue, listName, siblings, type TodoSection, type TodoView } from "./todoModel";

export interface TodoActions {
  add(title: string, due: string): void;
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
  newList(): void;
  renameList(): void;
  deleteList(): void;
  retry(): void;
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
}

const icon = (name: IconName, cls = "todo-ico"): HTMLElement => el("span", { class: cls, "aria-hidden": "true", html: svg(ICONS[name]) });

export function syncLine(snap: TodoSnapshot): HTMLElement {
  const at = snap.tabletSyncedAt;
  const time = at === null ? null : new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const text = snap.waiting
    ? at === null ? "Changes reach the tablet at its next sync." : `Changes reach the tablet at its next sync. Last sync ${time}.`
    : at === null ? "No tablet has synced these to-dos yet." : `On the tablet as of ${time}.`;
  return el("p", { class: "todo-sync" + (snap.waiting ? " is-waiting" : ""), role: "status" }, el("span", { class: "todo-sync__dot", "aria-hidden": "true" }), el("span", { text }));
}

export function header(p: TodoPaint, a: TodoActions): HTMLElement {
  const newList = el("button", { class: "todo-btn", type: "button" }, icon("plus"), el("span", { text: "New list" }));
  newList.addEventListener("click", () => a.newList());
  const more = p.view.kind === "list"
    ? createMenu({
        triggerLabel: `Options for the list ${p.title}`,
        wrapClass: "todo-head__menu",
        title: "LIST",
        items: [
          { label: "Rename list", icon: "edit", onSelect: () => a.renameList() },
          { label: "Delete list", icon: "trash", danger: true, onSelect: () => a.deleteList() },
        ],
      })
    : null;
  return el(
    "header",
    { class: "todo-head" },
    el("div", { class: "todo-head__title" }, el("h1", { id: "todo-title", text: p.title }), more),
    el("div", { class: "todo-head__side" }, syncLine(p.snap), newList),
  );
}

export function addForm(p: TodoPaint, a: TodoActions): HTMLElement | null {
  const target = addTarget(p.view, p.now);
  if (!target) return null;
  const placeholder = p.view.kind === "planned" ? "Add a task for today" : p.view.kind === "list" ? `Add a task to ${p.title}` : "Add a task";
  const title = el("input", { id: "todo-add-title", type: "text", placeholder, "aria-label": "New task", maxlength: "200", autocomplete: "off" }) as HTMLInputElement;
  const due = el("input", { id: "todo-add-due", type: "date", "aria-label": "Due date (optional)", value: target.due === null ? "" : inputFromDue(target.due) }) as HTMLInputElement;
  const add = el("button", { class: "todo-add__go", type: "submit", text: "Add", disabled: true }) as HTMLButtonElement;
  title.addEventListener("input", () => (add.disabled = title.value.trim() === "" || p.busy));
  const form = el("form", { class: "todo-add" }, title, el("label", { class: "todo-add__date" }, icon("calendar"), due), add);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (title.value.trim() !== "") a.add(title.value, due.value);
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
  let shown = 0;
  for (const sec of p.sections) {
    const tasks = sec.tasks.filter((t) => !p.hidden.has(t.id));
    shown += tasks.length;
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
  const open = p.sections.filter((sec) => !sec.collapsedByDefault).reduce((n, sec) => n + sec.tasks.filter((t) => !p.hidden.has(t.id)).length, 0);
  if (open === 0 && (shown === 0 || p.view.kind !== "completed")) {
    const [h, text] = emptyText(p.view);
    parts.unshift(el("div", { class: "todo-empty" }, el("p", { class: "todo-empty__title", text: h }), el("p", { text })));
  }
  return el("div", { class: "todo-body" }, ...parts);
}

function row(t: TodoTask, sec: TodoSection, p: TodoPaint, a: TodoActions): HTMLElement {
  const selected = p.selected === t.id;
  const check = el("button", {
    class: "todo-check",
    type: "button",
    "aria-pressed": String(t.done),
    "aria-label": `${t.done ? "Mark as not done" : "Mark as done"}: ${t.title}`,
    html: svg(ICONS.done),
    disabled: p.busy,
  });
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
    const late = t.due < p.now && dueLabel(t.due, p.now) !== "Today";
    meta.push(el("span", { class: late ? "is-overdue" : "", text: late ? `Overdue, ${dueLabel(t.due, p.now)}` : dueLabel(t.due, p.now) }));
  }
  if (t.done && t.completedAt !== null) {
    const when = dueLabel(t.completedAt, p.now);
    meta.push(el("span", { text: `Done ${when === "Today" || when === "Yesterday" ? when.toLowerCase() : when}` }));
  }
  if (sec.showList) meta.push(el("span", { class: "todo-meta__list", text: listName(p.snap, t.listId) }));
  if (t.linked) meta.push(el("span", { class: "todo-meta__list", text: "From a notebook page" }));
  if (t.waiting) meta.push(el("span", { class: "todo-meta__wait", text: "Waiting for the tablet" }));

  const main = el("div", { class: "todo-row__main" }, title, meta.length ? el("div", { class: "todo-meta" }, ...meta) : null);
  const r = el("div", { class: "todo-row" + (t.done ? " is-done" : "") + (selected ? " is-selected" : ""), role: "listitem", tabindex: "-1", "data-id": t.id }, check, main, selected ? actions(t, p, a) : null);
  r.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".todo-actions, .todo-title-edit")) return;
    a.select(selected ? null : t);
  });
  return r;
}

function actions(t: TodoTask, p: TodoPaint, a: TodoActions): HTMLElement {
  const sib = siblings(p.snap, t);
  const i = sib.findIndex((x) => x.id === t.id);
  const btn = (name: IconName, label: string, key: string | null, run: (b: HTMLElement) => void, opts: { disabled?: boolean; danger?: boolean; iconOnly?: boolean } = {}) => {
    const b = el(
      "button",
      { class: "todo-act" + (opts.danger ? " is-danger" : ""), type: "button", disabled: opts.disabled === true || p.busy, "aria-label": label, title: key ? `${label} (${key})` : label },
      icon(name),
      opts.iconOnly ? null : el("span", { text: label }),
    );
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      run(b);
    });
    return b;
  };
  return el(
    "div",
    { class: "todo-actions", role: "toolbar", "aria-label": `Actions for ${t.title}` },
    btn("edit", "Rename", "E", () => a.startRename(t)),
    btn("move", "Move", "M", (b) => a.move(t, b)),
    btn("calendar", "Date", "D", (b) => a.date(t, b)),
    btn("up", "Move up", "Alt+↑", () => a.reorder(t, -1), { disabled: t.done || i <= 0, iconOnly: true }),
    btn("down", "Move down", "Alt+↓", () => a.reorder(t, 1), { disabled: t.done || i < 0 || i >= sib.length - 1, iconOnly: true }),
    btn("trash", "Delete", "Del", () => a.remove(t), { danger: true }),
  );
}

export function keysHint(): HTMLElement {
  const k = (keys: string[], what: string) => el("span", {}, ...keys.map((x) => el("kbd", { text: x })), ` ${what}`);
  return el("p", { class: "todo-keys", "aria-hidden": "true" }, k(["N"], "new task"), k(["↑", "↓"], "select"), k(["X"], "done"), k(["E"], "rename"), k(["M"], "move"), k(["D"], "date"), k(["Alt", "↑↓"], "reorder"), k(["Del"], "delete"));
}

export function notice(title: string, text: string, retry: (() => void) | null): HTMLElement {
  const b = retry ? el("button", { class: "todo-btn", type: "button", text: "Try again" }) : null;
  b?.addEventListener("click", () => retry!());
  return el("div", { class: "todo-empty" }, el("p", { class: "todo-empty__title", text: title }), el("p", { text }), b);
}
