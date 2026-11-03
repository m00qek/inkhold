// In-memory `Api` over a small fixture tree, for `dev` and Playwright e2e.
// Synchronous data behind async signatures plus a small latency.

import type { Api, PageLinks } from "./types";
import type { PdfLink } from "../core/types";
import { createBinFake, BIN_SEED_NOTES } from "./binFake";
import {
  LAYERED_NOTE_ID,
  layeredPageLayers,
  layeredPagePayload,
  withLayeredPageLayers,
} from "./layeredFixture";

/**
 * The `.mark` annotating PDF `178`, reusing the layered fixture's real SNPG v2
 * payload. Sparse like a real mark: its one page annotates PDF page 2, so a
 * viewer that ignored `sourcePage` would visibly paint on the wrong page.
 */
export const MARKED_PDF_ID = "178";
export const PDF_MARK_ID = "179";
const PDF_MARK_SOURCE_PAGE = 2;
import { canPreviewHistory, isAcceptedUpload, nextAvailableName, uploadExtension } from "../core/fileKind";
import type {
  Entry,
  FileHistory,
  FileVersion,
  Folder,
  Id,
  Listing,
  NoteMeta,
  NoteSummary,
  PageRef,
  PageText,
  RestoredVersion,
  WordBox,
} from "../core/types";

/** Deterministic pseudo-hash from a seed — stands in for a real content md5. */
function fakeHash(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0").repeat(4); // 32 hex chars, md5-shaped
}

/** The fixture's whole-file `fileHash`, exported so e2e can mock one file's `/thumbnail/{hash}`. */
export function fakeFileHash(id: Id): string {
  return fakeHash(`${id}:file`);
}

/** Notes whose recognition starts after page 1; `getNoteMeta` must rebuild the summary's per-page pattern. */
const RECOGNIZED_FROM: Record<string, number> = {};

/** The PDF-template note: its pages keep the imported PDF's links. Seven pages, so an internal jump is meaningful. */
const LINKED_NOTE_ID: Id = "122";

/** A page with no ink, mid-note, so the ink rail has a gap to draw. */
const BLANK_PAGE_NOTE_ID: Id = "141";
const BLANK_PAGE_INDEX = 4;

function fakeTextHash(noteId: Id, index: number, recognized: boolean, from = 0): string | null {
  if (!recognized || index < from || index % 3 === 2) return null;
  return fakeHash(`${noteId}:${index}:recogntext`);
}

function pages(
  noteId: Id,
  count: number,
  recognized: boolean,
  dims?: { w: number; h: number },
  recognizedFrom?: number,
): PageRef[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    hash: fakeHash(`${noteId}:${index}`),
    // Effective dims: a landscape fixture passes 1872×1404.
    width: dims?.w ?? 1404,
    height: dims?.h ?? 1872,
    textHash: fakeTextHash(noteId, index, recognized, recognizedFrom),
    linksHash: noteId === LINKED_NOTE_ID ? fakeHash(`${noteId}:${index}:links`) : null,
    sourcePage: null,
    // `false`, not absent: the rail refuses to draw on an incomplete map.
    hasInk: !(noteId === BLANK_PAGE_NOTE_ID && index === BLANK_PAGE_INDEX),
  }));
}

/** A plausible multi-line transcript, deterministic per note + page. */
function fakeText(name: string, index: number): string {
  const lines = [
    `${name} — page ${index + 1}`,
    "",
    "Handwriting recognition ran on the device, so the",
    "transcript is stored inside the .note file itself.",
    "",
    "  · confirm the page-range serving budget",
    "  · md5-keyed cache stays immutable across edits",
    "  · ask about the vector question in the container",
    // HTML-syntax characters: device-authored text must stay `textContent`-rendered.
    "  · <draft> R&D budget — flag \"open\" items & re-check",
    "",
    "Follow-up: re-read the sync notes before Thursday,",
    "then fold the answers back into the design doc.",
    // The only line not on every page, so find can have matches off the current page.
    ...(index % 2 === 1 ? ["Marginalia: the witches of Endor, again."] : []),
  ];
  return lines.join("\n");
}

/**
 * Links as the real endpoint serves them: device panel pixels, 0-based target
 * for an internal jump, `-1` plus a URL for an external one. No refused schemes:
 * the server applies the allowlist.
 */
function fakePageLinks(page: PageRef, pageCount: number): PdfLink[] {
  const target = (page.index + 1) % pageCount;
  return [
    { x: 980, y: 96, w: 340, h: 64, page: -1, uri: "https://example.com/planner?utm=fixture&a=1,2" },
    { x: 96, y: 1680, w: 420, h: 72, page: target, uri: "none" },
  ];
}

/**
 * Ids are decimal because a real `files.id` is an integer: search joins hits
 * to cards by `Number(e.id)` / `String(doc.fileId)`, which a word id breaks.
 * Folder ids stay words; nothing joins them by number.
 */
