// To-dos as files: iCalendar (RFC 5545), one VTODO per task, which calendar
// and task apps import; and todo.txt, one line per task, which any editor
// reads. Pure: the page picks the tasks and saves the text. Done tasks are
// included: an export is the person's data, not what is left to do.

import type { TodoSnapshot, TodoTask } from "../../api/todoTypes";
import { byTabletOrder, inputFromDue, listName } from "./todoModel";

export interface ExportScope {
  /** One list (null: the Inbox), or every list when absent. */
  listId?: string | null;
}

/** The scope's tasks: list by list (Inbox first) in the tablet's order, open before done. */
export function exportTasks(s: TodoSnapshot, scope: ExportScope): TodoTask[] {
  const lists: (string | null)[] = "listId" in scope ? [scope.listId ?? null] : [null, ...s.lists.map((l) => l.id)];
  return lists.flatMap((id) => {
    const mine = s.tasks.filter((t) => t.listId === id);
    return [...mine.filter((t) => !t.done).sort(byTabletOrder), ...mine.filter((t) => t.done).sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))];
  });
}

/** A file name from a list's name: what a file system takes, never empty. */
export function exportName(name: string, ext: string): string {
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim();
  return `${safe || "To-Do"}.${ext}`;
}

// ---- iCalendar ----

/** TEXT values escape backslash, semicolon, comma and line breaks (RFC 5545 §3.3.11). */
function icsText(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** UTC date-time, `20261105T173235Z`. */
function icsStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Lines longer than 75 octets continue on the next, after a space (§3.1). */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let cur = "";
  let size = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (size + n > (parts.length === 0 ? 75 : 74)) {
      parts.push(cur);
      cur = "";
      size = 0;
    }
    cur += ch;
    size += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

export interface IcsOptions {
  /** The calendar's name: the list's, or "To-Do". */
  name: string;
  now: number;
  /** An absolute link to a notebook page (1-based), for a lassoed task. */
  noteUrl(noteId: string, page: number): string;
}

export function toICalendar(s: TodoSnapshot, tasks: readonly TodoTask[], o: IcsOptions): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Inkhold//To-Do//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${icsText(o.name)}`];
  for (const t of tasks) {
    lines.push("BEGIN:VTODO", `UID:${t.id}@inkhold`, `DTSTAMP:${icsStamp(o.now)}`, `SUMMARY:${icsText(t.title)}`);
    // A day, not a moment: the tablet keeps a time on the due day only to carry it.
    if (t.due !== null) lines.push(`DUE;VALUE=DATE:${inputFromDue(t.due).replace(/-/g, "")}`);
    if (t.done) {
      lines.push("STATUS:COMPLETED", "PERCENT-COMPLETE:100");
      if (t.completedAt !== null) lines.push(`COMPLETED:${icsStamp(t.completedAt)}`);
    } else {
      lines.push("STATUS:NEEDS-ACTION");
    }
    lines.push(`CATEGORIES:${icsText(listName(s, t.listId))}`);
    // No standard field keeps a list's order; this extension is the common one.
    lines.push(`X-APPLE-SORT-ORDER:${t.sort}`);
    if (t.link) lines.push(`URL:${o.noteUrl(t.link.noteId, t.link.page)}`);
    lines.push("END:VTODO");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// ---- todo.txt ----

/** A todo.txt project is one word: the list's name with its spaces as dashes. */
function project(name: string): string {
  return "+" + name.trim().replace(/\s+/g, "-");
}

/**
 * One task per line (todo.txt's format): `x <done date>` first when done,
 * then the title, `+List`, and `due:` and `note:` tags.
 */
export function toTodoTxt(s: TodoSnapshot, tasks: readonly TodoTask[], noteUrl: (noteId: string, page: number) => string): string {
  return tasks
    .map((t) => {
      const parts: string[] = [];
      if (t.done) parts.push("x", ...(t.completedAt !== null ? [inputFromDue(t.completedAt)] : []));
      // One line per task: a line break in a title would split it.
      parts.push(t.title.replace(/\s*\r?\n\s*/g, " ").trim() || "(untitled)");
      parts.push(project(listName(s, t.listId)));
      if (t.due !== null) parts.push(`due:${inputFromDue(t.due)}`);
      if (t.link) parts.push(`note:${noteUrl(t.link.noteId, t.link.page)}`);
      return parts.join(" ");
    })
    .join("\n") + (tasks.length ? "\n" : "");
}
