// The To-Do views: which tasks each shows, in the tablet's order.

import { describe, it, expect } from "vitest";
import type { TodoSnapshot, TodoTask } from "../../src/api/todoTypes";
import { addTarget, byTabletOrder, canReorder, cards, dateLine, dropOrder, isOverdue, summary, withOrder, withoutTask, dayOffset, dueFromInput, dueLabel, inputFromDue, openCount, parseView, findTodos, searchTasks, sections, siblings, viewPath } from "../../src/pages/todo/todoModel";

const NOW = new Date(2026, 10, 5, 9, 30).getTime();
const DAY = 86_400_000;
let n = 0;
const task = (p: Partial<TodoTask>): TodoTask => ({
  id: `t${++n}`, listId: null, title: "x", done: false, due: null, completedAt: null, sort: 0, sortTime: 0, linked: false, link: null, waiting: false, ...p,
});
const snap = (tasks: TodoTask[]): TodoSnapshot => ({
  enabled: true, lists: [{ id: "fr", title: "Français", waiting: false }], tasks, tabletSyncedAt: null, waiting: false,
});

describe("To-Do views", () => {
  it("round-trips view paths; the bare path and anything unknown is the overview", () => {
    for (const v of [{ kind: "overview" }, { kind: "planned" }, { kind: "list", id: "a/b c" }] as const) expect(parseView(viewPath(v))).toEqual(v);
    expect(parseView("nonsense")).toEqual({ kind: "overview" });
    expect(parseView("")).toEqual({ kind: "overview" });
  });

  it("orders like the tablet: sort ascending, then the newest sort time", () => {
    const a = task({ sort: 1, sortTime: 5 }), b = task({ sort: 0, sortTime: 1 }), c = task({ sort: 0, sortTime: 9 });
    expect([a, b, c].sort(byTabletOrder).map((t) => t.id)).toEqual([c.id, b.id, a.id]);
  });

  it("a list shows its open tasks, then its completed ones folded", () => {
    const open = task({ listId: "fr" }), done = task({ listId: "fr", done: true, completedAt: NOW }), inbox = task({});
    const [own, completed] = sections(snap([open, done, inbox]), { kind: "list", id: "fr" }, NOW);
    expect(own!.tasks).toEqual([open]);
    expect(own!.reorderable).toEqual({ listId: "fr" });
    expect(completed!.tasks).toEqual([done]);
    expect(completed!.collapsedByDefault).toBe(true);
  });

  it("Planned groups open dated tasks into overdue, today and upcoming", () => {
    const late = task({ due: NOW - DAY }), today = task({ due: NOW + 3_600_000 }), soon = task({ due: NOW + 3 * DAY });
    const doneLate = task({ due: NOW - DAY, done: true }), undated = task({});
    const [o, t, u] = sections(snap([soon, today, late, doneLate, undated]), { kind: "planned" }, NOW);
    expect(o!.tasks).toEqual([late]);
    expect(o!.overdue).toBe(true);
    expect(t!.tasks).toEqual([today]);
    expect(u!.tasks).toEqual([soon]);
  });

  it("All shows the open tasks of the Inbox and each list; counts are open tasks", () => {
    const s = snap([task({}), task({ listId: "fr" }), task({ done: true }), task({ listId: "fr", due: NOW })]);
    expect(sections(s, { kind: "all" }, NOW).map((x) => [x.label, x.tasks.length])).toEqual([["Inbox", 1], ["Français", 2]]);
    expect(openCount(s, { kind: "all" })).toBe(3);
    expect(openCount(s, { kind: "planned" })).toBe(1);
    expect(openCount(s, { kind: "inbox" })).toBe(1);
    expect(openCount(s, { kind: "completed" })).toBe(0);
  });

  it("Completed groups the done tasks by list, Inbox first, newest first in each", () => {
    const old = task({ done: true, completedAt: NOW - 2 }), recent = task({ done: true, completedAt: NOW - 1 });
    const fr = task({ listId: "fr", done: true, completedAt: NOW }), open = task({});
    const secs = sections(snap([old, fr, recent, open]), { kind: "completed" }, NOW);
    expect(secs.map((x) => [x.label, x.tasks.map((t) => t.id)])).toEqual([["Inbox", [recent.id, old.id]], ["Français", [fr.id]]]);
  });

  it("the overview: a card per list, Inbox first, with open, overdue and the first tasks", () => {
    const late = task({ listId: "fr", due: NOW - 2 * 86_400_000, sort: 0 });
    const a = task({ listId: "fr", sort: 1 }), b = task({ listId: "fr", sort: 2 }), c = task({ listId: "fr", sort: 3 });
    const done = task({ listId: "fr", done: true });
    const [inbox, fr] = cards(snap([late, a, b, c, done]), NOW);
    expect(inbox).toMatchObject({ name: "Inbox", open: 0, overdue: 0, peek: [] });
    expect(fr).toMatchObject({ name: "Français", open: 4, overdue: 1 });
    expect(fr!.peek.map((t) => t.id)).toEqual([late.id, a.id, b.id]);
  });

  it("the topbar's summary: to do and overdue, done on Completed, lists on the overview", () => {
    const late = task({ listId: "fr", due: NOW - 2 * DAY }), inbox = task({}), done = task({ done: true });
    const s = snap([late, inbox, done]);
    expect(summary(s, { kind: "list", id: "fr" }, NOW)).toEqual({ text: "1 to do", overdue: 1 });
    expect(summary(s, { kind: "inbox" }, NOW)).toEqual({ text: "1 to do", overdue: 0 });
    expect(summary(s, { kind: "completed" }, NOW)).toEqual({ text: "1 done", overdue: 0 });
    expect(summary(s, { kind: "overview" }, NOW)).toEqual({ text: "2 lists · 2 to do", overdue: 1 });
    expect(summary(snap([]), { kind: "inbox" }, NOW).text).toBe("Nothing to do");
  });

  it("siblings are the open tasks of the same list, in order", () => {
    const a = task({ sort: 1 }), b = task({ sort: 0 }), other = task({ listId: "fr" });
    expect(siblings(snap([a, b, other]), a).map((t) => t.id)).toEqual([b.id, a.id]);
  });
});

