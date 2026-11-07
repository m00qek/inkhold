// The fake API's fixture tree: folders, notes, pages, text, links, versions and sizes.

import type { PdfLink, Entry, FileVersion, Folder, Id, NoteSummary, PageRef, WordBox } from "../core/types";
import { BIN_SEED_NOTES } from "./binFake";
import { LAYERED_NOTE_ID, withLayeredPageLayers } from "./layeredFixture";
import { canPreviewHistory } from "../core/fileKind";
import { fakeFileHash, fakeHash } from "./fakeHash";

export { fakeFileHash };

/**
 * The `.mark` annotating PDF `178`, reusing the layered fixture's real SNPG v2
 * payload. Sparse like a real mark: its one page annotates PDF page 2, so a
 * viewer that ignored `sourcePage` would visibly paint on the wrong page.
 */
export const MARKED_PDF_ID = "178";
export const PDF_MARK_ID = "179";
export const PDF_MARK_SOURCE_PAGE = 2;

/** Notes whose recognition starts after page 1; `getNoteMeta` must rebuild the summary's per-page pattern. */
export const RECOGNIZED_FROM: Record<string, number> = {};

/** The PDF-template note: its pages keep the imported PDF's links. Seven pages, so an internal jump is meaningful. */
const LINKED_NOTE_ID: Id = "122";

/** A page with no ink, mid-note, so the ink rail has a gap to draw. */
const BLANK_PAGE_NOTE_ID: Id = "141";
const BLANK_PAGE_INDEX = 4;

export function fakeTextHash(noteId: Id, index: number, recognized: boolean, from = 0): string | null {
  if (!recognized || index < from || index % 3 === 2) return null;
  return fakeHash(`${noteId}:${index}:recogntext`);
}

export function pages(
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
export function fakeText(name: string, index: number): string {
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
export function fakePageLinks(page: PageRef, pageCount: number): PdfLink[] {
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
export function note(id: Id, name: string, pageCount: number, updatedAt: number, opts: NoteOpts = {}): NoteSummary {
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
export const UNSCALED_NOTE_ID = "144";

/** Word boxes in millimetres on the 118.64 x 158.19 mm canvas, kept inside the page. */
export function fakeWords(text: string): WordBox[] {
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

export function fakeSize(id: Id, pageCount: number): number {
  return 40_000 + pageCount * 90_000 + (id.length % 7) * 1_337;
}

// --- the upload fixture ------------------------------

/** Fixture account's free space; a bigger file gets the real 413. Exported as a test input. */
export const FAKE_UPLOAD_HEADROOM = 8 * 1024 * 1024;

/** Progress steps scale with size so the progress bar and Cancel are observable. */
export function uploadSteps(size: number): number {
  return Math.max(4, Math.min(24, Math.ceil(size / 65_536)));
}

/** Upload ids `901`, `902`, … — decimal, clear of the fixture tree. */
export const UPLOAD_ID_BASE = 900;

const DAY = 86_400_000;
export const NOW = 1_752_800_000_000; // fixed epoch ms — no Date.now(), keeps fixtures deterministic

// --- the version-history fixture ---------------------------------------------
// Every `.note` gets its current blob plus two retained versions, newest-first;
// other kinds carry only their current version.

/** The retained versions a `.note` accrues, by seed suffix — see `baseVersions`. */
const RETAINED_VERSION_KS = [1, 2] as const;

/** Older retained versions have fewer pages (`current - k`), so a preview must use the version's own geometry. */
export function versionPageCount(summary: NoteSummary, md5: string): number {
  for (const k of RETAINED_VERSION_KS) {
    if (fakeHash(`${summary.id}:v${k}`) === md5) return Math.max(1, summary.pageCount - k);
  }
  return summary.pageCount;
}

/** Current blob plus the retained pair for every previewable kind; others carry only the current one. */
export function baseVersions(id: Id): FileVersion[] {
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

export const CHILDREN: Record<string, Entry[]> = {
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

export const ALL_NOTES: Record<string, NoteSummary> = {};
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
export function noteSummary(id: Id): NoteSummary | undefined {
  return ALL_NOTES[id] ?? BIN_NOTES[id] ?? (id === PDF_MARK_ID ? PDF_MARK_SUMMARY : undefined);
}

// Parent of each folder (null = root), so listFolder can return the ancestor path.
const PARENT: Record<string, string | null> = {};
for (const [parent, entries] of Object.entries(CHILDREN)) {
  for (const e of entries) if (e.kind === "folder") PARENT[e.id] = parent === "root" ? null : parent;
}
export function pathTo(id: Id | null): Folder[] {
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
export function withItemCount(e: Entry): Entry {
  return e.kind === "folder" ? { ...e, itemCount: (CHILDREN[e.id] ?? []).length } : e;
}
