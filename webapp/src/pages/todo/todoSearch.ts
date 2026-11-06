// To-dos in the library-wide search: the browser already holds them all, so
// they are matched here (`todoModel.findTodos`) and painted as their own
// group: the lists named like the query, then the tasks, each with the
// matched words marked, and the typo fallback said as the notes say it.

import { el } from "../../ui/dom";
import { ICONS, svg } from "../../ui/icons";
import type { TodoSnapshot, TodoTask } from "../../api/todoTypes";
import { findTodos, homeView, openCount, viewPath, type TodoView } from "./todoModel";
import { taskMeta } from "./todoView";
import { expansionNotice } from "../noteSearch";
import { onPlainClick } from "../../ui/link";

/** Text and `<mark>` around the given ranges; never markup: titles are the person's own text. */
function marked(text: string, ranges: readonly (readonly [number, number])[]): Node[] {
  const out: Node[] = [];
  let from = 0;
  for (const [a, b] of ranges) {
    if (a > from) out.push(document.createTextNode(text.slice(from, a)));
    out.push(el("mark", { text: text.slice(a, b) }));
    from = b;
  }
  if (from < text.length) out.push(document.createTextNode(text.slice(from)));
  return out;
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

const onOpen = (a: HTMLElement, open: () => void) => onPlainClick(a, open);

/** Null when nothing matched (or To-Do is off): the search says nothing about to-dos. */
export function todoHits(
  snap: TodoSnapshot | null,
  q: string,
  now: number,
  open: (task: TodoTask) => void,
  chip: (task: TodoTask) => HTMLElement | null,
  openList: (view: TodoView) => void,
): HTMLElement | null {
  if (!snap?.enabled) return null;
  const found = findTodos(snap, q);
  if (found.tasks.length === 0 && found.lists.length === 0) return null;

  const listRows = found.lists.map((l) => {
    const view: TodoView = l.id === null ? { kind: "inbox" } : { kind: "list", id: l.id };
    const left = openCount(snap, view);
    const row = el(
      "a",
      { class: "todo-hit todo-hit--list", href: `#/todo/${viewPath(view)}` },
      el("span", { class: "todo-hit__icon", "aria-hidden": "true", html: svg(l.id === null ? ICONS.inbox : ICONS.list) }),
      el(
        "div",
        { class: "todo-hit__main" },
        el("span", { class: "todo-hit__title" }, ...marked(l.name, found.marks(l.name))),
        el("div", { class: "todo-meta" }, el("span", { text: left === 0 ? "List · nothing to do" : `List · ${left} to do` })),
      ),
    );
    onOpen(row, () => openList(view));
    return el("li", {}, row);
  });

  const taskRows = found.tasks.map((t) => {
    const row = el(
      "a",
      { class: "todo-hit" + (t.done ? " is-done" : ""), href: `#/todo/${viewPath(homeView(t))}` },
      el("span", { class: "todo-hit__ring", "aria-hidden": "true", html: t.done ? svg(ICONS.tick, 2.4) : "" }),
      el(
        "div",
        { class: "todo-hit__main" },
        el("span", { class: "todo-hit__title" }, ...marked(t.title, found.marks(t.title))),
        taskMeta(t, snap, now, { showList: true }),
      ),
      chip(t),
      t.done ? el("span", { class: "todo-sr", text: " (done)" }) : null,
    );
    onOpen(row, () => open(t));
    return el("li", {}, row);
  });

  const counts = [found.lists.length ? plural(found.lists.length, "list") : "", found.tasks.length ? plural(found.tasks.length, "to-do") : ""].filter(Boolean);
  const notice = expansionNotice(found.expansions);
  return el(
    "section",
    { class: "todo-hits", "aria-label": "To-dos" },
    el("div", { class: "section-head" }, el("span", { text: counts.join(" · ") })),
    notice
      ? el(
          "p",
          { class: "hits__notice", role: "status" },
          ...notice.map((p) => (p.matched ? el("strong", { class: "hits__matched", text: p.text }) : document.createTextNode(p.text))),
        )
      : null,
    el("ul", { class: "todo-hits__list" }, ...listRows, ...taskRows),
  );
}
