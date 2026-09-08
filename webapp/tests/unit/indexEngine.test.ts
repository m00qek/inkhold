import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MAPPING_FORMAT_VERSION,
  SearchIndex,
  SearchIndexError,
  StaleSnapshotError,
  type CoreLoader,
  type IndexSnapshot,
  type SearchCoreExports,
  type TermsDocument,
} from "../../src/search/indexEngine";

// THE REAL `sqlite-core.wasm`, not a fake, and it has to be: everything worth
// asserting here is a property of FTS5's tokenizer, not of our glue. A stub
// speaking the ABI would let the folding-parity test pass while proving nothing
// — and folding parity is the entire argument for putting SQLite in the browser
// (`golden-search.md` §1.1, §2.2).
//
// `public/`, not `zig-out/`: this is the artifact the app actually serves, and
// `npm run build:wasm` (a `pretest` hook) is what puts it there.
const wasmPath = fileURLToPath(new URL("../../public/sqlite-core.wasm", import.meta.url));

// Instantiating in Node is legitimate for this module — the same call the
// browser makes, on the same V8 that Chromium ships, and the module imports
// NOTHING (no WASI shim needed, unlike `pdf-decode.wasm`). What Node cannot
// stand in for is the network, and nothing here touches it.
let bytes: Uint8Array;
const loadCore: CoreLoader = async () => {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const core = instance.exports as unknown as SearchCoreExports;
  core._initialize?.();
  return core;
};

beforeAll(() => {
  if (!existsSync(wasmPath)) throw new Error(`missing ${wasmPath} — run \`npm run build:wasm\``);
  bytes = readFileSync(wasmPath);
});

/**
 * Three documents whose pages are FOLDED terms, which is what the stream
 * delivers (§2.2). Portuguese with real diacritics on purpose: the corpus is
 * unaccented (the server's `remove_diacritics 2` already stripped them) and the
 * queries below are not, which is the parity claim stated as data.
 *
 * Page ordinals are deliberately sparse and out of order in `NOTES`: only pages
 * with text get a row, so a document's rows are never a dense 0..n-1 range and
 * the rowid table cannot get away with arithmetic.
 */
const NOTES: TermsDocument = {
  md5: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  pages: [
    { p: 0, t: "reuniao orcamento projeto" },
    { p: 3, t: "reuniao acta caligrafia" },
    { p: 11, t: "conclusao do projeto" },
  ],
};
const BOOK: TermsDocument = {
  md5: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  pages: [
    { p: 0, t: "caligrafia japonesa" },
    { p: 1, t: "notas sobre dados" },
  ],
};
const PLAN: TermsDocument = {
  md5: "cccccccccccccccccccccccccccccccc",
  pages: [{ p: 7, t: "orcamento anual dados" }],
};
const LIBRARY = [NOTES, BOOK, PLAN];

/** An index holding `LIBRARY`, built the way a first search would build it. */
async function built(): Promise<SearchIndex> {
  const index = await SearchIndex.open(loadCore);
  index.build(LIBRARY);
  return index;
}

/** Hits as `md5:page` strings, sorted — rank order is asserted separately. */
const places = (r: { hits: { md5: string; page: number }[] }): string[] =>
  r.hits.map((h) => `${h.md5[0]}${h.page}`).sort();