describe("To-Do dates", () => {
  it("a date field's day is local noon, and back", () => {
    const ms = dueFromInput("2026-11-13")!;
    expect(new Date(ms).getHours()).toBe(12);
    expect(inputFromDue(ms)).toBe("2026-11-13");
    expect(dueFromInput("13/11/2026")).toBeNull();
  });

  it("labels count calendar days, not 24-hour spans", () => {
    const lateTonight = new Date(2026, 10, 5, 23, 59).getTime();
    expect(dayOffset(lateTonight, NOW)).toBe(0);
    expect(dueLabel(NOW + DAY, NOW)).toBe("Tomorrow");
    expect(dueLabel(NOW - DAY, NOW)).toBe("Yesterday");
    expect(dueLabel(NOW, NOW)).toBe("Today");
  });

  it("new tasks: Planned defaults to today, a list to itself, Completed takes none", () => {
    expect(inputFromDue(addTarget({ kind: "planned" }, NOW)!.due!)).toBe("2026-11-05");
    expect(addTarget({ kind: "list", id: "fr" }, NOW)).toEqual({ listId: "fr", due: null });
    expect(addTarget({ kind: "completed" }, NOW)).toBeNull();
  });

  it("overdue is a day before today; due today is not late yet; done is never late", () => {
    expect(isOverdue(task({ due: NOW - DAY }), NOW)).toBe(true);
    expect(isOverdue(task({ due: NOW - 3600_000 }), NOW)).toBe(false);
    expect(isOverdue(task({ due: NOW - DAY, done: true }), NOW)).toBe(false);
    expect(isOverdue(task({}), NOW)).toBe(false);
  });

  it("a task's date line: late ones say so, once under an Overdue heading", () => {
    const late = task({ due: NOW - 2 * DAY });
    expect(dateLine(late, NOW)).toEqual({ text: `Overdue, ${dueLabel(late.due!, NOW)}`, late: true });
    expect(dateLine(late, NOW, true)).toEqual({ text: dueLabel(late.due!, NOW), late: true });
    expect(dateLine(task({ due: NOW + DAY }), NOW)).toEqual({ text: "Tomorrow", late: false });
    expect(dateLine(task({ done: true, completedAt: NOW - DAY }), NOW)).toEqual({ text: "Done yesterday", late: false });
    // A month stays capitalised: only Today and Yesterday read as words.
    expect(dateLine(task({ done: true, completedAt: NOW - 9 * DAY }), NOW)!.text).toBe(`Done ${dueLabel(NOW - 9 * DAY, NOW)}`);
    expect(dateLine(task({}), NOW)).toBeNull();
  });

  it("reordering only where a list's own order is on screen", () => {
    const t = task({ listId: "fr", due: NOW }), done = task({ listId: "fr", done: true });
    const s = snap([t, done]);
    expect(canReorder(s, { kind: "list", id: "fr" }, t, NOW)).toBe(true);
    expect(canReorder(s, { kind: "all" }, t, NOW)).toBe(true);
    expect(canReorder(s, { kind: "planned" }, t, NOW)).toBe(false);
    expect(canReorder(s, { kind: "list", id: "fr" }, done, NOW)).toBe(false);
  });

  it("a drop lands just before the task below it, or last; tasks off screen keep their place", () => {
    const a = task({ listId: "fr", sort: 0 }), b = task({ listId: "fr", sort: 1 }), c = task({ listId: "fr", sort: 2 });
    const inbox = task({ sort: 0 });
    const s = snap([a, b, c, inbox]);
    expect(dropOrder(s, c, "fr", a.id)).toEqual([c.id, a.id, b.id]);
    expect(dropOrder(s, a, "fr", undefined)).toEqual([b.id, c.id, a.id]);
    // Into another list: the moved task joins its order.
    expect(dropOrder(s, inbox, "fr", b.id)).toEqual([a.id, inbox.id, b.id, c.id]);
    // With `b` off screen (its delete waits on Undo), `c` dropped last of what is shown: `b` keeps its slot.
    expect(dropOrder(s, c, "fr", undefined)).toEqual([a.id, b.id, c.id]);
  });

  it("an order shown at once: positions renumbered, a moved task in its new list; a pending delete gone", () => {
    const a = task({ listId: "fr", sort: 5 }), b = task({ sort: 9 });
    const s = withOrder(snap([a, b]), [b.id, a.id], { id: b.id, listId: "fr" });
    expect(s.tasks.find((t) => t.id === b.id)).toMatchObject({ listId: "fr", sort: 0 });
    expect(s.tasks.find((t) => t.id === a.id)).toMatchObject({ sort: 1 });
    expect(withoutTask(s, a.id).tasks.map((t) => t.id)).toEqual([b.id]);
  });
});

