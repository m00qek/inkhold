// The To-Do destination: the person's lists and tasks, the same ones the
// tablet's To-Do app syncs. Mounted in the shell's content area like the
// account page; painted by `todoView.ts` from `todoModel.ts`.
//
// Every edit goes to the server, then the page re-reads it: the server owns
// the times and the order the tablet will merge by. A delete waits a few
// seconds behind an Undo first, because once the tablet syncs it is gone there.

import { el } from "../../ui/dom";
import { ICONS, svg } from "../../ui/icons";
import { openDialog } from "../../ui/confirm";
import { field } from "../../ui/form";
import { clearPopover, getPortalRoot, openPopover, placePop, type OpenPopover } from "../../ui/popover";
import type { Api } from "../../api/types";
import type { TodoSnapshot, TodoTask } from "../../api/todoTypes";
import { addTarget, dueFromInput, inputFromDue, sameView, sections, siblings, viewPath, viewTitle, type TodoView } from "./todoModel";
import { addForm, body, header, keysHint, notice, type TodoActions } from "./todoView";

export interface TodoHost {
  api: Api;
  content: HTMLElement;
  gallery: HTMLElement;
  crumbs: HTMLElement;
  sortWrap: HTMLElement;
  segmented: HTMLElement;
  setMode(open: boolean): void;
  toast(message: string): void;
  /** Session expiry and the like; true when the shell took care of it. */
  handled(e: unknown): boolean;
  /** The snapshot changed: the rail's counts and lists repaint. */
  onChanged(): void;
  /** Go to a To-Do view (its `viewPath`). */
  go(viewPath: string): void;
  /** The breadcrumb's "Library". */
  onLeave(): void;
}

export interface TodoPage {
  open(view: TodoView): void;
  close(): void;
  isOpen(): boolean;
  /** The view on screen, or null when closed. */
  view(): TodoView | null;
  /** The last answer, for the rail; null before the first one. */
  snapshot(): TodoSnapshot | null;
  /** Re-reads the server (shell start, tab back in focus). */
  load(): Promise<void>;
  destroy(): void;
}

const UNDO_MS = 6000;
const DIALOG = { dialog: "admin-dialog", body: "admin-dialog__body", actions: "admin-dialog__actions", cancel: "admin-btn", go: "admin-btn admin-btn--go" };

