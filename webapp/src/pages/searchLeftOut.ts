// The documents search keeps no text for (`search/termsBudget.ts`), named
// under the line that counts them: a closed list, so the count stays one line
// until the person asks which. Names come from the listing the app holds, by
// file id; a document the walk hasn't reached yet is counted, never shown as
// an id. Once the walk has landed, the page drops ids it doesn't name before
// they get here (`gallerySearch.ts`): those have left the library.

import { el } from "../ui/dom";
import { onPlainClick } from "../ui/link";
import { go, noteHref } from "../router";
import type { Id } from "../core/types";

/** Names listed before "and N more": enough to scan, short enough to stay a list. */
export const LEFT_OUT_SHOWN = 50;

/** What the listing says about a left-out document. */
export interface LeftOutName {
  readonly name: string;
  /** The folders above it, as the results show them; null at the top. */
  readonly folderPath: string | null;
}

export interface LeftOutEntry extends LeftOutName {
  readonly id: Id;
}

export interface LeftOutList {
  /** In keep order, at most `LEFT_OUT_SHOWN`. */
  readonly shown: readonly LeftOutEntry[];
  /** Named, past the cap. */
  readonly more: number;
  /** Not in the listing yet, while the walk is still running: no name to show. */
  readonly unlisted: number;
}

/**
 * Pure. `ids` are `LocalResults.leftOut`, numbers as the index sends them;
 * the listing's ids are decimal strings. Each copy of a file is its own id,
 * so it is listed once per copy, each with its own name and place.
 */
export function leftOutList(ids: readonly number[], nameOf: (id: Id) => LeftOutName | null): LeftOutList {
  const named: LeftOutEntry[] = [];
  let unlisted = 0;
  for (const fileId of ids) {
    const id = String(fileId);
    const known = nameOf(id);
    if (known) named.push({ id, ...known });
    else unlisted += 1;
  }
  return { shown: named.slice(0, LEFT_OUT_SHOWN), more: Math.max(0, named.length - LEFT_OUT_SHOWN), unlisted };
}

export interface SearchLeftOut {
  /** The disclosure for the search `q`, or null when nothing is left out. */
  block(q: string, ids: readonly number[], nameOf: (id: Id) => LeftOutName | null): HTMLElement | null;
}

export function createSearchLeftOut(): SearchLeftOut {
  /**
   * The block last handed out and its search, read for its open state: the
   * gallery repaints whenever an answer lands, and the list must not close
   * under the person reading it (as `searchCoverage.ts`). A new search starts
   * closed: what was opened was another answer's list.
   */
  let shown: { q: string; box: HTMLDetailsElement } | null = null;

  return {
    block(q, ids, nameOf) {
      if (ids.length === 0) return null;
      const list = leftOutList(ids, nameOf);
      const rows = list.shown.map((entry) => {
        const href = noteHref(entry.id);
        const link = el("a", { class: "left-out__name", href, text: entry.name });
        onPlainClick(link, () => go(href));
        return el("li", {}, link, entry.folderPath ? el("span", { class: "left-out__where", text: entry.folderPath }) : null);
      });
      const rest = [
        list.more > 0 ? `and ${list.more} more` : null,
        list.unlisted > 0 ? `${list.unlisted} more not listed yet` : null,
      ].flatMap((text) => (text ? [el("p", { class: "left-out__rest", text })] : []));
      const box = el(
        "details",
        { class: "left-out" },
        el("summary", {}, el("span", { class: "left-out__more", text: "Show them" })),
        rows.length > 0 ? el("ul", { class: "left-out__list" }, ...rows) : null,
        ...rest,
      );
      box.open = shown?.q === q && shown.box.open;
      shown = { q, box };
      return box;
    },
  };
}
