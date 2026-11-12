// To-dos found by the search index (the real `sqlite-core.wasm`): its rows
// from `todoRows`, its answer read back by `findTodos`.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SearchIndex, type SearchCoreExports } from "../../src/search/indexEngine";
import type { TodoSnapshot, TodoTask } from "../../src/api/todoTypes";
import { findTodos, todoRows } from "../../src/pages/todo/todoSearch";

const bytes = readFileSync(fileURLToPath(new URL("../../public/sqlite-core.wasm", import.meta.url)));
let index: SearchIndex;
beforeAll(async () => {
  index = await SearchIndex.open(async () => {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const core = instance.exports as unknown as SearchCoreExports;
    core._initialize?.();
    return core;
  });
  index.build([]);
});
afterAll(() => index.close());

let n = 0;
const task = (p: Partial<TodoTask>): TodoTask => ({
  id: `t${++n}`, listId: null, title: "x", done: false, due: null, completedAt: null, sort: 0, sortTime: 0, linked: false, link: null, waiting: false, ...p,
});
const casa = { id: "casa", title: "Casa", waiting: false };
const snap = (tasks: TodoTask[]): TodoSnapshot => ({ enabled: true, lists: [casa], tasks, tabletSyncedAt: null, waiting: false });

/** What the library search does: the rows into the index, its answer back to the to-dos. */
function find(s: TodoSnapshot, q: string) {
  index.setItems("todo", todoRows(s));
  const r = index.query(q, 1000, true);
  return findTodos(s, q, r.items.filter((i) => i.kind === "todo").map((i) => i.key), r.expansions);
}
const ids = (f: { tasks: TodoTask[] }) => f.tasks.map((t) => t.id);

describe("finding to-dos", () => {
  const a = task({ id: "a", title: "Revisar o passé composé" });
  const b = task({ id: "b", title: "Haus of gabin", link: { noteId: "9", page: 27, name: "Apostila", text: null } });

  it("by the index's rule: accents aside, words in any order, the note's name too", () => {
    expect(ids(find(snap([a, b]), "passe compose"))).toEqual(["a"]);
    expect(ids(find(snap([a, b]), "composé revisar"))).toEqual(["a"]);
    expect(ids(find(snap([a, b]), "gabin apostila"))).toEqual(["b"]);
    expect(find(snap([a, b]), "passe compose zzz").tasks).toEqual([]);
  });

  it("when no word starts like the query, the typed text anywhere in a to-do", () => {
    expect(ids(find(snap([a, b]), "abin"))).toEqual(["b"]);
  });

  it("holds a quoted phrase to its order", () => {
    expect(ids(find(snap([a, b]), '"passé composé"'))).toEqual(["a"]);
    expect(find(snap([a, b]), '"composé passé"').tasks).toEqual([]);
  });
});

describe("finding to-dos: lists, lassoed words, typos, marks", () => {
  const ligar = task({ id: "l", title: "Ligar para o dentista", listId: "casa" });
  const haus = task({ id: "h", title: "Comprar pão", link: { noteId: "9", page: 27, name: "Apostila", text: "Haus of gabin" } });

  it("a list named like the query is found, and so are its tasks", () => {
    const f = find(snap([ligar, haus]), "casa");
    expect(f.lists).toEqual([{ id: "casa", name: "Casa" }]);
    expect(ids(f)).toEqual(["l"]);
  });

  it("the Inbox by its name", () => {
    expect(find(snap([haus]), "inbox").lists).toEqual([{ id: null, name: "Inbox" }]);
  });

  it("words in any order across title and list", () => {
    expect(ids(find(snap([ligar, haus]), "casa dentista"))).toEqual(["l"]);
  });

  it("the words it was lassoed from still find a renamed task", () => {
    expect(ids(find(snap([ligar, haus]), "gabin"))).toEqual(["h"]);
  });

  it("marks the matched words in the title, accents aside", () => {
    const f = find(snap([ligar, haus]), "dentista casa");
    expect(f.marks("Ligar para o dentista").map(([x, y]) => "Ligar para o dentista".slice(x, y))).toEqual(["dentista"]);
    expect(find(snap([haus]), "pao").marks("Comprar pão").map(([x, y]) => "Comprar pão".slice(x, y))).toEqual(["pão"]);
  });

  it("when nothing matches as typed, the nearest spelling, said, as the notes do", () => {
    const f = find(snap([ligar, haus]), "dentsta");
    expect(ids(f)).toEqual(["l"]);
    expect(f.corrected).toBe(true);
    expect(f.marks("Ligar para o dentista").length).toBe(1);
  });

  it("no typo answer for words too short to correct, or too far off", () => {
    expect(find(snap([ligar]), "pra").tasks).toEqual([]);
    expect(find(snap([ligar]), "xyzzyq").tasks).toEqual([]);
  });

  it("finds nothing when To-Do is off", () => {
    expect(todoRows({ ...snap([ligar]), enabled: false })).toEqual([]);
  });
});
