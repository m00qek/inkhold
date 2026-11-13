// The Digest page's model: where the person is (a view and maybe one digest),
// how that is written in the URL, and the digests' grouping and order, the
// tablet's two ways of browsing them. By category, newest first, as the
// tablet lists them. By source, each document's passages in page order, so a
// document's digests read as notes on it, top to bottom. Each way has an
// overview, a card per category or per source, as To-Do's lists have. No DOM here.

import type { Digest, DigestSnapshot, DigestSourceKind } from "../../api/digestTypes";

/**
 * The categories' overview; a category's digests (`uid` "" is Uncategorized,
 * null is All); the sources' overview; or a source's digests (`key` from
 * {@link sourceKey}).
 */
export type DigestView =
  | { kind: "categories" }
  | { kind: "category"; uid: string | null }
  | { kind: "sources" }
  | { kind: "source"; key: string };

/** A view, and the digest open in it; null: none. */
export interface DigestPlace {
  view: DigestView;
  digest: string | null;
}

const OVERVIEW: DigestView = { kind: "categories" };
export const ALL: DigestView = { kind: "category", uid: null };

/** Whether a view lists digests, which one of them may be open beside; an overview lists cards. */
export function listsDigests(v: DigestView): v is Extract<DigestView, { kind: "category" | "source" }> {
  return v.kind === "category" || v.kind === "source";
}

/**
 * The place a `#/digest/…` path names: `""` (the categories' overview), `all`,
 * `uncategorized`, `category/<uid>`, `sources` (the sources' overview),
 * `sources/<key>`; a list's maybe followed by `d/<id>`. A bare `d/<id>` (the
 * page's links before the overviews) opens in All. Anything else is the
 * overview.
 */
export function parsePlace(path: string): DigestPlace {
  const parts = path.split("/").filter((p) => p !== "").map(decode);
  let digest: string | null = null;
  if (parts.length >= 2 && parts.at(-2) === "d") {
    digest = parts.at(-1)!;
    parts.length -= 2;
  }
  const [head, arg, ...rest] = parts;
  const view: DigestView | null =
    rest.length > 0 ? null
    : head === undefined ? (digest === null ? OVERVIEW : ALL)
    : head === "all" && arg === undefined ? ALL
    : head === "uncategorized" && arg === undefined ? { kind: "category", uid: "" }
    : head === "category" && arg ? { kind: "category", uid: arg }
    : head === "sources" ? (arg === undefined ? { kind: "sources" } : { kind: "source", key: arg })
    : null;
  if (view === null) return { view: OVERVIEW, digest: null };
  return { view, digest: listsDigests(view) ? digest : null };
}

/** The `#/digest/…` path of a place; the inverse of {@link parsePlace}. */
export function placePath(p: DigestPlace): string {
  const v = p.view;
  const view =
    v.kind === "categories" ? ""
    : v.kind === "sources" ? "sources"
    : v.kind === "category" ? (v.uid === null ? "all" : v.uid === "" ? "uncategorized" : `category/${encodeURIComponent(v.uid)}`)
    : `sources/${encodeURIComponent(v.key)}`;
  if (p.digest === null || !listsDigests(v)) return view;
  return `${view}/d/${encodeURIComponent(p.digest)}`;
}

export function sameView(a: DigestView, b: DigestView): boolean {
  if (a.kind === "category" && b.kind === "category") return a.uid === b.uid;
  if (a.kind === "source" && b.kind === "source") return a.key === b.key;
  return a.kind === b.kind;
}

// ---- categories ----

export interface CategoryRow {
  /** As in {@link DigestView}: null All, "" Uncategorized. */
  uid: string | null;
  name: string;
  count: number;
}

/** All, Uncategorized, then the person's categories in the order they made them, empty ones too: the Move to… menu's choices and the overview's cards. */
export function categoryRows(s: DigestSnapshot): CategoryRow[] {
  const count = (uid: string) => s.digests.filter((d) => d.categoryUid === uid).length;
  return [
    { uid: null, name: "All", count: s.digests.length },
    { uid: "", name: "Uncategorized", count: count("") },
    ...s.categories.map((c) => ({ uid: c.uid, name: c.name || "Untitled category", count: count(c.uid) })),
  ];
}

// ---- sources ----

/**
 * A digest's source as one key: its path, or the kind for a digest with no
 * path. A path always has a folder, so it never equals a kind.
 */
export function sourceKey(d: Digest): string {
  return d.source.path ?? d.source.kind;
}

