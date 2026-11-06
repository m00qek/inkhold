// The topbar's Download on To-Do: the reader's menu shape (a section per
// scope, the format's extension on the right). This list on a list's page,
// the Inbox's included; every list in All; nothing elsewhere.

import type { TodoSnapshot } from "../../api/todoTypes";
import { download } from "../../export/exporter";
import { notePageHref } from "../../router";
import { listName, type TodoView } from "./todoModel";
import { exportName, exportTasks, toICalendar, toTodoTxt, type ExportScope } from "./todoExport";
import type { TodoMenus } from "./todoMenus";
import type { BarRow } from "../../ui/barMenu";

export interface TodoDownloadsDeps {
  button: HTMLButtonElement;
  menus: TodoMenus;
  snapshot(): TodoSnapshot | null;
  view(): TodoView;
  /** The page's toast. */
  say(message: string): void;
}

export interface TodoDownloads {
  /** What Download saves on this page; null: the button hides. */
  scope(): { title: string; scope: ExportScope; name: string } | null;
  /** Download's rows for a bar folded into ⋯ (`ui/barMenu.ts`): headed
   *  "Download", since that menu holds more than downloads. */
  barRows(): BarRow[];
  destroy(): void;
}

/** An absolute link to a notebook page (1-based), for the files' notebook links. */
const noteUrl = (id: string, page: number) => new URL(notePageHref(id, page - 1), location.href).href;

export function createTodoDownloads(d: TodoDownloadsDeps): TodoDownloads {
  function scope(): ReturnType<TodoDownloads["scope"]> {
    const snap = d.snapshot();
    const v = d.view();
    if (!snap) return null;
    if (v.kind === "list" || v.kind === "inbox") {
      const listId = v.kind === "list" ? v.id : null;
      return { title: "This list", scope: { listId }, name: listName(snap, listId) };
    }
    if (v.kind === "all") return { title: "All lists", scope: {}, name: "To-Do" };
    return null;
  }

  function save(kind: "ics" | "txt"): void {
    const snap = d.snapshot();
    const where = scope();
    if (!snap || !where) return;
    const tasks = exportTasks(snap, where.scope);
    const text = kind === "ics" ? toICalendar(snap, tasks, { name: where.name, now: Date.now(), noteUrl }) : toTodoTxt(snap, tasks, noteUrl);
    const file = exportName(where.name, kind);
    download(file, new Blob([text], { type: kind === "ics" ? "text/calendar" : "text/plain" }));
    d.say(`Saved ${file} (${tasks.length === 1 ? "1 task" : `${tasks.length} tasks`}).`);
  }

  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (d.button.getAttribute("aria-expanded") === "true") return d.menus.close();
    const rows = items();
    if (rows.length === 0) return;
    d.menus.pop(d.button, rows);
  };
  function barRows(): BarRow[] {
    if (!scope()) return [];
    return [
      { kind: "section", title: "Download" },
      { kind: "item", label: "Tasks", ext: ".ics", onSelect: () => save("ics") },
      { kind: "item", label: "Plain text", ext: ".txt", onSelect: () => save("txt") },
    ];
  }
  function items(): HTMLElement[] {
    const where = scope();
    if (!where) return [];
    return [
      d.menus.section(where.title),
      d.menus.fileItem("Tasks", ".ics", () => save("ics")),
      d.menus.fileItem("Plain text", ".txt", () => save("txt")),
    ];
  }
  d.button.addEventListener("click", onClick);

  return { scope, barRows, destroy: () => d.button.removeEventListener("click", onClick) };
}
