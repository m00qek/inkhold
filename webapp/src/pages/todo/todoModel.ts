// What each To-Do view shows, in the tablet's own order: pure functions over a
// `TodoSnapshot`, so the page and its tests agree on every row.

import type { TodoList, TodoSnapshot, TodoTask } from "../../api/todoTypes";

export type TodoView =
  /** The landing page: a card per list. */
  | { kind: "overview" }
  | { kind: "inbox" }
  | { kind: "planned" }
  | { kind: "all" }
  | { kind: "completed" }
  | { kind: "list"; id: string };

export const FIXED_VIEWS = ["inbox", "planned", "all", "completed"] as const;

/** The URL segment after `#/todo/`. */
export function viewPath(v: TodoView): string {
  if (v.kind === "overview") return "";
  return v.kind === "list" ? `list/${encodeURIComponent(v.id)}` : v.kind;
}

/** A URL segment back to a view; anything unknown is the overview. */
export function parseView(path: string): TodoView {
  if ((FIXED_VIEWS as readonly string[]).includes(path)) return { kind: path as Exclude<TodoView["kind"], "list"> };
  const m = path.match(/^list\/(.+)$/);
  if (m) return { kind: "list", id: decodeURIComponent(m[1]!) };
  // The bare `#/todo` (and anything unknown) lands on the lists' cards.
  return { kind: "overview" };
}

export function sameView(a: TodoView, b: TodoView): boolean {
  return a.kind === b.kind && (a.kind !== "list" || a.id === (b as { id: string }).id);
}

export function viewTitle(v: TodoView, lists: readonly TodoList[]): string {
  switch (v.kind) {
    case "overview": return "Lists";
    case "inbox": return "Inbox";
    case "planned": return "Planned";
    case "all": return "All";
    case "completed": return "Completed";
    case "list": return lists.find((l) => l.id === v.id)?.title ?? "List";
  }
}

/** The tablet's order: `sort` ascending, then the newest `sortTime` first. */
export function byTabletOrder(a: TodoTask, b: TodoTask): number {
  return a.sort - b.sort || b.sortTime - a.sortTime;
}

const newestDone = (a: TodoTask, b: TodoTask): number => (b.completedAt ?? 0) - (a.completedAt ?? 0);

// ---- dates ----

const DAY = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole calendar days from `now`'s day to `ms`'s day, in the browser's zone. */
export function dayOffset(ms: number, now: number): number {
  return Math.round((startOfDay(ms) - startOfDay(now)) / DAY);
}

export function dueLabel(ms: number, now: number): string {
  const d = dayOffset(ms, now);
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  if (d === -1) return "Yesterday";
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

/**
* A date field's `yyyy-mm-dd` as local noon: the tablet keeps a moment on the
* due day, and noon keeps the day right across a few hours of zone difference.
*/
export function dueFromInput(value: string): number | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getTime();
}

export function inputFromDue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Due on a day before today; a task due today is not late yet. */
export function isOverdue(t: Pick<TodoTask, "due" | "done">, now: number): boolean {
  return !t.done && t.due !== null && dayOffset(t.due, now) < 0;
}

/**
 * A task's date, as its row says it: "Tomorrow", "Overdue, 3 Nov" (just
 * "3 Nov" under an Overdue heading, which says it once), "Done yesterday".
 * Null when there is nothing to say.
 */
export function dateLine(t: TodoTask, now: number, underOverdue = false): { text: string; late: boolean } | null {
  if (t.done) {
    if (t.completedAt === null) return null;
    const when = dueLabel(t.completedAt, now);
    return { text: `Done ${when === "Today" || when === "Yesterday" ? when.toLowerCase() : when}`, late: false };
  }
  if (t.due === null) return null;
  const label = dueLabel(t.due, now);
  const late = isOverdue(t, now);
  return { text: late && !underOverdue ? `Overdue, ${label}` : label, late };
}

// ---- sections ----

/** A list's section key on its own page (null: the Inbox); its done tasks are `${key}:done`. */
export function listKey(listId: string | null): string {
  return listId === null ? "inbox" : `list:${listId}`;
}

export interface TodoSection {
  /** Stable across repaints, for remembering a collapsed section. */
  key: string;
  /** Null: no header (a list's own open tasks). */
  label: string | null;
  tasks: TodoTask[];
  /** Rows also say which list they are in. */
  showList: boolean;
  /** Painted in the overdue tone. */
  overdue?: boolean;
  /** Folded until opened. */
  collapsedByDefault?: boolean;
  /** The open tasks of one list (null: Inbox), so they can be reordered. */
  reorderable?: { listId: string | null };
}

