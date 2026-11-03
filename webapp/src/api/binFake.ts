// The fake `Api`'s recycle-bin half, self-contained so fake.ts spreads it in
// with one line. Known limitation: `trashEntry` adds a bin row but cannot remove
// the entry from fake.ts's frozen library listing.

import type { Id, NoteMeta, PageRef } from "../core/types";
import type { Bin, BinEntry, Restored, Trashed } from "../core/binTypes";
import { LAYERED_NOTE_ID, layeredPagePayload, withLayeredPageLayers } from "./layeredFixture";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 30;

/** Recognized notes carry a `textHash` on every page but each third, so the "page has none" state is exercised too. */
function pagesFor(id: Id, count: number, recognized: boolean): PageRef[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    // The fake renderer paints from the hash; it only needs to be stable and distinct.
    hash: `${id}-p${index}`,
    width: 1404,
    height: 1872,
    textHash: recognized && index % 3 !== 2 ? `${id}-t${index}` : null,
    linksHash: null,
    sourcePage: null,
  }));
}

/** The same ref `getBinNoteMeta` gives for page 0, layers included. */
function binFirstPage(id: Id, recognized: boolean): PageRef {
  const page = pagesFor(id, 1, recognized)[0]!;
  return id === LAYERED_NOTE_ID ? withLayeredPageLayers(page) : page;
}

interface Seed {
  kind: "folder" | "note";
  id: Id;
  name: string;
  /** Server-shaped (leading slash, container folders, own file name), not display form. */
  path: string;
  /** Days ago it was deleted; the countdown is computed live. */
  agoDays: number;
  size: number;
  parentId: Id | null;
  fileType: string;
  pageCount: number;
  recognized?: boolean;
}

/** A folder deleted with its two notes (the device deletes children first), plus one note near the end of its window. */
const SEEDS: Seed[] = [
  { kind: "folder", id: "301", name: "nested_to_remove", path: "/NOTE/Note/nested_to_remove", agoDays: 0, size: 0, parentId: null, fileType: "", pageCount: 0 },
  { kind: "note", id: "302", name: "20260720_152956.note", path: "/NOTE/Note/nested_to_remove/20260720_152956.note", agoDays: 0, size: 1_468_006, parentId: "301", fileType: "note", pageCount: 3, recognized: true },
  { kind: "note", id: "303", name: "20260720_153311.note", path: "/NOTE/Note/nested_to_remove/20260720_153311.note", agoDays: 0, size: 629_145, parentId: "301", fileType: "note", pageCount: 1 },
  { kind: "note", id: "304", name: "download_test.note", path: "/NOTE/Note/download_test.note", agoDays: 26, size: 2_202_009, parentId: null, fileType: "note", pageCount: 2, recognized: true },
];

/** Trashed note seeds, for fake.ts to register in `ALL_NOTES` so its transcript/history generators serve them too. */
export interface BinSeedNote {
  id: Id;
  name: string;
  fileType: string;
  pageCount: number;
  recognized: boolean;
}
export const BIN_SEED_NOTES: BinSeedNote[] = SEEDS.filter((s) => s.kind === "note").map((s) => ({
  id: s.id,
  name: s.name,
  fileType: s.fileType,
  pageCount: s.pageCount,
  recognized: s.recognized === true,
}));

export interface BinFake {
  listBin(): Promise<Bin>;
  getBinNoteMeta(id: Id): Promise<NoteMeta>;
  getBinPageBytes(id: Id, page: PageRef): Promise<ArrayBuffer>;
  trashEntry(id: Id): Promise<Trashed>;
  restoreEntry(id: Id): Promise<Restored>;
  purgeEntry(id: Id): Promise<void>;
  emptyBin(): Promise<number>;
}

/**
 * What `trashEntry` knows about the live entry, supplied by fake.ts. Without it
 * a trashed `.spd` or `.txt` would land as a `.note` and open in the wrong viewer.
 */
export interface TrashedLookup {
  (id: Id): {
    name: string;
    fileType: string;
    size: number;
    pageCount: number;
    recognized?: boolean;
    thumbAspect?: { w: number; h: number };
  } | null;
}

/** Whole-blob md5 from fake.ts, so a trashed row carries the same 32-hex content address as its live twin. */
export type BlobHash = (id: Id) => string;