describe("SearchIndex build and query", () => {
  it("finds the pages a term is on, across documents", async () => {
    const index = await built();
    try {
      const r = index.query("orcamento ", 10);
      expect(r.total).toBe(2);
      expect(places(r)).toEqual(["a0", "c7"]);
    } finally {
      index.close();
    }
  });

  it("maps every hit back to its document and its own page ordinal", async () => {
    const index = await built();
    try {
      // `caligrafia` is on page 3 of one document and page 0 of another — the
      // ordinals are per-document, which is the whole point of `page_of`.
      expect(places(index.query("caligrafia ", 10))).toEqual(["a3", "b0"]);
      // A sparse ordinal (page 11 of a 3-row document) comes back as 11, not 2.
      expect(index.query("conclusao ", 10).hits).toEqual([{ md5: NOTES.md5, page: 11 }]);
    } finally {
      index.close();
    }
  });

  it("ANDs terms within one row, so a match means the SAME page", async () => {
    const index = await built();
    try {
      // "orcamento" is on a0 and c7; "projeto" on a0 and a11. Same row: a0.
      expect(index.query("orcamento projeto ", 10).hits).toEqual([{ md5: NOTES.md5, page: 0 }]);
      // "orcamento" and "caligrafia" share no page anywhere.
      expect(index.query("orcamento caligrafia ", 10).total).toBe(0);
    } finally {
      index.close();
    }
  });

  it("reports the exact total whatever `limit` returns", async () => {
    const index = await built();
    try {
      // §9.5 retires the server's "N+" floors because a client holding the index
      // has already paid for the count; `limit` must not turn it back into one.
      const r = index.query("reuniao ", 1);
      expect(r.total).toBe(2);
      expect(r.hits).toHaveLength(1);
      expect(index.query("reuniao ", 0)).toEqual({ total: 2, hits: [], expansions: [] });
    } finally {
      index.close();
    }
  });

  it("prefix-matches the last word until a space finishes it", async () => {
    const index = await built();
    try {
      // What makes search answer while the user is still typing...
      expect(index.query("cali", 10).total).toBe(2);
      // ...and a trailing space is the user saying the word is done.
      expect(index.query("cali ", 10).total).toBe(0);
      expect(index.query("caligrafia ", 10).total).toBe(2);
    } finally {
      index.close();
    }
  });
});

describe("SearchIndex folding parity", () => {
  // THE PARITY ARGUMENT, and it is why the fold is in wasm rather than in JS.
  // The corpus is folded by the SERVER's `unicode61 remove_diacritics 2`; the
  // query is folded by the SAME C compiled to wasm. A JS folder would be a
  // second implementation, and the failure it produces — an accented query
  // silently matching nothing — looks exactly like "no results".
  it("matches an unaccented corpus from an accented query", async () => {
    const index = await built();
    try {
      expect(index.query("reunião ", 10).total).toBe(2);
      expect(index.query("orçamento ", 10).total).toBe(2);
      expect(index.query("conclusão ", 10).total).toBe(1);
    } finally {
      index.close();
    }
  });

  it("matches an accented corpus from an unaccented query, and vice versa", async () => {
    // The other direction, which needs a corpus row the server did NOT fold —
    // so this one is written with diacritics intact. Both spellings are one
    // term, so all four combinations are the same two hits.
    const index = await SearchIndex.open(loadCore);
    try {
      index.build([
        { md5: "d".repeat(32), pages: [{ p: 0, t: "reunião de caligrafia às terças" }] },
        { md5: "e".repeat(32), pages: [{ p: 0, t: "reuniao semanal do projeto" }] },
      ]);
      expect(index.query("reunião ", 10).total).toBe(2);
      expect(index.query("reuniao ", 10).total).toBe(2);
      expect(index.query("REUNIÃO ", 10).total).toBe(2);
      expect(index.query("REUNIAO ", 10).total).toBe(2);
    } finally {
      index.close();
    }
  });

  it("is case-insensitive, which is the same tokenizer property", async () => {
    const index = await built();
    try {
      expect(index.query("CALIGRAFIA ", 10).total).toBe(2);
    } finally {
      index.close();
    }
  });
});

describe("SearchIndex query folding to nothing", () => {
  // NOT an error. Each of these was a plausible FTS5 syntax error on a
  // keystroke, and the reason a JS-side escaper was rejected: it would have had
  // to decide what FTS5 makes of `-`, and guessing wrong turns typing into a
  // thrown exception.
  it("returns zero results, never an error, for punctuation", async () => {
    const index = await built();
    try {
      for (const junk of ["", "   ", "-", '"', '""', "...", "( )", "*", "^", "-- ", "()"]) {
        expect({ junk, ...index.query(junk, 10) }).toEqual({ junk, total: 0, hits: [], expansions: [] });
      }
    } finally {
      index.close();
    }
  });

  it("still finds the real word when punctuation is mixed in with it", async () => {
    const index = await built();
    try {
      expect(index.query('"caligrafia" ', 10).total).toBe(2);
      expect(index.query("caligrafia! ", 10).total).toBe(2);
    } finally {
      index.close();
    }
  });
});