describe("finding to-dos", () => {
  it("by the library's rule: accents aside, words in any order, the note's name too", () => {
    const a = task({ id: "a", title: "Revisar o passé composé" });
    const b = task({ id: "b", title: "Haus of gabin", link: { noteId: "9", page: 27, name: "Apostila", text: null } });
    const s = snap([a, b]);
    expect(searchTasks(s, "passe compose").map((t) => t.id)).toEqual(["a"]);
    expect(searchTasks(s, "composé revisar").map((t) => t.id)).toEqual(["a"]);
    expect(searchTasks(s, "gabin apostila").map((t) => t.id)).toEqual(["b"]);
    // No task has a word starting "abin": then the text anywhere in a title.
    expect(searchTasks(s, "abin").map((t) => t.id)).toEqual(["b"]);
    expect(searchTasks(s, "passe compose zzz")).toEqual([]);
  });
});

describe("finding to-dos: lists, lassoed words, typos, marks", () => {
  const casa = { id: "casa", title: "Casa", waiting: false };
  const withLists = (tasks: TodoTask[]): TodoSnapshot => ({ ...snap(tasks), lists: [casa] });
  const ligar = task({ id: "l", title: "Ligar para o dentista", listId: "casa" });
  const haus = task({ id: "h", title: "Comprar pão", link: { noteId: "9", page: 27, name: "Apostila", text: "Haus of gabin" } });

  it("a list named like the query is found, and so are its tasks", () => {
    const f = findTodos(withLists([ligar, haus]), "casa");
    expect(f.lists).toEqual([{ id: "casa", name: "Casa" }]);
    expect(f.tasks.map((t) => t.id)).toEqual(["l"]);
  });

  it("words in any order across title and list", () => {
    expect(findTodos(withLists([ligar, haus]), "casa dentista").tasks.map((t) => t.id)).toEqual(["l"]);
  });

  it("the words it was lassoed from still find a renamed task", () => {
    expect(findTodos(withLists([ligar, haus]), "gabin").tasks.map((t) => t.id)).toEqual(["h"]);
  });

  it("marks the matched words in the title, accents aside", () => {
    const f = findTodos(withLists([ligar, haus]), "dentista casa");
    expect(f.marks("Ligar para o dentista").map(([a, b]) => "Ligar para o dentista".slice(a, b))).toEqual(["dentista"]);
    expect(findTodos(withLists([haus]), "pao").marks("Comprar pão").map(([a, b]) => "Comprar pão".slice(a, b))).toEqual(["pão"]);
  });

  it("when nothing matches as typed, the nearest spelling, said, as the notes do", () => {
    const f = findTodos(withLists([ligar, haus]), "dentsta");
    expect(f.tasks.map((t) => t.id)).toEqual(["l"]);
    expect(f.expansions).toEqual([{ typed: "dentsta", matched: "dentista" }]);
    expect(f.marks("Ligar para o dentista").length).toBe(1);
  });

  it("no typo answer for words too short to correct, or too far off", () => {
    expect(findTodos(withLists([ligar]), "pra").tasks).toEqual([]);
    expect(findTodos(withLists([ligar]), "xyzzyq").tasks).toEqual([]);
  });
});
