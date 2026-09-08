// An in-memory Api implementation over a small fixture tree. This is what the UI
// runs against in `dev` and in Playwright e2e until the real control-plane endpoints
// (P4) exist, and it's the reference for what those endpoints must return. It is
// deliberately synchronous data behind async signatures + a tiny latency, so
// loading states and lazy behaviour are exercised realistically.

import type { Api, PageLinks } from "./types";
import type { PdfLink } from "../render/pdfLinks";
// The bin half of this fake, in its own module — see the `--- BIN WRITES ---`
// marker below and `binFake.ts`'s header for why it is not inline.
import { createBinFake, BIN_SEED_NOTES } from "./binFake";
// The layered `.note` fixture: real SNPG v2 payloads + `layers` page refs for
// ONE note, so the reader's layers panel runs against the real wasm decoder in
// dev and e2e. Shared with binFake (a trashed note keeps its layers, as the
// real blob-keyed index does) — see that module's header.
import {
  LAYERED_NOTE_ID,
  layeredPageLayers,
  layeredPagePayload,
  withLayeredPageLayers,
} from "./layeredFixture";

/**
 * The `.mark` that annotates `n-files-manual`, and the PDF it belongs to.
 *
 * It reuses the layered fixture's payload, which is already a real SNPG v2 body
 * at 1404x1872 — the device PANEL size, which is exactly what a mark is written
 * in. So the overlay path runs the real wasm decoder over real layer records
 * rather than a stand-in.
 *
 * SPARSE, like the real thing: one page, annotating PDF page 2 (`sourcePage: 2`,
 * 1-based). That the mark's only page is NOT the PDF's first is the point — a
 * viewer that ignored `sourcePage` would paint this ink on page 1 and look
 * perfectly plausible doing it.
 */
export const MARKED_PDF_ID = "n-files-manual";
export const PDF_MARK_ID = "n-files-manual.pdf.mark";
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
  NoteSearchBatch,
  NoteSearchResults,
  NoteSummary,
  PageMatch,
  PageRef,
  PageText,
  RestoredVersion,
  TxtMatch,
  TxtSearchBatch,
  TxtSearchResults,
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

/**
 * The whole-file content hash a fixture entry advertises as its `fileHash` —
 * the value the thumbnail facade puts in `/thumbnail/{hash}` for `.spd` and
 * `.note` tiles. Exported so the e2e thumbnail mock can address a SPECIFIC
 * fixture file's URL (serve this note's cover, withhold that one's) instead of
 * blanket-answering every hash the same way.
 */
export function fakeFileHash(id: Id): string {
  return fakeHash(`${id}:file`);
}

/**
 * The recognition hash for a fixture page, or null where the device never ran
 * recognition. A note the user never recognized has NO recognized page at all;
 * within one that they did, every third page (index 2, 5, 8…) is deliberately
 * left WITHOUT any — that's what keeps the reader's disabled toggle and empty
 * state honestly exercised in dev and in e2e, instead of a happy path where
 * everything happens to have text.
 *
 * Keeping the per-page nulls derived from the note's `hasRecognizedText` is what
 * makes the fixture self-consistent: the gallery's OCR marker means exactly
 * "some page here has a transcript", and in the fake it provably does.
 *
 * Note it is seeded independently of the page content hash, mirroring the real
 * thing: RECOGNTEXT is not a layer, so its hash moves independently of strokes.
 */
/**
 * Notes whose recognition does not start at page 1, by id (see
 * `NoteOpts.recognizedFrom`). A side table because `NoteSummary` has no field
 * for it — the server never sends one, since the listing only carries the
 * whole-note `hasRecognizedText` — and `getNoteMeta` still has to rebuild the
 * SAME per-page pattern the summary was derived from.
 */
const RECOGNIZED_FROM: Record<string, number> = {};

/**
 * The PDF-TEMPLATE fixture: the one note whose pages were rasterised from an
 * imported PDF and kept that document's own links (`note-format.md` §14).
 *
 * Chosen rather than invented, for the reason `n-late-ocr` states in reverse:
 * every listing count and section head in the e2e suite is asserted literally,
 * so a NEW note in a real folder rewrites unrelated expectations. This one is
 * seven pages long, which is what an internal page jump needs to be worth
 * looking at.
 */
const LINKED_NOTE_ID: Id = "n-proj-beta";

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
    // Supernote A5X native page size — EFFECTIVE dims, so a landscape fixture
    // passes 1872×1404 and its refs read honestly wide, as the real index does.
    width: dims?.w ?? 1404,
    height: dims?.h ?? 1872,
    textHash: fakeTextHash(noteId, index, recognized, recognizedFrom),
    // Non-null ONLY for the PDF-template fixture, exactly as the real page list
    // has it: a note on a built-in style has no links to preserve, so the field
    // is null for every page of every other note and the reader never asks.
    linksHash: noteId === LINKED_NOTE_ID ? fakeHash(`${noteId}:${index}:links`) : null,
    // A `.note` page: its number is always `index + 1`, so there is nothing
    // to carry (see `PageRef.sourcePage`).
    sourcePage: null,
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
    // Deliberately full of characters that are HTML syntax. The transcript is
    // DEVICE-AUTHORED text — whatever the handwriting recogniser produced — and
    // it is rendered through `textContent` everywhere, now that the excerpt that
    // used to reach `innerHTML` is gone (§6 step 6). Keeping angle brackets and
    // an ampersand in the fixture is what would catch that regressing, against a
    // corpus that would otherwise happen to be alphanumeric.
    "  · <draft> R&D budget — flag \"open\" items & re-check",
    "",
    "Follow-up: re-read the sync notes before Thursday,",
    "then fold the answers back into the design doc.",
    // ONE LINE THAT IS NOT ON EVERY PAGE, and the only one. Every other line of
    // this transcript is identical across pages, so any query either matched
    // everywhere at once or nowhere — and find's navigation had nothing to be
    // wrong about. A word that lives on some pages and not others is what makes
    // "the match is not on the page in front of you" a state the fixture can
    // reach at all; it is the shape the real bug was reported in.
    ...(index % 2 === 1 ? ["Marginalia: the witches of Endor, again."] : []),
  ];
  return lines.join("\n");
}

/**
 * A page's links, in the shape the real endpoint serves: **device panel pixels**
 * (the `.note` page IS the panel), a 0-based target for an internal jump and
 * `-1` with a real URL for an external one.
 *
 * Two per page, placed where a digital planner puts them — a header tab and a
 * footer nav — and NOT vertically centred, so a placement that lost the y
 * offset would be visible rather than symmetric enough to pass.
 *
 * The refused schemes are absent on purpose: the SERVER applies the allowlist,
 * so a `javascript:` record never reaches a client, and a fake that emitted one
 * would be testing the browser's last-ditch gate instead of the seam.
 */
function fakePageLinks(page: PageRef, pageCount: number): PdfLink[] {
  // Wrap, so the last page still links somewhere real — and never to itself.
  const target = (page.index + 1) % pageCount;
  return [
    { x: 980, y: 96, w: 340, h: 64, page: -1, uri: "https://example.com/planner?utm=fixture&a=1,2" },
    { x: 96, y: 1680, w: 420, h: 72, page: target, uri: "none" },
  ];
}

// --- the `.txt` fixture content ---------------------------------------------
//
// The raw text a `.txt` fixture holds. Its paragraphs are what the segment seam
// indexes, and what the `.txt` viewer's find scrolls to and marks inside.
// `zephyrine` lives ONLY here
// (no note transcript, no file name), so a search for it exercises the pure
// `.txt` path end to end — one text hit, opening the `.txt` viewer.
//
// e2e serves this SAME string as the raw `/file/:id` body, so the viewer's
// client-side marking lines up with the byte ranges this fixture reports.
const TXT_CONTENT: Record<Id, string> = {
  "n-files-readme":
    "Shopping list\n\n- oat milk\n- lentils\n- a new nib for the Supernote\n\n" +
    "The zephyrine tea arrived on Friday.\n\n" +
    "See you Sunday. More zephyrine steeped, brighter.",
};

// --- the `.pdf` fixture content ---------------------------------------------
//
// The text a `.pdf` fixture's PAGES hold — the segment seam's THIRD tenant, and
// the shape `pdf_text.zig` writes: one indexed segment per page, `kind = 2`,
// addressed by the PDF page number. Find-in-PDF marks inside them.
//
// NOT DERIVED FROM `hasRecognizedText`, and that is the point rather than a
// shortcut: a PDF is not a note and has no on-device recognition, so it is not
// what "only notes recognised on the device are searchable" is about. Whether
// its text is indexed is a fact
// about the SERVER's pass over the blob, which is exactly what this table stands
// in for — the same way `TXT_CONTENT` stands in for the `.txt` chunker.
//
// `marmalade` lives ONLY here (no note transcript, no `.txt` paragraph, no file
// name), so a search for it exercises the pure `.pdf` path end to end.
//
// e2e serves a REAL PDF carrying these same lines as the raw `/file/:id` body,
// so what MuPDF locates in the browser is what this fixture says matched. If the
// two ever drift, the deep-link test fails with marks missing rather than
// quietly proving nothing.
const PDF_CONTENT: Record<Id, string[]> = {
  "n-files-manual": [
    "Marmalade kettle descaling",
    "Marmalade drum bearing service",
    "Filter mesh rinse programme",
    "Marmalade spare parts",
  ],
};

