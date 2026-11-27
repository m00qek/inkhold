// The account page's "Search": what this browser's search
// reads the text of. A preference of the browser, not of the account, so it
// is kept beside the theme (`ui/searchScope.ts`), with no round trip.
// Notebooks are always searched; each other kind is a checkbox, which says
// its own state, unlike a toggle button.

import { el } from "../../ui/dom";
import { SCOPE_KINDS, type ScopeKind } from "../../search/searchScope";
import type { SearchScopeSetting } from "../../ui/searchScope";

/** Each kind's switch: its label and what it covers. */
const SWITCHES: Readonly<Record<ScopeKind, { label: string; covers: string }>> = {
  documents: { label: "Search inside documents", covers: "PDFs, XPS documents and text files" },
};

/**
 * What turning a kind off does, in the person's terms. It says "this
 * browser": the group's label doesn't. Notebooks never lose room to documents
 * (`termsBudget.ts` keeps them first), so it promises less to keep, not more
 * room.
 */
export const SEARCH_SCOPE_HINT =
  "Off, this browser no longer downloads or keeps the text inside documents, so it stores less and search uses less memory. Documents are still found by name, and by Find inside one you open.";

/** One account page at a time, so one id. */
const HINT_ID = "acct-search-scope-hint";

export interface SearchScopeSection {
  /** The rows: the notebooks' line, then a switch per kind. */
  readonly body: HTMLElement;
  readonly hint: HTMLElement;
  /** Stops following the setting. */
  dispose(): void;
}

export function createSearchScopeSection(setting: Pick<SearchScopeSetting, "get" | "set" | "subscribe">): SearchScopeSection {
  const boxes = new Map<ScopeKind, HTMLInputElement>();
  const switches = SCOPE_KINDS.map((kind) => {
    // The hint says what off costs: read with the box, not only after it.
    const box = el("input", { type: "checkbox", class: "check__box", "aria-describedby": HINT_ID });
    box.addEventListener("change", () => setting.set(kind, box.checked));
    boxes.set(kind, box);
    return el(
      "label",
      { class: "acct-row acct-check check" },
      box,
      el("span", { class: "acct-check__text" }, el("span", { text: SWITCHES[kind].label }), el("small", { text: SWITCHES[kind].covers })),
    );
  });

  const paint = () => {
    const scope = setting.get();
    for (const [kind, box] of boxes) box.checked = scope[kind];
  };
  paint();
  // Another tab may switch it while this page is open.
  const unsubscribe = setting.subscribe(paint);

  const body = el(
    "div",
    { class: "acct-rows" },
    el(
      "div",
      { class: "acct-row" },
      el("div", { class: "acct-row__k", text: "Notebooks" }),
      el("div", { class: "acct-row__v acct-data", text: "Always searched" }),
    ),
    ...switches,
  );
  const hint = el("p", { class: "acct-hint", id: HINT_ID, text: SEARCH_SCOPE_HINT });
  return { body, hint, dispose: unsubscribe };
}
