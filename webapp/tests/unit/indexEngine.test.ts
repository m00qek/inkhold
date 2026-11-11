import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SearchIndex, SearchIndexError, type CoreLoader, type SearchCoreExports, type TermsDocument } from "../../src/search/indexEngine";
import { fields } from "../../src/search/itemRows";

// Against the real `public/sqlite-core.wasm` (built by the `pretest` hook): the
// tokenizer is what is under test. It imports nothing, so Node can instantiate it.
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

/** Three documents of folded terms; ordinals sparse and out of order on purpose. */
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
const NO_ITEMS = { name: 0, todo: 0, digest: 0 };

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
      expect(index.query("orcamento projeto ", 10).hits).toEqual([{ md5: NOTES.md5, page: 0 }]);
      expect(index.query("orcamento caligrafia ", 10).total).toBe(0);
    } finally {
      index.close();
    }
  });

  it("reports the exact total whatever `limit` returns", async () => {
    const index = await built();
    try {
      const r = index.query("reuniao ", 1);
      expect(r.total).toBe(2);
      expect(r.hits).toHaveLength(1);
      expect(index.query("reuniao ", 0)).toEqual({ total: 2, hits: [], items: [], itemTotals: NO_ITEMS, expansions: [] });
    } finally {
      index.close();
    }
  });

  it("prefix-matches the last word until a space finishes it", async () => {
    const index = await built();
    try {
      expect(index.query("cali", 10).total).toBe(2);
      expect(index.query("cali ", 10).total).toBe(0);
      expect(index.query("caligrafia ", 10).total).toBe(2);
    } finally {
      index.close();
    }
  });
});

describe("SearchIndex folding parity", () => {
  // The query is folded by the same C as the server's corpus; a JS fold would drift.
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
  // Each was a plausible FTS5 syntax error on a keystroke; none may throw.
  it("returns zero results, never an error, for punctuation", async () => {
    const index = await built();
    try {
      for (const junk of ["", "   ", "-", '"', '""', "...", "( )", "*", "^", "-- ", "()"]) {
        expect({ junk, ...index.query(junk, 10) }).toEqual({ junk, total: 0, hits: [], items: [], itemTotals: NO_ITEMS, expansions: [] });
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

describe("SearchIndex lifecycle and refusals", () => {
  it("empties on reset and keeps answering", async () => {
    const index = await built();
    try {
      index.reset();
      expect(index.documentCount).toBe(0);
      expect(index.pageCount).toBe(0);
      expect(index.query("caligrafia ", 10)).toEqual({ total: 0, hits: [], items: [], itemTotals: NO_ITEMS, expansions: [] });
      index.build([BOOK]);
      expect(index.query("caligrafia ", 10).total).toBe(1);
    } finally {
      index.close();
    }
  });

  it("rebuilds onto the same instance, whether or not anything was there", async () => {
    const index = await SearchIndex.open(loadCore);
    try {
      index.rebuild([NOTES]);
      expect(index.documents()).toEqual([NOTES.md5]);
      // Held: the previous document goes, or the same md5 twice would be refused.
      index.rebuild([BOOK]);
      expect(index.documents()).toEqual([BOOK.md5]);
      expect(index.query("reuniao ", 10).total).toBe(0);
      expect(index.query("caligrafia ", 10).total).toBe(1);
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
      // A failed build resets rather than committing a partial index.
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
    expect(() => index.setItems("todo", [])).toThrow(/closed/);
    index.close();
  });

  it("reports a wasm-side refusal as SearchIndexError with the module's message", async () => {
    const index = await SearchIndex.open(loadCore);
    try {
      index.addPage(1, "reuniao");
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
  // Not a benchmark: big enough that a detached view after `memory.grow` shows up.
  it("builds thousands of rows and maps every one of them back", async () => {
    const docs: TermsDocument[] = [];
    for (let d = 0; d < 40; d++) {
      const pages = [];
      for (let p = 0; p < 100; p++) {
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
      expect(index.query("pagina39x99 ", 10).hits).toEqual([
        { md5: "39".padStart(32, "0"), page: 297 },
      ]);
    } finally {
      index.close();
    }
  });
});

describe("SearchIndex item rows", () => {
  const keys = (r: { items: { kind: string; key: string }[] }): string[] => r.items.map((i) => `${i.kind}:${i.key}`).sort();

  it("answers pages and items in one query, each with its own total", async () => {
    const index = await built();
    try {
      index.setItems("todo", [
        { key: "t1", text: "Rever o orçamento" },
        { key: "t2", text: "Comprar pão" },
      ]);
      index.setItems("digest", [{ key: "d1", text: "O orçamento anual\nUm comentário" }]);
      const r = index.query("orcamento ", 10);
      expect(r.total).toBe(2);
      expect(places(r)).toEqual(["a0", "c7"]);
      expect(keys(r)).toEqual(["digest:d1", "todo:t1"]);
      expect(r.itemTotals).toEqual({ name: 0, todo: 1, digest: 1 });
    } finally {
      index.close();
    }
  });

  it("rewrites only what changed, so a saved item is found at once", async () => {
    const index = await built();
    try {
      index.setItems("todo", [{ key: "t1", text: "Comprar pão" }]);
      expect(keys(index.query("pao ", 10))).toEqual(["todo:t1"]);
      index.setItems("todo", [{ key: "t1", text: "Comprar leite" }]);
      expect(keys(index.query("pao ", 10))).toEqual([]);
      expect(keys(index.query("leite ", 10))).toEqual(["todo:t1"]);
      index.setItems("todo", []);
      expect(index.query("leite ", 10).itemTotals.todo).toBe(0);
    } finally {
      index.close();
    }
  });

  it("keeps the item rows across a rebuild, and writes ones set before the first build", async () => {
    const index = await SearchIndex.open(loadCore);
    try {
      index.setItems("name", [{ key: "f1", text: "Caligrafia" }]);
      index.build(LIBRARY);
      expect(index.query("caligrafia ", 10).itemTotals.name).toBe(1);
      index.rebuild([BOOK]);
      const r = index.query("caligrafia ", 10);
      expect(places(r)).toEqual(["b0"]);
      expect(keys(r)).toEqual(["name:f1"]);
    } finally {
      index.close();
    }
  });

  it("holds a quoted phrase within one field of an item; its words may come from any", async () => {
    const index = await built();
    try {
      index.setItems("todo", [{ key: "t1", text: fields("Comprar leite", "Casa") }]);
      expect(keys(index.query('"leite casa" ', 10))).toEqual([]);
      expect(keys(index.query("leite casa ", 10))).toEqual(["todo:t1"]);
    } finally {
      index.close();
    }
  });

  it("holds a quoted phrase to its order in an item, not on a page of words", async () => {
    const index = await built();
    try {
      index.setItems("todo", [
        { key: "in-order", text: "notas sobre o projeto" },
        { key: "apart", text: "sobre as notas" },
      ]);
      const r = index.query('"notas sobre" ', 10);
      expect(places(r)).toEqual(["b1"]);
      expect(keys(r)).toEqual(["todo:in-order"]);
    } finally {
      index.close();
    }
  });

  it("corrects a typo over the items' words too", async () => {
    const index = await built();
    try {
      index.setItems("todo", [{ key: "t1", text: "Ligar para a farmácia" }]);
      const r = index.query("farmacai ", 10, true);
      expect(keys(r)).toEqual(["todo:t1"]);
      expect(r.expansions).toEqual([{ typed: "farmacai", matched: "farmacia" }]);
    } finally {
      index.close();
    }
  });

});
