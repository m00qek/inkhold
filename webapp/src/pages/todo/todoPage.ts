// The To-Do destination: the person's lists and tasks, the same ones the
// tablet's To-Do app syncs. Mounted in the shell's content area like the
// account page; painted by `todoView.ts` from `todoModel.ts`. Its page-level
// tools (sync status, list options, New list) are the shell topbar's.
//
// Every edit goes to the server, then the page re-reads it: the server owns
// the times and the order the tablet will merge by. A delete waits a few
// seconds behind an Undo first, because once the tablet syncs it is gone there.

import { el } from "../../ui/dom";
import { ICONS, svg, type IconName } from "../../ui/icons";
import { openDialog } from "../../ui/confirm";
import { clearPopover, getPortalRoot, openPopover, placePop, type OpenPopover } from "../../ui/popover";
import type { Api } from "../../api/types";
import type { TodoSnapshot, TodoTask } from "../../api/todoTypes";
import { addTarget, dueFromInput, inputFromDue, sameView, sections, siblings, viewPath, viewTitle, type TodoView } from "./todoModel";
import { addForm, body, header, keysHint, notice, rowHelp, syncText, type TodoActions, type TodoPaint } from "./todoView";

export interface TodoHost {
  api: Api;
  content: HTMLElement;
  gallery: HTMLElement;
  crumbs: HTMLElement;
  sortWrap: HTMLElement;
  segmented: HTMLElement;
  /** The topbar's sync status line. */
  status: HTMLElement;
  /** The topbar's list options button (a list's view only). */
  listBtn: HTMLButtonElement;
  /** The topbar's New list button. */
  newListBtn: HTMLButtonElement;
  setMode(open: boolean): void;
  toast(message: string): void;
  /** Session expiry and the like; true when the shell took care of it. */
  handled(e: unknown): boolean;
  /** The snapshot changed: the rail's counts and lists repaint. */
  onChanged(): void;
  /** Go to a To-Do view (its `viewPath`). */
  go(viewPath: string): void;
  /** Open a notebook at a page (0-based). */
  openNote(id: string, page: number): void;
  /** The breadcrumb's "Library". */
  onLeave(): void;
}

export interface TodoPage {
  open(view: TodoView): void;
  close(): void;
  isOpen(): boolean;
  /** The view on screen, or null when closed. */
  view(): TodoView | null;
  /** The last answer as the person sees it (a delete waiting on Undo is gone); null before the first. */
  snapshot(): TodoSnapshot | null;
  /** Re-reads the server (shell start, tab back in focus). */
  load(): Promise<void>;
  destroy(): void;
}

const UNDO_MS = 6000;
/** While open and in view, the tablet's edits show up within this. */
const POLL_MS = 30_000;
const DAY_MS = 86_400_000;
const DIALOG = { dialog: "confirm todo-dialog", body: "confirm__body", actions: "confirm__actions", cancel: "btn", go: "btn" };

