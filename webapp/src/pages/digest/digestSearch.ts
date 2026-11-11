// Digests in the library-wide search: a row in the search index per digest
// (`digestRows`), matched there like everything else. One digest is one
// unit: its passage, its comment, its category and its source's name, so
// "whale obsession" finds the passage about the whale commented "Ahab's
// obsession". The handwritten note is not in it: the tablet does not
// recognise it.

import type { DigestSnapshot } from "../../api/digestTypes";
import type { ItemRow } from "../../search/itemRows";
import { fileName } from "./digestModel";

/** The search index's rows for Digest, keyed by the digest's id. */
export function digestRows(s: DigestSnapshot): ItemRow[] {
  if (!s.enabled) return [];
  const names = new Map(s.categories.map((c) => [c.uid, c.name]));
  return s.digests.map((d) => ({
    key: d.id,
    text: [d.text, d.comment, names.get(d.categoryUid), d.source.path ? fileName(d.source.path) : null].filter(Boolean).join("\n"),
  }));
}
