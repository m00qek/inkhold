// The To-Do page's shared context: its state and the few things every part
// calls (an edit with its re-read, a toast, a repaint), named once.
//
// `createTodoPage` builds the root, the menus and the state, seeds a `TodoCtx`
// with its own `run`/`say`/`paint`, then creates the parts from it. A part
// reads a member only when one of its functions runs, so the construction
// order in `todoPage.ts` is the one place that has to be right.

import type { TodoSnapshot, TodoTask } from "../../api/todoTypes";
import type { TodoMenus } from "./todoMenus";
import type { TodoView } from "./todoModel";
import type { TodoHost } from "./todoPage";

export interface TodoState {
  snap: TodoSnapshot | null;
  failed: boolean;
  open_: boolean;
  view: TodoView;
  selected: string | null;
  // What the page is in the middle of. A background re-read waits until it is
  // `settled()`, and nothing repaints the rows under a drag.
  /** The task whose name is being edited in its row. */
  editing: string | null;
  /** A save in flight; its own re-read follows. */
  busy: boolean;
  /** A task held by its grip. */
  dragging: boolean;
  collapsed: Set<string>;
  /** The add form's date, per view; absent: the view's default. */
  addDue: Map<string, number | null>;
  /** A delete waiting out its Undo. */
  pendingDelete: { task: TodoTask; timer: ReturnType<typeof setTimeout> } | null;
  loadToken: number;
  /** A task to select on the next open, done tasks' section unfolded. */
  revealing: string | null;
  /** The view last painted, so a repaint of the same view keeps the add form's draft. */
  paintedView: TodoView | null;
  /** When the server was last asked, answered or not: a failure is not re-asked at once. */
  askedAt: number;
}

export function initialTodoState(): TodoState {
  return {
    snap: null,
    failed: false,
    open_: false,
    view: { kind: "overview" },
    selected: null,
    editing: null,
    busy: false,
    dragging: false,
    collapsed: new Set(),
    addDue: new Map(),
    pendingDelete: null,
    loadToken: 0,
    revealing: null,
    paintedView: null,
    askedAt: 0,
  };
}

export interface TodoCtx {
  host: TodoHost;
  root: HTMLElement;
  menus: TodoMenus;
  st: TodoState;
  /** One edit: the call, then a fresh read. A failure says so and changes nothing. */
  run(what: string, op: () => Promise<unknown>): Promise<boolean>;
  /** The shell's toast, never on top of the Undo. */
  say(message: string): void;
  paint(): void;
}
