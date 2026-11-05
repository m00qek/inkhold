// The person's To-Do, as the browser sees it: the same lists and tasks the
// tablet's To-Do app syncs (`/api/controlplane/todo`).

/** A user-made list. The Inbox is not one: a task with no list is in it. */
export interface TodoList {
  id: string;
  title: string;
  /** Changed here and not yet fetched by a tablet. */
  waiting: boolean;
}

export interface TodoTask {
  id: string;
  /** Null: the Inbox. */
  listId: string | null;
  title: string;
  done: boolean;
  /** Epoch ms of the due day (the tablet stores a moment on that day); null: no date. */
  due: number | null;
  completedAt: number | null;
  /** The tablet's order within a list: `sort` ascending, then newest `sortTime`. */
  sort: number;
  sortTime: number;
  /** Lassoed from a notebook page on the tablet. */
  linked: boolean;
  waiting: boolean;
}

export interface TodoSnapshot {
  /** False when the server keeps no To-Do (`todo_sync` off); everything else is empty then. */
  enabled: boolean;
  lists: TodoList[];
  tasks: TodoTask[];
  /** When a tablet last fetched these to-dos; null: never. */
  tabletSyncedAt: number | null;
  /** Something changed here that no tablet has fetched yet. */
  waiting: boolean;
}

export interface NewTodoTask {
  title: string;
  listId: string | null;
  due: number | null;
}

/** What an edit changes; an absent field stays as it is. */
export interface TodoTaskPatch {
  title?: string;
  /** Null moves the task to the Inbox. */
  listId?: string | null;
  /** Null removes the date. */
  due?: number | null;
  done?: boolean;
}
