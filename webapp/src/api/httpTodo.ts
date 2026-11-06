// The person's To-Do over HTTP (`/api/controlplane/todo…`).

import { request } from "./request";
import type { NewTodoTask, TodoSnapshot, TodoTaskPatch } from "./todoTypes";

type Raw = Partial<{
  enabled: boolean;
  lists: { id?: string; title?: string; waiting?: boolean }[];
  tasks: {
    id?: string; listId?: string; title?: string; done?: boolean; due?: number; completedAt?: number;
    sort?: number; sortTime?: number; linked?: boolean; waiting?: boolean;
    noteId?: number | string; notePage?: number; noteName?: string; noteText?: string;
  }[];
  tabletSyncedAt: number;
  waiting: boolean;
}>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The server omits null optionals: absent is "none", never 0. */
function todoOf(r: Raw): TodoSnapshot {
  return {
    enabled: r.enabled === true,
    lists: (r.lists ?? []).flatMap((l) => (typeof l.id === "string" ? [{ id: l.id, title: l.title ?? "", waiting: l.waiting === true }] : [])),
    tasks: (r.tasks ?? []).flatMap((t) =>
      typeof t.id === "string"
        ? [{
            id: t.id,
            listId: typeof t.listId === "string" && t.listId !== "" ? t.listId : null,
            title: t.title ?? "",
            done: t.done === true,
            due: num(t.due),
            completedAt: num(t.completedAt),
            sort: num(t.sort) ?? 0,
            sortTime: num(t.sortTime) ?? 0,
            linked: t.linked === true,
            link:
              (typeof t.noteId === "number" || typeof t.noteId === "string") && typeof t.notePage === "number"
                ? { noteId: String(t.noteId), page: t.notePage, name: t.noteName ?? "", text: typeof t.noteText === "string" ? t.noteText : null }
                : null,
            waiting: t.waiting === true,
          }]
        : [],
    ),
    tabletSyncedAt: num(r.tabletSyncedAt),
    waiting: r.waiting === true,
  };
}

const enc = encodeURIComponent;

export const todoMethods = {
  // --- TO-DO ---
  async todo(): Promise<TodoSnapshot> {
    return todoOf(await request<Raw>("GET", "/api/controlplane/todo"));
  },
  async todoCreateList(title: string): Promise<string> {
    return (await request<{ id: string }>("POST", "/api/controlplane/todo/lists", { title })).id;
  },
  async todoRenameList(id: string, title: string): Promise<void> {
    await request("PUT", `/api/controlplane/todo/lists/${enc(id)}`, { title });
  },
  async todoDeleteList(id: string): Promise<void> {
    await request("DELETE", `/api/controlplane/todo/lists/${enc(id)}`);
  },
  async todoCreateTask(task: NewTodoTask): Promise<string> {
    const body: Record<string, unknown> = { title: task.title };
    if (task.listId) body.listId = task.listId;
    if (task.due !== null) body.due = task.due;
    return (await request<{ id: string }>("POST", "/api/controlplane/todo/tasks", body)).id;
  },
  async todoUpdateTask(id: string, patch: TodoTaskPatch): Promise<void> {
    // The wire's sentinels: "" is the Inbox, 0 is "no date".
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.listId !== undefined) body.listId = patch.listId ?? "";
    if (patch.due !== undefined) body.due = patch.due ?? 0;
    if (patch.done !== undefined) body.done = patch.done;
    await request("PUT", `/api/controlplane/todo/tasks/${enc(id)}`, body);
  },
  async todoDeleteTask(id: string): Promise<void> {
    await request("DELETE", `/api/controlplane/todo/tasks/${enc(id)}`);
  },
  async todoReorder(listId: string | null, ids: string[]): Promise<void> {
    await request("PUT", "/api/controlplane/todo/order", { listId: listId ?? "", ids });
  },
};