export function sections(s: TodoSnapshot, v: TodoView, now: number): TodoSection[] {
  const open = (listId: string | null) => s.tasks.filter((t) => !t.done && t.listId === listId).sort(byTabletOrder);
  const done = (listId: string | null) => s.tasks.filter((t) => t.done && t.listId === listId).sort(newestDone);
  const ownList = (listId: string | null, key: string): TodoSection[] => [
    { key, label: null, tasks: open(listId), showList: false, reorderable: { listId } },
    { key: `${key}:done`, label: "Completed", tasks: done(listId), showList: false, collapsedByDefault: true },
  ];
  switch (v.kind) {
    case "overview":
      return [];
    case "inbox":
      return ownList(null, listKey(null));
    case "list":
      return ownList(v.id, listKey(v.id));
    case "planned": {
      const dated = s.tasks
        .filter((t) => !t.done && t.due !== null)
        .sort((a, b) => a.due! - b.due! || byTabletOrder(a, b));
      const when = (t: TodoTask) => dayOffset(t.due!, now);
      return [
        { key: "planned:overdue", label: "Overdue", tasks: dated.filter((t) => when(t) < 0), showList: true, overdue: true },
        { key: "planned:today", label: "Today", tasks: dated.filter((t) => when(t) === 0), showList: true },
        { key: "planned:upcoming", label: "Upcoming", tasks: dated.filter((t) => when(t) > 0), showList: true },
      ];
    }
    case "all":
      return [
        { key: "all:inbox", label: "Inbox", tasks: open(null), showList: false, reorderable: { listId: null } },
        ...s.lists.map((l): TodoSection => ({ key: `all:${l.id}`, label: l.title, tasks: open(l.id), showList: false, reorderable: { listId: l.id } })),
      ];
    case "completed":
      // Grouped like All: by list, Inbox first; newest first inside each.
      return [
        { key: "completed:inbox", label: "Inbox", tasks: done(null), showList: false },
        ...s.lists.map((l): TodoSection => ({ key: `completed:${l.id}`, label: l.title, tasks: done(l.id), showList: false })),
      ];
  }
}

/** The rail's number beside each view: open tasks in it. */
export function openCount(s: TodoSnapshot, v: TodoView): number {
  if (v.kind === "completed") return 0;
  if (v.kind === "overview") return s.tasks.filter((t) => !t.done).length;
  if (v.kind === "planned") return s.tasks.filter((t) => !t.done && t.due !== null).length;
  if (v.kind === "all") return s.tasks.filter((t) => !t.done).length;
  const listId = v.kind === "list" ? v.id : null;
  return s.tasks.filter((t) => !t.done && t.listId === listId).length;
}

/** Where a new task typed into this view goes, and its default date. */
export function addTarget(v: TodoView, now: number): { listId: string | null; due: number | null } | null {
  if (v.kind === "completed" || v.kind === "overview") return null;
  if (v.kind === "list") return { listId: v.id, due: null };
  if (v.kind === "planned") return { listId: null, due: dueFromInput(inputFromDue(now)) };
  return { listId: null, due: null };
}

/** Whether `t` can be moved up and down (or dragged) where `v` shows it: in its list's own order. */
export function canReorder(s: TodoSnapshot, v: TodoView, t: TodoTask, now: number): boolean {
  return !t.done && sections(s, v, now).some((sec) => sec.reorderable !== undefined && sec.tasks.some((x) => x.id === t.id));
}

/** The open tasks beside `t` in its own list, in order: what up and down move through. */
export function siblings(s: TodoSnapshot, t: TodoTask): TodoTask[] {
  if (t.done) return [];
  return s.tasks.filter((x) => !x.done && x.listId === t.listId).sort(byTabletOrder);
}

export function listName(s: TodoSnapshot, listId: string | null): string {
  return listId === null ? "Inbox" : s.lists.find((l) => l.id === listId)?.title ?? "A deleted list";
}

// ---- the overview ----

export interface TodoCard {
  view: TodoView;
  name: string;
  open: number;
  overdue: number;
  /** The first open tasks, in the list's order. */
  peek: TodoTask[];
}

