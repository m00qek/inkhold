// The excerpt line under each library search result (`search/excerpt.ts`
// picks it). A result paints at once with an empty line; the line is filled
// when the result scrolls into view and its text is already in the browser.
// Nothing is fetched for it: a document whose text isn't held shows none.
// Answers are kept per document, text version, query and typo answer, so a
// repaint or the same query typed again reads them back.

import { el } from "../ui/dom";
import { excerptNodes, excerptQuery, pickExcerpt, type Excerpt } from "../search/excerpt";
import type { Expansion } from "../search/localSearch";
import type { TextStore } from "../cache/textStore";

export interface SearchExcerptsDeps {
  store: Pick<TextStore, "get">;
  /** The document's text version, from the last manifest; null: unknown, no excerpt. */
  indexVersion(md5: string): number | null;
}

export interface SearchExcerpts {
  /**
   * The line for one result: empty until filled. `onPick` hears which page
   * (or `.txt` paragraph) it came from, so opening the result lands there.
   * `pageWord` labels it ("p." for pages); null: no label.
   */
  slot(
    hit: { md5: string; pages: readonly number[] },
    q: string,
    expansions: readonly Expansion[],
    pageWord: string | null,
    onPick: (segment: number) => void,
  ): HTMLElement;
}

export function createSearchExcerpts(d: SearchExcerptsDeps): SearchExcerpts {
  const answers = new Map<string, Promise<Excerpt | null>>();
  /** The lines waiting on each answer: work goes on while one is still on screen. */
  const lines = new Map<string, Set<Element>>();
  const wanted = (key: string) => [...(lines.get(key) ?? [])].some((l) => l.isConnected);
  interface Waiting {
    run(): void;
  }
  const waiting = new Map<Element, Waiting>();

  const seen = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const w = waiting.get(e.target);
      waiting.delete(e.target);
      seen!.unobserve(e.target);
      w?.run();
    }
  }, { rootMargin: "200px" });

  /** Lines of results a newer search replaced: stop watching them. */
  function prune(): void {
    for (const t of waiting.keys()) {
      if (t.isConnected) continue;
      waiting.delete(t);
      seen?.unobserve(t);
    }
  }

  function answer(md5: string, v: number, pages: readonly number[], q: string, expansions: readonly Expansion[], line: HTMLElement): Promise<Excerpt | null> {
    const key = `${md5}:${v}:${q}:${expansions.map((e) => `${e.typed}>${e.matched}`).join(",")}`;
    const mine = lines.get(key) ?? new Set<Element>();
    mine.add(line);
    lines.set(key, mine);
    let a = answers.get(key);
    if (!a) {
      a = (async () => {
        const doc = await d.store.get(md5, v).catch(() => null);
        // Typing on replaced every line waiting on this: skip the work.
        if (!doc || !wanted(key)) return null;
        const query = excerptQuery(q, expansions);
        return query ? pickExcerpt(doc, pages, query) : null;
      })();
      // Work skipped for gone lines is not an answer; let it be asked again.
      void a.then((x) => {
        if (x === null && !wanted(key)) answers.delete(key);
        lines.delete(key);
      });
      answers.set(key, a);
    }
    return a;
  }

  return {
    slot(hit, q, expansions, pageWord, onPick) {
      prune();
      const line = el("div", { class: "card__excerpt" });
      const v = d.indexVersion(hit.md5);
      if (v === null || hit.pages.length === 0) return line;
      const run = () => {
        void answer(hit.md5, v, hit.pages, q, expansions, line).then((x) => {
          if (!x || !line.isConnected) return;
          line.replaceChildren(...(pageWord === null ? [] : [el("span", { class: "card__excerpt-page", text: `${pageWord} ${x.segment + 1}` })]), ...excerptNodes(x));
          line.classList.add("is-filled");
          onPick(x.segment);
        });
      };
      if (seen) {
        waiting.set(line, { run });
        seen.observe(line);
      } else {
        run();
      }
      return line;
    },
  };
}
