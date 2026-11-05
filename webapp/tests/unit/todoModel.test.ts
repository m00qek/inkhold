// The To-Do views: which tasks each shows, in the tablet's order.

import { describe, it, expect } from "vitest";
import type { TodoSnapshot, TodoTask } from "../../src/api/todoTypes";
import { addTarget, byTabletOrder, dayOffset, dueFromInput, dueLabel, inputFromDue, openCount, parseView, sections, siblings, viewPath } from "../../src/pages/todo/todoModel";

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
  it("round-trips view paths; anything unknown is the Inbox", () => {
    for (const v of [{ kind: "planned" }, { kind: "list", id: "a/b c" }] as const) expect(parseView(viewPath(v))).toEqual(v);
    expect(parseView("nonsense")).toEqual({ kind: "inbox" });
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

  it("All shows the Inbox, each list, then everything completed; counts are open tasks", () => {
    const s = snap([task({}), task({ listId: "fr" }), task({ done: true }), task({ listId: "fr", due: NOW })]);
    expect(sections(s, { kind: "all" }, NOW).map((x) => [x.label, x.tasks.length])).toEqual([["Inbox", 1], ["Français", 2], ["Completed", 1]]);
    expect(openCount(s, { kind: "all" })).toBe(3);
    expect(openCount(s, { kind: "planned" })).toBe(1);
    expect(openCount(s, { kind: "inbox" })).toBe(1);
    expect(openCount(s, { kind: "completed" })).toBe(0);
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
});
