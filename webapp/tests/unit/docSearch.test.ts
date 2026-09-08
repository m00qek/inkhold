import { describe, it, expect, beforeAll, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  countMarks,
  createDocSearch,
  fold,
  planMarks,
  type DocSearchResult,
} from "../../src/search/docSearch";
import {
  DocumentTextUnavailable,
  parseDocumentText,
  type DocumentText,
  type TextTransport,
} from "../../src/search/docText";
import { SearchWireError } from "../../src/search/manifestCodec";
import { textKeyOf, type TextStore } from "../../src/cache/textStore";
import type { CoreLoader, SearchCoreExports } from "../../src/search/indexEngine";
import { byteToCharMap, resolveFindSegments } from "../../src/pages/txtFind";

// IN-DOCUMENT SEARCH, end to end, against THE REAL `sqlite-core.wasm`.
//
// It has to be the real one. Everything worth asserting here is a property of
// FTS5's own tokenizer and of the typo ladder compiled beside it — the fold, the
// prefix `*`, which near-miss `idx_fuzzy` reaches for — and a stub speaking the
// ABI would let every one of those pass while proving nothing.
//
// `public/`, not `zig-out/`: this is the artifact the app serves, and
// `npm run build:wasm` (a `pretest` hook) is what puts it there.
const wasmPath = fileURLToPath(new URL("../../public/sqlite-core.wasm", import.meta.url));

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

const NOTE_MD5 = "a".repeat(32);
const TXT_MD5 = "b".repeat(32);

/**
 * A `.note`-shaped record: the ordinal IS the address, so no `o`/`l`. Ordinals
 * are sparse and out of order on purpose — a page that recognised nothing emits
 * no line, so a document's segments are never a dense 0..n-1 range.
 *
 * Portuguese with the accents INTACT, which is the point of this record as
 * against `terms/`: the text arrives unfolded and FTS5 folds it on insert.
 */
const NOTE_LINES = [
  '{"md5":"' + NOTE_MD5 + '","v":15,"n":12}',
  '{"p":0,"t":"Reunião de orçamento do projeto"}',
  '{"p":3,"t":"Acta da reunião, com caligrafia difícil"}',
  '{"p":11,"t":"Conclusão do projeto e mais uma reunião"}',
].join("\n");

/**
 * A `.txt`-shaped record: paragraphs of one blob, each with its BYTE RANGE. The
 * body below is the blob those ranges address, and it is deliberately not ASCII
 * — `Reunião` is 8 characters and 9 UTF-8 bytes, so any code that treats the two
 * as interchangeable slides the highlight off the word.
 */
const TXT_BODY = "Reunião amanhã.\n\nO orçamento do projeto.\n\nOutra reunião marcada.";
const TXT_PARAS = TXT_BODY.split("\n\n");
const utf8 = new TextEncoder();
function txtRecord(): string {
  const lines = ['{"md5":"' + TXT_MD5 + '","v":15,"n":3}'];
  let offset = 0;
  TXT_PARAS.forEach((para, i) => {
    const len = utf8.encode(para).length;
    lines.push(JSON.stringify({ p: i, o: offset, l: len, t: para }));
    offset += len + utf8.encode("\n\n").length;
  });
  return lines.join("\n");
}

function transportFor(records: Record<string, string>): {
  transport: TextTransport;
  calls: { md5: string; version: number | null }[];
} {
  const calls: { md5: string; version: number | null }[] = [];
  const transport: TextTransport = async (md5, version) => {
    calls.push({ md5, version });
    const body = records[md5];
    if (body === undefined) throw new DocumentTextUnavailable(md5);
    return parseDocumentText(body);
  };
  return { transport, calls };
}

function docs(records: Record<string, string> = { [NOTE_MD5]: NOTE_LINES, [TXT_MD5]: txtRecord() }) {
  const { transport, calls } = transportFor(records);
  return { search: createDocSearch({ transport, load: loadCore }), calls };
}

const ordinals = (r: DocSearchResult): number[] => r.segments.map((s) => s.segment);