/** One paragraph of a `.txt` fixture, with its BYTE range — the real index's row. */
interface TxtSeg {
  ordinal: number;
  text: string;
  offset: number;
  length: number;
}

/**
 * Split a `.txt` fixture's content into paragraphs on blank lines, tracking each
 * paragraph's BYTE range — the same shape `txt_index.zig` derives (one segment
 * per run of non-blank lines; a `\r` before a terminator trimmed). Byte offsets
 * are computed through `TextEncoder`, so an accented fixture still reports the
 * ranges the viewer maps back through.
 */
function txtSegmentsOf(id: Id): TxtSeg[] {
  const content = TXT_CONTENT[id];
  if (content === undefined) return [];
  const enc = new TextEncoder();
  const segs: { startChar: number; text: string }[] = [];
  const lines = content.split("\n");
  let charPos = 0;
  let start = -1;
  let end = -1;
  const isBlank = (l: string): boolean => /^[ \t\r]*$/.test(l);
  const flush = (): void => {
    if (start >= 0) segs.push({ startChar: start, text: content.slice(start, end) });
    start = -1;
  };
  for (const line of lines) {
    const lineStart = charPos;
    const contentEnd = lineStart + line.length - (line.endsWith("\r") ? 1 : 0);
    if (isBlank(line)) flush();
    else {
      if (start < 0) start = lineStart;
      end = contentEnd;
    }
    charPos += line.length + 1; // the split consumed one "\n"
  }
  flush();
  return segs.map((s, ordinal) => ({
    ordinal,
    text: s.text,
    offset: enc.encode(content.slice(0, s.startChar)).length,
    length: enc.encode(s.text).length,
  }));
}

/**
 * The in-doc STREAMING stride: how many matching pages/paragraphs one batch of a
 * streaming find carries. Deliberately SMALLER than the real server's 20 so the
 * fake's modest fixtures still stream across several batches — which is what lets
 * the viewer's "N+" floor, its settle, and prev/next across a batch boundary be
 * exercised at all. The value is not observable as a number anywhere (the floor
 * shows the ACCUMULATED count, not the stride), so a fake-only stride is honest.
 */
const FIND_STREAM_BATCH = 6;

// --- the note-scoped search fixture -----------------------------------------
//
// Stands in for `note_search.searchNotePages`, and it is TOKEN-BASED rather than
// substring-based because the three properties the reader is built on are all
// properties of tokens:
//
//   1. NO LIMIT and NO RANKING — a per-note counter that clamps is silently
//      incomplete, which is why find has never been a library query filtered
//      down to one document;
//   2. every page names WHICH TERMS it matched, so the client circles exactly
//      what was counted instead of re-deriving it from the query;
//   3. a typo falls back to close matches, and the response says that it did.
//
// A substring model can express none of the last two honestly: it has no notion
// of a term to report, and no notion of a near-miss to fall back to.

/**
 * Case- and accent-insensitive form — the same fold `unicode61
 * remove_diacritics 2` applies to the real index, and the same one
 * `findInNote.ts` applies to a word label before comparing it with a term.
 */
function foldTerm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Every term a string tokenizes to, in order, folded. Punctuation splits. */
function termsOf(s: string): string[] {
  return foldTerm(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The edit budget for a token of `len` characters — the backend's 0/1/2 ladder. */
function fakeMaxEdits(len: number): number {
  if (len <= 3) return 0;
  if (len <= 7) return 1;
  return 2;
}

/** Levenshtein distance, bailing out past `budget`. */
function editDistance(a: string, b: string, budget: number): number | null {
  if (Math.abs(a.length - b.length) > budget) return null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 0; i < a.length; i++) {
    const curr = [i + 1];
    let rowMin = curr[0]!;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      curr.push(Math.min(curr[j]! + 1, prev[j + 1]! + 1, prev[j]! + cost));
      rowMin = Math.min(rowMin, curr[j + 1]!);
    }
    if (rowMin > budget) return null;
    prev = curr;
  }
  return prev[b.length]! > budget ? null : prev[b.length]!;
}

/** One term of the query as the index would search for it. */
interface QueryTerm {
  term: string;
  /** Whether the MATCH would prefix-match it — the word still being typed. */
  prefix: boolean;
}

/**
 * The query's terms. Only the LAST is a prefix, and only past two characters,
 * mirroring `buildMatch`. The `q` reaching here is already trimmed by the client
 * seam, so there is no trailing space left to say the word is finished.
 */
function queryTerms(query: string): QueryTerm[] {
  const terms = termsOf(query);
  return terms.map((term, i) => ({ term, prefix: i === terms.length - 1 && term.length >= 2 }));
}

function satisfies(pageTerm: string, q: QueryTerm): boolean {
  return q.prefix ? pageTerm.startsWith(q.term) : pageTerm === q.term;
}

/**
 * One word of the query and its accepted spellings. OR within a group, AND
 * across groups — the shape of the backend's expression, where a widened token
 * becomes `("witchez"* OR "witches")` and the AND between words survives it.
 */
type TermGroup = QueryTerm[];

const satisfiesGroup = (pageTerm: string, group: TermGroup): boolean =>
  group.some((q) => satisfies(pageTerm, q));

/** The recognised pages of a note, with their transcripts already tokenized. */
function notePageTerms(noteId: Id): { pageIndex: number; terms: string[] }[] {
  // `noteSummary`, not `ALL_NOTES`: a TRASHED note's in-note search (the bin
  // reroute) scans its retained transcript too. Library-WIDE search never reaches
  // here for a trashed id — it walks `ALL_NOTES` and the row is not in it.
  const summary = noteSummary(noteId);
  // A `.pdf`'s indexed pages, which is the SAME ROUTE a note's pages come
  // through — `searchNotePages` is keyed on the document's blob and not on its
  // format, so the server needs no branch here and neither does the fixture.
  // What differs is only where the text comes from.
  const pdfPages = PDF_CONTENT[noteId];
  if (pdfPages) {
    return pdfPages.map((text, pageIndex) => ({ pageIndex, terms: termsOf(text) }));
  }
  if (!summary || !summary.hasRecognizedText) return [];
  const out: { pageIndex: number; terms: string[] }[] = [];
  for (const page of pages(noteId, summary.pageCount, true)) {
    // A page the device never recognized is invisible to find, exactly as the
    // real index has no row for it.
    if (page.textHash === null) continue;
    out.push({ pageIndex: page.index, terms: termsOf(fakeText(summary.name, page.index)) });
  }
  return out;
}

/**
 * One pass: every page whose terms satisfy EVERY group, with the count of
 * matching word instances and the distinct terms those instances are.
 *
 * The count is INSTANCES and the term list is DISTINCT, which is the same
 * distinction the backend draws: a page saying "echo echo echo" is three matches
 * and one term, because the terms are labels to compare words against while the
 * count is the tally.
 */
function noteSearchPass(noteId: Id, groups: TermGroup[]): PageMatch[] {
  if (groups.length === 0) return [];
  const out: PageMatch[] = [];
  for (const page of notePageTerms(noteId)) {
    if (!groups.every((g) => page.terms.some((t) => satisfiesGroup(t, g)))) continue;
    const hit = page.terms.filter((t) => groups.some((g) => satisfiesGroup(t, g)));
    out.push({ pageIndex: page.pageIndex, matches: hit.length, terms: [...new Set(hit)] });
  }
  return out;
}

/**
 * Each query word widened by the near-miss spellings a VOCABULARY offers, or
 * null when nothing anywhere is near enough — in which case the caller must NOT
 * re-run, because the pass would be identical to the exact one that just found
 * nothing. This is the shared body of both the note- and `.txt`-scoped fuzzy
 * fallback; only the vocabulary source differs, so each caller assembles its own
 * and hands it in.
 *
 * A word still being typed is compared against the vocabulary term TRUNCATED to
 * what has been typed, exactly as the backend does, so a typo inside a half
 * written word is still reachable.
 */
function widenAgainstVocabulary(vocabulary: Set<string>, terms: QueryTerm[]): TermGroup[] | null {
  let widened = false;
  const groups = terms.map((q) => {
    const group: TermGroup = [q];
    const budget = fakeMaxEdits(q.term.length);
    if (budget === 0) return group;
    for (const word of vocabulary) {
      const candidate = q.prefix ? word.slice(0, q.term.length) : word;
      const d = editDistance(q.term, candidate, budget);
      // Distance 0 is the term the exact pass already searched for.
      if (d !== null && d > 0) {
        group.push({ term: word, prefix: false });
        widened = true;
      }
    }
    return group;
  });
  return widened ? groups : null;
}

/** {@link widenAgainstVocabulary} over one note's own page vocabulary. */
function fuzzyGroups(noteId: Id, terms: QueryTerm[]): TermGroup[] | null {
  return widenAgainstVocabulary(new Set(notePageTerms(noteId).flatMap((p) => p.terms)), terms);
}

