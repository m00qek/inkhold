// What each To-Do view shows, in the tablet's own order: pure functions over a
// `TodoSnapshot`, so the page and its tests agree on every row.

import type { TodoList, TodoSnapshot, TodoTask } from "../../api/todoTypes";

export type TodoView =
  | { kind: "inbox" }
  | { kind: "planned" }
  | { kind: "all" }
  | { kind: "completed" }
  | { kind: "list"; id: string };

export const FIXED_VIEWS = ["inbox", "planned", "all", "completed"] as const;

/** The URL segment after `#/todo/`. */
export function viewPath(v: TodoView): string {
  return v.kind === "list" ? `list/${encodeURIComponent(v.id)}` : v.kind;
}

/** A URL segment back to a view; anything unknown is the Inbox. */
export function parseView(path: string): TodoView {
  if ((FIXED_VIEWS as readonly string[]).includes(path)) return { kind: path as Exclude<TodoView["kind"], "list"> };
  const m = path.match(/^list\/(.+)$/);
  if (m) return { kind: "list", id: decodeURIComponent(m[1]!) };
  return { kind: "inbox" };
}

export function sameView(a: TodoView, b: TodoView): boolean {
  return a.kind === b.kind && (a.kind !== "list" || a.id === (b as { id: string }).id);
}

export function viewTitle(v: TodoView, lists: readonly TodoList[]): string {
  switch (v.kind) {
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

// ---- sections ----

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
    case "inbox":
      return ownList(null, "inbox");
    case "list":
      return ownList(v.id, `list:${v.id}`);
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
        { key: "all:done", label: "Completed", tasks: s.tasks.filter((t) => t.done).sort(newestDone), showList: true, collapsedByDefault: true },
      ];
    case "completed":
      return [{ key: "completed", label: null, tasks: s.tasks.filter((t) => t.done).sort(newestDone), showList: true }];
  }
}

/** The rail's number beside each view: open tasks in it. */
export function openCount(s: TodoSnapshot, v: TodoView): number {
  if (v.kind === "completed") return 0;
  if (v.kind === "planned") return s.tasks.filter((t) => !t.done && t.due !== null).length;
  if (v.kind === "all") return s.tasks.filter((t) => !t.done).length;
  const listId = v.kind === "list" ? v.id : null;
  return s.tasks.filter((t) => !t.done && t.listId === listId).length;
}

/** Where a new task typed into this view goes, and its default date. */
export function addTarget(v: TodoView, now: number): { listId: string | null; due: number | null } | null {
  if (v.kind === "completed") return null;
  if (v.kind === "list") return { listId: v.id, due: null };
  if (v.kind === "planned") return { listId: null, due: dueFromInput(inputFromDue(now)) };
  return { listId: null, due: null };
}

/** The open tasks beside `t` in its own list, in order: what up and down move through. */
export function siblings(s: TodoSnapshot, t: TodoTask): TodoTask[] {
  if (t.done) return [];
  return s.tasks.filter((x) => !x.done && x.listId === t.listId).sort(byTabletOrder);
}

export function listName(s: TodoSnapshot, listId: string | null): string {
  return listId === null ? "Inbox" : s.lists.find((l) => l.id === listId)?.title ?? "A deleted list";
}
