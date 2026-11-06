// The To-Do destination: the person's lists and tasks, the same ones the
// tablet's To-Do app syncs. Mounted in the shell's content area like the
// account page; painted by `todoView.ts` from `todoModel.ts`, with its menus
// and dialogs in `todoMenus.ts`, dragging in `todoDrag.ts` and the Undo in
// `todoUndo.ts`. Its page-level tools (sync status, list menu, New list) are
// the shell topbar's.
//
// Every edit goes to the server, then the page re-reads it: the server owns
// the times and the order the tablet will merge by. A delete waits a few
// seconds behind an Undo first, because once the tablet syncs it is gone there.

import { el } from "../../ui/dom";
import { DEFAULT_SECTION_TITLE } from "../../ui/menu";
import type { Api } from "../../api/types";
import type { TodoSnapshot, TodoTask } from "../../api/todoTypes";
import {
  addTarget, dropOrder, listKey, sameView, sections, siblings, viewPath, viewTitle, withOrder, withoutTask, type TodoView,
} from "./todoModel";
import { addForm, body, keysHint, notice, overview, placeTitle, rowHelp, syncText, type TodoActions, type TodoPaint } from "./todoView";
import { createTodoMenus } from "./todoMenus";
import { dragRow } from "./todoDrag";
import { createUndoToast } from "./todoUndo";
import { onTodoKey } from "./todoKeys";
import { createTodoDownloads } from "./todoDownload";
import type { TodoInk } from "./todoInk";

export interface TodoHost {
  api: Api;
  content: HTMLElement;
  gallery: HTMLElement;
  crumbs: HTMLElement;
  /** Names the screen (the tab's title and the page's <h1>) while To-Do is open; null on leaving. */
  setPlace(name: string | null): void;
  sortWrap: HTMLElement;
  segmented: HTMLElement;
  /** The topbar's sync status line. */
  status: HTMLElement;
  /** The topbar's list options button (a list's view only). */
  listBtn: HTMLButtonElement;
  /** The topbar's Download (a list's page, and All). */
  downloadBtn: HTMLButtonElement;
  /** The topbar's New list button. */
  newListBtn: HTMLButtonElement;
  setMode(open: boolean): void;
  /** The library's search box in the topbar. */
  setSearchShown(shown: boolean): void;
  toast(message: string): void;
  /** Session expiry and the like; true when the shell took care of it. */
  handled(e: unknown): boolean;
  /** The snapshot changed: the rail's counts and lists repaint. */
  onChanged(): void;
  /** Go to a To-Do view (its `viewPath`). */
  go(viewPath: string): void;
  /** Lassoed tasks' handwriting. */
  ink: TodoInk;
  /** Open a notebook at a page (0-based). */
  openNote(id: string, page: number): void;
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
  /**
   * Re-reads the server when the last read is over a minute old and the page
   * is closed (open, it keeps up on its own): a search reaching for to-dos.
   */
  freshen(): void;
  /** Select this task when its page next opens (a search result). */
  reveal(taskId: string): void;
  destroy(): void;
}

const UNDO_MS = 6000;
/** While open and in view, the tablet's edits show up within this. */
const POLL_MS = 30_000;
/** Closed, a search re-reads to-dos older than this. */
const FRESH_MS = 60_000;