describe("SearchIndex persistence", () => {
  it("round-trips through a FRESH instance and answers identically", async () => {
    const source = await built();
    let snapshot: IndexSnapshot;
    const before: Record<string, string[]> = {};
    const QUERIES = ["reunião ", "caligrafia ", "orcamento projeto ", "cali", "dados "];
    try {
      for (const q of QUERIES) before[q] = places(source.query(q, 10));
      snapshot = source.serialize();
    } finally {
      source.close();
    }
    expect(snapshot.image.length).toBeGreaterThan(0);
    expect(snapshot.mappingVersion).toBe(MAPPING_FORMAT_VERSION);

    // A FRESH instance: `idx_image_alloc` is its literal first call into SQLite,
    // which is where `OMIT_AUTOINIT` (trap 2) bites.
    const restored = await SearchIndex.restore(snapshot, loadCore);
    try {
      for (const q of QUERIES) expect(places(restored.query(q, 10))).toEqual(before[q]);
    } finally {
      restored.close();
    }
  });

  it("carries the rowid mapping across the round trip", async () => {
    const source = await built();
    const snapshot = source.serialize();
    source.close();

    const restored = await SearchIndex.restore(snapshot, loadCore);
    try {
      // The mapping is what makes a rowid a place. Without it the image answers
      // with integers nobody can name, so it is stored WITH the image.
      expect(restored.documents()).toEqual(LIBRARY.map((d) => d.md5));
      expect(restored.documentCount).toBe(3);
      expect(restored.pageCount).toBe(6);
      expect(restored.query("conclusao ", 10).hits).toEqual([{ md5: NOTES.md5, page: 11 }]);
      expect(places(restored.query("caligrafia ", 10))).toEqual(["a3", "b0"]);
      // ...and it survives a SECOND round trip, so restoring is not lossy.
      const again = restored.serialize();
      expect(again.docs).toEqual(snapshot.docs);
      expect(again.image.length).toBe(snapshot.image.length);
    } finally {
      restored.close();
    }
  });

  it("restores into an instance that is already open, without re-instantiating", async () => {
    // §4.1's preferred shape: `idx_deserialize` closes the previous database and
    // its pages go back to SQLite's heap inside the SAME linear memory, so the
    // instance need not be discarded to change what it holds.
    const index = await built();
    try {
      const snapshot = index.serialize();
      index.reset();
      index.build([PLAN]);
      expect(index.query("caligrafia ", 10).total).toBe(0);
      index.deserialize(snapshot);
      expect(index.query("caligrafia ", 10).total).toBe(2);
      expect(index.documentCount).toBe(3);
    } finally {
      index.close();
    }
  });

  it("refuses a snapshot from a different index shape rather than answering wrongly", async () => {
    const index = await built();
    const snapshot = index.serialize();
    index.close();

    // Either version can move with NOTHING server-side moving, which is why the
    // server's `index_version` cannot stand in for them. The right response is
    // to rebuild from the rows, so this is a distinguishable error and not a
    // corruption report.
    const fresh = await SearchIndex.open(loadCore);
    try {
      expect(() => fresh.deserialize({ ...snapshot, schemaVersion: snapshot.schemaVersion + 1 })).toThrow(
        StaleSnapshotError,
      );
      expect(() => fresh.deserialize({ ...snapshot, mappingVersion: 99 })).toThrow(StaleSnapshotError);
      // ...and the index it refused into is untouched and still usable.
      expect(fresh.query("caligrafia ", 10).total).toBe(0);
      fresh.deserialize(snapshot);
      expect(fresh.query("caligrafia ", 10).total).toBe(2);
    } finally {
      fresh.close();
    }
  });

  it("states the wasm's schema version, so a caller can check before restoring", async () => {
    const index = await SearchIndex.open(loadCore);
    try {
      expect(index.schemaVersion).toBeGreaterThanOrEqual(1);
      expect(index.serialize().schemaVersion).toBe(index.schemaVersion);
    } finally {
      index.close();
    }
  });
});