/**
 * The note-scoped search: EVERY matching page of one note, in page order, with a
 * per-page count, the terms that count counted, and whether it had to guess.
 *
 * Exact first; the vocabulary is consulted ONLY when that found nothing, which
 * is what keeps the fallback invisible whenever it is not needed.
 */
function noteSearchFixture(noteId: Id, query: string): { pages: PageMatch[]; usedFuzzy: boolean } {
  const terms = queryTerms(query);
  if (terms.length === 0) return { pages: [], usedFuzzy: false };

  const exact = noteSearchPass(noteId, terms.map((q) => [q]));
  if (exact.length > 0) return { pages: exact, usedFuzzy: false };

  const widened = fuzzyGroups(noteId, terms);
  if (widened === null) return { pages: [], usedFuzzy: false };
  // The expansion having RUN is what the flag reports, as on the real service —
  // so it is true even when the widened search still finds nothing.
  return { pages: noteSearchPass(noteId, widened), usedFuzzy: true };
}

// --- the `.txt`-scoped search fixture ---------------------------------------
//
// Stands in for `note_search.searchTxtSegments`, the `.txt` analog of the
// note-scoped fixture above and TOKEN-BASED for the same three reasons: no
// limit / no ranking (a per-file counter that clamps is silently wrong), every
// paragraph names WHICH terms it matched (so the viewer marks exactly what was
// counted), and a typo falls back to close matches, saying so. It differs from
// the note fixture only in what a segment IS — a paragraph carrying its byte
// range, not a page.

/** A `.txt` file's paragraphs, with their terms already tokenized (AND-per-paragraph). */
function txtSegTerms(id: Id): { seg: TxtSeg; terms: string[] }[] {
  return txtSegmentsOf(id).map((seg) => ({ seg, terms: termsOf(seg.text) }));
}

/**
 * One pass: every paragraph whose terms satisfy EVERY group, with its byte
 * range, the count of matching word instances, and the distinct terms — the
 * INSTANCES/DISTINCT split the backend draws (`countMatches`).
 */
function txtSearchPass(id: Id, groups: TermGroup[]): TxtMatch[] {
  if (groups.length === 0) return [];
  const out: TxtMatch[] = [];
  for (const { seg, terms } of txtSegTerms(id)) {
    if (!groups.every((g) => terms.some((t) => satisfiesGroup(t, g)))) continue;
    const hit = terms.filter((t) => groups.some((g) => satisfiesGroup(t, g)));
    out.push({
      segment: seg.ordinal,
      offset: seg.offset,
      length: seg.length,
      matches: hit.length,
      terms: [...new Set(hit)],
    });
  }
  return out;
}

/** {@link widenAgainstVocabulary} over a `.txt` file's own paragraph vocabulary. */
function txtFuzzyGroups(id: Id, terms: QueryTerm[]): TermGroup[] | null {
  return widenAgainstVocabulary(new Set(txtSegTerms(id).flatMap((s) => s.terms)), terms);
}

/**
 * The `.txt`-scoped search: EVERY matching paragraph of one file, in ordinal
 * order, with a per-paragraph count, the terms that count counted, and whether
 * it had to guess. Exact first; the vocabulary is consulted ONLY when that found
 * nothing, exactly as the note-scoped and library-wide fixtures do.
 */
function txtSearchFixture(id: Id, query: string): { segments: TxtMatch[]; usedFuzzy: boolean } {
  const terms = queryTerms(query);
  if (terms.length === 0) return { segments: [], usedFuzzy: false };

  const exact = txtSearchPass(id, terms.map((q) => [q]));
  if (exact.length > 0) return { segments: exact, usedFuzzy: false };

  const widened = txtFuzzyGroups(id, terms);
  if (widened === null) return { segments: [], usedFuzzy: false };
  return { segments: txtSearchPass(id, widened), usedFuzzy: true };
}

/**
 * A fixture note. `fileType` and `hasRecognizedText` are explicit per note so the
 * fixture carries a REALISTIC spread rather than a uniform "everything is a
 * recognized .note" — the tree genuinely holds PDFs and screenshots, and most
 * notes were never run through on-device recognition.
 */
interface NoteOpts {
  /** Default "note". Non-"note" fixtures exercise the badge's other values. */
  fileType?: string;
  /** Default false — recognition is opt-in ON the device, so it is the minority. */
  hasRecognizedText?: boolean;
  /**
   * First page index carrying recognition, when it does NOT start at page 1.
   *
   * The default pattern always gives page 0 a transcript, which made a whole
   * class of bug unrepresentable: the reader derives "can this note be searched"
   * from the page list, and while it is showing the SKELETON only page 0 is real.
   * A note recognised from page 2 onward is exactly the case that used to leave
   * Find disabled forever, so the fixture has to be able to express it.
   */
  recognizedFrom?: number;
  /** Default 1 MB-ish, derived from the id. Only the "no preview" state shows it. */
  size?: number;
  /** Effective page dims. Default portrait 1404×1872; a landscape fixture passes
   *  1872×1404 so both its page refs AND its derived `thumbAspect` read wide. */
  pageDims?: { w: number; h: number };
  /**
   * Explicit preview dims, overriding the derivation below — the COVER case for
   * a `.note` (cover dims win over page 1's) and the only source for a `.spd`
   * (its embedded thumbnail's dims, which the listing cannot derive from pages).
   */
  thumbAspect?: { w: number; h: number };
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
    // A LISTING ENTRY'S FIRST PAGE CARRIES ITS LAYERS, exactly as the meta's
    // page 0 does — the server builds both from the same index, and the reader
    // opens from this summary. Without it the layered fixture painted the
    // composite, disabled Layers, then re-fetched the same page bytes and swapped
    // the stack in when the meta landed; with it the stack is the FIRST paint and
    // the toggle is right immediately. Omitted (not null) where there are none.
    firstPage: id === LAYERED_NOTE_ID ? withLayeredPageLayers(first!) : first!,
    updatedAt,
    fileType,
    // Seeded independently of the page hashes, exactly like the real thing: this
    // is the WHOLE-FILE md5, not a per-page content hash.
    fileHash: fakeHash(`${id}:file`),
    hasRecognizedText,
    // The serving rule the real listing applies:
    //  - `.note` → cover dims when a cover exists (`opts.thumbAspect`), else
    //    page 1's EFFECTIVE dims — so a landscape note serves an honest 1872×1404;
    //  - `.spd` → its thumb dims, which only `opts.thumbAspect` can supply;
    //  - images/`.txt`/everything else → ABSENT, exactly like the server.
    thumbAspect:
      opts.thumbAspect ?? (fileType === "note" && first ? { w: first.width, h: first.height } : undefined),
  };
}

/**
 * A note whose recognition is real but whose hardware the scale table has never
 * measured — `getNoteMeta` returns `pxPerMm: null` for it. It exists so the
 * raster-only export path is a fixture the UI is built against, not a branch
 * that is only ever reached by a device nobody in the household owns.
 */
const UNSCALED_NOTE_ID = "n-doc-unscaled";

/**
 * Word boxes for a fake transcript, in MILLIMETRES on the 118.64 x 158.19 mm
 * canvas. Laid out as real lines of writing: they stay inside the page, so the
 * exporter's bounds guard passes, and they are spread over it rather than piled
 * at the origin — which is what a millimetre-as-pixel misread would look like.
 */
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

/** Deterministic stand-in for the stored file size, in bytes. */
function fakeSize(id: Id, pageCount: number): number {
  return 40_000 + pageCount * 90_000 + (id.length % 7) * 1_337;
}

// --- the upload fixture ------------------------------

/**
 * How much room the fixture account has left. A file bigger than this is refused
 * with the real 413 (`UploadRefusedError("quota")`).
 *
 * EXPORTED, because it is a test input rather than a decoration: the over-quota
 * path is one the interface has to phrase, and a test that wants it should not
 * have to guess a magic size. 8 MB is comfortably above every plausible fixture
 * upload and comfortably below a "large PDF", so both sides of the line are easy
 * to land on deliberately.
 *
 * The CLIENT-side pre-flight normally refuses an over-quota file before any of
 * this runs (it reads the account's real usage); this is the server's own
 * backstop, which exists because the browser's copy of "space left" is always a
 * little stale.
 */
export const FAKE_UPLOAD_HEADROOM = 8 * 1024 * 1024;

/**
 * How many progress steps a file of `size` bytes is sent in — 4 for anything
 * small, up to 24 for a few megabytes.
 *
 * SCALED BY SIZE ON PURPOSE. A fake that reported one instant 100% would make the
 * progress bar and Cancel unobservable in dev and untestable in e2e, which are
 * exactly the two things this feature's UI is made of. Each step costs one
 * `latency` tick, so a big file takes proportionally longer to send — the same
 * relationship the real transfer has.
 */
function uploadSteps(size: number): number {
  return Math.max(4, Math.min(24, Math.ceil(size / 65_536)));
}

/** Ids for uploaded files: `up-1`, `up-2`, … — never a fixture id. */
let uploadSeq = 0;

const DAY = 86_400_000;
const NOW = 1_752_800_000_000; // fixed epoch ms — no Date.now(), keeps fixtures deterministic