export function createTodoPage(host: TodoHost): TodoPage {
  const root = el("section", { class: "todo", "aria-label": "To-Do", hidden: true });
  host.content.append(root);

  const menus = createTodoMenus();
  const undo = createUndoToast(() => {
    if (!pendingDelete) return;
    clearTimeout(pendingDelete.timer);
    pendingDelete = null;
    undo.hide();
    host.onChanged();
    paint();
  });

  let snap: TodoSnapshot | null = null;
  let failed = false;
  let open_ = false;
  let view: TodoView = { kind: "overview" };
  let selected: string | null = null;
  // What the page is in the middle of. A background re-read waits until it is
  // `settled()`, and nothing repaints the rows under a drag.
  /** The task whose name is being edited in its row. */
  let editing: string | null = null;
  /** A save in flight; its own re-read follows. */
  let busy = false;
  /** A task held by its grip. */
  let dragging = false;
  const collapsed = new Set<string>();
  /** The add form's date, per view; absent: the view's default. */
  const addDue = new Map<string, number | null>();
  /** A delete waiting out its Undo. */
  let pendingDelete: { task: TodoTask; timer: ReturnType<typeof setTimeout> } | null = null;
  let loadToken = 0;
  /** A task to select on the next open, done tasks' section unfolded. */
  let revealing: string | null = null;
  /** The view last painted, so a repaint of the same view keeps the add form's draft. */
  let paintedView: TodoView | null = null;

  const settled = () => !busy && !dragging && editing === null;

  // ---- server ----

  /** When the server was last asked, answered or not: a failure is not re-asked at once. */
  let askedAt = 0;

  async function load(): Promise<void> {
    const mine = ++loadToken;
    askedAt = Date.now();
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

  function commitDelete(): void {
    const p = pendingDelete;
    if (!p) return;
    clearTimeout(p.timer);
    pendingDelete = null;
    undo.hide();
    void run("delete the task", () => host.api.todoDeleteTask(p.task.id));
  }

  // ---- painting ----

  /** The snapshot as the person sees it: a delete waiting on Undo is gone. */
  function visibleSnap(): TodoSnapshot | null {
    return snap && pendingDelete ? withoutTask(snap, pendingDelete.task.id) : snap;
  }

  /** Saves a new order (and maybe a new list) for one list, showing it at once. */
  function saveOrder(listId: string | null, ids: string[], moved?: TodoTask): void {
    if (!snap) return;
    snap = withOrder(snap, ids, moved ? { id: moved.id, listId } : undefined);
    void run(moved ? "move the task" : "reorder", async () => {
      if (moved) await host.api.todoUpdateTask(moved.id, { listId });
      await host.api.todoReorder(listId, ids);
    });
  }

  /** The shell's topbar dressed for To-Do (`mine`), or handed back to the library. */
  function chrome(mine: boolean): void {
    host.sortWrap.hidden = mine;
    host.segmented.hidden = mine;
    host.setMode(mine);
    // Each page's own tools: New list where the lists are, the list's menu on
    // a list of one's own (never the Inbox); the sync status only while waiting.
    const sync = snap?.enabled ? syncText(snap) : null;
    host.status.hidden = !mine || sync === null;
    host.newListBtn.hidden = !mine || !snap?.enabled || view.kind !== "overview";
    host.listBtn.hidden = !mine || !snap?.enabled || view.kind !== "list";
    host.downloadBtn.hidden = !mine || !snap?.enabled || downloads.scope() === null;
    // The search box only where To-Do is browsed, like a folder; inside a list
    // or a view, as inside a note, it would only carry the person away.
    host.setSearchShown(mine && view.kind === "overview");
    if (!mine) return;
    if (sync) {
      host.status.textContent = sync.short;
      host.status.title = sync.long;
    }
    if (snap?.enabled) {
      if (view.kind === "list") host.listBtn.setAttribute("aria-label", `Options for the list ${viewTitle(view, snap.lists)}`);
    }
    host.crumbs.replaceChildren(placeTitle(visibleSnap(), view, Date.now()));
  }

  function dueFor(v: TodoView, now: number): number | null {
    const key = viewPath(v);
    if (addDue.has(key)) return addDue.get(key)!;
    return addTarget(v, now)?.due ?? null;
  }

  function paint(): void {
    if (!open_ || dragging) return;
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
        chip: (t, open) => host.ink.chip(t, open),
      };
      const keys = keysHint(p);
      (keys as HTMLDetailsElement).open = keysOpen;
      host.setPlace(p.title);
      if (view.kind === "overview") kids.push(overview(p, actions));
      else kids.push(addForm(p, actions), body(p, actions), keys, rowHelp());
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

  // ---- lists ----

  async function newList(then?: (id: string) => Promise<unknown>): Promise<void> {
    const title = await menus.askName("New list", "Create list", "");
    if (!title) return;
    let created = "";
    if (!(await run("create the list", async () => { created = await host.api.todoCreateList(title); }))) return;
    if (then) {
      if (await run("move the task", () => then(created))) say(`Created "${title}" and moved the task there.`);
    } else {
      host.go(viewPath({ kind: "list", id: created }));
    }
  }

  /** The list on screen, or the one a card's menu names. */
  const listHere = (): string | null => (view.kind === "list" ? view.id : null);

  function renameList(id = listHere()): void {
    if (!snap || id === null) return;
    const current = snap.lists.find((l) => l.id === id)?.title ?? "";
    void menus.askName("Rename list", "Rename", current).then((title) => {
      if (title && title !== current) void run("rename the list", () => host.api.todoRenameList(id, title));
    });
  }

  function deleteList(id = listHere()): void {
    if (!snap || id === null) return;
    const list = snap.lists.find((l) => l.id === id);
    if (!list) return;
    const n = snap.tasks.filter((t) => t.listId === id).length;
    const done = menus.confirmDeleteList(list.title, n);
    void done.then(async (ok) => {
      if (!ok) return;
      if (await run("delete the list", () => host.api.todoDeleteList(id))) {
        say(`Deleted "${list.title}".`);
        if (view.kind !== "overview") host.go("");
      }
    });
  }

  const onListBtn = (e: MouseEvent) => {
    e.stopPropagation();
    if (host.listBtn.getAttribute("aria-expanded") === "true") return menus.close();
    // The card's ⋯ menu, header and all.
    menus.pop(host.listBtn, [menus.section(DEFAULT_SECTION_TITLE), menus.item("Rename list", "edit", () => renameList()), menus.item("Delete list", "trash", () => deleteList(), true)]);
  };
  const downloads = createTodoDownloads({ button: host.downloadBtn, menus, snapshot: () => snap, view: () => view, say });
  const onNewList = () => void newList();
  host.listBtn.addEventListener("click", onListBtn);
  host.newListBtn.addEventListener("click", onNewList);

  // ---- actions ----

  const actions: TodoActions = {
    show(v) {
      host.go(viewPath(v));
    },
    renameList: (id) => renameList(id),
    deleteList: (id) => deleteList(id),
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
      menus.dateMenu(trigger, dueFor(v, Date.now()), (due) => {
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
      menus.pop(trigger, [
        menus.section("MOVE TO"),
        ...targets
          .filter(([id]) => id !== t.listId)
          .map(([id, name]) => menus.item(name, id === null ? "inbox" : "list", () => void run("move the task", () => host.api.todoUpdateTask(t.id, { listId: id })))),
        menus.sep(),
        menus.item("New list…", "plus", () => void newList((id) => host.api.todoUpdateTask(t.id, { listId: id }))),
      ]);
    },
    date(t, trigger) {
      menus.dateMenu(trigger, t.due, (due) => void run(due === null ? "remove the date" : "set the date", () => host.api.todoUpdateTask(t.id, { due })));
    },
    drag(t, row, e) {
      if (!snap || dragging) return;
      dragging = true;
      menus.close();
      // In All every list's group takes a drop; on one list's page, just its own.
      dragRow(row, e, [...root.querySelectorAll<HTMLElement>("[data-list]")], (drop) => {
        dragging = false;
        if (!drop.changed || !snap) return paint();
        selected = t.id;
        const moved = drop.listId !== t.listId;
        saveOrder(drop.listId, dropOrder(snap, t, drop.listId, drop.nextShown), moved ? t : undefined);
      });
    },
    reorder(t, dir) {
      if (!snap) return;
      const sib = siblings(snap, t);
      const i = sib.findIndex((x) => x.id === t.id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= sib.length) return;
      const ids = sib.map((x) => x.id);
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
      saveOrder(t.listId, ids);
    },
    remove(t) {
      commitDelete(); // one Undo at a time
      selected = null;
      pendingDelete = { task: t, timer: setTimeout(commitDelete, UNDO_MS) };
      undo.show(t.title);
      host.onChanged();
      paint();
    },
    toggleSection(key) {
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      paint();
    },
    openNote(t) {
      if (!t.link) return;
      // Back from the note lands on this task again.
      revealing = t.id;
      host.openNote(t.link.noteId, Math.max(0, t.link.page - 1));
    },
  };

  // ---- keyboard and pointer ----

  function onKey(e: KeyboardEvent): void {
    if (!open_ || !snap?.enabled) return;
    onTodoKey(e, {
      root, snap, view, selected, actions,
      select: (id) => {
        selected = id;
        paint();
      },
    });
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
    if (open_ && settled() && document.visibilityState === "visible") void load();
  }, POLL_MS);

  return {
    freshen() {
      if (!open_ && Date.now() - askedAt > FRESH_MS) void load();
    },
    open(next) {
      if (!open_ || !sameView(next, view)) {
        selected = null;
        editing = null;
        menus.close();
      }
      view = next;
      if (revealing !== null) {
        const t = snap?.tasks.find((x) => x.id === revealing);
        if (t) {
          selected = t.id;
          // Done tasks wait in the list's folded Completed: open it.
          if (t.done) collapsed.add(`${listKey(t.listId)}:done`);
        }
        revealing = null;
      }
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
      host.setPlace(null);
      menus.close();
      chrome(false);
    },
    isOpen: () => open_,
    view: () => (open_ ? view : null),
    snapshot: visibleSnap,
    load,
    reveal(id) {
      revealing = id;
    },
    destroy() {
      commitDelete();
      clearInterval(poll);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onPointer);
      document.removeEventListener("visibilitychange", onVisible);
      host.listBtn.removeEventListener("click", onListBtn);
      downloads.destroy();
      host.newListBtn.removeEventListener("click", onNewList);
      menus.close();
      undo.destroy();
      root.remove();
    },
  };
}
