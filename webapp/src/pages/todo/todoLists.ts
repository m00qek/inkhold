// The To-Do page's lists: making, renaming and deleting one (the apps' shared
// dialogs, `ui/nameDialog.ts`), and the bar's list menu (⋯ on a list's page)
// and New list button. A part of the page, built from its context.

import { rowsFromItems, setMenuRows, toggleBarMenu, type BarRow } from "../../ui/barMenu";
import { listActions } from "./todoView";
import { askName, confirmDelete } from "../../ui/nameDialog";
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

/** The longest list name the field takes, as before the dialogs were shared. */
const MAX_LIST_TITLE = 60;

export function createTodoLists(ctx: TodoCtx): TodoLists {
  const { host, st } = ctx;

  async function newList(then?: (id: string) => Promise<unknown>): Promise<void> {
    const title = await askName({ title: "New list", goLabel: "Create list", initial: "", maxLength: MAX_LIST_TITLE });
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
    void askName({ title: "Rename list", goLabel: "Rename", initial: current, maxLength: MAX_LIST_TITLE }).then((title) => {
      if (title) void ctx.run("rename the list", () => host.api.todoRenameList(id, title));
    });
  }

  function deleteList(id = listHere()): void {
    if (!st.snap || id === null) return;
    const list = st.snap.lists.find((l) => l.id === id);
    if (!list) return;
    const n = st.snap.tasks.filter((t) => t.listId === id).length;
    void confirmDelete({
      title: n ? `Delete "${list.title}" and its ${n} task${n === 1 ? "" : "s"}?` : `Delete "${list.title}"?`,
      body: n ? "They are also removed from the tablet at its next sync. This can't be undone." : "It is also removed from the tablet at its next sync.",
      goLabel: "Delete list",
    }).then(async (ok) => {
      if (!ok) return;
      if (await ctx.run("delete the list", () => host.api.todoDeleteList(id))) {
        ctx.say(`Deleted "${list.title}".`);
        if (st.view.kind !== "overview") host.go("");
      }
    });
  }

  /** The card's ⋯ menu, header and all, from the bar. */
  const listRows = (): BarRow[] => {
    const id = listHere();
    return id === null ? [] : rowsFromItems(DEFAULT_SECTION_TITLE, listActions(id, { renameList, deleteList }));
  };
  const onListBtn = (e: MouseEvent): void => {
    e.stopPropagation();
    toggleBarMenu(host.listBtn, listRows());
  };
  const onNewList = (): void => void newList();
  host.listBtn.addEventListener("click", onListBtn);
  host.newListBtn.addEventListener("click", onNewList);
  // On a phone the bar folds into ⋯ (`ui/barMenu.ts`); the list menu hands
  // it its rows rather than opening a menu inside a menu.
  setMenuRows(host.listBtn, listRows);

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
