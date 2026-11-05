// To-dos as files: iCalendar for task apps, todo.txt for editors.

import { describe, it, expect } from "vitest";
import type { TodoSnapshot, TodoTask } from "../../src/api/todoTypes";
import { exportName, exportTasks, toICalendar, toTodoTxt } from "../../src/pages/todo/todoExport";

const NOW = Date.UTC(2026, 10, 5, 17, 32, 35);
let n = 0;
const task = (p: Partial<TodoTask>): TodoTask => ({
  id: `t${++n}`, listId: null, title: "x", done: false, due: null, completedAt: null, sort: 0, sortTime: 0, linked: false, link: null, waiting: false, ...p,
});
const snap = (tasks: TodoTask[]): TodoSnapshot => ({
  enabled: true, lists: [{ id: "fr", title: "Français, nível 2", waiting: false }], tasks, tabletSyncedAt: null, waiting: false,
});
const noteUrl = (id: string, page: number) => `https://ink.example/#/note/${id}/page/${page}`;

describe("To-Do exports", () => {
  it("a list's tasks, or every list's, Inbox first; open before done", () => {
    const a = task({ listId: "fr", sort: 1 }), b = task({ listId: "fr", sort: 0 }), d = task({ listId: "fr", done: true, completedAt: NOW });
    const inbox = task({});
    const s = snap([a, d, b, inbox]);
    expect(exportTasks(s, { listId: "fr" }).map((t) => t.id)).toEqual([b.id, a.id, d.id]);
    expect(exportTasks(s, { listId: null }).map((t) => t.id)).toEqual([inbox.id]);
    expect(exportTasks(s, {}).map((t) => t.id)).toEqual([inbox.id, b.id, a.id, d.id]);
  });

  it("iCalendar: one VTODO per task, escaped, dated, done, listed, linked", () => {
    const due = new Date(2026, 10, 13, 12).getTime();
    const open = task({ id: "a1", listId: "fr", title: "Estudar; ler, revisar", due, sort: 2, link: { noteId: "101", page: 3, name: "Weekly review" } });
    const done = task({ id: "b2", title: "Haus of gabin", done: true, completedAt: NOW });
    const s = snap([open, done]);
    const ics = toICalendar(s, [open, done], { name: "To-Do", now: NOW, noteUrl });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.match(/BEGIN:VTODO/g)).toHaveLength(2);
    expect(ics).toContain("UID:a1@inkhold\r\n");
    expect(ics).toContain("SUMMARY:Estudar\\; ler\\, revisar\r\n");
    expect(ics).toContain("DUE;VALUE=DATE:20261113\r\n");
    expect(ics).toContain("CATEGORIES:Français\\, nível 2\r\n");
    expect(ics).toContain("X-APPLE-SORT-ORDER:2\r\n");
    expect(ics).toContain("URL:https://ink.example/#/note/101/page/3\r\n");
    expect(ics).toContain("STATUS:NEEDS-ACTION\r\n");
    expect(ics).toContain("STATUS:COMPLETED\r\nPERCENT-COMPLETE:100\r\nCOMPLETED:20261105T173235Z\r\n");
    expect(ics).toContain("CATEGORIES:Inbox\r\n");
  });

  it("iCalendar folds long lines at 75 octets, never inside a character", () => {
    const long = task({ title: "é".repeat(60) });
    const ics = toICalendar(snap([long]), [long], { name: "To-Do", now: NOW, noteUrl });
    const lines = ics.split("\r\n");
    for (const line of lines) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    // Unfolded (a CRLF and one space removed), the title is whole again.
    expect(ics.replace(/\r\n /g, "")).toContain(`SUMMARY:${"é".repeat(60)}`);
  });

  it("todo.txt: x and the done date first, then the title, +List, due: and note:", () => {
    const due = new Date(2026, 10, 13, 12).getTime();
    const open = task({ listId: "fr", title: "Estudar\nmais", due, link: { noteId: "101", page: 3, name: "Weekly review" } });
    const done = task({ title: "Haus of gabin", done: true, completedAt: new Date(2026, 10, 5, 12).getTime() });
    expect(toTodoTxt(snap([open, done]), [open, done], noteUrl)).toBe(
      "Estudar mais +Français,-nível-2 due:2026-11-13 note:https://ink.example/#/note/101/page/3\n" + "x 2026-11-05 Haus of gabin +Inbox\n",
    );
    expect(toTodoTxt(snap([]), [], noteUrl)).toBe("");
  });

  it("file names keep the list's name, minus what a file system refuses", () => {
    expect(exportName("Casa", "ics")).toBe("Casa.ics");
    expect(exportName("a/b: c?", "txt")).toBe("a-b- c-.txt");
    expect(exportName("  ", "ics")).toBe("To-Do.ics");
  });
});
