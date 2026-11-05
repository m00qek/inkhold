// The fake API's To-Do: one person's lists and tasks, edited by the server's
// own rules (`services/todo_web.zig`): server-stamped times, a new or moved
// task on top of its list, a reorder as positions plus one sort time.

import { delay } from "./fake";
import { ApiError } from "./errors";
import type { NewTodoTask, TodoList, TodoSnapshot, TodoTask, TodoTaskPatch } from "./todoTypes";

const DAY = 86_400_000;

function noonIn(days: number): number {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime() + days * DAY;
}

export function fakeTodoMethods(latency: number) {
  let seq = 0;
  const id = (): string => (++seq).toString(16).padStart(32, "0");
  const now = () => Date.now();
  const lists: TodoList[] = [
    { id: id(), title: "Français", waiting: false },
    { id: id(), title: "Casa", waiting: false },
  ];
  const [fr, casa] = [lists[0]!.id, lists[1]!.id];
  const t = (p: Partial<TodoTask> & Pick<TodoTask, "title">): TodoTask => ({
    id: id(), listId: null, done: false, due: null, completedAt: null, sort: 0, sortTime: now() - DAY,
    linked: false, link: null, waiting: false, ...p,
  });
  const tasks: TodoTask[] = [
    t({ title: "Estudar", listId: fr, due: noonIn(8), sort: 0 }),
    t({ title: "Ler", listId: fr, sort: 1 }),
    t({ title: "Revisar o passé composé", listId: fr, sort: 2, linked: true, link: { noteId: "101", page: 2, name: "Weekly review" } }),
    t({ title: "Devolver o livro na biblioteca", listId: casa, due: noonIn(-1), sort: 0 }),
    t({ title: "Ligar para o dentista", listId: casa, due: noonIn(0), sort: 1 }),
    t({ title: "Comprar papel para a impressora", listId: casa, done: true, completedAt: now() - 2 * DAY, sort: 2 }),
    t({ title: "Haus of gabin", done: true, completedAt: now() - 3 * 3_600_000, linked: true, link: { noteId: "101", page: 3, name: "Weekly review" } }),
    t({ title: "after snapshot" }),
  ];
  let tabletSyncedAt: number | null = now() - 4 * 60_000;
  let changedAt: number | null = null;
  const touch = (): number => (changedAt = now());

  const snapshot = (): TodoSnapshot => ({
    enabled: true,
    lists: lists.map((l) => ({ ...l })),
    tasks: tasks.map((x) => ({ ...x })),
    tabletSyncedAt,
    waiting: changedAt !== null && (tabletSyncedAt === null || changedAt > tabletSyncedAt),
  });
  const task = (tid: string): TodoTask => {
    const x = tasks.find((y) => y.id === tid);
    if (!x) throw new ApiError("NO_SUCH_TASK", "there is no such task", 404);
    return x;
  };
  const checkList = (lid: string | null): void => {
    if (lid !== null && !lists.some((l) => l.id === lid)) throw new ApiError("NO_SUCH_LIST", "there is no such list", 404);
  };

  return {
    async todo(): Promise<TodoSnapshot> {
      await delay(latency);
      return snapshot();
    },
    async todoCreateList(title: string): Promise<string> {
      await delay(latency);
      const l = { id: id(), title: title.trim(), waiting: true };
      lists.push(l);
      touch();
      return l.id;
    },
    async todoRenameList(lid: string, title: string): Promise<void> {
      await delay(latency);
      const l = lists.find((x) => x.id === lid);
      checkList(l ? lid : "missing");
      l!.title = title.trim();
      l!.waiting = true;
      touch();
    },
    async todoDeleteList(lid: string): Promise<void> {
      await delay(latency);
      const i = lists.findIndex((x) => x.id === lid);
      if (i >= 0) lists.splice(i, 1);
      for (let j = tasks.length - 1; j >= 0; j--) if (tasks[j]!.listId === lid) tasks.splice(j, 1);
      touch();
    },
    async todoCreateTask(n: NewTodoTask): Promise<string> {
      await delay(latency);
      checkList(n.listId);
      const at = touch();
      const x = t({ title: n.title.trim(), listId: n.listId, due: n.due, sort: 0, sortTime: at, waiting: true });
      tasks.push(x);
      return x.id;
    },
    async todoUpdateTask(tid: string, p: TodoTaskPatch): Promise<void> {
      await delay(latency);
      const x = task(tid);
      if (p.listId !== undefined) checkList(p.listId);
      const at = touch();
      if (p.title !== undefined) x.title = p.title.trim();
      if (p.due !== undefined) x.due = p.due;
      if (p.done !== undefined) {
        x.done = p.done;
        x.completedAt = p.done ? at : null;
      }
      if (p.listId !== undefined) {
        x.listId = p.listId;
        x.sort = 0;
        x.sortTime = at;
      }
      x.waiting = true;
    },
    async todoDeleteTask(tid: string): Promise<void> {
      await delay(latency);
      const i = tasks.findIndex((x) => x.id === tid);
      if (i >= 0) tasks.splice(i, 1);
      touch();
    },
    async todoReorder(lid: string | null, ids: string[]): Promise<void> {
      await delay(latency);
      const at = touch();
      const open = tasks.filter((x) => x.listId === lid && !x.done);
      for (const x of open) {
        const i = ids.indexOf(x.id);
        x.sort = i >= 0 ? i : ids.length + x.sort;
        x.sortTime = at;
        x.waiting = true;
      }
    },
    /** Dev and tests only: what a tablet's next sync does to the waiting marks. */
    fakeTabletSync(): void {
      tabletSyncedAt = now();
      for (const l of lists) l.waiting = false;
      for (const x of tasks) x.waiting = false;
    },
  };
}
