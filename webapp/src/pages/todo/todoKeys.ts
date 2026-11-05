// To-Do's keyboard: N to add, arrows to select, then X/E/M/D/Delete on the
// selected task and Alt+arrows to reorder it. Ignored while typing or in a
// dialog. Mirrors the task's ⋯ menu; `keysHint` and `rowHelp` describe it.

import type { TodoSnapshot } from "../../api/todoTypes";
import { canReorder, type TodoView } from "./todoModel";
import type { TodoActions } from "./todoView";

export interface TodoKeyCtx {
  root: HTMLElement;
  snap: TodoSnapshot;
  view: TodoView;
  selected: string | null;
  /** Selects a task (null: none) and repaints. */
  select(id: string | null): void;
  actions: TodoActions;
}

export function onTodoKey(e: KeyboardEvent, k: TodoKeyCtx): void {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey) return;
  const target = e.target as HTMLElement;
  if (target.closest("input, textarea, select, dialog, summary, [contenteditable]")) return;
  const task = k.snap.tasks.find((t) => t.id === k.selected) ?? null;

  if (e.key === "n" || e.key === "N") {
    e.preventDefault();
    k.root.querySelector<HTMLInputElement>("#todo-add-title")?.focus();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const dir = e.key === "ArrowUp" ? -1 : 1;
    if (e.altKey) {
      // Only where the list's own order is on screen, like Move up and down.
      if (task && canReorder(k.snap, k.view, task, Date.now())) k.actions.reorder(task, dir);
      return;
    }
    const rows = [...k.root.querySelectorAll<HTMLElement>(".todo-row")].map((r) => r.dataset.id!);
    const from = k.selected ?? target.closest<HTMLElement>(".todo-row")?.dataset.id ?? null;
    const i = from ? rows.indexOf(from) : -1;
    k.select(rows[i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + dir))] ?? null);
    return;
  }
  if (e.key === "Escape" && k.selected) {
    k.select(null);
    return;
  }
  if (!task) return;
  // Move to… and the date open from the task's ⋯, as they do from its menu.
  const more = k.root.querySelector<HTMLElement>(`.todo-row[data-id="${CSS.escape(task.id)}"] .card__more`);
  const run: Record<string, () => void> = {
    x: () => k.actions.toggle(task),
    e: () => k.actions.startRename(task),
    m: () => more && k.actions.move(task, more),
    d: () => more && k.actions.date(task, more),
    delete: () => k.actions.remove(task),
  };
  const act = run[e.key.toLowerCase()];
  if (!act) return;
  e.preventDefault();
  act();
}