export function createTodoPage(host: TodoHost): TodoPage {
  const root = el("section", { class: "todo", "aria-labelledby": "todo-title", hidden: true });
  host.content.append(root);

  // The bin's Undo toast, reused as is; in the document only while it shows.
  const undoMsg = el("span", { class: "bin-toast__msg" });
  const undoSub = el("span", { class: "bin-toast__sub", text: "It leaves the tablet at its next sync." });
  const undoBtn = el("button", { class: "bin-toast__action", type: "button", text: "Undo" });
  const undoBar = el("div", { class: "bin-toast todo-undo", role: "status", "aria-live": "polite" }, el("span", { class: "bin-toast__lines" }, undoMsg, undoSub), undoBtn);
  let undoGone: ReturnType<typeof setTimeout> | undefined;

  let snap: TodoSnapshot | null = null;
  let failed = false;
  let open_ = false;
  let view: TodoView = { kind: "all" };
  let selected: string | null = null;
  let editing: string | null = null;
  let busy = false;
  const collapsed = new Set<string>();
  /** The add form's date, per view; absent: the view's default. */
  const addDue = new Map<string, number | null>();
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
      if (!host.handled(e)) say(`Couldn't ${what}. Check your connection and try again.`);
      return false;
    } finally {
      busy = false;
      await load();
    }
  }

  /** The shell's toast, never on top of the Undo: a new message settles the delete first. */
  function say(message: string): void {
    commitDelete();
    host.toast(message);
  }

  function showUndo(title: string): void {
    clearTimeout(undoGone);
    undoMsg.textContent = `Deleted "${title}"`;
    if (!undoBar.isConnected) {
      document.body.append(undoBar);
      void undoBar.offsetWidth; // so it slides in rather than appearing
    }
    undoBar.classList.add("is-shown");
  }

  function hideUndo(): void {
    undoBar.classList.remove("is-shown");
    clearTimeout(undoGone);
    undoGone = setTimeout(() => undoBar.remove(), 260);
  }

  function commitDelete(): void {
    const p = pendingDelete;
    if (!p) return;
    clearTimeout(p.timer);
    pendingDelete = null;
    hideUndo();
    void run("delete the task", () => host.api.todoDeleteTask(p.task.id));
  }

  undoBtn.addEventListener("click", () => {
    if (!pendingDelete) return;
    clearTimeout(pendingDelete.timer);
    pendingDelete = null;
    hideUndo();
    host.onChanged();
    paint();
  });

  // ---- painting ----

  function chrome(mine: boolean): void {
    host.sortWrap.hidden = mine;
    host.segmented.hidden = mine;
    host.setMode(mine);
    host.status.hidden = !mine || !snap?.enabled;
    host.newListBtn.hidden = !mine || !snap?.enabled;
    host.listBtn.hidden = !mine || !snap?.enabled || view.kind !== "list";
    if (!mine) return;
    if (snap?.enabled) {
      host.status.textContent = syncText(snap);
      host.status.classList.toggle("is-waiting", snap.waiting);
      if (view.kind === "list") host.listBtn.setAttribute("aria-label", `Options for the list ${viewTitle(view, snap.lists)}`);
    }
    const home = el("button", { type: "button", text: "Library" });
    home.addEventListener("click", () => host.onLeave());
    const todo = el("button", { type: "button", text: "To-Do" });
    todo.addEventListener("click", () => host.go("all"));
    host.crumbs.replaceChildren(home, el("span", { class: "crumbs__sep", text: "/" }), todo, el("span", { class: "crumbs__sep", text: "/" }), el("span", { class: "crumbs__here", text: snap ? viewTitle(view, snap.lists) : "" }));
  }

  function dueFor(v: TodoView, now: number): number | null {
    const key = viewPath(v);
    if (addDue.has(key)) return addDue.get(key)!;
    return addTarget(v, now)?.due ?? null;
  }

  function paint(): void {
    if (!open_) return;
    chrome(true);
    const keep = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.id : "";
    const keepRow = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.closest<HTMLElement>(".todo-row")?.dataset.id ?? null : null;
    // A repaint must not wipe what is being typed into the add form.
    const draftTitle = root.querySelector<HTMLInputElement>("#todo-add-title");
    const draft = draftTitle && paintedView && sameView(paintedView, view) ? { title: draftTitle.value, caret: draftTitle.selectionStart } : null;
    const keysOpen = root.querySelector<HTMLDetailsElement>(".todo-keys")?.open ?? false;
    const kids: (HTMLElement | null)[] = [];
    if (snap === null) {
      kids.push(failed ? notice("Your to-dos could not be loaded", "Check your connection and try again.", () => void load()) : notice("Loading…", "Reading your to-dos.", null));
    } else if (!snap.enabled) {
      kids.push(notice("To-Do sync is off on this server", "The tablet's to-dos are not kept here. An administrator can turn it on with todo_sync in the server's config.", null));
    } else {
      const now = Date.now();
      const p: TodoPaint = {
        snap, view, now, title: viewTitle(view, snap.lists), sections: sections(snap, view, now), collapsed,
        selected, editing, hidden: new Set(pendingDelete ? [pendingDelete.task.id] : []), busy, addDue: dueFor(view, now),
      };
      const keys = keysHint(p);
      (keys as HTMLDetailsElement).open = keysOpen;
      kids.push(header(p), addForm(p, actions), body(p, actions), keys, rowHelp());
    }
    root.replaceChildren(...kids.filter((k): k is HTMLElement => k !== null));
    paintedView = view;
    if (draft) {
      const t = root.querySelector<HTMLInputElement>("#todo-add-title");
      if (t) {
        t.value = draft.title;
        const go = root.querySelector<HTMLButtonElement>(".todo-add__go");
        if (go) go.disabled = draft.title.trim() === "" || busy;
        if (keep === "todo-add-title" && draft.caret !== null) t.setSelectionRange(draft.caret, draft.caret);
      }
    }
    const rowEl = (id: string) => root.querySelector<HTMLElement>(`.todo-row[data-id="${CSS.escape(id)}"]`);
    if (editing) {
      const input = root.querySelector<HTMLInputElement>(`#todo-edit-${CSS.escape(editing)}`);
      input?.focus();
      input?.select();
    } else if (keep) {
      document.getElementById(keep)?.focus();
    } else if (selected && rowEl(selected)) {
      rowEl(selected)!.focus();
    } else if (keepRow) {
      rowEl(keepRow)?.focus();
    }
  }

  // ---- popovers and dialogs ----

  let popClose: () => void = () => {};

  function pop(trigger: HTMLElement, items: HTMLElement[]): void {
    popClose();
    const box = el("div", { class: "menu__pop menu__pop--float is-open todo-pop", role: "menu" }, ...items);
    const self: OpenPopover = {
      trigger,
      contains: (t) => box.contains(t) || trigger.contains(t),
      close: () => {
        box.remove();
        clearPopover(self);
        trigger.setAttribute("aria-expanded", "false");
        popClose = () => {};
      },
    };
    getPortalRoot().append(box);
    placePop(trigger, box);
    openPopover(self);
    trigger.setAttribute("aria-expanded", "true");
    box.querySelector<HTMLElement>("button, input")?.focus();
    box.addEventListener("click", (e) => e.stopPropagation());
    popClose = self.close;
  }

  function item(label: string, iconName: IconName, onSelect: () => void, danger = false): HTMLElement {
    const b = el(
      "button",
      { class: "menu__item menu__item--lead" + (danger ? " menu__item--danger" : ""), type: "button", role: "menuitem" },
      el("span", { class: "menu__item-mark", html: svg(ICONS[iconName]) }),
      el("span", { text: label }),
    );
    b.addEventListener("click", () => {
      popClose();
      onSelect();
    });
    return b;
  }

  const section = (text: string) => el("div", { class: "menu__section", role: "presentation", text });

  /** Today, Tomorrow, a picked day, and "No date" when there is one. */
  function dateMenu(trigger: HTMLElement, current: number | null, set: (due: number | null) => void): void {
    const input = el("input", { class: "todo-pop__date", type: "date", "aria-label": "Pick a day", value: current === null ? "" : inputFromDue(current) }) as HTMLInputElement;
    input.addEventListener("change", () => {
      const due = dueFromInput(input.value);
      if (due === null) return;
      popClose();
      set(due);
    });
    const day = (offset: number) => dueFromInput(inputFromDue(Date.now() + offset * DAY_MS));
    pop(trigger, [
      section("DUE"),
      item("Today", "calendar", () => set(day(0))),
      item("Tomorrow", "calendar", () => set(day(1))),
      input,
      ...(current !== null ? [el("div", { class: "menu__sep", "aria-hidden": "true" }), item("No date", "trash", () => set(null))] : []),
    ]);
  }

  function askName(title: string, goLabel: string, initial: string): Promise<string | null> {
    const input = el("input", { class: "rename__field todo-dialog__name", type: "text", "aria-label": "Name", maxlength: "60", autocomplete: "off", spellcheck: "false", value: initial }) as HTMLInputElement;
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
          if (e.key === "Enter") {
            e.preventDefault();
            if (!go.disabled) go.click();
          }
        });
      },
    });
    // The name is what is being asked for: focus it, not Cancel.
    input.focus();
    input.select();
    return done.then((ok) => (ok && input.value.trim() !== "" ? input.value.trim() : null));
  }

  async function newList(then?: (id: string) => Promise<unknown>): Promise<void> {
    const title = await askName("New list", "Create list", "");
    if (!title) return;
    let created = "";
    if (!(await run("create the list", async () => { created = await host.api.todoCreateList(title); }))) return;
    if (then) {
      if (await run("move the task", () => then(created))) say(`Created "${title}" and moved the task there.`);
    } else {
      host.go(viewPath({ kind: "list", id: created }));
    }
  }

  function renameList(): void {
    if (!snap || view.kind !== "list") return;
    const id = view.id;
    const current = snap.lists.find((l) => l.id === id)?.title ?? "";
    void askName("Rename list", "Rename", current).then((title) => {
      if (title && title !== current) void run("rename the list", () => host.api.todoRenameList(id, title));
    });
  }

  function deleteList(): void {
    if (!snap || view.kind !== "list") return;
    const id = view.id;
    const list = snap.lists.find((l) => l.id === id);
    if (!list) return;
    const n = snap.tasks.filter((t) => t.listId === id).length;
    const { done } = openDialog({
      host: document.body,
      classes: { ...DIALOG, go: "btn is-danger" },
      goLabel: "Delete list",
      cancelLabel: "Cancel",
      labelledBy: "todo-dialog-title",
      build: (content) => content.append(
        el("h2", { id: "todo-dialog-title", text: n ? `Delete "${list.title}" and its ${n} task${n === 1 ? "" : "s"}?` : `Delete "${list.title}"?` }),
        el("p", { text: n ? "They are also removed from the tablet at its next sync. This can't be undone." : "It is also removed from the tablet at its next sync." }),
      ),
    });
    void done.then(async (ok) => {
      if (!ok) return;
      if (await run("delete the list", () => host.api.todoDeleteList(id))) {
        say(`Deleted "${list.title}".`);
        host.go("all");
      }
    });
  }

  const onListBtn = (e: MouseEvent) => {
    e.stopPropagation();
    if (host.listBtn.getAttribute("aria-expanded") === "true") return popClose();
    pop(host.listBtn, [item("Rename list", "edit", renameList), item("Delete list", "trash", deleteList, true)]);
  };
  const onNewList = () => void newList();
  host.listBtn.addEventListener("click", onListBtn);
  host.newListBtn.addEventListener("click", onNewList);

  // ---- actions ----

  const actions: TodoActions = {
    add(title) {
      if (!snap) return;
      const target = addTarget(view, Date.now());
      if (!target) return;
      const due = dueFor(view, Date.now());
      void run("add the task", () => host.api.todoCreateTask({ title: title.trim(), listId: target.listId, due })).then((ok) => {
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
    addDate(trigger) {
      const v = view;
      dateMenu(trigger, dueFor(v, Date.now()), (due) => {
        addDue.set(viewPath(v), due);
        paint();
        root.querySelector<HTMLInputElement>("#todo-add-title")?.focus();
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
        section("MOVE TO"),
        ...targets.filter(([id]) => id !== t.listId).map(([id, name]) => item(name, id === null ? "inbox" : "list", () => void run("move the task", () => host.api.todoUpdateTask(t.id, { listId: id })))),
        el("div", { class: "menu__sep", "aria-hidden": "true" }),
        item("New list…", "plus", () => void newList((id) => host.api.todoUpdateTask(t.id, { listId: id }))),
      ]);
    },
    date(t, trigger) {
      dateMenu(trigger, t.due, (due) => void run(due === null ? "remove the date" : "set the date", () => host.api.todoUpdateTask(t.id, { due })));
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
      showUndo(t.title);
      host.onChanged();
      paint();
    },
    toggleSection(key) {
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      paint();
    },
    openNote(t) {
      if (t.link) host.openNote(t.link.noteId, Math.max(0, t.link.page - 1));
    },
  };

  // ---- keyboard and pointer ----

  function onKey(e: KeyboardEvent): void {
    if (!open_ || e.defaultPrevented || e.metaKey || e.ctrlKey) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, dialog, summary, [contenteditable]")) return;
    if (!snap?.enabled) return;
    const rows = [...root.querySelectorAll<HTMLElement>(".todo-row")].map((r) => r.dataset.id!);
    const task = snap.tasks.find((t) => t.id === selected) ?? null;
    if (e.key === "n" || e.key === "N") { e.preventDefault(); root.querySelector<HTMLInputElement>("#todo-add-title")?.focus(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (e.altKey) {
        // Only where the list's own order is on screen, like the buttons.
        if (task && root.querySelector(`.todo-row[data-id="${CSS.escape(task.id)}"] .todo-act[aria-label="Move up"]`)) actions.reorder(task, e.key === "ArrowUp" ? -1 : 1);
        return;
      }
      const from = selected ?? (target.closest<HTMLElement>(".todo-row")?.dataset.id ?? null);
      const i = from ? rows.indexOf(from) : -1;
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
      case "delete": e.preventDefault(); return actions.remove(task);
    }
  }

  /** A click outside every row lets the selection go. */
  function onPointer(e: MouseEvent): void {
    if (!open_ || selected === null) return;
    const t = e.target as HTMLElement;
    if (!(t instanceof Element) || !t.isConnected) return;
    if (t.closest(".todo-row, dialog, .menu__pop, .bin-toast")) return;
    selected = null;
    paint();
  }

  document.addEventListener("keydown", onKey);
  document.addEventListener("click", onPointer);
  const onVisible = () => { if (document.visibilityState === "visible" && open_) void load(); };
  document.addEventListener("visibilitychange", onVisible);
  // The tablet syncs on its own: keep up while someone is looking.
  const poll = setInterval(() => {
    if (open_ && !busy && editing === null && document.visibilityState === "visible") void load();
  }, POLL_MS);

  return {
    open(next) {
      if (!open_ || !sameView(next, view)) { selected = null; editing = null; popClose(); }
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
    snapshot: () => {
      if (!snap || !pendingDelete) return snap;
      const gone = pendingDelete.task.id;
      return { ...snap, tasks: snap.tasks.filter((t) => t.id !== gone) };
    },
    load,
    destroy() {
      commitDelete();
      clearInterval(poll);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onPointer);
      document.removeEventListener("visibilitychange", onVisible);
      host.listBtn.removeEventListener("click", onListBtn);
      host.newListBtn.removeEventListener("click", onNewList);
      popClose();
      clearTimeout(undoGone);
      undoBar.remove();
      root.remove();
    },
  };
}