describe("parseDocumentText", () => {
  it("reads the header and the segments, keeping the text unfolded", () => {
    const doc = parseDocumentText(NOTE_LINES);
    expect(doc.md5).toBe(NOTE_MD5);
    expect(doc.indexVersion).toBe(15);
    // `n` is the ADDRESS SPACE, not the row count: three of twelve pages carried
    // text, which is the normal case and not a truncated record.
    expect(doc.segmentCount).toBe(12);
    expect(doc.segments).toHaveLength(3);
    expect(doc.segments[0]!.t).toContain("Reunião");
  });

  it("decodes an absent byte range as null, never as 0", () => {
    // A `.txt` paragraph legitimately starts at byte 0, so a defaulted 0 would be
    // indistinguishable from the real first paragraph — and would map every
    // `.note` page onto the top of a file that has none.
    const note = parseDocumentText(NOTE_LINES);
    expect(note.segments[0]!.o).toBeNull();
    expect(note.segments[0]!.l).toBeNull();
    const txt = parseDocumentText(txtRecord());
    expect(txt.segments[0]!.o).toBe(0);
    expect(txt.segments[0]!.l).toBe(utf8.encode(TXT_PARAS[0]!).length);
  });

  it("accepts a header with nothing under it — a document whose text is empty", () => {
    const doc = parseDocumentText('{"md5":"' + NOTE_MD5 + '","v":15,"n":4}');
    expect(doc.segments).toEqual([]);
    expect(doc.segmentCount).toBe(4);
  });

  it("REFUSES what it cannot read rather than defaulting it", () => {
    const header = '{"md5":"' + NOTE_MD5 + '","v":15,"n":2}';
    for (const body of [
      "", // no header at all
      '{"p":0,"t":"orphan"}', // a segment before its header
      header + "\nnot json",
      header + "\n" + header, // two documents in a single-document record
      '{"md5":"short","v":15,"n":1}',
      '{"md5":"' + NOTE_MD5 + '","n":1}', // no version
      '{"md5":"' + NOTE_MD5 + '","v":15}', // no address space
      header + '\n{"p":0}', // no text
      header + '\n{"p":0,"o":4,"t":"x"}', // half a byte range
      header + '\n{"p":0,"o":-1,"l":2,"t":"x"}',
    ]) {
      expect(() => parseDocumentText(body)).toThrow(SearchWireError);
    }
  });
});

describe("planMarks / countMarks", () => {
  // These name the words to MARK inside a segment the engine already matched.
  // They never decide membership — see `docSearch.ts`'s header — so a divergence
  // here costs a mark and never a result.
  it("folds the way the index folds", () => {
    expect(fold("Reunião")).toBe("reuniao");
    expect(fold("ÀÉÎÕÜ")).toBe("aeiou");
  });

  it("prefix-matches the last term, and only the last", () => {
    const plan = planMarks("orcamento reun");
    expect(plan.exact.has("orcamento")).toBe(true);
    expect(plan.prefix).toBe("reun");
    // `orcamento` is exact, so a longer word starting with it is not marked.
    expect(countMarks("orcamentos", plan).terms).toEqual([]);
    expect(countMarks("reunião", plan).terms).toEqual(["reuniao"]);
  });

  it("does not prefix-match when the query ends in whitespace", () => {
    // A trailing space is the user saying they finished the word — the rule
    // `sqlite_core.zig`'s `buildMatch` applies, mirrored so the two cannot drift.
    expect(planMarks("reun ").prefix).toBeNull();
    expect(countMarks("reunião", planMarks("reun ")).terms).toEqual([]);
  });

  it("keeps an expanded token's own form BESIDE the ladder's substitution", () => {
    // The fuzzy expression is `("caligrafa"* OR "caligrafia")`, not a
    // replacement, so both are marked.
    const plan = planMarks("caligrafa", [{ typed: "caligrafa", matched: "caligrafia" }]);
    expect(countMarks("caligrafia e caligrafado", plan).terms.sort()).toEqual([
      "caligrafado",
      "caligrafia",
    ]);
  });

  it("FLOORS the count at 1 for a segment the engine matched but it cannot name", () => {
    // The honesty rule as arithmetic. FTS5 said this segment matches; if this
    // pass names nothing in it — a ligature, a hyphenated break — reporting 0
    // would subtract the segment from the counter while the viewer still steps to
    // it, and a document that plainly contains the word would read "No matches".
    const { terms, matches } = countMarks("nothing here", planMarks("rutabaga"));
    expect(terms).toEqual([]);
    expect(matches).toBe(1);
  });

  it("counts every instance, and names each folded word once", () => {
    const { terms, matches } = countMarks("Reunião, reunião e REUNIÃO", planMarks("reuniao "));
    expect(terms).toEqual(["reuniao"]);
    expect(matches).toBe(3);
  });
});

