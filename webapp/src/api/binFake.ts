// The fake `Api`'s recycle-bin half — the fixture the dev server, the unit tests
// and the e2e suite all drive the bin from.
//
// ITS OWN FILE, and self-contained, for the reason `core/binTypes.ts` is its
// own file: fake.ts is extended by two features in parallel at markers inside
// its returned object literal, and a fixture cannot be declared there. So this
// module owns bin state end to end and fake.ts spreads it in with one line.
//
// KNOWN LIMITATION, deliberate and confined to the fake. `trashEntry` adds a row
// to this bin but cannot remove one from the library, because the fake's folder
// listings are derived from a frozen `CHILDREN` fixture that lives in fake.ts
// above the marker and is not reachable from here. Against the real server the
// entry leaves the gallery on the refetch the trash triggers; against the fake
// it stays. Nothing in the bin's own behaviour depends on the difference, and
// closing it would mean rewriting fake.ts's listing path — precisely the kind of
// edit outside a marker this split exists to avoid.

import type { Id, NoteMeta, PageRef } from "../core/types";
import type { Bin, BinEntry, Restored, Trashed } from "../core/binTypes";
// The layered fixture is served through the BIN routes too: on the real server
// the per-page index is keyed by blob md5 and survives trashing untouched, so
// a layered note opened from the recycle bin keeps its layers. A shared
// fixture module (not fake.ts — see the header above) is what lets this file
// mirror that without seeing the library fixtures.
import { LAYERED_NOTE_ID, layeredPageLayers, layeredPagePayload } from "./layeredFixture";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 30;

/**
 * A page list shaped like the real one, so the reader can open a trashed note.
 *
 * `recognized` mirrors the live fixture's rule (`fakeTextHash`): a trashed note
 * the device DID recognize carries a `textHash` on every page but each third
 * (index 2, 5, …), so the reader considers it searchable, requests the bin-scoped
 * transcript for its ovals, and still exercises the "this page has none" state.
 * A trashed file's transcript survives the delete (md5-keyed index, `deleted =
 * 1`), so the empty stub the bin viewer used to show was a scope shortcut, not a
 * data limit — hence the non-null hashes now.
 */
function pagesFor(id: Id, count: number, recognized: boolean): PageRef[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    // The fake renderer paints FROM the hash, so it only has to be stable and
    // distinct — the same property the real per-page content hash has.
    hash: `${id}-p${index}`,
    width: 1404,
    height: 1872,
    textHash: recognized && index % 3 !== 2 ? `${id}-t${index}` : null,
  }));
}

interface Seed {
  kind: "folder" | "note";
  id: Id;
  name: string;
  /**
   * SERVER-SHAPED, and that is the point: the real `path` is slash-separated,
   * leading-slash, names the device's container folders (`NOTE`) and INCLUDES
   * the entry's own file name. The row does not render it raw — `folderLabel` in
   * pages/bin.ts strips the name and hands the rest to the rail's
   * `labelPathSegments` — so a fixture already in display form would have hidden
   * exactly the defect that treatment exists to fix.
   */
  path: string;
  /** Days ago it was deleted — the countdown is computed from this, live. */
  agoDays: number;
  size: number;
  parentId: Id | null;
  fileType: string;
  pageCount: number;
  /** Whether the device ran recognition on it — drives the trashed transcript,
   *  ovals and in-note find (Phase 1 parity). Folders and un-recognized notes
   *  are false. */
  recognized?: boolean;
}

/**
 * Mirrors the approved mockup's fixture: a folder deleted with the two notes
 * inside it (which is what the date grouping reunites — the device deletes a
 * folder as separate per-entity requests, children first), plus one older note
 * close enough to the end of its window to render the `is-soon` treatment.
 */
const SEEDS: Seed[] = [
  { kind: "folder", id: "t-folder", name: "nested_to_remove", path: "/NOTE/Note/nested_to_remove", agoDays: 0, size: 0, parentId: null, fileType: "", pageCount: 0 },
  // Recognized, so its bin preview draws ovals and find-in-a-trashed-note works
  // (Phase 1) and it has a version history to browse (Phase 2).
  { kind: "note", id: "t-child-a", name: "20260720_152956.note", path: "/NOTE/Note/nested_to_remove/20260720_152956.note", agoDays: 0, size: 1_468_006, parentId: "t-folder", fileType: "note", pageCount: 3, recognized: true },
  // Un-recognized, kept so the "trashed note with no transcript" state stays a
  // fixture the bin viewer is exercised against.
  { kind: "note", id: "t-child-b", name: "20260720_153311.note", path: "/NOTE/Note/nested_to_remove/20260720_153311.note", agoDays: 0, size: 629_145, parentId: "t-folder", fileType: "note", pageCount: 1 },
  { kind: "note", id: "t-old", name: "download_test.note", path: "/NOTE/Note/download_test.note", agoDays: 26, size: 2_202_009, parentId: null, fileType: "note", pageCount: 2, recognized: true },
];

