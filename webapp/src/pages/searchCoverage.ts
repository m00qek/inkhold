// How much of the person's handwriting search can find, said where they
// search. Only what the tablet recognized is searchable, so a note with
// recognition off, or pages not recognized yet, is invisible to search except
// by name. One line with the total, opening to the notes that need attention
// and why. Fetched once per search, from `GET …/search-index/coverage`.

import { el } from "../ui/dom";
import { go, noteHref } from "../router";
import type { Api, NoteCoverage } from "../api/types";

/** Coverage answers this long before a new search asks again. */
const FRESH_MS = 60_000;

export interface CoverageSummary {
  readonly written: number;
  readonly recognized: number;
  /** Notes with pages search can't find, most unsearchable pages first. */
  readonly attention: readonly NoteCoverage[];
}

/** Pages of a note search can't find: everything when recognition is off. */
export function unsearchable(n: NoteCoverage): number {
  return Math.max(0, n.written - n.recognized);
}

export function summarize(notes: readonly NoteCoverage[]): CoverageSummary {
  let written = 0;
  let recognized = 0;
  for (const n of notes) {
    written += n.written;
    recognized += Math.min(n.recognized, n.written);
  }
  const attention = notes.filter((n) => unsearchable(n) > 0).sort((a, b) => unsearchable(b) - unsearchable(a));
  return { written, recognized, attention };
}

const pages = (n: number) => `${n} ${n === 1 ? "page" : "pages"}`;

/** Why a note's pages can't be found, in the person's terms. */
export function why(n: NoteCoverage): string {
  if (!n.recognition) return `Recognition is off on the tablet: ${pages(n.written)} with writing can't be searched`;
  const waiting = Math.min(n.running, unsearchable(n));
  const missing = unsearchable(n) - waiting;
  const parts: string[] = [];
  if (missing > 0) parts.push(`${missing} of ${pages(n.written)} with writing not recognized`);
  if (waiting > 0) parts.push(`${pages(waiting)} still being recognized on the tablet`);
  return parts.join("; ");
}

/** The headline: how much of the handwriting search reads. */
export function coverageText(s: CoverageSummary): string {
  if (s.written === 0) return "No handwriting to search yet.";
  if (s.attention.length === 0) return `All your handwriting is searchable: ${pages(s.written)}.`;
  return `Handwriting is searchable on ${s.recognized} of ${pages(s.written)} with writing.`;
}

export interface SearchCoverage {
  /** The last answer, or null before the first; asks again when stale. */
  current(): CoverageSummary | null;
  /**
   * The line and its list, or null before the first answer. `nameOf` names a
   * note from the listing; a note it doesn't know is left out of the list.
   */
  block(nameOf: (id: string) => string | null): HTMLElement | null;
}

export function createSearchCoverage(api: Pick<Api, "searchCoverage">, onChange: () => void): SearchCoverage {
  let summary: CoverageSummary | null = null;
  let at = 0;
  let asking = false;
  /** The list stays open across repaints while the person reads it. */
  let open = false;

  function ask(): void {
    if (asking || (summary && Date.now() - at < FRESH_MS)) return;
    asking = true;
    api
      .searchCoverage()
      .then((notes) => {
        summary = summarize(notes);
        at = Date.now();
        onChange();
      })
      // Coverage is a courtesy: a failure leaves search as it was.
      .catch(() => undefined)
      .finally(() => {
        asking = false;
      });
  }

  return {
    current() {
      ask();
      return summary;
    },
    block(nameOf) {
      ask();
      if (!summary || summary.written === 0) return null;
      const line = el("span", { class: "coverage__line", text: coverageText(summary) });
      if (summary.attention.length === 0) return el("p", { class: "coverage" }, line);
      const rows = summary.attention.flatMap((n) => {
        const name = nameOf(n.id);
        if (name === null) return [];
        const link = el("a", { class: "coverage__name", href: noteHref(n.id), text: name });
        link.addEventListener("click", (e) => {
          e.preventDefault();
          go(noteHref(n.id));
        });
        return [el("li", {}, link, el("span", { class: "coverage__why", text: why(n) }))];
      });
      const box = el(
        "details",
        { class: "coverage" },
        el("summary", {}, line, el("span", { class: "coverage__more", text: "Which notes" })),
        el("p", { class: "coverage__how", text: "Search reads the text the tablet recognized from your handwriting. Pages it hasn't recognized can only be found by the note's name." }),
        el("ul", { class: "coverage__list" }, ...rows),
      ) as HTMLDetailsElement;
      box.open = open;
      box.addEventListener("toggle", () => (open = box.open));
      return box;
    },
  };
}
