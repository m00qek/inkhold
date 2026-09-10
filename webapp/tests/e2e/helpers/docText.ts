import type { Page } from "@playwright/test";

// ONE DOCUMENT'S TEXT, served to e2e — the only route in-document search still
// makes (§1.1, §6 step 7).
//
//     GET /api/controlplane/text/<md5>?v=<index_version>
//
// Find-in-note, find-in-txt, find-in-PDF, find-in-a-version and find-in-the-bin
// used to be five server routes with three response shapes, and every spec that
// exercised one stubbed a `/search` endpoint's JSON: the SERVER decided which
// pages matched and how many words it counted, and the browser drew ovals over
// the answer. All five are gone. What the browser fetches now is the document's
// REAL TEXT, once, and it answers every one of those questions itself out of the
// same wasm FTS5 instance the library search runs on.
//
// So the mock moved a layer down, and that is the point rather than an
// inconvenience. A spec that stubbed `{"pages":[{"pageIndex":1,"matches":2}]}`
// was asserting that the viewer rendered a number it had been handed. A spec
// that stubs the TEXT asserts that the engine found the word, counted its
// instances, named the ones to circle and ordered them down the document — the
// work that used to happen on a Pi and is now the thing under test.
//
// ## THE FIXTURE TEXT IS DUPLICATED HERE, DELIBERATELY
//
// `src/api/fake.ts` generates the transcripts the reader's word boxes are laid
// out from, and its `.txt`/`.pdf` text tables went with the routes that read them
// (§6 step 7). It exports none of it. So the generators below are a second
// spelling of `fakeText`, of `txtSegmentsOf` and of the four `.pdf` lines —
// exactly the arrangement `txtSearch.spec.ts` already had for its `BODY`, and
// for the same reason: the raw file the viewer fetches and the text the index is
// built from must be the SAME STRING, or a find reports the right count over
// marks that are somewhere else.
//
// If they drift, the symptom is loud: the counter is right and nothing is
// circled, which is precisely the failure `pdfFind.ts`'s honesty rule tolerates
// on a real document and must never tolerate in a fixture. The facts to keep in
// step are named where each generator states them.
//
// ## Uncompressed, and the transport does not care
//
// The real route serves ONE gzip member under `content-encoding: gzip`, which
// the browser inflates before `httpTextTransport`'s `await res.text()` ever
// runs — `docText.ts`'s header is explicit that nothing on the client
// decompresses. So a `route.fulfill` with a plain body reaches the parser as the
// identical string.
//
// AND A HAND-GZIPPED BODY WOULD NOT WORK, which is stronger than "would prove
// nothing". Measured in Chromium: Playwright fulfils a route BELOW the
// content-encoding pipeline, so `content-encoding: gzip` is passed through as a
// header and the gzip bytes arrive at the page verbatim (45 bytes beginning
// `1f 8b 08 00` for a 55-byte record, with and without a matching
// `content-length`). `helpers/searchIndex.ts`'s header records the probe.

/** One extracted segment, in the record's own spelling (`p`/`o`/`l`/`t`). */
export interface TextSegmentFixture {
  /** The ordinal — a `.note` page index, a PDF page index, a `.txt` paragraph. */
  readonly p: number;
  /** The `.txt` byte offset into the raw blob. Omitted for `.note` and `.pdf`,
   *  where the ordinal is already the address — and omitted means ABSENT on the
   *  wire, not zero (`docText.ts` refuses half a byte range). */
  readonly o?: number;
  readonly l?: number;
  readonly t: string;
}

/** One document's text record. */
export interface TextRecord {
  /** `n`: the ADDRESS SPACE, not `segments.length`. A page that extracted to
   *  nothing produces no line, so the two differ for every fixture note. */
  readonly n: number;
  /** The record's own `v`. Nothing in the client compares it — see
   *  `docText.ts` — so it is a plausible constant rather than a fact. */
  readonly v?: number;
  readonly segments: readonly TextSegmentFixture[];
}

/**
 * Serialise a record the way `derive_search.zig` writes it: a header line, then
 * one line per segment that carried text.
 *
 * The header echoes the md5 the record is SERVED under, always. It used to be
 * overridable, because `binFake.ts` gave a trashed file a `fileHash` that was
 * not 32 hex and `parseDocumentText` refuses one — a fixture defect, now fixed
 * at the fixture (`BlobHash`), so the escape hatch is gone with it.
 */