interface NoteOpts {
  fileType?: string;
  hasRecognizedText?: boolean;
  /** First recognized page index, when not 0 (the case that once left Find disabled from the skeleton). */
  recognizedFrom?: number;
  size?: number;
  /** Effective page dims; a landscape fixture passes 1872×1404. */
  pageDims?: { w: number; h: number };
  /** Explicit preview dims: a `.note`'s cover, or a `.spd`'s embedded thumbnail. */
  thumbAspect?: { w: number; h: number };
  annotationsId?: Id;
}
function note(id: Id, name: string, pageCount: number, updatedAt: number, opts: NoteOpts = {}): NoteSummary {
  const fileType = opts.fileType ?? "note";
  const hasRecognizedText = opts.hasRecognizedText ?? false;
  if (opts.recognizedFrom !== undefined) RECOGNIZED_FROM[String(id)] = opts.recognizedFrom;
  const [first] = pages(id, pageCount, hasRecognizedText, opts.pageDims, opts.recognizedFrom);
  return {
    kind: "note",
    id,
    name,
    pageCount,
    // Layers on the listing's first page too, so a layered note's first paint is its stack.
    firstPage: id === LAYERED_NOTE_ID ? withLayeredPageLayers(first!) : first!,
    updatedAt,
    fileType,
    // Whole-file md5, seeded apart from the page hashes.
    fileHash: fakeHash(`${id}:file`),
    hasRecognizedText,
    // As the server: `.note` → cover dims or page 1's; `.spd` → thumb dims; others absent.
    thumbAspect:
      opts.thumbAspect ?? (fileType === "note" && first ? { w: first.width, h: first.height } : undefined),
    // The server folds the mark out of the listing; this is the row's only pairing signal.
    annotationsId: opts.annotationsId ?? null,
  };
}

/** Recognized, but on hardware the scale table never measured: `pxPerMm: null`. */
const UNSCALED_NOTE_ID = "144";

/** Word boxes in millimetres on the 118.64 x 158.19 mm canvas, kept inside the page. */
function fakeWords(text: string): WordBox[] {
  const out: WordBox[] = [];
  const lines = text.split("\n");
  for (let row = 0; row < lines.length; row++) {
    const yMm = 12 + row * 9.5;
    if (yMm + 6 > 158.19) break;
    let xMm = 8;
    for (const word of lines[row]!.split(/\s+/).filter(Boolean)) {
      const wMm = Math.min(word.length * 2.4, 100);
      if (xMm + wMm > 110) break;
      out.push({ text: word, xMm, yMm, wMm, hMm: 6 });
      xMm += wMm + 2.5;
    }
  }
  return out;
}

function fakeSize(id: Id, pageCount: number): number {
  return 40_000 + pageCount * 90_000 + (id.length % 7) * 1_337;
}

// --- the upload fixture ------------------------------

/** Fixture account's free space; a bigger file gets the real 413. Exported as a test input. */
export const FAKE_UPLOAD_HEADROOM = 8 * 1024 * 1024;

/** Progress steps scale with size so the progress bar and Cancel are observable. */
function uploadSteps(size: number): number {
  return Math.max(4, Math.min(24, Math.ceil(size / 65_536)));
}

/** Upload ids `901`, `902`, … — decimal, clear of the fixture tree. */
let uploadSeq = 0;
const UPLOAD_ID_BASE = 900;

const DAY = 86_400_000;
const NOW = 1_752_800_000_000; // fixed epoch ms — no Date.now(), keeps fixtures deterministic

// --- the version-history fixture ---------------------------------------------
// Every `.note` gets its current blob plus two retained versions, newest-first;
// other kinds carry only their current version.

/** The retained versions a `.note` accrues, by seed suffix — see `baseVersions`. */
const RETAINED_VERSION_KS = [1, 2] as const;

/** Older retained versions have fewer pages (`current - k`), so a preview must use the version's own geometry. */
function versionPageCount(summary: NoteSummary, md5: string): number {
  for (const k of RETAINED_VERSION_KS) {
    if (fakeHash(`${summary.id}:v${k}`) === md5) return Math.max(1, summary.pageCount - k);
  }
  return summary.pageCount;
}

/** Current blob plus the retained pair for every previewable kind; others carry only the current one. */
function baseVersions(id: Id): FileVersion[] {
  // Through `noteSummary`: a trashed file's history follows it into the bin.
  const summary = noteSummary(id);
  if (!summary) return [];
  const size = fakeSize(id, summary.pageCount);
  // Only a `.note` carries a page count; other kinds carry 0 and the UI falls back to size.
  const isNote = summary.fileType === "note";
  const current: FileVersion = {
    md5: fakeFileHash(id),
    size,
    createdAt: summary.updatedAt,
    current: true,
    pageCount: isNote ? summary.pageCount : 0,
  };
  if (!canPreviewHistory(summary.fileType)) return [current];
  const retained: FileVersion[] = [1, 2].map((k) => ({
    md5: fakeHash(`${id}:v${k}`),
    size: Math.max(1, size - k * 6_000),
    createdAt: summary.updatedAt - k * 2 * DAY,
    current: false,
    pageCount: isNote ? Math.max(1, summary.pageCount - k) : 0,
  }));
  return [current, ...retained];
}

// The Supernote's real default tree: containers (NOTE, DOCUMENT), flat categories
// (EXPORT, SCREENSHOT, INBOX), categories one level down, plus user folders.
const FOLDERS: Record<string, Folder> = {
  "dir-note": { kind: "folder", id: "dir-note", name: "NOTE" },
  "dir-document": { kind: "folder", id: "dir-document", name: "DOCUMENT" },
  export: { kind: "folder", id: "export", name: "EXPORT" },
  screenshot: { kind: "folder", id: "screenshot", name: "SCREENSHOT" },
  inbox: { kind: "folder", id: "inbox", name: "INBOX" },
  note: { kind: "folder", id: "note", name: "Note" },
  mystyle: { kind: "folder", id: "mystyle", name: "MyStyle" },
  document: { kind: "folder", id: "document", name: "Document" },
  projects: { kind: "folder", id: "projects", name: "Projects" },
  scratch: { kind: "folder", id: "scratch", name: "Scratch" },
  archive: { kind: "folder", id: "archive", name: "Archive" },
  // One of every previewable kind, plus a `.pdf` with no preview.
  files: { kind: "folder", id: "files", name: "Files" },
};

