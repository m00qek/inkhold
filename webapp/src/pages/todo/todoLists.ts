// The To-Do page's lists: making, renaming and deleting one, and the bar's
// list menu (⋯ on a list's page) and New list button. A part of the page,
// built from its context.

import { setMenuRows } from "../../ui/barMenu";
import { ICONS } from "../../ui/icons";
import { DEFAULT_SECTION_TITLE } from "../../ui/menu";
import { viewPath } from "./todoModel";
import type { TodoCtx } from "./todoContext";

export interface TodoLists {
  /** Ask a name, create the list; with `then`, act on it (move a task there) instead of opening it. */
  newList(then?: (id: string) => Promise<unknown>): Promise<void>;
  /** The list on screen when no id is given. */
  renameList(id?: string | null): void;
  deleteList(id?: string | null): void;
  destroy(): void;
}

export function createTodoLists(ctx: TodoCtx): TodoLists {
  const { host, menus, st } = ctx;

  async function newList(then?: (id: string) => Promise<unknown>): Promise<void> {
    const title = await menus.askName("New list", "Create list", "");
    if (!title) return;
    let created = "";
    if (!(await ctx.run("create the list", async () => { created = await host.api.todoCreateList(title); }))) return;
    if (then) {
      if (await ctx.run("move the task", () => then(created))) ctx.say(`Created "${title}" and moved the task there.`);
    } else {
      host.go(viewPath({ kind: "list", id: created }));
    }
  }

  /** The list on screen, or the one a card's menu names. */
  const listHere = (): string | null => (st.view.kind === "list" ? st.view.id : null);

  function renameList(id = listHere()): void {
    if (!st.snap || id === null) return;
    const current = st.snap.lists.find((l) => l.id === id)?.title ?? "";
    void menus.askName("Rename list", "Rename", current).then((title) => {
      if (title && title !== current) void ctx.run("rename the list", () => host.api.todoRenameList(id, title));
    });
  }

  function deleteList(id = listHere()): void {
    if (!st.snap || id === null) return;
    const list = st.snap.lists.find((l) => l.id === id);
    if (!list) return;
    const n = st.snap.tasks.filter((t) => t.listId === id).length;
    void menus.confirmDeleteList(list.title, n).then(async (ok) => {
      if (!ok) return;
      if (await ctx.run("delete the list", () => host.api.todoDeleteList(id))) {
        ctx.say(`Deleted "${list.title}".`);
        if (st.view.kind !== "overview") host.go("");
      }
    });
  }

  const onListBtn = (e: MouseEvent): void => {
    e.stopPropagation();
    if (host.listBtn.getAttribute("aria-expanded") === "true") return menus.close();
    // The card's ⋯ menu, header and all.
    menus.pop(host.listBtn, [
      menus.section(DEFAULT_SECTION_TITLE),
      menus.item("Rename list", "edit", () => renameList()),
      menus.item("Delete list", "trash", () => deleteList(), true),
    ]);
  };
  const onNewList = (): void => void newList();
  host.listBtn.addEventListener("click", onListBtn);
  host.newListBtn.addEventListener("click", onNewList);
  // On a phone the bar folds into ⋯ (`ui/barMenu.ts`); the list menu hands
  // it its rows rather than opening a menu inside a menu.
  setMenuRows(host.listBtn, () => [
    { kind: "section", title: DEFAULT_SECTION_TITLE },
    { kind: "item", label: "Rename list", icon: ICONS.edit, onSelect: () => renameList() },
    { kind: "item", label: "Delete list", icon: ICONS.trash, danger: true, onSelect: () => deleteList() },
  ]);

  return {
    newList,
    renameList,
    deleteList,
    destroy() {
      host.listBtn.removeEventListener("click", onListBtn);
      host.newListBtn.removeEventListener("click", onNewList);
    },
  };
}
