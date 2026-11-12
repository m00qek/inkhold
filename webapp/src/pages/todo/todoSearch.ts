// To-dos in the library-wide search: a row in the search index per task and
// per list (`todoRows`), matched there like everything else, and painted here
// as their own group: the lists named like the query, then the tasks, each
// with the matched words marked; the typo ladder's notice is the search's own.

import { el } from "../../ui/dom";
import { ICONS, svg } from "../../ui/icons";
import type { TodoSnapshot, TodoTask } from "../../api/todoTypes";
import { byTabletOrder, homeView, listName, newestDone, openCount, viewPath, type TodoView } from "./todoModel";
import { holdsInside, insideMarks, insideOf, typedMarks } from "../../search/match";
import { fields, type ItemRow } from "../../search/itemRows";
import type { Expansion } from "../../search/localSearch";
import { taskMeta } from "./todoView";
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

/** What a to-do is found by, each a field: its title, the notebook and words it was lassoed from, and its list. */
function searchText(s: TodoSnapshot, t: TodoTask): string {
  return fields(t.title, t.link?.name, t.link?.text, listName(s, t.listId));
}

const TASK = "t:";
const LIST = "l:";

/** The search index's rows for To-Do: one per task, one per list by its name, the Inbox too (key `l:`). */
export function todoRows(s: TodoSnapshot): ItemRow[] {
  if (!s.enabled) return [];
  return [
    ...s.tasks.map((t) => ({ key: TASK + t.id, text: searchText(s, t) })),
    { key: LIST, text: "Inbox" },
    ...s.lists.map((l) => ({ key: LIST + l.id, text: fields(l.title) })),
  ];
}

export interface TodoFind {
  /** Open tasks in list order, then done ones, newest first. */
  readonly tasks: TodoTask[];
  /** Lists named like the query; null is the Inbox. */
  readonly lists: { readonly id: string | null; readonly name: string }[];
  /** Found by the typo ladder's spelling, not as typed. */
  readonly corrected: boolean;
  /** Where the matched words are in a title or a list's name. */
  marks(text: string): [number, number][];
}

/**
 * The to-dos the index found (`keys`, `todoRows`'), in the tablet's order.
 * When none matched as typed, the typed text anywhere in a to-do comes first
 * ("abin" in "gabin", `match.ts`), then the typo ladder's answer.
 */
export function findTodos(s: TodoSnapshot, q: string, keys: readonly string[], expansions: readonly Expansion[]): TodoFind {
  const lists = [{ id: null as string | null, name: "Inbox" }, ...s.lists.map((l) => ({ id: l.id as string | null, name: l.title }))];
  if (keys.length > 0 && expansions.length === 0) return found(s, q, keys, lists, []);
  const inside = insideOf(q);
  const tasks = s.tasks.filter((t) => holdsInside(searchText(s, t), inside));
  const named = lists.filter((l) => holdsInside(l.name, inside));
  if (tasks.length > 0 || named.length > 0) return { tasks: ordered(s, tasks), lists: named, corrected: false, marks: (text) => insideMarks(text, inside) };
  return found(s, q, keys, lists, expansions);
}

function found(s: TodoSnapshot, q: string, keys: readonly string[], lists: TodoFind["lists"], expansions: readonly Expansion[]): TodoFind {
  const want = new Set(keys);
  const tasks = s.tasks.filter((t) => want.has(TASK + t.id));
  const named = lists.filter((l) => want.has(LIST + (l.id ?? "")));
  const corrected = expansions.length > 0 && (tasks.length > 0 || named.length > 0);
  return { tasks: ordered(s, tasks), lists: named, corrected, marks: (text) => typedMarks(text, q, expansions) };
}

function ordered(s: TodoSnapshot, hit: TodoTask[]): TodoTask[] {
  const listOrder = new Map<string | null, number>([[null, 0], ...s.lists.map((l, i): [string, number] => [l.id, i + 1])]);
  const open = hit.filter((t) => !t.done).sort((a, b) => (listOrder.get(a.listId) ?? 0) - (listOrder.get(b.listId) ?? 0) || byTabletOrder(a, b));
  const done = hit.filter((t) => t.done).sort(newestDone);
  return [...open, ...done];
}

/** The To-dos group of the library's search; null when nothing matched: the search says nothing about to-dos. */
export function todoHits(
  snap: TodoSnapshot,
  found: TodoFind,
  now: number,
  open: (task: TodoTask) => void,
  chip: (task: TodoTask) => HTMLElement | null,
  openList: (view: TodoView) => void,
): HTMLElement | null {
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
  return el(
    "section",
    { class: "todo-hits", "aria-label": "To-dos" },
    el("h2", { class: "section-head" }, el("span", { text: counts.join(" · ") })),
    el("ul", { class: "todo-hits__list" }, ...listRows, ...taskRows),
  );
}