// Enough notes that the gallery scrolls and lazy thumbnails are observable.
const ARCHIVE_NOTES: NoteSummary[] = Array.from({ length: 30 }, (_, i) =>
  note(String(200 + i), `Archive note ${String(i + 1).padStart(2, "0")}`, 1 + (i % 6), NOW - (i + 4) * DAY, {
    hasRecognizedText: i % 2 === 0,
  }),
);

const CHILDREN: Record<string, Entry[]> = {
  // No loose notes at root; the device never puts any.
  root: [
    FOLDERS["dir-note"]!,
    FOLDERS["dir-document"]!,
    FOLDERS.export!,
    FOLDERS.screenshot!,
    FOLDERS.inbox!,
    FOLDERS.archive!,
    FOLDERS.files!,
  ],
  // `Scratch` is a user folder inside a container, so flattening `NOTE` must promote it, not drop it.
  "dir-note": [FOLDERS.note!, FOLDERS.mystyle!, FOLDERS.scratch!],
  "dir-document": [FOLDERS.document!],
  note: [
    FOLDERS.projects!,
    note("101", "Weekly review", 3, NOW - DAY, { hasRecognizedText: true }),
    note("102", "Ideas & scratch", 1, NOW),
    note("103", "Sketch — kitchen layout", 1, NOW - 3 * DAY),
    note(LAYERED_NOTE_ID, "Layered field sketch", 2, NOW - 2 * DAY),
  ],
  scratch: [note("111", "Scratch — todo", 1, NOW - 2 * DAY)],
  projects: [
    note("121", "Project Aurora — kickoff", 6, NOW - 6 * DAY, { hasRecognizedText: true }),
    note("122", "Project Beta", 7, NOW - 8 * DAY),
  ],
  // Blank templates: nothing to recognize.
  mystyle: [
    note("131", "Cornell notes", 1, NOW - 60 * DAY),
    note("132", "Weekly planner", 1, NOW - 60 * DAY),
    note("133", "Dot grid", 1, NOW - 60 * DAY),
  ],
  document: [
    note("141", "Attention Is All You Need", 20, NOW - 9 * DAY, { hasRecognizedText: true }),
    note("142", "Apartment lease — signed", 6, NOW - 26 * DAY, { fileType: "pdf" }),
    // Uploadable, but no viewer here: the reader's "no preview, download" state.
    note("143", "Sourdough — a field guide", 1, NOW - 27 * DAY, { fileType: "epub" }),
    note(UNSCALED_NOTE_ID, "Field notes — unknown device", 3, NOW - 4 * DAY, {
      hasRecognizedText: true,
    }),
  ],
  export: [],
  screenshot: [
    note("151", "Screenshot — pricing page", 1, NOW - 2 * DAY, { fileType: "png" }),
    note("152", "Screenshot — trailhead map", 1, NOW - 5 * DAY, { fileType: "png" }),
  ],
  inbox: [note("161", "Unsorted — meeting doodles", 2, NOW - DAY, { hasRecognizedText: true })],
  archive: ARCHIVE_NOTES,
  // One of every previewable kind; also the masonry fixture (every `thumbAspect` source, both clamp extremes).
  files: [
    // Cover dims win over page 1's; the same 3:4 so cover e2e stay shape-agnostic.
    note("171", "Meeting notes — Q3", 2, NOW - DAY, { hasRecognizedText: true, thumbAspect: { w: 120, h: 160 } }),
    note("172", "Whiteboard — sprint plan", 1, NOW - 2 * DAY, { pageDims: { w: 1872, h: 1404 } }),
    // Images carry no thumbAspect (local dims memo only).
    note("173", "Screenshot — dashboard", 1, NOW - 3 * DAY, { fileType: "png" }),
    note("174", "Kitchen sketch", 1, NOW - 4 * DAY, { fileType: "spd", thumbAspect: { w: 600, h: 800 } }),
    // Clamp extremes: a panorama hitting the wide floor, a scroll hitting the 2.5× tall cap.
    note("175", "Panorama — coastline", 1, NOW - 5 * DAY, { fileType: "spd", thumbAspect: { w: 3000, h: 400 } }),
    note("176", "Receipt — long scroll", 1, NOW - 6 * DAY, { fileType: "spd", thumbAspect: { w: 240, h: 1800 } }),
    // A `.txt` carries no thumbAspect: the snippet shape is a client constant.
    note("177", "readme", 1, NOW - 7 * DAY, { fileType: "txt" }),
    // The paired mark has no listing row, so this field is how its history is reached.
    note("178", "Appliance manual", 4, NOW - 8 * DAY, {
      fileType: "pdf",
      annotationsId: PDF_MARK_ID,
    }),
  ],
};

const ALL_NOTES: Record<string, NoteSummary> = {};
for (const entries of Object.values(CHILDREN)) {
  for (const e of entries) if (e.kind === "note") ALL_NOTES[e.id] = e;
}

/**
 * Recognised from page 2 only — the case that once left Find disabled from the
 * skeleton. Kept out of `CHILDREN` because e2e asserts listing counts literally.
 */
ALL_NOTES["181"] = note("181", "Recognised from page two", 4, NOW - 2 * DAY, {
  hasRecognizedText: true,
  recognizedFrom: 1,
});

// Bin fixture notes: per-id generators answer for them via `noteSummary`, but
// they stay out of `ALL_NOTES` so live-wide walks never surface a trashed note.
const BIN_NOTES: Record<string, NoteSummary> = {};
for (const s of BIN_SEED_NOTES) {
  BIN_NOTES[s.id] = note(s.id, s.name, s.pageCount, NOW, {
    fileType: s.fileType,
    hasRecognizedText: s.recognized,
  });
}