describe("SearchIndex lifecycle and refusals", () => {
  it("empties on reset and keeps answering", async () => {
    const index = await built();
    try {
      index.reset();
      expect(index.documentCount).toBe(0);
      expect(index.pageCount).toBe(0);
      expect(index.query("caligrafia ", 10)).toEqual({ total: 0, hits: [], expansions: [] });
      index.build([BOOK]);
      expect(index.query("caligrafia ", 10).total).toBe(1);
    } finally {
      index.close();
    }
  });

  it("rebuilds onto the same instance, whether or not anything was there", async () => {
    // The one thing both consumers do, and the reason it is a method rather than
    // two lines repeated on each side of the worker boundary. §8.1: successive
    // builds through ONE instance converge on the cost of the worst document,
    // which is why a worker per document would be waste.
    const index = await SearchIndex.open(loadCore);
    try {
      // Nothing held: the reset is skipped, and the build is just a build.
      index.rebuild([NOTES]);
      expect(index.documents()).toEqual([NOTES.md5]);
      // Held: the previous document goes rather than being added to — the same
      // md5 twice would be refused, and a second document would answer queries
      // belonging to the one that is no longer open.
      index.rebuild([BOOK]);
      expect(index.documents()).toEqual([BOOK.md5]);
      expect(index.query("reuniao ", 10).total).toBe(0);
      expect(index.query("caligrafia ", 10).total).toBe(1);
      // And after a FAILED build, which reset on its way out, the short path is
      // the right one — `rebuild` must be safe to call blindly.
      expect(() => index.rebuild([NOTES, NOTES])).toThrow(/already in this index/);
      index.rebuild([NOTES]);
      expect(index.documents()).toEqual([NOTES.md5]);
    } finally {
      index.close();
    }
  });

  it("refuses the same document twice instead of doubling its counts", async () => {
    const index = await SearchIndex.open(loadCore);
    try {
      expect(() => index.build([NOTES, NOTES])).toThrow(/already in this index/);
      // The failed build reset rather than committing what got in: a partial
      // index is worse than none, because it answers.
      expect(index.documentCount).toBe(0);
      expect(index.query("reuniao ", 10).total).toBe(0);
    } finally {
      index.close();
    }
  });

  it("refuses every call once closed, rather than using a stale handle", async () => {
    const index = await built();
    index.close();
    expect(() => index.query("reuniao ", 10)).toThrow(/closed/);
    expect(() => index.build([BOOK])).toThrow(/closed/);
    expect(() => index.serialize()).toThrow(/closed/);
    index.close(); // idempotent
  });

  it("reports a wasm-side refusal as SearchIndexError with the module's message", async () => {
    const index = await SearchIndex.open(loadCore);
    try {
      index.addPage(1, "reuniao");
      // A repeated ROWID is what `idx_add` itself catches — a UNIQUE failure,
      // not a silent overwrite of a row the caller still believes in.
      let caught: unknown;
      try {
        index.addPage(1, "outra coisa");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SearchIndexError);
      expect((caught as SearchIndexError).rc).toBeLessThan(0);
      expect((caught as Error).message).toMatch(/UNIQUE|constraint/i);
    } finally {
      index.close();
    }
  });

  it("rejects a negative limit before it reaches the wasm", async () => {
    const index = await built();
    try {
      expect(() => index.query("reuniao ", -1)).toThrow(RangeError);
    } finally {
      index.close();
    }
  });
});

describe("SearchIndex scale", () => {
  // Not a benchmark — the numbers in §8.1 came from a real corpus through
  // `webapp/wasm/tests/residency_bench.mjs`. This asserts the SHAPE holds at a
  // size where a per-row `idx_alloc`, a linear rowid scan or a detached view
  // after `memory.grow` would show up, and pins the one behaviour a small corpus
  // cannot: that the staging buffer survives the growth its own inserts cause.
  it("builds thousands of rows and maps every one of them back", async () => {
    const docs: TermsDocument[] = [];
    for (let d = 0; d < 40; d++) {
      const pages = [];
      for (let p = 0; p < 100; p++) {
        // A term unique to this page, one shared by the document, one global.
        pages.push({ p: p * 3, t: `pagina${d}x${p} documento${d} biblioteca` });
      }
      docs.push({ md5: `${d}`.padStart(32, "0"), pages });
    }
    const index = await SearchIndex.open(loadCore);
    try {
      index.build(docs);
      expect(index.pageCount).toBe(4000);
      expect(index.query("biblioteca ", 0).total).toBe(4000);
      expect(index.query("documento7 ", 0).total).toBe(100);
      expect(index.query("pagina7x50 ", 10).hits).toEqual([
        { md5: "7".padStart(32, "0"), page: 150 },
      ]);
      // The last document's last page, through the binary search, after the
      // image has been through a serialize/restore.
      const snapshot = index.serialize();
      index.deserialize(snapshot);
      expect(index.query("pagina39x99 ", 10).hits).toEqual([
        { md5: "39".padStart(32, "0"), page: 297 },
      ]);
    } finally {
      index.close();
    }
  });
});
