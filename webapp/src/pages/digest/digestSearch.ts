// Digests in the library-wide search: a row in the search index per digest
// (`digestRows`), matched there like everything else. One digest is one
// unit: its passage, its comment, its category and its source's name, so
// "whale obsession" finds the passage about the whale commented "Ahab's
// obsession". The handwritten note is not in it: the tablet does not
// recognise it.

import type { Digest, DigestSnapshot } from "../../api/digestTypes";
import { fields, type ItemRow } from "../../search/itemRows";
import type { Expansion } from "../../search/localSearch";
import { excerptNodes, excerptQuery, pickExcerpt, WIDTH, type ExcerptQuery } from "../../search/excerpt";
import { wordMarks } from "../../search/match";
import { el } from "../../ui/dom";
import { onPlainClick } from "../../ui/link";
import { digestHref } from "../../router";
import { categoryName, fileName, placePath, sourceLine, type DigestPlace } from "./digestModel";
import { shorten } from "../../core/passage";

/** The search index's rows for Digest, keyed by the digest's id. */
export function digestRows(s: DigestSnapshot): ItemRow[] {
  if (!s.enabled) return [];
  const names = new Map(s.categories.map((c) => [c.uid, c.name]));
  return s.digests.map((d) => ({
    key: d.id,
    text: fields(d.text, d.comment, names.get(d.categoryUid), d.source.path ? fileName(d.source.path) : null),
  }));
}

/** Digests the index found (`keys`), newest first, as the Digest page's All lists them. */
export function foundDigests(s: DigestSnapshot, keys: readonly string[]): Digest[] {
  const want = new Set(keys);
  return s.digests.filter((d) => want.has(d.id)).sort((a, b) => b.createdAt - a.createdAt);
}

/** `text` cut where the query's words sit closest, marked; or its start, its words still marked. */
function line(text: string, q: ExcerptQuery | null): Node[] {
  const x = q ? pickExcerpt({ segments: [{ p: 0, o: null, l: null, t: text }] }, [0], q) : null;
  if (x) return excerptNodes(x);
  const short = shorten(text, WIDTH);
  if (!q) return [document.createTextNode(short)];
  const marks = wordMarks(short, (w) => q.terms.includes(w) || (q.start !== null && w.startsWith(q.start)));
  return excerptNodes({ segment: 0, text: short, marks, cutStart: false, cutEnd: false });
}

const plural = (n: number) => `${n} ${n === 1 ? "digest" : "digests"}`;

/** The Digests group of the library's search; null when none matched. */
export function digestHits(
  s: DigestSnapshot,
  found: readonly Digest[],
  q: string,
  expansions: readonly Expansion[],
  open: (place: DigestPlace) => void,
): HTMLElement | null {
  if (found.length === 0) return null;
  const eq = excerptQuery(q, expansions);
  const rows = found.map((d) => {
    const place: DigestPlace = { view: { kind: "category", uid: null }, digest: d.id };
    const row = el(
      "a",
      { class: "digest-hit", href: digestHref(placePath(place)) },
      el("q", { class: "digest-hit__text" }, ...line(d.text, eq)),
      d.comment ? el("span", { class: "digest-hit__comment" }, ...line(d.comment, eq)) : null,
      el("span", { class: "digest-hit__meta", text: `${categoryName(s, d)} · ${sourceLine(d)}` }),
    );
    onPlainClick(row, () => open(place));
    return el("li", {}, row);
  });
  return el(
    "section",
    { class: "digest-hits", "aria-label": "Digests" },
    el("h2", { class: "section-head" }, el("span", { text: plural(found.length) })),
    el("ul", { class: "digest-hits__list" }, ...rows),
  );
}