/**
 * The paired `.mark`, outside `CHILDREN` and `ALL_NOTES` because the server
 * folds a live mark out of every listing; registered so its history resolves.
 */
const PDF_MARK_SUMMARY: NoteSummary = note(PDF_MARK_ID, "Appliance manual.pdf.mark", 1, NOW - 8 * DAY, {
  fileType: "mark",
});

/** Live library, then bin, then the paired mark. Library-wide walks use `ALL_NOTES` only. */
function noteSummary(id: Id): NoteSummary | undefined {
  return ALL_NOTES[id] ?? BIN_NOTES[id] ?? (id === PDF_MARK_ID ? PDF_MARK_SUMMARY : undefined);
}

// Parent of each folder (null = root), so listFolder can return the ancestor path.
const PARENT: Record<string, string | null> = {};
for (const [parent, entries] of Object.entries(CHILDREN)) {
  for (const e of entries) if (e.kind === "folder") PARENT[e.id] = parent === "root" ? null : parent;
}
function pathTo(id: Id | null): Folder[] {
  const out: Folder[] = [];
  let cur: string | null = id;
  while (cur) {
    const folder = FOLDERS[cur];
    if (!folder) break;
    out.unshift(folder);
    cur = PARENT[cur] ?? null;
  }
  return out;
}