/** State is per-instance, so tests do not leak into each other. */
export function createBinFake(
  delay: (ms: number) => Promise<void>,
  latency: number,
  lookup: TrashedLookup | undefined,
  blobHash: BlobHash,
): BinFake {
  const now = Date.now();
  let rows: BinEntry[] = SEEDS.map((s) => ({
    kind: s.kind,
    id: s.id,
    name: s.name,
    path: s.path,
    deletedAt: now - s.agoDays * DAY_MS,
    size: s.size,
    parentId: s.parentId,
    isRoot: s.parentId === null,
    fileType: s.fileType,
    fileHash: s.kind === "folder" ? null : blobHash(s.id),
    // Same ref as `getBinNoteMeta`'s page 0, so the thumbnail and reader share a render-cache entry.
    firstPage: s.pageCount > 0 ? binFirstPage(s.id, s.recognized === true) : null,
    // Seed notes are all portrait; a folder states no shape.
    ...(s.kind === "note" && s.pageCount > 0 ? { thumbAspect: { w: 1404, h: 1872 } } : {}),
  }));
  const pageCounts = new Map<Id, number>(SEEDS.map((s) => [s.id, s.pageCount]));
  const recognizedOf = new Map<Id, boolean>(SEEDS.map((s) => [s.id, s.recognized === true]));

  /** A row and everything beneath it. */
  function subtree(id: Id): BinEntry[] {
    const out: BinEntry[] = [];
    const walk = (at: Id): void => {
      const row = rows.find((r) => r.id === at);
      if (!row) return;
      out.push(row);
      for (const child of rows.filter((r) => r.parentId === at)) walk(child.id);
    };
    walk(id);
    return out;
  }

  return {
    async listBin(): Promise<Bin> {
      await delay(latency);
      const entries = [...rows].sort((a, b) => b.deletedAt - a.deletedAt);
      return {
        entries,
        // Folders contribute 0, so a folder is never double-counted with its contents.
        totalBytes: entries.reduce((n, e) => n + e.size, 0),
        retentionDays: RETENTION_DAYS,
        syncVersion: 1,
      };
    },

    async getBinNoteMeta(id: Id): Promise<NoteMeta> {
      await delay(latency);
      const row = rows.find((r) => r.id === id && r.kind !== "folder");
      if (!row) throw new Error(`no such trashed note: ${id}`);
      return {
        // Trashing a PDF does not trash its mark, so the bin never pairs.
        annotationsId: null,
        id,
        name: row.name,
        pages: pagesFor(id, pageCounts.get(id) ?? 1, recognizedOf.get(id) === true).map((p) =>
          id === LAYERED_NOTE_ID ? withLayeredPageLayers(p) : p,
        ),
        fileType: row.fileType,
        fileHash: row.fileHash,
        size: row.size,
        pxPerMm: 1404 / 118.64,
      };
    },

    async getBinPageBytes(_id: Id, page: PageRef): Promise<ArrayBuffer> {
      await delay(latency);
      if (_id === LAYERED_NOTE_ID) {
        const payload = layeredPagePayload(page.index);
        if (payload) return payload.slice().buffer as ArrayBuffer;
      }
      const buf = new Uint8Array(16);
      for (let i = 0; i < buf.length; i++) buf[i] = page.hash.charCodeAt(i) & 0xff;
      return buf.buffer;
    },

    async trashEntry(id: Id): Promise<Trashed> {
      await delay(latency);
      // Carry the real name/type/size from `lookup` so the bin opens the right viewer.
      const known = lookup?.(id) ?? null;
      const name = known?.name ?? id;
      const fileType = known?.fileType ?? "note";
      const pageCount = known?.pageCount ?? 1;
      const recognized = known?.recognized === true;
      pageCounts.set(id, pageCount);
      recognizedOf.set(id, recognized);
      const row: BinEntry = {
        kind: "note",
        id,
        name,
        path: `/NOTE/Note/${name}`,
        deletedAt: Date.now(),
        size: known?.size ?? 1_048_576,
        parentId: null,
        isRoot: true,
        fileType,
        fileHash: blobHash(id),
        firstPage: pageCount > 0 ? binFirstPage(id, recognized) : null,
        ...(known?.thumbAspect ? { thumbAspect: known.thumbAspect } : {}),
      };
      rows = [row, ...rows.filter((r) => r.id !== id)];
      return { id, name: row.name, isFolder: false, entries: 1 };
    },

    async restoreEntry(id: Id): Promise<Restored> {
      await delay(latency);
      const going = subtree(id);
      const row = going[0];
      if (!row) throw new Error(`no such trashed entry: ${id}`);
      const ids = new Set(going.map((r) => r.id));
      rows = rows.filter((r) => !ids.has(r.id));
      return { name: row.name, renamed: false, ancestors: 0, descendants: going.length - 1 };
    },

    async purgeEntry(id: Id): Promise<void> {
      await delay(latency);
      const ids = new Set(subtree(id).map((r) => r.id));
      if (ids.size === 0) throw new Error(`no such trashed entry: ${id}`);
      rows = rows.filter((r) => !ids.has(r.id));
    },

    async emptyBin(): Promise<number> {
      await delay(latency);
      const n = rows.length;
      rows = [];
      return n;
    },
  };
}