describe("in-document search, on the real engine", () => {
  it("answers the right ordinals, in ORDINAL order, not bm25 order", async () => {
    const { search } = docs();
    const r = await search.search(NOTE_MD5, "reuniao");
    // Pages 3 and 11 mention it once, page 0 once — bm25 would rank the shortest
    // first, and the viewer needs document order so prev/next means "next".
    expect(ordinals(r)).toEqual([0, 3, 11]);
    expect(r.md5).toBe(NOTE_MD5);
    expect(r.query).toBe("reuniao");
  });

  it("finds an ACCENTED word from an unaccented query, because the fold is the index's", async () => {
    const { search } = docs();
    // The corpus is Portuguese and the household types without accents. The text
    // arrived unfolded; FTS5's `remove_diacritics 2` folded it on insert, and the
    // same tokenizer folds the query — which is the whole argument for putting
    // SQLite in the browser.
    expect(ordinals(await search.search(NOTE_MD5, "conclusao"))).toEqual([11]);
    expect(ordinals(await search.search(NOTE_MD5, "caligrafia"))).toEqual([3]);
  });

  it("ANDs the tokens: a multi-word query means the same segment", async () => {
    const { search } = docs();
    expect(ordinals(await search.search(NOTE_MD5, "reuniao orcamento"))).toEqual([0]);
    expect(ordinals(await search.search(NOTE_MD5, "reuniao caligrafia"))).toEqual([3]);
  });

  it("names the terms and the counts the viewer marks from", async () => {
    const { search } = docs();
    const r = await search.search(NOTE_MD5, "projeto");
    expect(r.segments.map((s) => [s.segment, s.matches, [...s.terms]])).toEqual([
      [0, 1, ["projeto"]],
      [11, 1, ["projeto"]],
    ]);
  });

  // THE REGRESSION STEP 6 OPENED, CLOSING. The server's in-document routes never
  // ran their fuzzy fallback and step 6 deleted the ladder outright; the wasm has
  // it, `idx_fuzzy` gates it to a query that matched NOTHING, and this is what
  // makes it reachable from a find bar again.
  it("A TYPO STILL FINDS THE WORD, and says what it searched instead", async () => {
    const { search } = docs();
    const exact = await search.search(NOTE_MD5, "caligrafia");
    expect(exact.usedFuzzy).toBe(false);
    expect(exact.expansions).toEqual([]);

    const typo = await search.search(NOTE_MD5, "caligrafai");
    expect(typo.usedFuzzy).toBe(true);
    expect(ordinals(typo)).toEqual([3]);
    expect(typo.expansions.map((e) => e.matched)).toContain("caligrafia");
    // And the mark points at the word the corpus actually spells, not the typo.
    expect(typo.segments[0]!.terms).toContain("caligrafia");
  });

  it("a query that matches needs no ladder, and reports no substitution", async () => {
    const { search } = docs();
    const r = await search.search(NOTE_MD5, "orcamento");
    expect(r.usedFuzzy).toBe(false);
    expect(ordinals(r)).toEqual([0]);
  });

  it("answers nothing — not an error — for a query that folds to no terms", async () => {
    const { search } = docs();
    const r = await search.search(NOTE_MD5, "!!! ???");
    expect(r.segments).toEqual([]);
    expect(r.usedFuzzy).toBe(false);
  });

  // §4.1 / §8.1: the built index is kept, so searching as you type costs the
  // query alone (1.3–11.5 ms) rather than a fetch plus a 39–363 ms build.
  it("fetches and builds ONCE per document, however many queries follow", async () => {
    const { search, calls } = docs();
    await search.search(NOTE_MD5, "reuniao");
    await search.search(NOTE_MD5, "orcamento");
    await search.search(NOTE_MD5, "projeto");
    expect(calls).toHaveLength(1);
  });

  it("coalesces a burst of keystrokes on a COLD document into one fetch", async () => {
    const { search, calls } = docs();
    await Promise.all([
      search.search(NOTE_MD5, "r"),
      search.search(NOTE_MD5, "re"),
      search.search(NOTE_MD5, "reu"),
    ]);
    expect(calls).toHaveLength(1);
  });

  // §8.1 refuted the teardown rule: `idx_open()` returns the closed database's
  // pages to SQLite's heap inside linear memory, so documents do not stack and
  // the next one is a `reset()` rather than a new instance. What must be true for
  // that to be safe is that the OLD document stops answering.
  it("reuses one instance across documents, and the previous one stops answering", async () => {
    const { search } = docs();
    expect(ordinals(await search.search(NOTE_MD5, "reuniao"))).toEqual([0, 3, 11]);
    // The `.txt` document has its own `reunião`s, at its own ordinals.
    expect(ordinals(await search.search(TXT_MD5, "reuniao"))).toEqual([0, 2]);
    // `conclusao` exists only in the `.note` — the reset really emptied the table.
    expect(ordinals(await search.search(TXT_MD5, "conclusao"))).toEqual([]);
    // …and going back rebuilds it.
    expect(ordinals(await search.search(NOTE_MD5, "conclusao"))).toEqual([11]);
  });

  it("sends the manifest's index_version as ?v=, and re-indexes when it moves", async () => {
    // `text/<md5>` is served immutable and its PATH carries only the md5, so a
    // re-derivation at a new `index_version` would otherwise be invisible to the
    // browser's cache AND to the index built from it.
    let version = 15;
    const { transport, calls } = transportFor({ [NOTE_MD5]: NOTE_LINES });
    const search = createDocSearch({ transport, load: loadCore, indexVersion: () => version });
    await search.search(NOTE_MD5, "reuniao");
    await search.search(NOTE_MD5, "orcamento");
    expect(calls).toEqual([{ md5: NOTE_MD5, version: 15 }]);

    version = 16;
    await search.search(NOTE_MD5, "reuniao");
    expect(calls).toEqual([
      { md5: NOTE_MD5, version: 15 },
      { md5: NOTE_MD5, version: 16 },
    ]);
  });

  it("sends no version when the manifest has none, rather than inventing one", async () => {
    const { transport, calls } = transportFor({ [NOTE_MD5]: NOTE_LINES });
    const search = createDocSearch({ transport, load: loadCore });
    await search.search(NOTE_MD5, "reuniao");
    expect(calls).toEqual([{ md5: NOTE_MD5, version: null }]);
  });

  // The route's 404 is byte-identical for "not derived", "not yours" and "no such
  // blob". It reaches the viewers as their `error` state, never as "No matches" —
  // which would be a confident false statement about a document that may well
  // contain the word.
  it("raises rather than answering empty for a document with no text record", async () => {
    const { search } = docs({ [NOTE_MD5]: NOTE_LINES });
    await expect(search.search("f".repeat(32), "reuniao")).rejects.toBeInstanceOf(DocumentTextUnavailable);
  });

  it("leaves nothing half-built when a load fails mid-session", async () => {
    // A failed rebuild resets the table (`SearchIndex.build` does), so the
    // previous document's ordinal map must go with it — otherwise the engine and
    // the map disagree and a hit resolves to somebody else's segment.
    const { search } = docs({ [NOTE_MD5]: NOTE_LINES });
    expect(ordinals(await search.search(NOTE_MD5, "reuniao"))).toEqual([0, 3, 11]);
    await expect(search.search(TXT_MD5, "reuniao")).rejects.toBeInstanceOf(DocumentTextUnavailable);
    // And the good document rebuilds cleanly afterwards.
    expect(ordinals(await search.search(NOTE_MD5, "reuniao"))).toEqual([0, 3, 11]);
  });

  it("drops a superseded search rather than letting it paint", async () => {
    const { search } = docs();
    const ac = new AbortController();
    const p = search.search(NOTE_MD5, "reuniao", ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("hands the instance back on drop, and rebuilds on the next find", async () => {
    const { search, calls } = docs();
    await search.search(NOTE_MD5, "reuniao");
    search.drop();
    expect(ordinals(await search.search(NOTE_MD5, "reuniao"))).toEqual([0, 3, 11]);
    expect(calls).toHaveLength(2);
  });
});

// §1.1's one thing that is NOT unified: highlight geometry stays per format.
// `.note` and `.pdf` are addressed by ordinal; `.txt` is addressed by a byte
// range in the raw blob, and `byteToCharMap` is the sole conversion from that to
// the UTF-16 index the viewer holds. This is that seam, end to end, on text
// whose byte and character counts differ.
describe("the `.txt` byte range, through byteToCharMap", () => {
  it("maps the engine's byte offsets onto the loaded string's characters", async () => {
    const { search } = docs();
    const r = await search.search(TXT_MD5, "reuniao");
    expect(ordinals(r)).toEqual([0, 2]);

    // The record's ranges are BYTES and the body has multi-byte characters, so
    // the two counts genuinely differ — which is what the map is for.
    const third = r.segments[1]!;
    expect(third.offset).toBe(utf8.encode(TXT_PARAS[0]! + "\n\n" + TXT_PARAS[1]! + "\n\n").length);
    expect(third.offset).toBeGreaterThan(TXT_PARAS[0]!.length + TXT_PARAS[1]!.length + 4);

    const located = r.segments.map((s) => ({
      segment: s.segment,
      offset: s.offset!,
      length: s.length!,
      matches: s.matches,
      terms: s.terms,
    }));
    const resolved = resolveFindSegments(TXT_BODY, located);
    // Every resolved range slices back EXACTLY the paragraph it addresses. That
    // is the property: a multi-byte character before a match must not slide the
    // highlight off the word.
    expect(TXT_BODY.slice(resolved[0]!.startChar, resolved[0]!.endChar)).toBe(TXT_PARAS[0]);
    expect(TXT_BODY.slice(resolved[1]!.startChar, resolved[1]!.endChar)).toBe(TXT_PARAS[2]);
    // …and the terms carried across are what the marks are drawn from.
    expect([...resolved[0]!.terms]).toEqual(["reuniao"]);
  });

  it("byteToCharMap is doing real work here, not agreeing by accident", () => {
    // The end of paragraph 1 is byte 16 and character 15 — one apart, because of
    // the `ã` in `amanhã`. A viewer that used the byte offset directly would cut
    // the highlight one character short on this very body.
    const bytes0 = utf8.encode(TXT_PARAS[0]!).length;
    expect(bytes0).not.toBe(TXT_PARAS[0]!.length);
    expect(byteToCharMap(TXT_BODY, [bytes0]).get(bytes0)).toBe(TXT_PARAS[0]!.length);
  });
});

// §1.1: "history and bin are not special: they are other md5s." A version
// preview and a trashed file reach the SAME `search` with a different md5 — no
// second route, no second response shape, and the typo ladder that a live
// document gets comes with them (the history and bin routes never had one).
describe("history and bin are just other md5s", () => {
  it("searches a retained version's own blob through the same call", async () => {
    const versionMd5 = "e".repeat(32);
    const versionLines = [
      '{"md5":"' + versionMd5 + '","v":15,"n":2}',
      '{"p":0,"t":"Uma versão antiga desta reunião"}',
    ].join("\n");
    const { search } = docs({ [NOTE_MD5]: NOTE_LINES, [versionMd5]: versionLines });

    // The live blob and the retained one answer differently, from one code path.
    expect(ordinals(await search.search(NOTE_MD5, "conclusao"))).toEqual([11]);
    expect(ordinals(await search.search(versionMd5, "conclusao"))).toEqual([]);
    expect(ordinals(await search.search(versionMd5, "antiga"))).toEqual([0]);

    // AND THE LADDER COMES WITH IT. The history and bin search routes returned
    // `usedFuzzy: false` by contract; a preview now gets the same typo tolerance
    // a live document gets, because it is the same engine.
    const typo = await search.search(versionMd5, "versai");
    expect(typo.usedFuzzy).toBe(true);
    expect(typo.expansions.map((e) => e.matched)).toContain("versao");
    expect(ordinals(typo)).toEqual([0]);
  });

  it("a trashed file's md5 is answered exactly as a live one is", async () => {
    // Trashing tombstones the row; the blob and its md5 are untouched, and the
    // text route authorizes on its own terms. There is nothing for a bin scope to
    // reroute — which is why `createBinScope` no longer wraps a search method.
    const { search, calls } = docs();
    const r = await search.search(NOTE_MD5, "reuniao");
    expect(ordinals(r)).toEqual([0, 3, 11]);
    expect(calls).toEqual([{ md5: NOTE_MD5, version: null }]);
  });
});

describe("httpTextTransport's URL", () => {
  it("puts the version in the query string and the md5 in the path", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      seen.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => NOTE_LINES,
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { httpTextTransport } = await import("../../src/search/docText");
      const t = httpTextTransport();
      const doc: DocumentText = await t(NOTE_MD5, 15);
      expect(doc.md5).toBe(NOTE_MD5);
      expect(seen[0]).toBe(`/api/controlplane/text/${NOTE_MD5}?v=15`);
      await t(NOTE_MD5, null);
      expect(seen[1]).toBe(`/api/controlplane/text/${NOTE_MD5}`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("turns a 404 into DocumentTextUnavailable, not an empty document", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response),
    );
    try {
      const { httpTextTransport } = await import("../../src/search/docText");
      await expect(httpTextTransport()(NOTE_MD5, 15)).rejects.toBeInstanceOf(DocumentTextUnavailable);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the offline text store", () => {
  // §4.4's other half: `.note` and `.mark`-annotated documents are PROMISED
  // offline, so their text is in IndexedDB rather than only in the HTTP cache.
  // What this asserts is the seam — which source answers, and when the stored one
  // is refused — not the store itself, which `textPrefetch.test.ts` owns.
  function heldStore(records: DocumentText[]): TextStore {
    const held = new Map(records.map((r) => [textKeyOf(r.md5, r.indexVersion), r]));
    return {
      available: true,
      async get(hash, version) {
        const rec = held.get(textKeyOf(hash, version));
        return rec ? { ...rec, storedAt: 1, protect: true } : null;
      },
      async keys() {
        return [...held.values()].map((r) => ({
          md5: r.md5,
          indexVersion: r.indexVersion,
          size: 1,
          protect: true,
          lastAccess: 1,
        }));
      },
      async put() {},
      async setProtection() {},
      async drop() {},
      async pins() {
        return [];
      },
      async pin() {},
      async unpin() {},
      async budget() {
        return 0;
      },
      async clear() {},
    };
  }

  it("prefers the stored copy over the network", async () => {
    const { transport, calls } = transportFor({ [NOTE_MD5]: NOTE_LINES });
    const search = createDocSearch({
      transport,
      load: loadCore,
      store: heldStore([parseDocumentText(NOTE_LINES)]),
      indexVersion: () => 15,
    });
    expect(ordinals(await search.search(NOTE_MD5, "reuniao"))).toEqual([0, 3, 11]);
    // Offline, this is the only reason there was an answer at all.
    expect(calls).toEqual([]);
  });

  it("does NOT answer from a generation the index version moved past", async () => {
    // The stored record is version 15 and the manifest now says 16: the same md5
    // re-derived into different text. A store keyed on the md5 alone would go on
    // answering out of the old parser's output with no symptom — so this MISSES
    // and the fetch that already works takes over.
    const { transport, calls } = transportFor({ [NOTE_MD5]: NOTE_LINES });
    const search = createDocSearch({
      transport,
      load: loadCore,
      store: heldStore([parseDocumentText(NOTE_LINES)]),
      indexVersion: () => 16,
    });
    expect(ordinals(await search.search(NOTE_MD5, "reuniao"))).toEqual([0, 3, 11]);
    expect(calls).toEqual([{ md5: NOTE_MD5, version: 16 }]);
  });

  it("never consults the store for a session with no version to key by", async () => {
    const { transport, calls } = transportFor({ [NOTE_MD5]: NOTE_LINES });
    const store = heldStore([parseDocumentText(NOTE_LINES)]);
    const search = createDocSearch({ transport, load: loadCore, store });
    expect(ordinals(await search.search(NOTE_MD5, "reuniao"))).toEqual([0, 3, 11]);
    expect(calls).toEqual([{ md5: NOTE_MD5, version: null }]);
  });

  it("degrades to the network where IndexedDB is missing", async () => {
    // No store injected, and node has no indexedDB — so this is the real
    // `openTextStore` answering "nothing held", and in-document search doing what
    // it has always done. §4.2's "index absent, rebuild" path, unchanged.
    const { transport, calls } = transportFor({ [NOTE_MD5]: NOTE_LINES });
    const search = createDocSearch({ transport, load: loadCore, indexVersion: () => 15 });
    expect(ordinals(await search.search(NOTE_MD5, "reuniao"))).toEqual([0, 3, 11]);
    expect(calls).toEqual([{ md5: NOTE_MD5, version: 15 }]);
  });
});
