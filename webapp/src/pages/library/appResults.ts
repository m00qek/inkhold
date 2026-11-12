// The tablet's apps in the library-wide search: the Digests and To-dos groups,
// from the index's answer to the query on screen (`gallerySearch`'s
// `moreResults`), each only while its app keeps data. Reading them asks the
// apps again when their answers are old, digests only while the server keeps
// them.

import type { DigestSnapshot } from "../../api/digestTypes";
import type { TodoSnapshot, TodoTask } from "../../api/todoTypes";
import { answerFor, type SearchState } from "../noteSearch";
import type { MoreResults } from "../gallerySearch";
import type { DigestPlace } from "../digest/digestModel";
import { digestHits, foundDigests } from "../digest/digestSearch";
import { findTodos, todoHits } from "../todo/todoSearch";
import type { TodoView } from "../todo/todoModel";

export interface AppResultsDeps {
  state(): SearchState;
  todo(): TodoSnapshot | null;
  digest(): DigestSnapshot | null;
  /** Ask the apps again when their answers are old. */
  freshenTodo(): void;
  freshenDigest(): void;
  openDigest(place: DigestPlace): void;
  openTask(task: TodoTask): void;
  openList(view: TodoView): void;
  chip(task: TodoTask): HTMLElement | null;
  now(): number;
}

/** Both groups, digests first; null when neither has anything for `q`, or the index has not answered it. */
export function appResults(deps: AppResultsDeps, q: string): MoreResults | null {
  const digests = deps.digest();
  deps.freshenTodo();
  // Off on the server: nothing to keep up with.
  if (digests?.enabled !== false) deps.freshenDigest();
  // Like the names, only from the index's answer to this query: no group before it, or over a failure.
  const s = answerFor(deps.state(), q);
  if (!s) return null;
  const dHits = digests?.enabled ? digestHits(digests, foundDigests(digests, s.items.digest), q, s.expansions, deps.openDigest) : null;
  const snap = deps.todo();
  const found = snap?.enabled ? findTodos(snap, q, s.items.todo, s.expansions) : null;
  const tHits = snap && found ? todoHits(snap, found, deps.now(), deps.openTask, deps.chip, deps.openList) : null;
  if (!dHits && !tHits) return null;
  const node = document.createDocumentFragment();
  node.append(...[dHits, tHits].filter((x): x is HTMLElement => x !== null));
  // Digests come only from the index's answer, so from the ladder's spelling whenever it answered.
  return { node, corrected: (dHits !== null && s.expansions.length > 0) || (tHits !== null && found!.corrected) };
}