/** Direct-child count, every kind, on listing rows only (never a breadcrumb), derived from `CHILDREN`. */
function withItemCount(e: Entry): Entry {
  return e.kind === "folder" ? { ...e, itemCount: (CHILDREN[e.id] ?? []).length } : e;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface FakeApiOptions {
  /** Simulated latency per call, ms. Default 120. Set 0 in unit tests. */
  latencyMs?: number;
  /** Starting sync-version; a LiveChannel fake can bump the mirror separately. */
  syncVersion?: number;
}

/** The paired `.mark`'s one page is PDF page 2; its dims are the device panel, not the PDF page. */
function markMeta(): NoteMeta {
  const layers = layeredPageLayers(0);
  return {
    id: PDF_MARK_ID,
    name: "Appliance manual.pdf.mark",
    annotationsId: null,
    fileType: "mark",
    fileHash: "m".repeat(32) as NoteMeta["fileHash"],
    size: 28_349,
    pxPerMm: null,
    pages: [
      {
        index: 0,
        hash: "m".repeat(32) as PageRef["hash"],
        width: 1404,
        height: 1872,
        textHash: null,
        // A `.mark` imports no template, so no links of its own.
        linksHash: null,
        sourcePage: PDF_MARK_SOURCE_PAGE,
        hasInk: true,
        layers,
      },
    ],
  };
}

export function createFakeApi(opts: FakeApiOptions = {}): Api {
  const latency = opts.latencyMs ?? 120;
  const syncVersion = opts.syncVersion ?? 1;

  // Per-instance, seeded lazily; a restore rewrites the entry as the real supersede path does.
  const historyState = new Map<Id, FileVersion[]>();
  const historyFor = (id: Id): FileVersion[] => {
    let v = historyState.get(id);
    if (!v) {
      v = baseVersions(id);
      historyState.set(id, v);
    }
    return v;
  };

  return {
    async listFolder(parentId: Id | null): Promise<Listing> {
      await delay(latency);
      const key = parentId ?? "root";
      const entries = (CHILDREN[key] ?? []).map(withItemCount);
      return {
        folderId: parentId,
        // No counts on the breadcrumb, as the real control plane.
        path: pathTo(parentId),
        entries,
        syncVersion,
      };
    },

    async getNoteMeta(id: Id): Promise<NoteMeta> {
      await delay(latency);
      if (id === PDF_MARK_ID) return markMeta();
      const summary = ALL_NOTES[id];
      if (!summary) throw new Error(`no such note: ${id}`);
      return {
        annotationsId: id === MARKED_PDF_ID ? PDF_MARK_ID : null,
        id,
        name: summary.name,
        // Layers per note (same helper as the listing's `firstPage`); dims from the summary so a landscape meta agrees.
        pages: pages(
          id,
          summary.pageCount,
          summary.hasRecognizedText,
          { w: summary.firstPage.width, h: summary.firstPage.height },
          RECOGNIZED_FROM[String(id)],
        ).map((p) => (id === LAYERED_NOTE_ID ? withLayeredPageLayers(p) : p)),
        // A route reload lands here with only the id, and the reader branches on these.
        fileType: summary.fileType,
        fileHash: summary.fileHash,
        size: fakeSize(id, summary.pageCount),
        // N6-class (1404 px over 118.64 mm); `144` has recognition but no scale.
        pxPerMm: summary.id === UNSCALED_NOTE_ID ? null : 1404 / 118.64,
      };
    },

    async getPageBytes(_id: Id, page: PageRef): Promise<ArrayBuffer> {
      await delay(latency);
      if (_id === PDF_MARK_ID) {
        const payload = layeredPagePayload(0);
        if (payload) return payload.slice().buffer as ArrayBuffer;
      }
      if (_id === LAYERED_NOTE_ID) {
        const payload = layeredPagePayload(page.index);
        if (payload) return payload.slice().buffer as ArrayBuffer;
      }
      // The fake renderer paints from page.hash; these bytes are only stable and page-shaped.
      const seed = page.hash;
      const buf = new Uint8Array(16);
      for (let i = 0; i < buf.length; i++) buf[i] = seed.charCodeAt(i) & 0xff;
      return buf.buffer;
    },

    async getTemplate(_id: Id, _hash: string): Promise<Blob> {
      // No custom image templates in the fake; a call would be a fixture bug.
      await delay(latency);
      throw new Error("fake api has no custom image templates");
    },

    async getPageText(id: Id, page: PageRef): Promise<PageText> {
      await delay(latency);
      const summary = ALL_NOTES[id];
      if (!summary) throw new Error(`no such note: ${id}`);
      // Unrecognized page: empty result, not an error, as the real endpoint.
      if (page.textHash === null) return { text: "", words: [] };
      const text = fakeText(summary.name, page.index);
      return { text, words: fakeWords(text) };
    },

    async getPageLinks(id: Id, page: PageRef): Promise<PageLinks> {
      await delay(latency);
      const summary = noteSummary(id);
      if (!summary) throw new Error(`no such note: ${id}`);
      // No link block: empty, not an error, as the real endpoint.
      if (page.linksHash === null) return { links: [] };
      return { links: fakePageLinks(page, summary.pageCount) };
    },

    // --- history ---
    // `restoreVersion` re-points and retains the displaced current, so it is undoable.

    async noteHistory(id: Id): Promise<FileHistory> {
      await delay(latency);
      return { id, versions: historyFor(id).map((v) => ({ ...v })) };
    },

    async historyMeta(id: Id, md5: string): Promise<NoteMeta> {
      await delay(latency);
      const summary = ALL_NOTES[id];
      if (!summary) throw new Error(`no such note: ${id}`);
      // The version's own geometry (fewer pages); `fileHash` is the version md5; layers omitted.
      const count = versionPageCount(summary, md5);
      return {
        // Today's mark annotates the current blob, not this past one.
        annotationsId: null,
        id,
        name: summary.name,
        // No per-version links route, so no links in a preview.
        pages: pages(
          id,
          count,
          summary.hasRecognizedText,
          { w: summary.firstPage.width, h: summary.firstPage.height },
          RECOGNIZED_FROM[String(id)],
        ).map((p) => ({ ...p, linksHash: null })),
        fileType: summary.fileType,
        fileHash: md5,
        size: fakeSize(id, count),
        pxPerMm: summary.id === UNSCALED_NOTE_ID ? null : 1404 / 118.64,
      };
    },

    async historyPageBytes(_id: Id, md5: string, index: number): Promise<ArrayBuffer> {
      await delay(latency);
      // The PDF annotation preview decodes this for real, so serve the live mark payload rather than junk.
      if (_id === PDF_MARK_ID) {
        const payload = layeredPagePayload(0);
        if (payload) return payload.slice().buffer as ArrayBuffer;
      }
      const seed = `${md5}:${index}`;
      const buf = new Uint8Array(16);
      for (let i = 0; i < buf.length; i++) buf[i] = seed.charCodeAt(i % seed.length) & 0xff;
      return buf.buffer;
    },

    async historyPageText(id: Id, md5: string, index: number): Promise<PageText> {
      await delay(latency);
      const summary = ALL_NOTES[id];
      if (!summary) throw new Error(`no such note: ${id}`);
      // Same recognition spread as live, version-flavoured text so tests can tell the two apart.
      if (!summary.hasRecognizedText || fakeTextHash(id, index, true) === null) {
        return { text: "", words: [] };
      }
      const text = `Version ${md5.slice(0, 6)} — ${fakeText(summary.name, index)}`;
      return { text, words: fakeWords(text) };
    },

    async restoreVersion(id: Id, md5: string): Promise<RestoredVersion> {
      await delay(latency);
      const versions = historyFor(id);
      const target = versions.find((v) => v.md5 === md5);
      if (!target) throw new Error(`no such version: ${md5}`);
      // The displaced current is retained (undoable). Newest-first: restored, displaced, rest.
      const now = NOW;
      const restored: FileVersion = { md5, size: target.size, createdAt: now, current: true, pageCount: target.pageCount };
      const displaced = versions.filter((v) => v.current).map((v) => ({ ...v, current: false }));
      const rest = versions.filter((v) => !v.current && v.md5 !== md5).map((v) => ({ ...v, current: false }));
      historyState.set(id, [restored, ...displaced, ...rest]);
      return { md5, size: target.size, createdAt: now, current: true };
    },

    async historyRaw(id: Id, md5: string): Promise<ArrayBuffer> {
      await delay(latency);
      // Shape-only; e2e serves real bytes off the mocked route.
      const seed = `${id}:${md5}:raw`;
      const buf = new Uint8Array(16);
      for (let i = 0; i < buf.length; i++) buf[i] = seed.charCodeAt(i % seed.length) & 0xff;
      return buf.buffer;
    },

    // --- bin-scoped reads ---
    // The same generators as the live routes, keyed on the trashed id.

    async binPageText(id: Id, page: PageRef): Promise<PageText> {
      await delay(latency);
      const summary = noteSummary(id);
      if (!summary) throw new Error(`no such trashed note: ${id}`);
      if (page.textHash === null) return { text: "", words: [] };
      const text = fakeText(summary.name, page.index);
      return { text, words: fakeWords(text) };
    },

    async binNoteHistory(id: Id): Promise<FileHistory> {
      await delay(latency);
      return { id, versions: historyFor(id).map((v) => ({ ...v })) };
    },

    async binHistoryPageBytes(_id: Id, md5: string, index: number): Promise<ArrayBuffer> {
      await delay(latency);
      const seed = `${md5}:${index}`;
      const buf = new Uint8Array(16);
      for (let i = 0; i < buf.length; i++) buf[i] = seed.charCodeAt(i % seed.length) & 0xff;
      return buf.buffer;
    },

    async binHistoryPageText(id: Id, md5: string, index: number): Promise<PageText> {
      await delay(latency);
      const summary = noteSummary(id);
      if (!summary) throw new Error(`no such trashed note: ${id}`);
      if (!summary.hasRecognizedText || fakeTextHash(id, index, true) === null) {
        return { text: "", words: [] };
      }
      const text = `Version ${md5.slice(0, 6)} — ${fakeText(summary.name, index)}`;
      return { text, words: fakeWords(text) };
    },

    async binHistoryRaw(id: Id, md5: string): Promise<ArrayBuffer> {
      await delay(latency);
      const seed = `${id}:${md5}:raw`;
      const buf = new Uint8Array(16);
      for (let i = 0; i < buf.length; i++) buf[i] = seed.charCodeAt(i % seed.length) & 0xff;
      return buf.buffer;
    },

    // --- rename ---
    // In place: the entry objects are shared with `listFolder` and `ALL_NOTES`. A
    // same-name sibling is the real 409. Imported dynamically: no top-level
    // import of `client.ts` here.
    async rename(id: Id, name: string): Promise<Entry> {
      await delay(latency);
      for (const entries of Object.values(CHILDREN)) {
        const entry = entries.find((e) => e.id === id);
        if (!entry) continue;
        if (entries.some((e) => e !== entry && e.name === name)) {
          const { NameTakenError } = await import("./client");
          throw new NameTakenError();
        }
        entry.name = name;
        return { ...entry };
      }
      throw new Error(`no such entry: ${id}`);
    },

    // --- upload ---
    // Mutates the fixture tree and enforces the real refusals (415 type, 413
    // quota). Progress comes in size-scaled steps so Cancel is observable.
    async upload(
      folderId: Id | null,
      file: File,
      onProgress?: (fraction: number) => void,
      signal?: AbortSignal,
      onConflict: "rename" | "replace" = "rename",
    ): Promise<Entry> {
      const { UploadRefusedError, ApiError } = await import("./client");
      const destKey = folderId === null ? "root" : String(folderId);
      const siblings = CHILDREN[destKey];
      // Missing, foreign and trashed are one answer, as on the real route.
      if (!siblings) throw new ApiError("NOT_FOUND", "That folder isn't there any more.", 404);

      const name = file.name.trim();
      if (name === "" || name.includes("/") || name === "." || name === "..") {
        throw new UploadRefusedError("name", 400);
      }
      if (!isAcceptedUpload(name)) throw new UploadRefusedError("type", 415);
      if (file.size > FAKE_UPLOAD_HEADROOM) throw new UploadRefusedError("quota", 413);

      const steps = uploadSteps(file.size);
      for (let i = 1; i <= steps; i++) {
        await delay(latency);
        // Checked between steps, so a cancel lands mid-transfer like `xhr.abort()`.
        if (signal?.aborted) throw new ApiError("CANCELLED", "Upload cancelled.", 0);
        onProgress?.(i / steps);
      }

      // Replace supersedes in place: same id, new timestamp (the displaced blob becomes a version).
      const occupant =
        onConflict === "replace"
          ? siblings.find((e): e is NoteSummary => e.kind === "note" && e.name === name)
          : undefined;
      if (occupant) {
        occupant.updatedAt = Date.now();
        return { ...occupant };
      }
      // Otherwise a free name, from the same helper the conflict prompt previews with.
      const final = nextAvailableName(
        name,
        siblings.map((e) => e.name),
      );
      const id = String(UPLOAD_ID_BASE + ++uploadSeq) as Id;
      const entry = note(id, final, 1, Date.now(), { fileType: uploadExtension(final) || "note" });
      siblings.push(entry);
      ALL_NOTES[String(id)] = entry;
      return { ...entry };
    },

    // --- WRITES (append-only, at your own marker — see `types.ts`) ---
    // --- BIN WRITES ---
    // Separate module: a fixture cannot be declared inside this object literal.
    ...createBinFake(
      delay,
      latency,
      (id) => {
        const n = ALL_NOTES[id];
        return n
          ? {
              name: n.name,
              fileType: n.fileType,
              size: fakeSize(id, n.pageCount),
              pageCount: n.pageCount,
              // Recognition and shape survive trashing (blob-keyed index).
              recognized: n.hasRecognizedText,
              thumbAspect: n.thumbAspect,
            }
          : null;
      },
      // Trashing does not rewrite a blob, so the same md5 as the live listing.
      fakeFileHash,
    ),
    // --- ADMIN WRITES ---
    //
    // A spread IIFE gives these methods a shared mutable fixture without
    // declaring anything outside this marker.
    ...(() => {
      const people = [
        { id: 1, email: "ana@household.lan", isAdmin: true, mustChangePassword: false, createdAt: 1_751_500_000 },
        { id: 2, email: "rui@household.lan", isAdmin: false, mustChangePassword: false, createdAt: 1_747_500_000 },
        { id: 3, email: "guest@household.lan", isAdmin: false, mustChangePassword: true, createdAt: 1_753_000_000 },
      ];
      let nextId = 4;

      /** Starts locked, so dev and e2e land on the gate first, as the real console does. */
      let elevated = false;

      /** The only password the fake accepts, so the wrong-password branch is reachable. */
      const PASSWORD = "inkhold";

      /**
       * The real `ApiError`, because `dispatchApiFailure` routes on `instanceof`.
       * Imported dynamically: no top-level import of client.ts here.
       */
      const httpError = async (code: string, message: string, status: number): Promise<Error> => {
        const { ApiError } = await import("./client");
        return new ApiError(code, message, status);
      };
      const needsElevation = () =>
        httpError("ELEVATION_REQUIRED", "Confirm your password to continue.", 428);

      const GB = 1024 * 1024 * 1024;

      /** Rui has a revoked device, so the re-pairable row is on screen. */
      const devices: Record<number, { equipmentNo: string; name: string; model: string | null; firmware: string | null; active: boolean; createdAt: number }[]> = {
        1: [{ equipmentNo: "SN1000A2X", name: "Nomad", model: "A5X2", firmware: "3.20.29", active: true, createdAt: 1_751_500_000 }],
        2: [
          { equipmentNo: "SN1000B7K", name: "Manta", model: "A6X2", firmware: "3.21.02", active: true, createdAt: 1_747_600_000 },
          { equipmentNo: "SN1000C1M", name: "Nomad", model: "A5X2", firmware: "3.19.11", active: false, createdAt: 1_735_700_000 },
        ],
        // Guest has none: the "no device linked yet" state.
        3: [],
      };

      /** Rui is over his allotment, which the meter must draw rather than clamp. */
      const quotas: Record<number, { usedBytes: number; totalBytes: number }> = {
        1: { usedBytes: 5.4 * GB, totalBytes: 10 * GB },
        2: { usedBytes: 11.2 * GB, totalBytes: 10 * GB },
        3: { usedBytes: 0, totalBytes: 2 * GB },
      };

      let retentionDays = 30;
      let retentionChangedAt = 0;

      const notFound = () => httpError("USER_NOT_FOUND", "no such user", 404);

      /** A readable temporary password, in the shape the server generates. */
      const tempPassword = (): string => {
        const nouns = ["plum", "river", "otter", "copper", "linen", "cedar"];
        const pick = () => nouns[Math.floor(Math.random() * nouns.length)]!;
        return `${pick()}-${pick()}-${String(Math.floor(Math.random() * 90) + 10)}`;
      };

      return {
        async adminListUsers() {
          await delay(latency);
          if (!elevated) throw await needsElevation();
          return people.map((p) => ({ ...p }));
        },

        async adminCreateUser(email: string, isAdmin: boolean): Promise<string> {
          await delay(latency);
          if (!elevated) throw await needsElevation();
          const address = email.trim().toLowerCase();
          if (people.some((p) => p.email.toLowerCase() === address)) {
            throw await httpError("EMAIL_EXISTS", "an account with that email already exists", 200);
          }
          // Must-change from birth, as on the real server.
          const id = nextId++;
          people.push({ id, email: address, isAdmin, mustChangePassword: true, createdAt: Date.now() / 1000 });
          // Accounting rows at creation, like the server's `ensureCapacity`.
          quotas[id] = { usedBytes: 0, totalBytes: 2 * GB };
          devices[id] = [];
          return tempPassword();
        },

        async adminDeleteUser(id: number): Promise<void> {
          await delay(latency);
          if (!elevated) throw await needsElevation();
          const at = people.findIndex((p) => p.id === id);
          if (at < 0) return;
          // The server refuses deleting the last administrator.
          if (people[at]!.isAdmin && people.filter((p) => p.isAdmin).length <= 1) {
            throw await httpError("LAST_ADMIN", "cannot remove the last administrator", 200);
          }
          const [gone] = people.splice(at, 1);
          // By hand what the server's FK cascade does, so a recycled id has a clean meter.
          if (gone) {
            delete quotas[gone.id];
            delete devices[gone.id];
          }
        },

        async adminResetPassword(id: number): Promise<string> {
          await delay(latency);
          if (!elevated) throw await needsElevation();
          const person = people.find((p) => p.id === id);
          if (person) person.mustChangePassword = true;
          return tempPassword();
        },

        async adminElevate(_account: string, plaintext: string): Promise<void> {
          await delay(latency);
          if (plaintext !== PASSWORD) {
            throw await httpError("INVALID_CREDENTIALS", "password incorrect", 200);
          }
          elevated = true;
        },

        async adminLock(): Promise<void> {
          await delay(latency);
          elevated = false;
        },

        async adminListDevices(userId: number) {
          await delay(latency);
          if (!elevated) throw await needsElevation();
          const list = devices[userId];
          if (!list) throw await notFound();
          // Revoked bindings included, as the server does.
          return list.map((d) => ({ ...d }));
        },

        async adminUnlinkDevice(userId: number, equipmentNo: string): Promise<void> {
          await delay(latency);
          if (!elevated) throw await needsElevation();
          const device = devices[userId]?.find((d) => d.equipmentNo === equipmentNo && d.active);
          // Unknown and someone else's serial are one error, so serials can't be probed.
          if (!device) throw await httpError("DEVICE_NOT_FOUND", "that user has no such device", 404);
          device.active = false; // a soft flip, exactly as the server does it
        },

        async adminGetQuota(userId: number) {
          await delay(latency);
          if (!elevated) throw await needsElevation();
          const q = quotas[userId];
          if (!q) throw await notFound();
          return { ...q };
        },

        async adminSetQuota(userId: number, totalBytes: number) {
          await delay(latency);
          if (!elevated) throw await needsElevation();
          const q = quotas[userId];
          if (!q) throw await notFound();
          if (totalBytes < 0) throw await httpError("INVALID_QUOTA", "an allotment cannot be negative", 400);
          // Stored verbatim, even below usage: nothing is deleted.
          q.totalBytes = totalBytes;
          return { ...q };
        },

        async adminGetRetention() {
          await delay(latency);
          if (!elevated) throw await needsElevation();
          return { retentionDays, defaultDays: 30, minDays: 1, maxDays: 365, changedAt: retentionChangedAt };
        },

        async adminSetRetention(days: number) {
          await delay(latency);
          if (!elevated) throw await needsElevation();
          if (!Number.isInteger(days) || days < 1 || days > 365) {
            throw await httpError("INVALID_RETENTION", "retention must be between 1 and 365 days", 400);
          }
          retentionDays = days;
          // Not retroactive: nothing is purged; `changedAt` gives existing entries a new window.
          retentionChangedAt = Math.floor(Date.now() / 1000);
          return { retentionDays, defaultDays: 30, minDays: 1, maxDays: 365, changedAt: retentionChangedAt };
        },

        async adminHealth() {
          await delay(latency);
          if (!elevated) throw await needsElevation();
          return {
            version: "0.0.1",
            memoryBytes: 31.4 * 1024 * 1024,
            memoryBudgetBytes: 50 * 1024 * 1024,
            blobBytes: 4.8 * GB,
            blobCount: 1284,
          };
        },
      };
    })(),

    // --- account (self-service) ---
    // A spread IIFE like the admin block. `changePassword` verifies the current
    // password, as the real route does. One member's account, one Nomad.
    ...(() => {
      const MB = 1024 * 1024;

      /** One named tablet; `lastSeenAt` relative to build time so the row never ages. */
      const now = () => Math.floor(Date.now() / 1000);
      let devices = [
        {
          equipmentNo: "SN1000A2X",
          name: "Nomad",
          model: "A5X2",
          firmware: "3.20.29",
          lastSeenAt: now() - 20 * 60,
          linkedAt: now() - 190 * 86_400,
        },
      ];

      /** A partition: the kinds plus bin plus versions sum to `usedBytes` (214+46+178+12+13 = 463 MB). */
      const kinds = { notebookBytes: 214 * MB, sketchBytes: 46 * MB, documentBytes: 178 * MB, binBytes: 12 * MB };
      const totalBytes = 10 * 1024 * MB;

      /** Retained versions per file; `keep = 3` removes 8, the design's own example. */
      let retainedPerFile: number[] = [5, 5, 5, 5, 3, 2];
      let keep = 5;
      /** The admin's ceiling on `keep`. */
      const maxKeep = 20;
      const bytesPerVersion = (13 * MB) / 25; // the 25 retained versions above ≈ 13 MB
      const versionBytes = () => Math.round(retainedPerFile.reduce((a, b) => a + b, 0) * bytesPerVersion);

      /** Same as the admin gate's; mutable so the new password is the one the next change must prove. */
      let password = "inkhold";

      /** The real error class, imported dynamically like the admin block's. */
      const httpError = async (code: string, message: string, status: number): Promise<Error> => {
        const { ApiError } = await import("./client");
        return new ApiError(code, message, status);
      };

      let otherSessions = 2;
      /** A date rather than null so dev and e2e exercise the common rendering. */
      let passwordChangedAt: number | null = now() - 97 * 86_400;
      const thisSessionSince = now() - 3 * 86_400;

      const policy = () => ({ keep, maxKeep, retainedPerFile: [...retainedPerFile] });

      return {
        async myDevices() {
          await delay(latency);
          return devices.map((d) => ({ ...d }));
        },

        async unlinkMyDevice(equipmentNo: string): Promise<void> {
          await delay(latency);
          const found = devices.some((d) => d.equipmentNo === equipmentNo);
          // Unknown and someone else's serial are one error.
          if (!found) throw await httpError("DEVICE_NOT_FOUND", "no such device on this account", 404);
          // Removed, unlike the admin listing: your list is the tablets that sync.
          devices = devices.filter((d) => d.equipmentNo !== equipmentNo);
        },

        async signOutEverywhere(): Promise<number> {
          await delay(latency);
          const ended = otherSessions;
          otherSessions = 0;
          return ended;
        },

        async storageBreakdown() {
          await delay(latency);
          const byKind = { ...kinds, versionBytes: versionBytes() };
          // Summed, so the lines always add up to the meter.
          const usedBytes =
            byKind.notebookBytes +
            byKind.sketchBytes +
            byKind.documentBytes +
            byKind.binBytes +
            byKind.versionBytes;
          return { usedBytes, totalBytes, byKind };
        },

        async versionPolicy() {
          await delay(latency);
          return policy();
        },

        async setVersionPolicy(next: number) {
          await delay(latency);
          // Clamped by the server, not just the control.
          const target = Math.max(0, Math.min(maxKeep, Math.floor(next)));
          const before = retainedPerFile.reduce((a, b) => a + b, 0);
          retainedPerFile = retainedPerFile.map((c) => Math.min(c, target));
          const removedVersions = before - retainedPerFile.reduce((a, b) => a + b, 0);
          keep = target;
          return {
            policy: policy(),
            removedVersions,
            freedBytes: Math.round(removedVersions * bytesPerVersion),
          };
        },

        async accountSecurity() {
          await delay(latency);
          return { passwordChangedAt, otherSessions, thisSessionSince };
        },

        async changePassword(currentPlaintext: string, newPlaintext: string): Promise<void> {
          await delay(latency);
          // `INVALID_CREDENTIALS` at status 200, before anything changes, as the server.
          if (currentPlaintext !== password) {
            throw await httpError("INVALID_CREDENTIALS", "current password incorrect", 200);
          }
          if (newPlaintext === password) {
            throw await httpError("SAME_PASSWORD", "that is already your password", 200);
          }
          password = newPlaintext;
          // The real route revokes every other session.
          otherSessions = 0;
          passwordChangedAt = now();
        },
      };
    })(),
  };
}
