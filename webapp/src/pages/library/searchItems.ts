// What search finds besides document pages, written into the search index as
// rows of their own: the library's names (`nameRows`), read from the cached
// tree, and the tablet's apps, the last To-Do and Digest answers (`todoRows`,
// `digestRows`), kept on the device (`cache/itemStore.ts`) so search finds
// them offline too (#18). The pages hand each answer over; until the first
// one, the stored one stands in. A change re-asks an open search, so what was
// just saved is found at once.

import type { TodoSnapshot } from "../../api/todoTypes";
import type { DigestSnapshot } from "../../api/digestTypes";
import type { ItemStore } from "../../cache/itemStore";
import type { SearchService } from "../../search/searchService";
import { fields, type ItemRow } from "../../search/itemRows";
import type { FolderCache } from "../folderCache";
import { FOLDER, NOTE } from "../gallerySearch";
import type { Folder } from "../../core/types";
import { todoRows } from "../todo/todoSearch";
import { digestRows } from "../digest/digestSearch";

/** The search index's rows for names: every note's, and every folder's by the label the rail shows. */
export function nameRows(folders: Pick<FolderCache, "values">, labelFor: (folder: Folder) => string): ItemRow[] {
  const rows = new Map<string, string>();
  for (const cached of folders.values()) {
    for (const e of cached.entries) {
      if (e.kind === "note") rows.set(NOTE + e.id, fields(e.name));
      else rows.set(FOLDER + e.id, fields(labelFor(e)));
    }
  }
  return [...rows].map(([key, text]) => ({ key, text }));
}

export interface SearchItems {
  /** The To-Do answer search uses: the page's last, or the stored one. */
  todo(): TodoSnapshot | null;
  digest(): DigestSnapshot | null;
  /** The page's answer; null (its load failed) keeps what search has. */
  setTodo(s: TodoSnapshot | null): void;
  setDigest(s: DigestSnapshot | null): void;
  /**
   * Reads the names again (the tree changed, or a search is about to run). A
   * change re-asks the search, unless `quiet`: a question about to be asked
   * reads them anyway.
   */
  refreshNames(quiet?: boolean): void;
}

export interface SearchItemsDeps {
  service: Pick<SearchService, "setItems">;
  store: ItemStore;
  /** Every name the library shows, from the cached tree. */
  names(): ItemRow[];
  /** Search's rows changed: re-ask an open search. */
  onChanged(): void;
}

/** Two answers alike: plain data, so their JSON says it. */
function same(a: unknown, b: unknown): boolean {
  return b !== null && JSON.stringify(a) === JSON.stringify(b);
}

export function createSearchItems(deps: SearchItemsDeps): SearchItems {
  const { service, store } = deps;
  let todo: TodoSnapshot | null = null;
  let digest: DigestSnapshot | null = null;
  /** The pages answered: the stored copies are no longer wanted. */
  let todoLive = false;
  let digestLive = false;
  /** The names last written, as one string: a tree walk mostly changes nothing. */
  let namesHeld = "";

  function useTodo(s: TodoSnapshot): void {
    todo = s;
    service.setItems("todo", todoRows(s));
    deps.onChanged();
  }

  function useDigest(s: DigestSnapshot): void {
    digest = s;
    service.setItems("digest", digestRows(s));
    deps.onChanged();
  }

  void store.get<TodoSnapshot>("todo").then((s) => {
    if (s && !todoLive) useTodo(s);
  });
  void store.get<DigestSnapshot>("digest").then((s) => {
    if (s && !digestLive) useDigest(s);
  });

  return {
    todo: () => todo,
    digest: () => digest,
    setTodo(s) {
      // A poll answers anew each time; only a change re-asks the search.
      if (!s || same(s, todo)) return;
      todoLive = true;
      void store.put("todo", s);
      useTodo(s);
    },
    setDigest(s) {
      if (!s || same(s, digest)) return;
      digestLive = true;
      void store.put("digest", s);
      useDigest(s);
    },
    refreshNames(quiet = false) {
      const rows = deps.names();
      const held = rows.map((r) => `${r.key}\t${r.text}`).join("\n");
      if (held === namesHeld) return;
      namesHeld = held;
      service.setItems("name", rows);
      if (!quiet) deps.onChanged();
    },
  };
}
