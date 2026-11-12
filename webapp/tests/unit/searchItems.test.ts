// What search keeps of the apps and the library's names, and when it asks again (`pages/library/searchItems.ts`).

import { describe, it, expect } from "vitest";
import { createSearchItems } from "../../src/pages/library/searchItems";
import type { ItemStore, StoredKind } from "../../src/cache/itemStore";
import type { ItemKind, ItemRow } from "../../src/search/itemRows";
import type { TodoSnapshot } from "../../src/api/todoTypes";

const todo = (title: string): TodoSnapshot => ({
  enabled: true,
  lists: [],
  tasks: [{ id: "t1", listId: null, title, done: false, due: null, completedAt: null, sort: 0, sortTime: 0, linked: false, link: null, waiting: false }],
  tabletSyncedAt: null,
  waiting: false,
});

function harness(stored: Partial<Record<StoredKind, unknown>> = {}, names: ItemRow[] = []) {
  const written: [ItemKind, readonly ItemRow[]][] = [];
  const kept: Partial<Record<StoredKind, unknown>> = { ...stored };
  let asked = 0;
  const store: ItemStore = {
    get: async <T>(k: StoredKind) => (kept[k] as T | undefined) ?? null,
    put: async (k, v) => {
      kept[k] = v;
    },
  };
  const items = createSearchItems({
    service: { setItems: (kind, rows) => written.push([kind, rows]) },
    store,
    names: () => names,
    onChanged: () => asked++,
  });
  return { items, written, kept, asked: () => asked, names };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("search's items", () => {
  it("the stored answer stands in until the page's own, which replaces and is kept", async () => {
    const h = harness({ todo: todo("Comprar pão") });
    await settle();
    expect(h.items.todo()?.tasks[0]?.title).toBe("Comprar pão");
    expect(h.written).toEqual([["todo", [{ key: "t:t1", text: "Comprar pão\x1fInbox" }, { key: "l:", text: "Inbox" }]]]);

    h.items.setTodo(todo("Comprar leite"));
    expect(h.items.todo()?.tasks[0]?.title).toBe("Comprar leite");
    expect(h.kept.todo).toEqual(todo("Comprar leite"));
    expect(h.asked()).toBe(2);
  });

  it("an answer like the last asks the search nothing; a failed load keeps what search has", async () => {
    const h = harness();
    await settle();
    h.items.setTodo(todo("a"));
    h.items.setTodo(todo("a"));
    h.items.setTodo(null);
    expect(h.written).toHaveLength(1);
    expect(h.asked()).toBe(1);
    expect(h.items.todo()?.tasks[0]?.title).toBe("a");
  });

  it("names are written again only when they changed", async () => {
    const h = harness({}, [{ key: "n:1", text: "Receitas" }]);
    h.items.refreshNames();
    h.items.refreshNames();
    expect(h.written).toEqual([["name", [{ key: "n:1", text: "Receitas" }]]]);
    h.names.push({ key: "f:2", text: "Aulas" });
    h.items.refreshNames();
    expect(h.written).toHaveLength(2);
    expect(h.asked()).toBe(2);
  });
});
