// To-dos in the library-wide search: the browser already holds them all, so
// they are matched here and painted after the notes, as their own group.

import { el } from "../../ui/dom";
import { ICONS, svg } from "../../ui/icons";
import type { TodoSnapshot, TodoTask } from "../../api/todoTypes";
import { homeView, searchTasks, viewPath } from "./todoModel";
import { taskMeta } from "./todoView";

/** Null when nothing matched (or To-Do is off): the search says nothing about to-dos. */
export function todoHits(snap: TodoSnapshot | null, q: string, now: number, open: (task: TodoTask) => void): HTMLElement | null {
  if (!snap?.enabled) return null;
  const tasks = searchTasks(snap, q);
  if (tasks.length === 0) return null;
  const rows = tasks.map((t) => {
    const row = el(
      "a",
      { class: "todo-hit" + (t.done ? " is-done" : ""), href: `#/todo/${viewPath(homeView(t))}` },
      el("span", { class: "todo-hit__ring", "aria-hidden": "true", html: t.done ? svg(ICONS.tick, 2.4) : "" }),
      el("div", { class: "todo-hit__main" }, el("span", { class: "todo-hit__title", text: t.title }), taskMeta(t, snap, now, { showList: true })),
      t.done ? el("span", { class: "todo-sr", text: " (done)" }) : null,
    );
    row.addEventListener("click", (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      open(t);
    });
    return el("li", {}, row);
  });
  return el(
    "section",
    { class: "todo-hits", "aria-label": "To-dos" },
    el("div", { class: "section-head" }, el("span", { text: tasks.length === 1 ? "1 to-do" : `${tasks.length} to-dos` })),
    el("ul", { class: "todo-hits__list" }, ...rows),
  );
}