// --- the version-history fixture (hot-cache versioning, phases 3-6) ----------
//
// Stands in for `ControlPlaneService.history`. A `.note` accrues versions when
// it is re-synced; the fixture gives every `.note` its current blob plus two
// retained versions (a small K, as the real hot cache keeps), newest-first, so
// the list/preview/restore UI has real history to render in dev and e2e. A
// non-note kind (a one-shot PDF/image) carries only its current version — the
// self-limiting property H6 names.

/** The retained versions a `.note` accrues, by seed suffix — see `baseVersions`. */
const RETAINED_VERSION_KS = [1, 2] as const;

/**
 * A version's OWN page count in the fake. Older retained versions have FEWER pages
 * than the current note (`current - k`), so previewing one exercises the
 * differing-page-count path H7 is about — the reader must render the version's
 * geometry, not the live note's slot count. The current blob (and a displaced-
 * current row after a restore) falls through to the live count.
 */
function versionPageCount(summary: NoteSummary, md5: string): number {
  for (const k of RETAINED_VERSION_KS) {
    if (fakeHash(`${summary.id}:v${k}`) === md5) return Math.max(1, summary.pageCount - k);
  }
  return summary.pageCount;
}

/**
 * A file's versions, newest-first: the current blob (flagged) + retained. Every
 * previewable kind ({@link canPreviewHistory}) gets the retained pair, so the list
 * has a past version to open for each; a non-previewable one-shot (a `.pdf`)
 * carries only its current version — the self-limiting property H6 names, and it
 * keeps the fake in step with what the UI can actually preview. (The real retain
 * path has no extension filter; the fixture just does not bother where no viewer
 * would ever open the result.)
 */
function baseVersions(id: Id): FileVersion[] {
  // `noteSummary`, not `ALL_NOTES`: a TRASHED file's `file_history` follows it into
  // the bin (H10), so the bin's `noteHistory` reroute resolves its versions here.
  const summary = noteSummary(id);
  if (!summary) return [];
  const size = fakeSize(id, summary.pageCount);
  // Only a `.note` is paginated: its versions carry a real, DIFFERING page count
  // (older versions have fewer pages — see `versionPageCount`), so the menu's
  // content signal reads "17 pages +2". Every other kind carries 0 → the signal
  // falls back to the byte size, no delta.
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
    // A retained version's md5 is its own content address — distinct from the
    // current blob's, which is what the preview reroutes page bytes by.
    md5: fakeHash(`${id}:v${k}`),
    size: Math.max(1, size - k * 6_000),
    createdAt: summary.updatedAt - k * 2 * DAY,
    current: false,
    pageCount: isNote ? Math.max(1, summary.pageCount - k) : 0,
  }));
  return [current, ...retained];
}

// The Supernote's real default tree. The device ships fixed *container* folders
// (NOTE, DOCUMENT) plus flat category folders (EXPORT, SCREENSHOT, INBOX); the
// meaningful categories live one level down (Note, MyStyle, Document). The web
// rail is anchored in those categories, so the fixture mirrors the device layout
// exactly — plus a user-created subfolder under Note (Projects) and a custom
// top-level folder (Archive) so the rail's nesting and its "Other" group both
// have something real to render.
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
  // A custom top-level folder holding one of EVERY previewable kind, so the
  // thumbnail facade's four strategies (note render, image, `.spd` embedded
  // extract, `.txt` snippet) all have a fixture to paint in dev and e2e — plus a
  // `.pdf`, which keeps the honest no-preview glyph.
  files: { kind: "folder", id: "files", name: "Files" },
};

// A deep folder of many notes, so the gallery actually scrolls — this is what
// makes the lazy behaviour (off-screen thumbnails staying blank until scrolled
// in) observable in dev and pixel-probeable in e2e. It lives in the custom
// top-level "Archive" folder (the rail's "Other" group).
const ARCHIVE_NOTES: NoteSummary[] = Array.from({ length: 30 }, (_, i) =>
  note(`n-arc-${i}`, `Archive note ${String(i + 1).padStart(2, "0")}`, 1 + (i % 6), NOW - (i + 4) * DAY, {
    // Alternating, so a single scrolled gallery shows both marker states side by side.
    hasRecognizedText: i % 2 === 0,
  }),
);

const CHILDREN: Record<string, Entry[]> = {
  // Root mirrors the device: the two containers, the three flat categories, and
  // one custom user folder. No loose notes at root (the device never puts any).
  root: [
    FOLDERS["dir-note"]!,
    FOLDERS["dir-document"]!,
    FOLDERS.export!,
    FOLDERS.screenshot!,
    FOLDERS.inbox!,
    FOLDERS.archive!,
    FOLDERS.files!,
  ],
  // Containers hold their category subfolders (flattened away by the rail and
  // the root gallery) — PLUS, here, a folder the user made on the device inside
  // one. `Scratch` is not a category, so flattening `NOTE` has to PROMOTE it to
  // the root rather than drop it; without a fixture case, the code path that
  // loses a user's folder is one nobody ever exercises.
  "dir-note": [FOLDERS.note!, FOLDERS.mystyle!, FOLDERS.scratch!],
  "dir-document": [FOLDERS.document!],
  // Note: a user subfolder + a few notes (recursive count = 5).
  note: [
    FOLDERS.projects!,
    note("n-weekly", "Weekly review", 3, NOW - DAY, { hasRecognizedText: true }),
    note("n-ideas", "Ideas & scratch", 1, NOW),
    note("n-sketch", "Sketch — kitchen layout", 1, NOW - 3 * DAY),
    // The layered fixture (see layeredFixture.ts): page 1 carries `layers` in
    // its meta ref and a real SNPG v2 payload — a device-hidden Layer 2, a
    // renamed current layer — page 2 carries none, so the reader's panel both
    // appears and disappears within one note.
    note(LAYERED_NOTE_ID, "Layered field sketch", 2, NOW - 2 * DAY),
  ],
  // A user folder living INSIDE the NOTE container — see "dir-note" above.
  scratch: [note("n-scratch-todo", "Scratch — todo", 1, NOW - 2 * DAY)],
  projects: [
    note("n-proj-alpha", "Project Aurora — kickoff", 6, NOW - 6 * DAY, { hasRecognizedText: true }),
    note("n-proj-beta", "Project Beta", 7, NOW - 8 * DAY),
  ],
  // MyStyle: templates (count = 3). Blank templates: nothing to recognize.
  mystyle: [
    note("n-tmpl-cornell", "Cornell notes", 1, NOW - 60 * DAY),
    note("n-tmpl-planner", "Weekly planner", 1, NOW - 60 * DAY),
    note("n-tmpl-dots", "Dot grid", 1, NOW - 60 * DAY),
  ],
  // Document: an annotated paper (a real .note) next to a plain PDF that was
  // never a note at all — the "another file type living in the tree" case the
  // hardcoded "note" badge used to misreport.
  document: [
    note("n-doc-attn", "Attention Is All You Need", 20, NOW - 9 * DAY, { hasRecognizedText: true }),
    note("n-doc-lease", "Apartment lease — signed", 6, NOW - 26 * DAY, { fileType: "pdf" }),
    // An `.epub`: uploadable (`UPLOAD_ACCEPT`) and readable ON THE DEVICE, but
    // with no viewer here — so it is the reader's "no preview, here is a
    // download" state. That state used to be exercised by the PDF above; PDFs
    // now open in their own viewer, and this keeps the reader's own fallback
    // under test rather than letting it go dark.
    note("n-doc-epub", "Sourdough — a field guide", 1, NOW - 27 * DAY, { fileType: "epub" }),
    // Recognized, but written on hardware whose millimetre scale has never been
    // measured — `getNoteMeta` answers `pxPerMm: null` for it. This is the
    // raster-only export case, kept in the fixture so it is a state the UI is
    // built and tested against rather than a branch nobody ever sees.
    note(UNSCALED_NOTE_ID, "Field notes — unknown device", 3, NOW - 4 * DAY, {
      hasRecognizedText: true,
    }),
  ],
  // Export: empty (nothing exported yet — count 0, exercises the empty state).
  export: [],
  // SCREENSHOT holds PNGs, not notes — and a screenshot is never recognized.
  screenshot: [
    note("n-shot-pricing", "Screenshot — pricing page", 1, NOW - 2 * DAY, { fileType: "png" }),
    note("n-shot-map", "Screenshot — trailhead map", 1, NOW - 5 * DAY, { fileType: "png" }),
  ],
  inbox: [note("n-inbox-doodles", "Unsorted — meeting doodles", 2, NOW - DAY, { hasRecognizedText: true })],
  archive: ARCHIVE_NOTES,
  // One of every previewable kind, for the thumbnail facade. The `.note` renders
  // its page, the png is a native <img>, the `.spd` shows its extracted embedded
  // thumbnail, the `.txt` a rasterised snippet; the `.pdf` keeps the glyph.
  //
  // The folder is ALSO the masonry fixture: every `thumbAspect`
  // source and both clamp extremes are on one screen, so the aspect-truth,
  // order-pin, reflow and clamp e2e all read from here.
  files: [
    // The COVER note: its aspect is the cover's dims (the e2e cover mock serves
    // a 120×160 PNG), which win over page 1's — same 3:4 here, deliberately, so
    // the cover-vs-coverless e2e stay shape-agnostic.
    note("n-files-note", "Meeting notes — Q3", 2, NOW - DAY, { hasRecognizedText: true, thumbAspect: { w: 120, h: 160 } }),
    // A LANDSCAPE note: page 1's effective dims are wide, so its derived aspect
    // is the honest 1872×1404 — the §D case the masonry layout exists for.
    note("n-files-board", "Whiteboard — sprint plan", 1, NOW - 2 * DAY, { pageDims: { w: 1872, h: 1404 } }),
    // An image carries NO thumbAspect (decision 5: local dims memo only).
    note("n-files-shot", "Screenshot — dashboard", 1, NOW - 3 * DAY, { fileType: "png" }),
    // A `.spd` serves its embedded thumbnail's dims.
    note("n-files-sketch", "Kitchen sketch", 1, NOW - 4 * DAY, { fileType: "spd", thumbAspect: { w: 600, h: 800 } }),
    // The two clamp extremes, both `.spd` (the one type whose thumb can be any
    // shape): a panorama that must reserve its LETTERBOXED width in rows and hit
    // the wide floor in the grid, and a scroll that must hit the 2.5× tall cap.
    note("n-files-pano", "Panorama — coastline", 1, NOW - 5 * DAY, { fileType: "spd", thumbAspect: { w: 3000, h: 400 } }),
    note("n-files-scroll", "Receipt — long scroll", 1, NOW - 6 * DAY, { fileType: "spd", thumbAspect: { w: 240, h: 1800 } }),
    // A `.txt` carries NO thumbAspect either — its snippet's shape is the
    // client-side constant (we rasterise it, we fix it).
    note("n-files-readme", "readme", 1, NOW - 7 * DAY, { fileType: "txt" }),
    note("n-files-manual", "Appliance manual", 4, NOW - 8 * DAY, { fileType: "pdf" }),
  ],
};

