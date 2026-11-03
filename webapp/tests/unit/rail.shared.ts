// Helpers shared by the rail tests.

import { it, vi } from "vitest";
import { createRail, DESTINATIONS, type FolderTree, type RailPlace, type RailRow, type RailView, type Destination } from "../../src/pages/rail";
import type { IconName } from "../../src/ui/icons";
import type { Folder, Id } from "../../src/core/types";

// `DESTINATIONS` ships entries; each test starts empty and the shipped set is restored.
export const SHIPPED: Destination[] = [...DESTINATIONS];

export interface Spec {
  id: Id;
  name: string;
  /** Omitted = the server did not count this folder. */
  count?: number;
  children?: Spec[];
}

export const folder = (s: Spec): Folder => ({ kind: "folder", id: s.id, name: s.name, ...(s.count === undefined ? {} : { itemCount: s.count }) });

/** A tree over a literal spec; `unwalked` folders report no children and say so. */
export function treeOf(roots: Spec[], unwalked: Id[] = []): FolderTree {
  const byId = new Map<Id, Spec>();
  const index = (s: Spec): void => {
    byId.set(s.id, s);
    for (const c of s.children ?? []) index(c);
  };
  for (const r of roots) index(r);
  const missing = new Set(unwalked);
  return {
    roots: () => roots.map(folder),
    children: (id) => (missing.has(id) ? [] : (byId.get(id)?.children ?? []).map(folder)),
    walked: (id) => !missing.has(id),
  };
}

/** The device's default tree, as it looks once a household has used it. */
export const FULL: Spec[] = [
  {
    id: "dir-note",
    name: "NOTE",
    count: 3,
    children: [
      { id: "note", name: "Note", count: 4, children: [{ id: "projects", name: "Projects", count: 2 }] },
      { id: "mystyle", name: "MyStyle", count: 3 },
      { id: "scratch", name: "Scratch", count: 1 },
    ],
  },
  { id: "dir-doc", name: "DOCUMENT", count: 1, children: [{ id: "doc", name: "Document", count: 3 }] },
  { id: "export", name: "EXPORT", count: 0 },
  { id: "screenshot", name: "SCREENSHOT", count: 2 },
  { id: "inbox", name: "INBOX", count: 1 },
  { id: "archive", name: "Archive", count: 24 },
];

/** Only `NOTE/Note` exists — Export, Screenshot and Inbox were never created. */
export const SPARSE: Spec[] = [{ id: "dir-note", name: "NOTE", count: 1, children: [{ id: "note", name: "Note", count: 0 }] }];

export function build(
  spec: Spec[],
  place: RailPlace = { folderId: null, openPath: null },
  unwalked: Id[] = [],
  over: Partial<{
    destinationCount: (k: string) => number;
    destinationState: (k: string) => { icon: IconName; label: string } | null;
    isAdmin: () => boolean;
  }> = {},
) {
  const painted: RailRow[][] = [];
  const view = {
    render: vi.fn((rows: readonly RailRow[]) => void painted.push([...rows])),
    setBusy: vi.fn(),
  } satisfies RailView;
  const deps = {
    view,
    tree: treeOf(spec, unwalked),
    place: () => place,
    onOpenFolder: vi.fn(),
    onSelectCategory: vi.fn(),
    onOpenDestination: vi.fn(),
    destinationCount: vi.fn(over.destinationCount ?? (() => 0)),
    destinationState: vi.fn(over.destinationState ?? (() => null)),
    isAdmin: vi.fn(over.isAdmin ?? (() => false)),
    onSettled: vi.fn(),
    onLabelsSettled: vi.fn(),
  };
  const rail = createRail(deps);
  return { rail, view, painted, ...deps, last: () => painted[painted.length - 1]!, setPlace: (p: RailPlace) => void (place = p) };
}

/** Every item row's visible name, in paint order. Labels excluded. */
export const names = (rows: RailRow[]): string[] => rows.filter((r) => r.kind === "item").map((r) => (r.kind === "item" ? r.name : ""));

export const item = (rows: RailRow[], name: string) => rows.find((r): r is Extract<RailRow, { kind: "item" }> => r.kind === "item" && r.name === name);
