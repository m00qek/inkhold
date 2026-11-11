// The Digest page's model: where the person is (a view and maybe one digest),
// how that is written in the URL, and the digests' grouping and order, the
// tablet's two ways of browsing them. By category, newest first, as the
// tablet lists them. By source, each document's passages in page order, so a
// document's digests read as notes on it, top to bottom. No DOM here.

import type { Digest, DigestSnapshot, DigestSourceKind } from "../../api/digestTypes";

/**
 * A category (`uid` "" is Uncategorized, null is All), or a source (`key`
 * from {@link sourceKey}, null is every source).
 */
export type DigestView = { kind: "category"; uid: string | null } | { kind: "source"; key: string | null };

/** A view, and the digest open in it; null: none. */
export interface DigestPlace {
  view: DigestView;
  digest: string | null;
}

const ALL: DigestView = { kind: "category", uid: null };

/**
 * The place a `#/digest/…` path names: `""` (All), `uncategorized`,
 * `category/<uid>`, `sources`, `sources/<key>`, each maybe followed by
 * `d/<id>`. Anything else is All.
 */
export function parsePlace(path: string): DigestPlace {
  const parts = path.split("/").filter((p) => p !== "").map(decode);
  let digest: string | null = null;
  if (parts.length >= 2 && parts.at(-2) === "d") {
    digest = parts.at(-1)!;
    parts.length -= 2;
  }
  const [head, arg, ...rest] = parts;
  if (rest.length > 0) return { view: ALL, digest };
  if (head === "uncategorized" && arg === undefined) return { view: { kind: "category", uid: "" }, digest };
  if (head === "category" && arg) return { view: { kind: "category", uid: arg }, digest };
  if (head === "sources") return { view: { kind: "source", key: arg ?? null }, digest };
  return { view: ALL, digest };
}

/** The `#/digest/…` path of a place; the inverse of {@link parsePlace}. */
export function placePath(p: DigestPlace): string {
  const v = p.view;
  const view =
    v.kind === "category"
      ? v.uid === null ? "" : v.uid === "" ? "uncategorized" : `category/${encodeURIComponent(v.uid)}`
      : v.key === null ? "sources" : `sources/${encodeURIComponent(v.key)}`;
  if (p.digest === null) return view;
  const d = `d/${encodeURIComponent(p.digest)}`;
  return view === "" ? d : `${view}/${d}`;
}

export function sameView(a: DigestView, b: DigestView): boolean {
  return a.kind === "category" && b.kind === "category" ? a.uid === b.uid : a.kind === "source" && b.kind === "source" && a.key === b.key;
}

/** Which tab a view belongs to. */
export function tabOf(v: DigestView): "categories" | "sources" {
  return v.kind === "category" ? "categories" : "sources";
}

// ---- categories ----

export interface CategoryRow {
  /** As in {@link DigestView}: null All, "" Uncategorized. */
  uid: string | null;
  name: string;
  count: number;
}

/** All, Uncategorized, then the person's categories in the order they made them, empty ones too. */
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

/** The kinds' sections in the Sources list, in this order. */
export const SOURCE_SECTIONS: readonly { kind: DigestSourceKind; name: string }[] = [
  { kind: "document", name: "Documents" },
  { kind: "note", name: "Notes" },
  { kind: "manual", name: "Typed on the tablet" },
  { kind: "other", name: "Other" },
];

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
      const name = d.source.path ? fileName(d.source.path) : SOURCE_SECTIONS.find((x) => x.kind === d.source.kind)!.name;
      g = { key, kind: d.source.kind, name, fileId: d.source.fileId, digests: [] };
      groups.set(key, g);
    }
    g.digests.push(d);
  }
  const order = (k: DigestSourceKind) => SOURCE_SECTIONS.findIndex((x) => x.kind === k);
  return [...groups.values()]
    .map((g) => ({ ...g, digests: [...g.digests].sort(byPage) }))
    .sort((a, b) => order(a.kind) - order(b.kind) || a.name.localeCompare(b.name));
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

/** The digests a view lists: a category's newest first, a source's in page order (every source: grouped, in the list's order). */
export function digestsIn(s: DigestSnapshot, v: DigestView): Digest[] {
  if (v.kind === "category") {
    const picked = v.uid === null ? s.digests : s.digests.filter((d) => d.categoryUid === v.uid);
    return [...picked].sort((a, b) => b.createdAt - a.createdAt);
  }
  const groups = sourceGroups(s);
  return (v.key === null ? groups : groups.filter((g) => g.key === v.key)).flatMap((g) => g.digests);
}

/** The view's name, as its heading and the rail say it; null for a category or source that is gone. */
export function viewTitle(s: DigestSnapshot, v: DigestView): string | null {
  if (v.kind === "category") return categoryRows(s).find((r) => r.uid === v.uid)?.name ?? null;
  if (v.key === null) return "Sources";
  return sourceGroups(s).find((g) => g.key === v.key)?.name ?? null;
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