const ALL_NOTES: Record<string, NoteSummary> = {};
for (const entries of Object.values(CHILDREN)) {
  for (const e of entries) if (e.kind === "note") ALL_NOTES[e.id] = e;
}

/**
 * RECOGNISED LATE: nothing on page 1, a transcript from page 2 on — the shape
 * that used to leave Find disabled for a whole session, because the reader
 * derives "can this be searched" from a SKELETON page list whose pages all read
 * `textHash: null`. The default fixture pattern always recognises page 1, which
 * is exactly why the bug was unrepresentable and shipped.
 *
 * Registered BY ID ONLY, deliberately outside `CHILDREN`: every listing count
 * and section head in the e2e suite is asserted literally, so a note added to a
 * real folder would rewrite half a dozen unrelated expectations for a fixture
 * that exists to be opened by route.
 */
ALL_NOTES["n-late-ocr"] = note("n-late-ocr", "Recognised from page two", 4, NOW - 2 * DAY, {
  hasRecognizedText: true,
  recognizedFrom: 1,
});

// The recycle-bin fixture's own notes, kept in a SEPARATE map from the live
// library. Keyed the same way, so every PER-ID transcript / search / version-
// history generator answers for a TRASHED id exactly as for a live one — the fake
// mirror of "a trashed file's md5-keyed data is fully retained".
// Deliberately NOT in `ALL_NOTES`: the library-wide enumerations walk
// `ALL_NOTES`, and a trashed note must not surface in a live-wide listing (the
// real server excludes `deleted = 1`). `noteSummary(id)` unions the two for the
// per-id lookups that DO need the trashed rows.
const BIN_NOTES: Record<string, NoteSummary> = {};
for (const s of BIN_SEED_NOTES) {
  BIN_NOTES[s.id] = note(s.id, s.name, s.pageCount, NOW, {
    fileType: s.fileType,
    hasRecognizedText: s.recognized,
  });
}

/**
 * A note summary by id — the live library first, then the recycle-bin fixture.
 * The per-id generators (transcript, in-note search, version history) resolve
 * through this so they answer for a TRASHED id, while the library-wide walks stay
 * on `ALL_NOTES` alone (a trashed note is unfindable in a live-wide search).
 */
function noteSummary(id: Id): NoteSummary | undefined {
  return ALL_NOTES[id] ?? BIN_NOTES[id];
}

// Parent of each folder (null = root), derived from CHILDREN. Lets listFolder
// return the full ancestor path (root → here) the way the real control-plane
// does — the breadcrumbs and the rail's folder tree both rely on it.
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

/**
 * Attach a folder's direct-child count, the way `ControlPlaneService.listing`
 * does: DIRECT children only, of every kind (subfolders included), and only on
 * LISTING rows — never on a breadcrumb.
 *
 * Derived from `CHILDREN` rather than written down per folder, so the fixture
 * cannot drift into claiming a count its own tree contradicts. The fake has no
 * bin, so there is nothing trashed to exclude here; the exclusion rule is proved
 * against the real query in `files.zig`.
 */
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

/** Construct a fresh fixture-backed Api. State is per-instance (test isolation). */
/**
 * The paired `.mark`'s metadata: ONE page, and it is the PDF's page 2.
 *
 * `width`/`height` are the device panel, not the PDF page — that mismatch is the
 * whole reason `markGeometry` exists, and a fixture that quietly matched the
 * page would test nothing.
 */
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
        // A `.mark` annotates a PDF and imports no template of its own, so it
        // carries no `EXTERNALLINKINFO` — the PDF's links come from the PDF.
        linksHash: null,
        sourcePage: PDF_MARK_SOURCE_PAGE,
        layers,
      },
    ],
  };
}

