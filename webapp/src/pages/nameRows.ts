// File and folder names in the library-wide search: a row in the search index
// per note and per folder (`nameRows`), and the ids an answer's keys name
// (`namedIds`), so the key's spelling lives in one place.

import { fields, type ItemRow } from "../search/itemRows";
import type { FolderCache } from "./folderCache";
import type { Folder, Id } from "../core/types";

const NOTE = "n:";
const FOLDER = "f:";

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

/** The notes and folders the index's name keys name. */
export function namedIds(keys: readonly string[]): { notes: Set<Id>; folders: Set<Id> } {
  const notes = new Set<Id>();
  const folders = new Set<Id>();
  for (const key of keys) {
    if (key.startsWith(NOTE)) notes.add(key.slice(NOTE.length));
    else if (key.startsWith(FOLDER)) folders.add(key.slice(FOLDER.length));
  }
  return { notes, folders };
}
