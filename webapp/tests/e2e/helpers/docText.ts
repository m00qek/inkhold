import type { Page } from "@playwright/test";

// Serves `GET /api/controlplane/text/<md5>?v=`, the only route in-document search
// uses. The generators restate `src/api/fake.ts` (which exports none of it): the raw
// file and the indexed text must be the same string, or counts and marks disagree.
// Bodies are plain; Playwright fulfils below Chromium's content-encoding.

/** One extracted segment, in the record's own spelling (`p`/`o`/`l`/`t`). */
export interface TextSegmentFixture {
  /** The ordinal — a `.note` page index, a PDF page index, a `.txt` paragraph. */
  readonly p: number;
  /** The `.txt` byte offset. Omitted (not zero) for `.note` and `.pdf`. */
  readonly o?: number;
  readonly l?: number;
  readonly t: string;
}

/** One document's text record. */
export interface TextRecord {
  /** `n`: the address space, not `segments.length`; empty pages produce no line. */
  readonly n: number;
  /** The record's own `v`; the client never compares it. */
  readonly v?: number;
  readonly segments: readonly TextSegmentFixture[];
}

/**
 * Serialise a record as `derive_search.zig` does: a header echoing the served md5,
 * then one line per segment that carried text.
 */
export function encodeTextRecord(md5: string, record: TextRecord): string {
  const lines = [JSON.stringify({ md5, v: record.v ?? 1, n: record.n })];
  for (const s of record.segments) {
    lines.push(
      JSON.stringify(s.o === undefined ? { p: s.p, t: s.t } : { p: s.p, o: s.o, l: s.l, t: s.t }),
    );
  }
  return lines.join("\n") + "\n";
}

// ---- `.note` transcript ----

/**
 * The second spelling of `fakeText(name, index)` in `src/api/fake.ts`. Every recognised
 * page has "budget" twice; only odd-indexed pages have "witches", once.
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
 * `fakeTextHash`'s rule: every third page (index 2, 5, 8…) has no text, and a note may
 * start later (`181`).
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

// ---- `.txt` paragraphs ----

/** Byte-for-byte what the raw `/file/:id` mock serves. `zephyrine` lives only here. */
export const TXT_BODY =
  "Shopping list\n\n- oat milk\n- lentils\n- a new nib for the Supernote\n\n" +
  "The zephyrine tea arrived on Friday.\n\n" +
  "See you Sunday. More zephyrine steeped, brighter.";

/**
 * Split into paragraphs on blank lines with byte ranges, as `txt_index.zig` does.
 * Computed, never hand-typed: a one-byte error marks the wrong word.
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

// ---- `.pdf` pages ----

/**
 * The lines `wasm/tests/fixtures/text-four-page.pdf` carries; `marmalade` lives only here.
 * Page 3 (index 2) lacks it, which `pdfSearch.spec.ts` relies on.
 */
export const PDF_PAGES = [
  "Marmalade kettle descaling",
  "Marmalade drum bearing service",
  "Filter mesh rinse programme",
  "Marmalade spare parts",
];

/** One segment per 0-based page (`pdf_text.zig`'s `kind = 2` rows). */
export function pdfTextRecord(pages: readonly string[] = PDF_PAGES): TextRecord {
  return { n: pages.length, segments: pages.map((t, p) => ({ p, t })) };
}

// ---- route ----

/** What {@link mockDocText} counted, so a spec can assert find fetched once. */
export interface DocTextHits {
  /** Requests for `md5`, or for every md5 when omitted. */
  count(md5?: string): number;
  /** Every search-related `/api/` path requested, in order. */
  searchPaths(): string[];
}

export interface DocTextOptions {
  /** Hold every text response this long, to observe the `counting` phase. */
  delayMs?: number;
  /**
   * A record for any md5 the map does not name, for retained blobs whose md5 the fake
   * does not export. It disables the 404 that makes a forgotten record fail loudly.
   */
  fallback?: TextRecord;
}

/**
 * Serve `GET /api/controlplane/text/<md5>` from a map. Unknown md5s get a 404, which
 * the viewers show as an error, not "No matches". Register after `signedIn`.
 */
export async function mockDocText(
  page: Page,
  records: Readonly<Record<string, TextRecord>>,
  opts: DocTextOptions = {},
): Promise<DocTextHits> {
  const hits: string[] = [];
  const searchPaths: string[] = [];

  // Logs every request whose path contains `search`, scoped to `/api/` (Vite serves
  // `/src/search/*` modules too). `text/` with its trailing slash, so `/page/{n}/text`
  // word rectangles are not swept up.
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
        // The real route sends `content-encoding: gzip`; see the header.
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