export function createFakeApi(opts: FakeApiOptions = {}): Api {
  const latency = opts.latencyMs ?? 120;
  const syncVersion = opts.syncVersion ?? 1;

  // Per-instance version history, so a restore in one test cannot leak into the
  // next (test isolation, like the admin/bin state). Seeded lazily from the
  // fixture; a restore rewrites the entry the way the real supersede path does.
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
        // NO counts on the breadcrumb — `pathTo` hands back the bare fixture
        // folders, exactly as the real control plane omits `itemCount` there.
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
        // The one paired fixture: this PDF has a `.mark` beside it. The real
        // server resolves the pairing by name (`NoteMetaVO.annotationsId`).
        annotationsId: id === MARKED_PDF_ID ? PDF_MARK_ID : null,
        id,
        name: summary.name,
        // Layers are attached here rather than inside `pages()` because they are
        // a per-note fixture fact, not a page-shape one — and the listing's
        // `firstPage` gets the SAME treatment through the same helper (see
        // `note()`), which is what the reader's instant layered first paint
        // depends on. Dims come off the summary's own first page, so a landscape
        // fixture's meta agrees with its listing instead of quietly reverting to
        // portrait.
        pages: pages(
          id,
          summary.pageCount,
          summary.hasRecognizedText,
          { w: summary.firstPage.width, h: summary.firstPage.height },
          RECOGNIZED_FROM[String(id)],
        ).map((p) => (id === LAYERED_NOTE_ID ? withLayeredPageLayers(p) : p)),
        // The reader branches on these, so the fake has to carry them: a route
        // reload lands here with nothing but the id.
        fileType: summary.fileType,
        fileHash: summary.fileHash,
        size: fakeSize(id, summary.pageCount),
        // The fixture is an N6-class device (1404 px over a 118.64 mm canvas),
        // which is exactly the hardware the real scale table has verified. The
        // "unknown hardware" case is exercised by `n-doc-unscaled` below, which
        // has recognition but NO scale — the raster-only PDF path.
        pxPerMm: summary.id === UNSCALED_NOTE_ID ? null : 1404 / 118.64,
      };
    },

    async getPageBytes(_id: Id, page: PageRef): Promise<ArrayBuffer> {
      await delay(latency);
      // The mark's ink: a real SNPG v2 payload, so the overlay decodes for real.
      if (_id === PDF_MARK_ID) {
        const payload = layeredPagePayload(0);
        if (payload) return payload.slice().buffer as ArrayBuffer;
      }
      // The layered fixture answers with a REAL SNPG v2 payload — the reader's
      // per-layer path drives the actual wasm decoder over it, fake data plane
      // or not. Every other page keeps the junk bytes below.
      if (_id === LAYERED_NOTE_ID) {
        const payload = layeredPagePayload(page.index);
        if (payload) return payload.slice().buffer as ArrayBuffer;
      }
      // The fake renderer ignores these bytes (it paints from page.hash), but we
      // return a stable, page-shaped buffer so callers can treat the contract as
      // real — a few bytes seeded by the page hash.
      const seed = page.hash;
      const buf = new Uint8Array(16);
      for (let i = 0; i < buf.length; i++) buf[i] = seed.charCodeAt(i) & 0xff;
      return buf.buffer;
    },

    async getTemplate(_id: Id, _hash: string): Promise<Blob> {
      // The fake data plane has no custom image templates: the fake renderer
      // paints from `page.hash` and never reads a raster-image background. This
      // exists only to satisfy the Api shape; a call would be a fixture bug.
      await delay(latency);
      throw new Error("fake api has no custom image templates");
    },

    async getPageText(id: Id, page: PageRef): Promise<PageText> {
      await delay(latency);
      const summary = ALL_NOTES[id];
      if (!summary) throw new Error(`no such note: ${id}`);
      // Mirrors the real endpoint: a page the device never recognized has no
      // transcript, and says so with an empty result rather than an error.
      if (page.textHash === null) return { text: "", words: [] };
      const text = fakeText(summary.name, page.index);
      return { text, words: fakeWords(text) };
    },

    async getPageLinks(id: Id, page: PageRef): Promise<PageLinks> {
      await delay(latency);
      const summary = noteSummary(id);
      if (!summary) throw new Error(`no such note: ${id}`);
      // Mirrors the real endpoint's short-circuit: a page with no link block has
      // no version to ask for, and the answer is empty rather than an error.
      if (page.linksHash === null) return { links: [] };
      return { links: fakePageLinks(page, summary.pageCount) };
    },

    async searchInNote(noteId: Id, query: string): Promise<NoteSearchResults> {
      const q = query.trim();
      if (q === "") return { query: "", pages: [], usedFuzzy: false };
      await delay(latency);
      return { query: q, ...noteSearchFixture(noteId, q) };
    },

    async searchInTxt(noteId: Id, query: string): Promise<TxtSearchResults> {
      const q = query.trim();
      if (q === "") return { query: "", segments: [], usedFuzzy: false };
      await delay(latency);
      return { query: q, ...txtSearchFixture(noteId, q) };
    },

    // The STREAMING twins — the fake actually BATCHES the in-doc keyset (a small
    // page/paragraph stride), so a viewer sees first matches + a "N+" floor and
    // then the exact count, exactly as it would against the real server. The
    // EXACT path streams in `FIND_STREAM_BATCH`-sized chunks with a yield between;
    // the FUZZY fallback mirrors the server's one-shot, no-cursor result — a
    // single `done` batch. `signal` stops the walk between chunks.
    async searchInNoteStream(
      noteId: Id,
      query: string,
      onBatch: (batch: NoteSearchBatch) => void,
      signal?: AbortSignal,
    ): Promise<void> {
      const q = query.trim();
      if (q === "") {
        onBatch({ query: "", pages: [], usedFuzzy: false, done: true });
        return;
      }
      const { pages, usedFuzzy } = noteSearchFixture(noteId, q);
      if (usedFuzzy) {
        await delay(latency);
        if (signal?.aborted) return;
        onBatch({ query: q, pages, usedFuzzy: true, done: true });
        return;
      }
      const acc: PageMatch[] = [];
      for (let i = 0; i < pages.length || i === 0; i += FIND_STREAM_BATCH) {
        await delay(latency);
        if (signal?.aborted) return;
        acc.push(...pages.slice(i, i + FIND_STREAM_BATCH));
        const done = i + FIND_STREAM_BATCH >= pages.length;
        onBatch({ query: q, pages: [...acc], usedFuzzy: false, done });
        if (done) return;
      }
    },

    async searchInTxtStream(
      noteId: Id,
      query: string,
      onBatch: (batch: TxtSearchBatch) => void,
      signal?: AbortSignal,
    ): Promise<void> {
      const q = query.trim();
      if (q === "") {
        onBatch({ query: "", segments: [], usedFuzzy: false, done: true });
        return;
      }
      const { segments, usedFuzzy } = txtSearchFixture(noteId, q);
      if (usedFuzzy) {
        await delay(latency);
        if (signal?.aborted) return;
        onBatch({ query: q, segments, usedFuzzy: true, done: true });
        return;
      }
      const acc: TxtMatch[] = [];
      for (let i = 0; i < segments.length || i === 0; i += FIND_STREAM_BATCH) {
        await delay(latency);
        if (signal?.aborted) return;
        acc.push(...segments.slice(i, i + FIND_STREAM_BATCH));
        const done = i + FIND_STREAM_BATCH >= segments.length;
        onBatch({ query: q, segments: [...acc], usedFuzzy: false, done });
        if (done) return;
      }
    },

    // --- HISTORY (hot-cache versioning) ---
    //
    // The read + restore face over the per-instance `historyState`. Mirrors the
    // real client at the seam: `noteHistory` newest-first, `searchHistory` EXACT
    // ONLY (usedFuzzy pinned false — a one-document scan never widens), and
    // `restoreVersion` re-points AND retains the displaced current, so the result
    // is undoable by construction.

    async noteHistory(id: Id): Promise<FileHistory> {
      await delay(latency);
      return { id, versions: historyFor(id).map((v) => ({ ...v })) };
    },

    async historyMeta(id: Id, md5: string): Promise<NoteMeta> {
      await delay(latency);
      const summary = ALL_NOTES[id];
      if (!summary) throw new Error(`no such note: ${id}`);
      // The version's OWN geometry: a retained version has FEWER pages than the
      // current note (see `versionPageCount`), so the preview renders a DIFFERENT
      // count than the live meta — the whole point of H7. `fileHash` is the version
      // md5; everything else mirrors `getNoteMeta`. Layers are omitted (a preview
      // nulls them anyway), so this never needs the layered fixture.
      const count = versionPageCount(summary, md5);
      return {
        // A version PREVIEW shows the bytes of a past blob; the mark beside
        // the file today annotates the CURRENT one, so it is not this one's.
        annotationsId: null,
        id,
        name: summary.name,
        // A version preview carries NO links: there is no per-version links
        // route (unlike the transcript, which has one), so claiming a hash here
        // would send the reader to an address that cannot answer. The real
        // client's `historyScope` nulls it for the same reason.
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
      // The fake renderer paints from the preview meta's page.hash (which the
      // reader keys per-version), so these bytes are shape-only — a stable buffer
      // seeded by the version + page, mirroring `getPageBytes`.
      const seed = `${md5}:${index}`;
      const buf = new Uint8Array(16);
      for (let i = 0; i < buf.length; i++) buf[i] = seed.charCodeAt(i % seed.length) & 0xff;
      return buf.buffer;
    },

    async historyPageText(id: Id, md5: string, index: number): Promise<PageText> {
      await delay(latency);
      const summary = ALL_NOTES[id];
      if (!summary) throw new Error(`no such note: ${id}`);
      // A retained version carries its OWN transcript, with the SAME recognition
      // spread as the live note (an un-recognized note — and every third page of
      // a recognized one — has none, exactly as `getPageText` reads it). The
      // recognized pages get a version-FLAVOURED transcript so a preview's ovals,
      // find-in-preview boxes and PDF text layer are visibly the version's, not the
      // current blob's — which is what lets a test tell the two apart.
      if (!summary.hasRecognizedText || fakeTextHash(id, index, true) === null) {
        return { text: "", words: [] };
      }
      const text = `Version ${md5.slice(0, 6)} — ${fakeText(summary.name, index)}`;
      return { text, words: fakeWords(text) };
    },

    async searchHistory(id: Id, _md5: string, query: string): Promise<NoteSearchResults> {
      const q = query.trim();
      if (q === "") return { query: "", pages: [], usedFuzzy: false };
      await delay(latency);
      // The retained version's own recognized text. In the fake a version shares
      // the live note's transcript — enough to exercise counts + navigation — and
      // history search is exact-only, so `usedFuzzy` is pinned false (H8).
      return { query: q, pages: noteSearchFixture(id, q).pages, usedFuzzy: false };
    },

    async restoreVersion(id: Id, md5: string): Promise<RestoredVersion> {
      await delay(latency);
      const versions = historyFor(id);
      const target = versions.find((v) => v.md5 === md5);
      // The real route 404s an md5 not in this file's history; the fake throws so
      // the same "no such version" path is reachable.
      if (!target) throw new Error(`no such version: ${md5}`);
      // Re-point: the target becomes current at `now`; the displaced current is
      // retained as a new history row (undoable — H9). Newest-first: restored,
      // then the just-displaced current, then the remaining retained rows.
      const now = NOW;
      const restored: FileVersion = { md5, size: target.size, createdAt: now, current: true, pageCount: target.pageCount };
      const displaced = versions.filter((v) => v.current).map((v) => ({ ...v, current: false }));
      const rest = versions.filter((v) => !v.current && v.md5 !== md5).map((v) => ({ ...v, current: false }));
      historyState.set(id, [restored, ...displaced, ...rest]);
      return { md5, size: target.size, createdAt: now, current: true };
    },

    async historyRaw(id: Id, md5: string): Promise<ArrayBuffer> {
      await delay(latency);
      // The version's whole raw blob. Shape-only in the fake — the client-side
      // viewers (`.spd`/`.txt`/image) decode their own dims from these bytes, and
      // e2e serves REAL image/text bytes off the mocked route — so this is a
      // stable buffer seeded by the version md5, distinct per version, mirroring
      // `historyPageBytes`.
      const seed = `${id}:${md5}:raw`;
      const buf = new Uint8Array(16);
      for (let i = 0; i < buf.length; i++) buf[i] = seed.charCodeAt(i % seed.length) & 0xff;
      return buf.buffer;
    },

    // --- BIN-SCOPED READS (recycle-bin viewer parity) ---
    //
    // The `/bin/…` twins delegate to the SAME generators as their live cousins,
    // keyed on the trashed id (which is registered in `ALL_NOTES` above) — the
    // fake's expression of "a trashed file's transcript, matches and history are
    // fully retained, md5-keyed". So a trashed note's bin preview draws the same
    // ovals, finds the same matches and browses the same version list a live one
    // does; only the ROUTE differs, which is the real client's concern, not the
    // fixture's.

    async binPageText(id: Id, page: PageRef): Promise<PageText> {
      await delay(latency);
      const summary = noteSummary(id);
      if (!summary) throw new Error(`no such trashed note: ${id}`);
      // The trashed file's retained transcript — same shape/content as the live
      // route, so a page the device never recognized (a null `textHash` on the
      // bin meta) reads empty, exactly as `getPageText` does.
      if (page.textHash === null) return { text: "", words: [] };
      const text = fakeText(summary.name, page.index);
      return { text, words: fakeWords(text) };
    },

    async binSearchInNote(noteId: Id, query: string): Promise<NoteSearchResults> {
      const q = query.trim();
      if (q === "") return { query: "", pages: [], usedFuzzy: false };
      await delay(latency);
      // A one-document scan over the trashed file's retained transcript, exact-
      // only (no corpus to widen against), so `usedFuzzy` is pinned false — the
      // `searchHistory` shape, on the current version.
      return { query: q, pages: noteSearchFixture(noteId, q).pages, usedFuzzy: false };
    },

    async binNoteHistory(id: Id): Promise<FileHistory> {
      await delay(latency);
      // The trashed file's retained `file_history` — the same list a live note
      // has, since history follows the file into the bin (H10).
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
      // The retained version's own transcript, version-flavoured exactly as the
      // live `historyPageText` is — so a trashed note's version preview draws the
      // version's ovals, not the current blob's.
      if (!summary.hasRecognizedText || fakeTextHash(id, index, true) === null) {
        return { text: "", words: [] };
      }
      const text = `Version ${md5.slice(0, 6)} — ${fakeText(summary.name, index)}`;
      return { text, words: fakeWords(text) };
    },

    async binSearchHistory(id: Id, _md5: string, query: string): Promise<NoteSearchResults> {
      const q = query.trim();
      if (q === "") return { query: "", pages: [], usedFuzzy: false };
      await delay(latency);
      return { query: q, pages: noteSearchFixture(id, q).pages, usedFuzzy: false };
    },

    async binHistoryRaw(id: Id, md5: string): Promise<ArrayBuffer> {
      await delay(latency);
      const seed = `${id}:${md5}:raw`;
      const buf = new Uint8Array(16);
      for (let i = 0; i < buf.length; i++) buf[i] = seed.charCodeAt(i % seed.length) & 0xff;
      return buf.buffer;
    },

    // --- RENAME (control-plane) ---
    //
    // Mutates the fixture entry IN PLACE — a rename is a metadata change, and the
    // fixture's entries are the same objects `listFolder` hands out and (for a
    // note) the same object `ALL_NOTES` holds, so one field write is seen
    // everywhere the entry appears. The collision rule is the real server's, on
    // the data the client cannot re-derive: a sibling in the SAME parent already
    // carrying that exact name is a `NameTaken` (the real 409), which the dialog
    // catches and stays open on. `NameTakenError` is imported dynamically for the
    // same reason the admin fake imports `ApiError` that way — this file has no
    // top-level import of `client.ts` and cannot grow one at a marker.
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

    // --- UPLOAD (control-plane) ---
    //
    // The web → cloud half of, fixture-side. It MUTATES
    // the fixture tree — the uploaded file appears in `CHILDREN[dest]` and in
    // `ALL_NOTES` — so the row the gallery reconciles is the row a later
    // `listFolder` returns, exactly as the real endpoint behaves.
    //
    // IT ENFORCES THE REFUSALS, and that is the point of it rather than an
    // afterthought: the accept list (415) and a quota ceiling (413) are the two
    // paths the UI has to phrase, and without them here they would be unreachable
    // until the server existed. `UploadRefusedError` is imported dynamically for
    // the same reason the admin fake imports `ApiError` that way.
    //
    // PROGRESS IS REPORTED IN STEPS, scaled by size (see `uploadSteps`), so a
    // big file genuinely takes longer than a small one — which is what makes the
    // progress bar, and Cancel, observable in dev and deterministic in e2e.
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
      // Missing, foreign and trashed are one indistinguishable answer, here as
      // on the real route.
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
        // Checked BETWEEN steps, so a cancel lands mid-transfer the way an
        // `xhr.abort()` does rather than after the whole thing completed.
        if (signal?.aborted) throw new ApiError("CANCELLED", "Upload cancelled.", 0);
        onProgress?.(i / steps);
      }

      // REPLACE SUPERSEDES IN PLACE, and the id is the whole point: the file
      // keeps its identity, so every link to it still resolves and the displaced
      // blob becomes a retained VERSION of it — the same path the device takes
      // when it re-uploads a note it has edited. The fixture cannot really keep
      // a blob, so it models the part the UI can see: one row, same id, new
      // timestamp. Nothing is added, and nothing is lost.
      const occupant =
        onConflict === "replace"
          ? siblings.find((e): e is NoteSummary => e.kind === "note" && e.name === name)
          : undefined;
      if (occupant) {
        occupant.updatedAt = Date.now();
        return { ...occupant };
      }
      // Otherwise the default: invent a free name and leave the occupant alone.
      // Through the SAME helper the conflict prompt previews the name with, so
      // what the dialog promised is what the tree gets.
      const final = nextAvailableName(
        name,
        siblings.map((e) => e.name),
      );
      const id = `up-${String(++uploadSeq)}` as Id;
      const entry = note(id, final, 1, Date.now(), { fileType: uploadExtension(final) || "note" });
      siblings.push(entry);
      ALL_NOTES[String(id)] = entry;
      return { ...entry };
    },

    // --- WRITES (append-only, at your own marker — see `types.ts`) ---
    // --- BIN WRITES ---
    // The whole bin, from `./binFake`. It is a separate module because a fixture
    // cannot be declared inside this object literal, and one spread is the
    // smallest edit this marker can carry — see that file's header, including
    // the one behaviour it deliberately cannot fake. The lookup is how a trashed
    // fixture entry keeps its real name/type/size — a `.spd` trashed from the
    // library must still be a `.spd` when the bin opens it into its viewer.
    ...createBinFake(delay, latency, (id) => {
      const n = ALL_NOTES[id];
      return n
        ? {
            name: n.name,
            fileType: n.fileType,
            size: fakeSize(id, n.pageCount),
            pageCount: n.pageCount,
            // Recognition survives trashing (md5-keyed index), so a note trashed
            // from the library keeps its transcript, ovals and find in the bin.
            recognized: n.hasRecognizedText,
            // The shape survives trashing (blob-keyed index), so a trashed row
            // keeps reserving its final tile width exactly like a live one.
            thumbAspect: n.thumbAspect,
          }
        : null;
    }),
    // --- ADMIN WRITES ---
    //
    // A SPREAD OF AN IIFE, deliberately. These five methods need a fixture they
    // all mutate (people are added and deleted, an elevation goes stale), and
    // this marker is INSIDE the returned object literal — there is nowhere above
    // it to declare a `const` that is not a line a parallel feature is also
    // editing. The IIFE gives them one shared closure without touching a single
    // line outside the marker, and it is the whole of the admin fake.
    ...(() => {
      /** The household, mirroring the approved mockup's cast. */
      const people = [
        { id: 1, email: "ana@household.lan", isAdmin: true, mustChangePassword: false, createdAt: 1_751_500_000 },
        { id: 2, email: "rui@household.lan", isAdmin: false, mustChangePassword: false, createdAt: 1_747_500_000 },
        { id: 3, email: "guest@household.lan", isAdmin: false, mustChangePassword: true, createdAt: 1_753_000_000 },
      ];
      let nextId = 4;

      /**
       * Whether this "session" is elevated. Starts FALSE so dev and e2e both
       * land on the gate — which is the console's first screen in the real thing
       * too, and the one state a fake that started unlocked would never show.
       */
      let elevated = false;

      /**
       * The fixture password, and the only one the fake accepts. A published
       * constant rather than "anything non-empty", so the wrong-password branch
       * is reachable in a test without the fake having to invent a rule.
       */
      const PASSWORD = "inkhold";

      /**
       * The 428 the real server answers with, as the REAL error class.
       *
       * `dispatchApiFailure` routes on `instanceof ApiError`, so a fake throwing
       * a plain `Error` here would exercise a code path the shipped app never
       * takes — the console would fall through to its generic failure state and
       * the gate would never open. Imported dynamically because this file has no
       * top-level import of client.ts and cannot grow one at this marker; the
       * module is already in the graph, so it resolves off the module cache.
       */
      const httpError = async (code: string, message: string, status: number): Promise<Error> => {
        const { ApiError } = await import("./client");
        return new ApiError(code, message, status);
      };
      const needsElevation = () =>
        httpError("ELEVATION_REQUIRED", "Confirm your password to continue.", 428);

      const GB = 1024 * 1024 * 1024;

      /**
       * Devices per user id. Rui carries two — one of them REVOKED, so the
       * console's "unlinked but re-pairable" row is on screen in dev and in e2e
       * rather than reachable only by clicking Unlink first.
       */
      const devices: Record<number, { equipmentNo: string; name: string; model: string | null; firmware: string | null; active: boolean; createdAt: number }[]> = {
        1: [{ equipmentNo: "SN1000A2X", name: "Nomad", model: "A5X2", firmware: "3.20.29", active: true, createdAt: 1_751_500_000 }],
        2: [
          { equipmentNo: "SN1000B7K", name: "Manta", model: "A6X2", firmware: "3.21.02", active: true, createdAt: 1_747_600_000 },
          { equipmentNo: "SN1000C1M", name: "Nomad", model: "A5X2", firmware: "3.19.11", active: false, createdAt: 1_735_700_000 },
        ],
        // Guest has none: the "no device linked yet" state is a real one, and a
        // fixture where everybody has a tablet would never show it.
        3: [],
      };

      /**
       * Quota per user id. Rui is deliberately OVER his allotment — the state a
       * lowered quota produces, which the meter has to draw rather than clamp.
       */
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
          // Must-change from birth, like the real one: the temporary password
          // unlocks nothing but its own replacement.
          const id = nextId++;
          people.push({ id, email: address, isAdmin, mustChangePassword: true, createdAt: Date.now() / 1000 });
          // A new account gets its accounting rows the same moment the server's
          // `insertUser` calls `ensureCapacity`. Without them the console's
          // per-person detail fetch would 404 on somebody it had just created.
          quotas[id] = { usedBytes: 0, totalBytes: 2 * GB };
          devices[id] = [];
          return tempPassword();
        },

        async adminDeleteUser(id: number): Promise<void> {
          await delay(latency);
          if (!elevated) throw await needsElevation();
          const at = people.findIndex((p) => p.id === id);
          if (at < 0) return;
          // The same refusal the server makes, and it has to be here or the
          // console's LAST_ADMIN branch is unreachable in dev: deleting the only
          // administrator would lock administration out of the server for good.
          if (people[at]!.isAdmin && people.filter((p) => p.isAdmin).length <= 1) {
            throw await httpError("LAST_ADMIN", "cannot remove the last administrator", 200);
          }
          const [gone] = people.splice(at, 1);
          // The server's FK cascade takes capacity and device bindings with the
          // account; the fake has to do it by hand or a recycled id would
          // inherit a stranger's meter.
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
          // Revoked bindings included — filtering them here would make the
          // console's revoked row unreachable and quietly teach the fake a rule
          // the server does not have.
          return list.map((d) => ({ ...d }));
        },

        async adminUnlinkDevice(userId: number, equipmentNo: string): Promise<void> {
          await delay(latency);
          if (!elevated) throw await needsElevation();
          const device = devices[userId]?.find((d) => d.equipmentNo === equipmentNo && d.active);
          // Same conflation the server makes: an unknown serial and someone
          // else's serial are one error, so this cannot be used to discover
          // which housemate holds a given tablet.
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
          // Stored VERBATIM, even below current usage, and `usedBytes` is left
          // alone. That is the whole behaviour under test: nothing is deleted,
          // and the meter is handed a genuine over-quota pair.
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
          // Nothing already in the bin is purged. `changedAt` moving is exactly
          // what gives every existing entry a full new window — the fake records
          // it so the UI's non-retroactive sentence describes real behaviour.
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

    // --- ACCOUNT (self-service) ---
    //
    // THE REFERENCE IMPLEMENTATION of this surface (
    // §5–§7): where the intended behaviour is written down, and what the
    // endpoints are built to match. `changePassword` mirrors the real route,
    // which now REQUIRES and VERIFIES the current password of a control-plane
    // caller (§4) — so the refusal below is a rehearsal of a real server answer,
    // not a fiction the server would wave through.
    //
    // A SPREAD OF AN IIFE, for the same reason the admin block above is one:
    // these methods share mutable fixture state (a device is unlinked, `keep`
    // goes down and takes versions with it), and this marker is INSIDE the
    // returned object literal, so there is nowhere above it to declare a `const`
    // that is not a line another feature is also editing.
    //
    // The fixture is ONE HOUSEHOLD MEMBER'S account, deliberately small: a
    // single "Nomad" (the only device this app supports — the mobile app is out
    // of scope), and a few hundred megabytes across the four kinds.
    ...(() => {
      const MB = 1024 * 1024;

      /**
       * The bound tablets. ONE, named as an object rather than as a serial —
       * that naming is the point of the section (§7), and a fixture with three
       * anonymous devices would never show it.
       *
       * `lastSeenAt` is 20 minutes ago, RELATIVE to when the fake is built, so
       * the row reads "last seen 20 minutes ago" in dev and in e2e instead of
       * drifting into "8 months ago" as the fixture ages.
       */
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

      /**
       * The FIVE kinds, as a PARTITION: their sum IS `usedBytes`, which is the
       * property that makes the panel worth believing (§8). Two halves of that:
       *
       *  - the RECYCLE BIN line, which the numbers found — three live kinds that
       *    came up 597,016 bytes short of a real `used_bytes`, being two trashed
       *    files still charging;
       *  - VERSIONS, charged at all only after §6. A fixture whose total excluded
       *    them would model the bug rather than the fix, and the sum would not be
       *    a partition.
       *
       * 214 + 46 + 178 + 12 + 13 = 463 MB, which is deliberately the figure the
       * design doc quotes when it argues that "463 MB" alone answers nothing.
       */
      const kinds = { notebookBytes: 214 * MB, sketchBytes: 46 * MB, documentBytes: 178 * MB, binBytes: 12 * MB };
      const totalBytes = 10 * 1024 * MB;

      /**
       * Retained versions per file. Chosen so the design's own example is the
       * one the fake produces: at `keep = 3` this discards
       * `Σ max(0, c − 3)` = 2+2+2+2+0+0 = **8** versions — "Keeping 3 will remove
       * 8 versions now" (§7).
       */
      let retainedPerFile: number[] = [5, 5, 5, 5, 3, 2];
      let keep = 5;
      /** The admin's ceiling. One person must not set the household's disk
       *  policy, so the control is bounded by config it cannot see. */
      const maxKeep = 20;
      /** What the retained copies cost. Held per version so an eviction can
       *  report the bytes it actually freed rather than a guess. */
      const bytesPerVersion = (13 * MB) / 25; // the 25 retained versions above ≈ 13 MB
      const versionBytes = () => Math.round(retainedPerFile.reduce((a, b) => a + b, 0) * bytesPerVersion);

      /**
       * The fixture password — the same string the admin gate accepts, and
       * published for the same reason: the WRONG-password branch has to be
       * reachable in a test without the fake inventing a rule about what counts
       * as right. Restated rather than shared because both live inside marker
       * IIFEs that cannot see each other. MUTABLE, so a successful change makes
       * the NEW password the one the next change has to prove — a fake where the
       * old password kept working would model nothing.
       */
      let password = "inkhold";

      /** The real error class, imported dynamically for the reason the admin
       *  block's `httpError` gives (no top-level import is reachable here). */
      const httpError = async (code: string, message: string, status: number): Promise<Error> => {
        const { ApiError } = await import("./client");
        return new ApiError(code, message, status);
      };

      let otherSessions = 2;
      /**
       * NULL WOULD ALSO BE A REALISTIC FIXTURE — `users.password_changed_at`
       * does not exist yet, so every real account reads unrecorded until the
       * column lands and its owner changes one. A date is used here so the
       * common, informative rendering is the one dev and e2e exercise; the null
       * branch is covered in the unit tests instead.
       */
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
          // The same conflation the admin route makes: an unknown serial and
          // somebody else's serial are one indistinguishable error.
          if (!found) throw await httpError("DEVICE_NOT_FOUND", "no such device on this account", 404);
          // The ROW GOES. Unlike the admin listing — which keeps a revoked
          // binding so an admin can see it — your own list is the list of
          // tablets that sync, and an unlinked one does not.
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
          // SUMMED, never stated separately: the whole invariant is that the
          // lines add up to the meter, and a fixture that wrote the total down
          // by hand could drift from its own parts.
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
          // Clamped by the SERVER, not by the control: a hand-crafted request
          // must not be able to set the household's disk policy either.
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
          // The same refusal the server gives (§4): `INVALID_CREDENTIALS` at
          // status 200, before anything is changed and before any session is
          // revoked. Modelled here so the path is exercised in dev and in e2e
          // without standing a backend up.
          if (currentPlaintext !== password) {
            throw await httpError("INVALID_CREDENTIALS", "current password incorrect", 200);
          }
          if (newPlaintext === password) {
            throw await httpError("SAME_PASSWORD", "that is already your password", 200);
          }
          password = newPlaintext;
          // Every OTHER session goes — the real `changePassword` mints a new
          // session and revokes the rest — which is why the screen says so.
          otherSessions = 0;
          passwordChangedAt = now();
        },
      };
    })(),
  };
}