/** One card per list, Inbox first: what the overview shows. */
export function cards(s: TodoSnapshot, now: number, peek = 3): TodoCard[] {
  const card = (listId: string | null, view: TodoView, name: string): TodoCard => {
    const open = s.tasks.filter((t) => !t.done && t.listId === listId).sort(byTabletOrder);
    const overdue = open.filter((t) => isOverdue(t, now)).length;
    return { view, name, open: open.length, overdue, peek: open.slice(0, peek) };
  };
  return [card(null, { kind: "inbox" }, "Inbox"), ...s.lists.map((l) => card(l.id, { kind: "list", id: l.id }, l.title))];
}

// ---- search ----

/**
 * Tasks whose title, or the notebook they were lassoed from, contains `q`:
 * open ones first, list by list (Inbox first) in the tablet's order, then the
 * done ones, newest first.
 */
export function searchTasks(s: TodoSnapshot, q: string): TodoTask[] {
  const needle = q.trim().toLowerCase();
  if (needle === "") return [];
  const hit = s.tasks.filter((t) => t.title.toLowerCase().includes(needle) || (t.link?.name.toLowerCase().includes(needle) ?? false));
  const listOrder = new Map<string | null, number>([[null, 0], ...s.lists.map((l, i): [string, number] => [l.id, i + 1])]);
  const open = hit.filter((t) => !t.done).sort((a, b) => (listOrder.get(a.listId) ?? 0) - (listOrder.get(b.listId) ?? 0) || byTabletOrder(a, b));
  const done = hit.filter((t) => t.done).sort(newestDone);
  return [...open, ...done];
}

/** The page a task lives on: its list, or the Inbox. */
export function homeView(t: TodoTask): TodoView {
  return t.listId === null ? { kind: "inbox" } : { kind: "list", id: t.listId };
}

// ---- the topbar's subtitle ----

/** What a view holds, in the cards' words: "3 to do", "1 overdue", "2 done". */
export function summary(s: TodoSnapshot, v: TodoView, now: number): { text: string; overdue: number } {
  if (v.kind === "completed") {
    const n = s.tasks.filter((t) => t.done).length;
    return { text: n === 0 ? "Nothing done yet" : `${n} done`, overdue: 0 };
  }
  const open = sections(s, v, now).flatMap((sec) => (sec.collapsedByDefault ? [] : sec.tasks));
  const tasks = v.kind === "overview" ? s.tasks.filter((t) => !t.done) : open;
  const overdue = tasks.filter((t) => isOverdue(t, now)).length;
  const todo = tasks.length === 0 ? "Nothing to do" : `${tasks.length} to do`;
  if (v.kind !== "overview") return { text: todo, overdue };
  const lists = s.lists.length + 1; // the Inbox is one
  return { text: `${lists === 1 ? "1 list" : `${lists} lists`} · ${todo.toLowerCase()}`, overdue };
}

// ---- reordering ----

/**
 * The order of list `target` once `task` is dropped there just before
 * `nextShown` (undefined: at the end). Tasks not on screen (a delete waiting
 * on Undo) keep their place among their neighbours.
 */
export function dropOrder(s: TodoSnapshot, task: TodoTask, target: string | null, nextShown: string | undefined): string[] {
  const ids = s.tasks.filter((x) => !x.done && x.listId === target && x.id !== task.id).sort(byTabletOrder).map((x) => x.id);
  const at = nextShown === undefined ? -1 : ids.indexOf(nextShown);
  ids.splice(at < 0 ? ids.length : at, 0, task.id);
  return ids;
}

/**
 * The snapshot with `ids` in that order (and one task moved to another list),
 * so the screen shows a reorder before the server answers. The re-read after
 * the save replaces these numbers with the server's own.
 */
export function withOrder(s: TodoSnapshot, ids: readonly string[], move?: { id: string; listId: string | null }): TodoSnapshot {
  const at = new Map(ids.map((id, i) => [id, i]));
  return {
    ...s,
    tasks: s.tasks.map((t) => {
      const listed = move && t.id === move.id ? { ...t, listId: move.listId } : t;
      return at.has(t.id) ? { ...listed, sort: at.get(t.id)! } : listed;
    }),
  };
}

/** The snapshot without one task: what is seen while its delete waits on Undo. */
export function withoutTask(s: TodoSnapshot, id: string): TodoSnapshot {
  return { ...s, tasks: s.tasks.filter((t) => t.id !== id) };
}