export function createTodoPage(host: TodoHost): TodoPage {
  const root = el("section", { class: "todo", "aria-labelledby": "todo-title", hidden: true });
  host.content.append(root);
  const undoBar = el("div", { class: "todo-undo", role: "status", hidden: true });
  root.append(undoBar);

  let snap: TodoSnapshot | null = null;
  let failed = false;
  let open_ = false;
  let view: TodoView = { kind: "inbox" };
  let selected: string | null = null;
  let editing: string | null = null;
  let busy = false;
  const collapsed = new Set<string>();
  /** A delete waiting out its Undo. */
  let pendingDelete: { task: TodoTask; timer: ReturnType<typeof setTimeout> } | null = null;
  let loadToken = 0;
  /** The view last painted, so a repaint of the same view keeps the add form's draft. */
  let paintedView: TodoView | null = null;

  // ---- server ----

  async function load(): Promise<void> {
    const mine = ++loadToken;
    try {
      const s = await host.api.todo();
      if (mine !== loadToken) return;
      snap = s;
      failed = false;
    } catch (e) {
      if (mine !== loadToken || host.handled(e)) return;
      failed = snap === null;
    }
    host.onChanged();
    if (open_) paint();
  }

  /** One edit: the call, then a fresh read. A failure says so and changes nothing. */
  async function run(what: string, op: () => Promise<unknown>): Promise<boolean> {
    busy = true;
    paint();
    try {
      await op();
      return true;
    } catch (e) {
      if (!host.handled(e)) host.toast(`Couldn't ${what}. Check your connection and try again.`);
      return false;
    } finally {
      busy = false;
      await load();
    }
  }

  function commitDelete(): void {
    const p = pendingDelete;
    if (!p) return;
    clearTimeout(p.timer);
    pendingDelete = null;
    undoBar.hidden = true;
    void run("delete the task", () => host.api.todoDeleteTask(p.task.id));
  }

  // ---- painting ----

  function chrome(mine: boolean): void {
    host.sortWrap.hidden = mine;
    host.segmented.hidden = mine;
    host.setMode(mine);
    if (!mine) return;
    const home = el("button", { type: "button", text: "Library" });
    home.addEventListener("click", () => host.onLeave());
    const todo = el("button", { type: "button", text: "To-Do" });
    todo.addEventListener("click", () => host.go("inbox"));
    host.crumbs.replaceChildren(home, el("span", { class: "crumbs__sep", text: "/" }), todo, el("span", { class: "crumbs__sep", text: "/" }), el("span", { class: "crumbs__here", text: snap ? viewTitle(view, snap.lists) : "" }));
  }

  function paint(): void {
    if (!open_) return;
    chrome(true);
    const keep = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.id : "";
    // A repaint must not wipe what is being typed into the add form.
    const draftTitle = root.querySelector<HTMLInputElement>("#todo-add-title");
    const draftDue = root.querySelector<HTMLInputElement>("#todo-add-due");
    const draft = draftTitle && paintedView && sameView(paintedView, view)
      ? { title: draftTitle.value, due: draftDue?.value ?? "", caret: draftTitle.selectionStart }
      : null;
    const kids: (HTMLElement | null)[] = [];
    if (snap === null) {
      kids.push(failed ? notice("Your to-dos could not be loaded", "Check your connection and try again.", () => void load()) : notice("Loading…", "Reading your to-dos.", null));
    } else if (!snap.enabled) {
      kids.push(notice("To-Do sync is off on this server", "The tablet's to-dos are not kept here. An administrator can turn it on with todo_sync in the server's config.", null));
    } else {
      const now = Date.now();
      const p = {
        snap, view, now, title: viewTitle(view, snap.lists), sections: sections(snap, view, now), collapsed,
        selected, editing, hidden: new Set(pendingDelete ? [pendingDelete.task.id] : []), busy,
      };
      kids.push(header(p, actions), addForm(p, actions), body(p, actions), keysHint());
    }
    root.replaceChildren(...kids.filter((k): k is HTMLElement => k !== null), undoBar);
    paintedView = view;
    if (draft) {
      const t = root.querySelector<HTMLInputElement>("#todo-add-title");
      const d = root.querySelector<HTMLInputElement>("#todo-add-due");
      if (t) {
        t.value = draft.title;
        if (d) d.value = draft.due;
        const go = root.querySelector<HTMLButtonElement>(".todo-add__go");
        if (go) go.disabled = draft.title.trim() === "" || busy;
        if (keep === "todo-add-title" && draft.caret !== null) t.setSelectionRange(draft.caret, draft.caret);
      }
    }
    if (editing) {
      const input = root.querySelector<HTMLInputElement>(`#todo-edit-${CSS.escape(editing)}`);
      input?.focus();
      input?.select();
    } else if (keep) {
      (document.getElementById(keep) ?? null)?.focus();
    } else if (selected) {
      root.querySelector<HTMLElement>(`.todo-row[data-id="${CSS.escape(selected)}"]`)?.focus();
    }
  }

  // ---- popovers and dialogs ----

  function pop(trigger: HTMLElement, items: HTMLElement[]): void {
    const box = el("div", { class: "menu__pop menu__pop--float is-open todo-pop", role: "menu" }, ...items);
    const self: OpenPopover = { trigger, contains: (t) => box.contains(t) || trigger.contains(t), close: () => { box.remove(); clearPopover(self); } };
    getPortalRoot().append(box);
    placePop(trigger, box);
    openPopover(self);
    box.querySelector<HTMLElement>("button, input")?.focus();
    box.addEventListener("click", (e) => e.stopPropagation());
    popClose = self.close;
  }
  let popClose: () => void = () => {};

  function item(label: string, iconName: keyof typeof ICONS, onSelect: () => void): HTMLElement {
    const b = el("button", { class: "menu__item menu__item--lead", type: "button", role: "menuitem" }, el("span", { class: "menu__item-mark", html: svg(ICONS[iconName]) }), el("span", { text: label }));
    b.addEventListener("click", () => { popClose(); onSelect(); });
    return b;
  }

  function askName(title: string, goLabel: string, initial: string): Promise<string | null> {
    const name = field({ id: "todo-name", label: "Name", autofocus: true });
    name.input.value = initial;
    name.input.maxLength = 60;
    const { done } = openDialog({
      host: document.body,
      classes: DIALOG,
      goLabel,
      cancelLabel: "Cancel",
      build: (content, { go }) => {
        content.append(el("h2", { class: "admin-dialog__title", text: title }), name.row);
        const check = () => (go.disabled = name.input.value.trim() === "");
        name.input.addEventListener("input", check);
        check();
        name.input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !go.disabled) { e.preventDefault(); go.click(); } });
      },
    });
    return done.then((ok) => (ok && name.input.value.trim() !== "" ? name.input.value.trim() : null));
  }

  async function newList(then?: (id: string) => Promise<unknown>): Promise<void> {
    const title = await askName("New list", "Create list", "");
    if (!title) return;
    let created = "";
    if (!(await run("create the list", async () => { created = await host.api.todoCreateList(title); }))) return;
    if (then) {
      await run("move the task", () => then(created));
      host.toast(`Created "${title}" and moved the task there.`);
    } else {
      host.toast(`Created "${title}".`);
      host.go(viewPath({ kind: "list", id: created }));
    }
  }

  // ---- actions ----

  const actions: TodoActions = {
    add(title, due) {
      if (!snap) return;
      const target = addTarget(view, Date.now());
      if (!target) return;
      void run("add the task", () => host.api.todoCreateTask({ title: title.trim(), listId: target.listId, due: dueFromInput(due) })).then((ok) => {
        const input = root.querySelector<HTMLInputElement>("#todo-add-title");
        if (!input) return;
        if (ok) {
          input.value = "";
          const go = root.querySelector<HTMLButtonElement>(".todo-add__go");
          if (go) go.disabled = true;
        }
        input.focus();
      });
    },
    toggle(t) {
      const r = root.querySelector(`.todo-row[data-id="${CSS.escape(t.id)}"]`);
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (!t.done && r && !reduce) r.classList.add("is-striking");
      if (selected === t.id) selected = null;
      setTimeout(() => void run(t.done ? "reopen the task" : "complete the task", () => host.api.todoUpdateTask(t.id, { done: !t.done })), !t.done && !reduce ? 420 : 0);
    },
    select(t) {
      selected = t?.id ?? null;
      editing = null;
      paint();
    },
    startRename(t) {
      editing = t.id;
      paint();
    },
    rename(t, title) {
      editing = null;
      const next = title.trim();
      if (next === "" || next === t.title) return paint();
      void run("rename the task", () => host.api.todoUpdateTask(t.id, { title: next }));
    },
    cancelRename() {
      editing = null;
      paint();
    },
    move(t, trigger) {
      if (!snap) return;
      const targets: [string | null, string][] = [[null, "Inbox"], ...snap.lists.map((l): [string, string] => [l.id, l.title])];
      pop(trigger, [
        el("div", { class: "menu__section", role: "presentation", text: "MOVE TO" }),
        ...targets.filter(([id]) => id !== t.listId).map(([id, name]) => item(name, id === null ? "inbox" : "list", () => void run("move the task", () => host.api.todoUpdateTask(t.id, { listId: id })))),
        el("div", { class: "menu__sep", "aria-hidden": "true" }),
        item("New list…", "plus", () => void newList((id) => host.api.todoUpdateTask(t.id, { listId: id }))),
      ]);
    },
    date(t, trigger) {
      const input = el("input", { class: "todo-pop__date", type: "date", "aria-label": "Due date", value: t.due === null ? "" : inputFromDue(t.due) }) as HTMLInputElement;
      input.addEventListener("change", () => {
        const due = dueFromInput(input.value);
        if (due === null) return;
        popClose();
        void run("set the date", () => host.api.todoUpdateTask(t.id, { due }));
      });
      const day = (offset: number) => dueFromInput(inputFromDue(Date.now() + offset * 86_400_000));
      pop(trigger, [
        el("div", { class: "menu__section", role: "presentation", text: "DUE" }),
        input,
        item("Today", "calendar", () => void run("set the date", () => host.api.todoUpdateTask(t.id, { due: day(0) }))),
        item("Tomorrow", "calendar", () => void run("set the date", () => host.api.todoUpdateTask(t.id, { due: day(1) }))),
        ...(t.due !== null ? [item("Remove the date", "trash", () => void run("remove the date", () => host.api.todoUpdateTask(t.id, { due: null })))] : []),
      ]);
    },
    reorder(t, dir) {
      if (!snap) return;
      const sib = siblings(snap, t);
      const i = sib.findIndex((x) => x.id === t.id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= sib.length) return;
      const ids = sib.map((x) => x.id);
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
      void run("reorder", () => host.api.todoReorder(t.listId, ids));
    },
    remove(t) {
      commitDelete(); // one Undo at a time
      selected = null;
      pendingDelete = { task: t, timer: setTimeout(commitDelete, UNDO_MS) };
      const undo = el("button", { type: "button", text: "Undo" });
      undo.addEventListener("click", () => {
        if (!pendingDelete) return;
        clearTimeout(pendingDelete.timer);
        pendingDelete = null;
        undoBar.hidden = true;
        paint();
      });
      undoBar.replaceChildren(el("span", { text: `Deleted "${t.title}". It leaves the tablet at its next sync.` }), undo);
      undoBar.hidden = false;
      paint();
    },
    toggleSection(key) {
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      paint();
    },
    newList: () => void newList(),
    renameList() {
      if (!snap || view.kind !== "list") return;
      const id = view.id;
      const current = snap.lists.find((l) => l.id === id)?.title ?? "";
      void askName("Rename list", "Rename", current).then((title) => {
        if (title && title !== current) void run("rename the list", () => host.api.todoRenameList(id, title));
      });
    },
    deleteList() {
      if (!snap || view.kind !== "list") return;
      const id = view.id;
      const list = snap.lists.find((l) => l.id === id);
      if (!list) return;
      const n = snap.tasks.filter((t) => t.listId === id).length;
      const { done } = openDialog({
        host: document.body,
        classes: { ...DIALOG, go: "admin-btn admin-btn--go admin-btn--danger" },
        goLabel: "Delete list",
        cancelLabel: "Cancel",
        build: (content) => content.append(
          el("h2", { class: "admin-dialog__title", text: n ? `Delete "${list.title}" and its ${n} task${n === 1 ? "" : "s"}?` : `Delete "${list.title}"?` }),
          el("p", { class: "admin-dialog__text", text: "They will also be removed from the tablet at its next sync." }),
        ),
      });
      void done.then(async (ok) => {
        if (!ok) return;
        if (await run("delete the list", () => host.api.todoDeleteList(id))) {
          host.toast(`Deleted "${list.title}".`);
          host.go("all");
        }
      });
    },
    retry: () => void load(),
  };

  // ---- keyboard ----

  function onKey(e: KeyboardEvent): void {
    if (!open_ || e.defaultPrevented || e.metaKey || e.ctrlKey) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, dialog, [contenteditable]")) return;
    if (!snap?.enabled) return;
    const rows = [...root.querySelectorAll<HTMLElement>(".todo-row")].map((r) => r.dataset.id!);
    const task = snap.tasks.find((t) => t.id === selected) ?? null;
    if (e.key === "n" || e.key === "N") { e.preventDefault(); root.querySelector<HTMLInputElement>("#todo-add-title")?.focus(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (e.altKey && task) return actions.reorder(task, e.key === "ArrowUp" ? -1 : 1);
      const i = selected ? rows.indexOf(selected) : -1;
      const j = i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
      selected = rows[j] ?? null;
      return paint();
    }
    if (e.key === "Escape" && selected) { selected = null; return paint(); }
    if (!task) return;
    const btn = (label: string) => root.querySelector<HTMLElement>(`.todo-row[data-id="${CSS.escape(task.id)}"] .todo-act[aria-label="${label}"]`);
    switch (e.key.toLowerCase()) {
      case "x": e.preventDefault(); return actions.toggle(task);
      case "e": e.preventDefault(); return actions.startRename(task);
      case "m": { e.preventDefault(); const b = btn("Move"); if (b) actions.move(task, b); return; }
      case "d": { e.preventDefault(); const b = btn("Date"); if (b) actions.date(task, b); return; }
      case "delete": case "backspace": e.preventDefault(); return actions.remove(task);
    }
  }
  document.addEventListener("keydown", onKey);
  const onVisible = () => { if (document.visibilityState === "visible" && open_) void load(); };
  document.addEventListener("visibilitychange", onVisible);

  return {
    open(next) {
      if (!open_ || !sameView(next, view)) { selected = null; editing = null; }
      view = next;
      if (!open_) {
        open_ = true;
        root.hidden = false;
        host.gallery.hidden = true;
      }
      paint();
      void load();
    },
    close() {
      if (!open_) return;
      commitDelete();
      open_ = false;
      root.hidden = true;
      host.gallery.hidden = false;
      popClose();
      chrome(false);
    },
    isOpen: () => open_,
    view: () => (open_ ? view : null),
    snapshot: () => snap,
    load,
    destroy() {
      commitDelete();
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisible);
      root.remove();
    },
  };
}