/**
 * The trashed NOTE seeds, exported so fake.ts can register them in its
 * `ALL_NOTES` map and drive every transcript/search/history generator for a
 * trashed id exactly as it does for a live one — the fake mirror of "a trashed
 * file's md5-keyed data is fully retained". fake.ts owns those generators, so the
 * bin read methods live there; this module stays the bin STATE owner.
 */
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
 * What `trashEntry` can learn about the live entry it is tombstoning — supplied
 * by fake.ts off its own fixture, because this module deliberately cannot see
 * `ALL_NOTES` (see the header). Without it a trashed row falls back to a generic
 * `.note` shape, which is wrong the moment a `.spd` or `.txt` is trashed: the
 * bin routes files with a real viewer by their TYPE, so the fake has to carry
 * the truth for "trash it, then open it from the bin" to be exercisable at all.
 */
export interface TrashedLookup {
  (id: Id): {
    name: string;
    fileType: string;
    size: number;
    pageCount: number;
    /** Whether the live entry had recognized text — carried into the bin so a
     *  trashed note keeps its transcript/ovals/find, as the real md5-keyed index
     *  does. */
    recognized?: boolean;
    /** The live entry's preview dims, if it stated any — see `BinEntry.thumbAspect`. */
    thumbAspect?: { w: number; h: number };
  } | null;
}

/** Construct the fake bin. State is per-instance, so tests do not leak into each other. */
export function createBinFake(delay: (ms: number) => Promise<void>, latency: number, lookup?: TrashedLookup): BinFake {
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
    fileHash: s.kind === "folder" ? null : `${s.id}-md5`,
    // The SAME ref `getBinNoteMeta` hands the reader for page 0, so the row's
    // thumbnail and the reader's first page share a content hash and therefore a
    // render-cache entry — exactly as they do against the real server.
    firstPage: s.pageCount > 0 ? pagesFor(s.id, 1, s.recognized === true)[0]! : null,
    // The seed notes are all portrait `.note` files, so they serve page 1's
    // effective dims exactly as the listing VO does; a folder states no shape.
    ...(s.kind === "note" && s.pageCount > 0 ? { thumbAspect: { w: 1404, h: 1872 } } : {}),
  }));
  const pageCounts = new Map<Id, number>(SEEDS.map((s) => [s.id, s.pageCount]));
  // Whether a trashed note keeps recognized text — its transcript, ovals and find
  // survive the delete (md5-keyed index). Seeded from SEEDS; `trashEntry` records
  // the live entry's own value.
  const recognizedOf = new Map<Id, boolean>(SEEDS.map((s) => [s.id, s.recognized === true]));

  /** A row and everything beneath it — what a purge or a restore really touches. */
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
      // Newest first, exactly as the server orders it.
      const entries = [...rows].sort((a, b) => b.deletedAt - a.deletedAt);
      return {
        entries,
        // Folders contribute 0, so this can never double-count a folder with
        // its contents — the property the confirmations depend on.
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
        id,
        name: row.name,
        // A trashed layered note keeps its layers (blob-keyed index — header).
        pages: pagesFor(id, pageCounts.get(id) ?? 1, recognizedOf.get(id) === true).map((p) =>
          id === LAYERED_NOTE_ID ? { ...p, layers: layeredPageLayers(p.index) } : p,
        ),
        fileType: row.fileType,
        fileHash: row.fileHash,
        size: row.size,
        pxPerMm: 1404 / 118.64,
      };
    },

    async getBinPageBytes(_id: Id, page: PageRef): Promise<ArrayBuffer> {
      await delay(latency);
      // Same rule as the live route: the layered fixture's page 1 answers with
      // its real SNPG v2 payload wherever the blob is read from.
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
      // Nothing is removed from the library here — see the header. What matters
      // for the UI under test is that the row lands in the bin CARRYING THE
      // TRUTH about what it is — name, type, size, pages, from `lookup` where
      // fake.ts can supply it — so opening it from the bin dispatches to the
      // right viewer, and the response states the fanout.
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
        fileHash: `${id}-md5`,
        firstPage: pageCount > 0 ? pagesFor(id, 1, recognized)[0]! : null,
        // Carried through from the live entry, exactly like name/type/size: the
        // real index is blob-keyed, so trashing does not change a file's shape.
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