/** A file's name as the library shows it: the last part of its path, without the extension. */
export function fileName(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

export interface SourceGroup {
  key: string;
  kind: DigestSourceKind;
  name: string;
  /** The file in the library, when it is there. */
  fileId: string | null;
  /** In page order. */
  digests: Digest[];
}

/**
 * The Sources list's sections, in this order. Documents and notebooks share
 * one, as on the tablet; what was typed there is its own.
 */
export const SOURCE_SECTIONS: readonly { kinds: readonly DigestSourceKind[]; name: string; alone?: true }[] = [
  { kinds: ["document", "note"], name: "Documents & notes" },
  // One group, its row named like the section: no label above it.
  { kinds: ["manual"], name: "Typed on the tablet", alone: true },
  { kinds: ["other"], name: "Other" },
];

/** The section a kind of source is listed under. */
export function sectionOf(kind: DigestSourceKind): (typeof SOURCE_SECTIONS)[number] {
  return SOURCE_SECTIONS.find((x) => x.kinds.includes(kind))!;
}

/** Page order: by page (pages unknown last), then the order they were made. */
function byPage(a: Digest, b: Digest): number {
  const pa = a.source.page ?? Number.POSITIVE_INFINITY;
  const pb = b.source.page ?? Number.POSITIVE_INFINITY;
  return pa !== pb ? pa - pb : a.createdAt - b.createdAt;
}

/** Every source, documents and notes by name, each with its digests in page order. */
export function sourceGroups(s: DigestSnapshot): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const d of s.digests) {
    const key = sourceKey(d);
    let g = groups.get(key);
    if (!g) {
      const name = d.source.path ? fileName(d.source.path) : sectionOf(d.source.kind).name;
      g = { key, kind: d.source.kind, name, fileId: d.source.fileId, digests: [] };
      groups.set(key, g);
    }
    g.digests.push(d);
  }
  const order = (k: DigestSourceKind) => SOURCE_SECTIONS.indexOf(sectionOf(k));
  return [...groups.values()]
    .map((g) => ({ ...g, digests: [...g.digests].sort(byPage) }))
    .sort((a, b) => order(a.kind) - order(b.kind) || a.name.localeCompare(b.name));
}

/**
 * Whether the digest's source opens at its page here: a PDF or a notebook in
 * the library. An EPUB, a CBZ and the like have no viewer that goes to a page.
 */
export function opensAtPage(d: Digest): boolean {
  const path = d.source.path?.toLowerCase() ?? "";
  return d.source.fileId !== null && (path.endsWith(".pdf") || path.endsWith(".note"));
}

/** What a digest from a changed file says: its page may not hold the passage any more. */
export function changedLine(d: Digest): string {
  return d.source.page === null
    ? "This file has changed since the digest was taken: the passage may have moved."
    : `This file has changed since the digest was taken: page ${d.source.page} may no longer hold the passage.`;
}

/** The digests taken from one library file, in page order: what its viewer's Digests panel lists. */
export function fileDigests(s: DigestSnapshot, fileId: string): Digest[] {
  return s.digests.filter((d) => d.source.kind !== "manual" && d.source.fileId === fileId).sort(byPage);
}

/** A digest's place on the Digest page: under its source, open. */
export function digestPlace(d: Digest): DigestPlace {
  return { view: { kind: "source", key: sourceKey(d) }, digest: d.id };
}

// ---- what a view shows ----

/** The digests a view lists: a category's newest first, a source's in page order; an overview's none. */
export function digestsIn(s: DigestSnapshot, v: DigestView): Digest[] {
  if (v.kind === "category") {
    const picked = v.uid === null ? s.digests : s.digests.filter((d) => d.categoryUid === v.uid);
    return [...picked].sort((a, b) => b.createdAt - a.createdAt);
  }
  if (v.kind === "source") return sourceGroups(s).find((g) => g.key === v.key)?.digests ?? [];
  return [];
}

/** The view's name, as the top bar and the tab's title say it; null for a category or source that is gone. */
export function viewTitle(s: DigestSnapshot, v: DigestView): string | null {
  switch (v.kind) {
    case "categories": return "Categories";
    case "sources": return "Sources";
    case "category": return categoryRows(s).find((r) => r.uid === v.uid)?.name ?? null;
    case "source": return sourceGroups(s).find((g) => g.key === v.key)?.name ?? null;
  }
}

/** What the top bar says under the name: how many digests (an overview: how many cards too). */
export function viewSummary(s: DigestSnapshot, v: DigestView): string {
  const digests = (n: number) => (n === 1 ? "1 digest" : `${n} digests`);
  if (v.kind === "categories") {
    const n = s.categories.length;
    return `${n === 1 ? "1 category" : `${n} categories`} · ${digests(s.digests.length)}`;
  }
  if (v.kind === "sources") {
    const n = sourceGroups(s).length;
    return `${n === 1 ? "1 source" : `${n} sources`} · ${digests(s.digests.length)}`;
  }
  return digests(digestsIn(s, v).length);
}

/** Where a digest came from, in a few words: "Appliance manual, page 2". */
export function sourceLine(d: Digest): string {
  const s = d.source;
  if (s.kind === "manual") return "Typed on the tablet";
  const name = s.path ? fileName(s.path) : "Unknown source";
  return s.page === null ? name : `${name}, page ${s.page}`;
}

/** The category's name a digest is in. */
export function categoryName(s: DigestSnapshot, d: Digest): string {
  if (d.categoryUid === "") return "Uncategorized";
  return s.categories.find((c) => c.uid === d.categoryUid)?.name || "Untitled category";
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