export function encodeTextRecord(md5: string, record: TextRecord): string {
  const lines = [JSON.stringify({ md5, v: record.v ?? 1, n: record.n })];
  for (const s of record.segments) {
    lines.push(
      JSON.stringify(s.o === undefined ? { p: s.p, t: s.t } : { p: s.p, o: s.o, l: s.l, t: s.t }),
    );
  }
  // Every record the writer emits ends in a newline. `parseDocumentText` skips
  // blank lines, so the trailing one is free — but writing it keeps this the
  // same shape the stream parser is strict about.
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// THE `.note` TRANSCRIPT
// ---------------------------------------------------------------------------

/**
 * A fixture note's transcript for one page — the second spelling of
 * `fakeText(name, index)` in `src/api/fake.ts`.
 *
 * The two lines carrying "budget" and the odd-page-only "witches" line are what
 * every find spec counts, so they are the two facts to check first if a count
 * assertion moves: EVERY recognised page carries "budget" exactly twice, and
 * ONLY odd-indexed pages carry "witches", once.
 */
export function noteTranscript(name: string, index: number): string {
  return [
    `${name} — page ${index + 1}`,
    "",
    "Handwriting recognition ran on the device, so the",
    "transcript is stored inside the .note file itself.",
    "",
    "  · confirm the page-range serving budget",
    "  · md5-keyed cache stays immutable across edits",
    "  · ask about the vector question in the container",
    "  · <draft> R&D budget — flag \"open\" items & re-check",
    "",
    "Follow-up: re-read the sync notes before Thursday,",
    "then fold the answers back into the design doc.",
    ...(index % 2 === 1 ? ["Marginalia: the witches of Endor, again."] : []),
  ].join("\n");
}

/**
 * Which pages of a fixture note the device recognised — `fakeTextHash`'s rule,
 * restated: every third page (index 2, 5, 8…) carries none, and a note may also
 * start later than page 1 (`181`, "Recognised from page two").
 *
 * An unrecognised page produces NO SEGMENT LINE, which is what makes `n` and
 * `segments.length` genuinely different here rather than accidentally equal.
 */
export function recognisedPages(pageCount: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < pageCount; i += 1) if (i >= from && i % 3 !== 2) out.push(i);
  return out;
}

/** A `.note`'s text record: one segment per recognised page, ordinal = page index. */
export function noteTextRecord(name: string, pageCount: number, from = 0): TextRecord {
  return {
    n: pageCount,
    segments: recognisedPages(pageCount, from).map((p) => ({ p, t: noteTranscript(name, p) })),
  };
}

// ---------------------------------------------------------------------------
// THE `.txt` PARAGRAPHS, WITH THEIR BYTE RANGES
// ---------------------------------------------------------------------------

/**
 * The `.txt` fixture's content, byte-for-byte what the raw `/file/:id` mock
 * serves. `zephyrine` lives ONLY here — no note transcript, no file name — so a
 * search for it exercises the `.txt` path and nothing else.
 */
export const TXT_BODY =
  "Shopping list\n\n- oat milk\n- lentils\n- a new nib for the Supernote\n\n" +
  "The zephyrine tea arrived on Friday.\n\n" +
  "See you Sunday. More zephyrine steeped, brighter.";

/**
 * Split `.txt` content into paragraphs on blank lines, tracking each one's BYTE
 * range — the shape `txt_index.zig` derives, and the reason `o`/`l` travel at
 * all: in a `.txt` the ordinal is a paragraph index and the ADDRESS is a byte
 * range in the raw blob, which `txtFind.ts`'s `byteToCharMap` converts to the
 * UTF-16 index the viewer holds.
 *
 * Computed rather than written out, because the numbers are the assertion: a
 * hand-typed offset that is one byte out marks the wrong word and no test can
 * tell you which digit to change.
 */
export function txtTextRecord(content: string = TXT_BODY): TextRecord {
  const enc = new TextEncoder();
  const segs: { startChar: number; text: string }[] = [];
  let charPos = 0;
  let start = -1;
  let end = -1;
  const flush = (): void => {
    if (start >= 0) segs.push({ startChar: start, text: content.slice(start, end) });
    start = -1;
  };
  for (const line of content.split("\n")) {
    const lineStart = charPos;
    // A `\r` before the terminator is not part of the paragraph.
    const contentEnd = lineStart + line.length - (line.endsWith("\r") ? 1 : 0);
    if (/^[ \t\r]*$/.test(line)) flush();
    else {
      if (start < 0) start = lineStart;
      end = contentEnd;
    }
    charPos += line.length + 1; // the split consumed one "\n"
  }
  flush();
  return {
    n: segs.length,
    segments: segs.map((s, p) => ({
      p,
      o: enc.encode(content.slice(0, s.startChar)).length,
      l: enc.encode(s.text).length,
      t: s.text,
    })),
  };
}

// ---------------------------------------------------------------------------
// THE `.pdf` PAGES
// ---------------------------------------------------------------------------

/**
 * The `.pdf` fixture's per-page text — the same lines the real
 * `wasm/tests/fixtures/text-four-page.pdf` carries, so what MuPDF locates in the
 * browser is what this record says matched. `marmalade` lives ONLY here.
 *
 * Page 3 (index 2) is the one WITHOUT it, and that is load-bearing: it is what
 * makes "Next skipped a page" a document-wide find rather than a per-page one,
 * and what lets `pdfSearch.spec.ts` observe a page with a count and no marks.
 */
export const PDF_PAGES = [
  "Marmalade kettle descaling",
  "Marmalade drum bearing service",
  "Filter mesh rinse programme",
  "Marmalade spare parts",
];

/** A `.pdf`'s text record: one segment per page, ordinal = 0-based page index —
 *  `pdf_text.zig`'s `kind = 2` rows, which the viewer deep-links to as `page + 1`. */
export function pdfTextRecord(pages: readonly string[] = PDF_PAGES): TextRecord {
  return { n: pages.length, segments: pages.map((t, p) => ({ p, t })) };
}

// ---------------------------------------------------------------------------
// THE ROUTE
// ---------------------------------------------------------------------------

/** What {@link mockDocText} counted, so a spec can assert not just that find
 *  answered but that it fetched ONCE — the §4.1 "on first find, then never
 *  again" property, which is otherwise invisible. */
export interface DocTextHits {
  /** Requests for `md5`, or for every md5 when omitted. */
  count(md5?: string): number;
  /** Every search-related path the page has requested, in order. The sweep's own
   *  shape (§6.1): after step 7 the only ones that may appear are
   *  `search-index/manifest`, `search-index/stream` and `text/<md5>`. */
  searchPaths(): string[];
}

export interface DocTextOptions {
  /** Hold every text response this long. For observing the `counting` phase,
   *  which is otherwise a frame wide on localhost. */
  delayMs?: number;
  /**
   * A record to serve for ANY md5 the map does not name.
   *
   * For the one case where the md5 is not knowable from the test: a version
   * preview and a bin preview search a RETAINED blob's own content address
   * (§1.1's "history and bin are not special: they are other md5s"), and
   * `api/fake.ts` mints those from a hash it does not export. A test that cannot
   * name the md5 can still assert the thing that matters — that the md5 asked
   * for was NOT the live note's — with {@link DocTextHits.count}.
   *
   * Use it deliberately and nowhere else: it turns the 404 off, and the 404 is
   * what makes a forgotten record fail loudly.
   */
  fallback?: TextRecord;
}

/**
 * Serve `GET /api/controlplane/text/<md5>` from a map of records.
 *
 * An md5 the map does not name gets a **404**, and that is the server's own
 * answer rather than a convenience: `docText.ts` documents the 404 as
 * deliberately ambiguous — unreachable, or not derived yet — and it reaches the
 * viewers as their `error` state, never as "No matches". So a spec that forgets
 * a record fails as a red find bar, not as a silent zero.
 *
 * Register AFTER `signedIn`: Playwright matches routes newest-first, and
 * `mockApi`'s catch-all would otherwise answer `{"success":true}` — which the
 * parser refuses as a record with no document header, at some distance from the
 * cause.
 */
export async function mockDocText(
  page: Page,
  records: Readonly<Record<string, TextRecord>>,
  opts: DocTextOptions = {},
): Promise<DocTextHits> {
  const hits: string[] = [];
  const searchPaths: string[] = [];

  // Every request the page makes, not only the ones this mock answers — the
  // network log the sweep assertion reads. Recorded from `request`, so a route
  // some OTHER handler fulfils (or `mockApi`'s bland catch-all succeeds) is
  // still seen.
  //
  // `search` ANYWHERE IN THE PATH, which is §6.1's own criterion and not a
  // convenience: the retired set includes `txt-search`, which a `/search`
  // fragment would miss and which is exactly the sort of near-miss a sweep is
  // for. `/page/{n}/text` is the one route that must NOT be swept up — it is the
  // word RECTANGLES, not a search — so the text route is matched with its
  // trailing slash, which only `text/{md5}` has.
  //
  // SCOPED TO `/api/`, because this is an API log and the app is served by Vite
  // in dev: every module the browser imports is a real request for a real path,
  // and after §6 step 7 the in-document engine lives at `src/search/*`. So an
  // unscoped filter logged `/src/search/searchService.ts`,
  // `/src/search/indexEngine.ts` and a dozen siblings — sixteen entries, none of
  // them traffic, and every one of them a source file whose EXISTENCE is what
  // the sweep is celebrating. Funny once; a permanently red assertion after
  // that. The routes the sweep polices are all under `/api/controlplane/`, and a
  // resurrected one would be too, so nothing it exists to catch is lost.
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    if (!path.startsWith("/api/")) return;
    if (/search/.test(path) || path.includes("/text/")) searchPaths.push(path);
  });

  await page.route(
    (url) => url.pathname.startsWith("/api/controlplane/text/"),
    async (route) => {
      const md5 = decodeURIComponent(
        new URL(route.request().url()).pathname.slice("/api/controlplane/text/".length),
      );
      hits.push(md5);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const record = records[md5] ?? opts.fallback;
      if (!record) {
        await route.fulfill({ status: 404, contentType: "text/plain", body: "" });
        return;
      }
      await route.fulfill({
        status: 200,
        // The real route sends `content-encoding: gzip`; see the header for why
        // this one does not have to.
        contentType: "application/x-ndjson; charset=utf-8",
        headers: { "cache-control": "private, immutable, max-age=31536000" },
        body: encodeTextRecord(md5, record),
      });
    },
  );

  return {
    count: (md5) => (md5 === undefined ? hits.length : hits.filter((h) => h === md5).length),
    searchPaths: () => [...searchPaths],
  };
}
