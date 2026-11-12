// @vitest-environment happy-dom
// Names in the library's search follow the index's rule: the renderer over the
// real `sqlite-core.wasm`, holding the tree's names (`pages/nameRows.ts`).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { nameRows } from "../../src/pages/nameRows";
import { SearchIndex, type SearchCoreExports } from "../../src/search/indexEngine";
import type { SearchState } from "../../src/pages/noteSearch";
import type { Entry } from "../../src/core/types";
import { harness, listing, note, results } from "./gallerySearch.shared";

describe("names follow the index's rule", () => {
  const folder = (id: string, name: string): Entry => ({ kind: "folder", id, name }) as Entry;
  const idle: SearchState = results("x", []);
  // From the working directory: under happy-dom `import.meta.url` is not a file URL.
  const wasm = readFileSync(resolve("public/sqlite-core.wasm"));

  /** The renderer over the real index (`sqlite-core.wasm`), holding the tree's names. */
  async function indexed(tree: Entry[]) {
    const h = harness({ state: idle, pending: 0, tree });
    const index = await SearchIndex.open(async () => {
      const { instance } = await WebAssembly.instantiate(wasm, {});
      const core = instance.exports as unknown as SearchCoreExports;
      core._initialize?.();
      return core;
    });
    index.build([]);
    index.setItems("name", nameRows({ values: () => [listing(tree)] }, (f) => f.name));
    return {
      ...h,
      paint(q: string) {
        const r = index.query(q, 1000, true);
        h.setState(results(q, [], r.expansions, r.items.map((i) => i.key)));
        return h.paint(q);
      },
    };
  }

  it("ignores accents and case, and takes the words in any order", async () => {
    const h = await indexed([note("1", "Reunião de pais"), note("2", "Haus of gabin"), note("3", "Ideias")]);
    h.paint("reuniao");
    expect(h.rows()).toEqual(["Reunião de pais"]);
    h.paint("gabin haus");
    expect(h.rows()).toEqual(["Haus of gabin"]);
  });

  it("the last word may be the start of one; the others are whole words", async () => {
    const h = await indexed([note("1", "Haus of gabin")]);
    h.paint("haus gab");
    expect(h.rows()).toEqual(["Haus of gabin"]);
    h.paint("hau gabin");
    expect(h.rows()).toEqual([]);
  });

  it("falls back to the text inside a name only when no name matched by words", async () => {
    const h = await indexed([note("1", "MyStyle"), note("2", "Style guide")]);
    // "style" is a word of "Style guide": the word rule answers, alone.
    h.paint("style");
    expect(h.rows()).toEqual(["Style guide"]);
    // No name has the word "tyle": then anywhere inside a name.
    h.paint("tyle");
    expect(h.rows()).toEqual(["MyStyle", "Style guide"]);
  });

  it("finds folders by name, in their own group before the notes", async () => {
    const h = await indexed([folder("f1", "Aulas de Francês"), note("1", "Francês 3")]);
    const g = h.paint("frances");
    expect(h.folderRows()).toEqual(["Aulas de Francês"]);
    expect(h.rows()).toEqual(["Francês 3"]);
    expect(g.querySelector(".section-head")?.textContent).toBe("1 folder");
    // The folders' heading, then their list.
    expect(g.querySelector(".section-head + ul.cards > .card--folder")?.textContent).toBe("Aulas de Francês");
  });

  it("says the typo ladder's spelling once, over a name or folder it found", async () => {
    const h = await indexed([folder("f1", "Projects"), note("1", "Receitas")]);
    h.paint("Projcts");
    expect(h.folderRows()).toEqual(["Projects"]);
    expect(h.notices()).toEqual(["Matched projects instead of “Projcts”."]);
  });

  it("a folder alone is an answer, not 'no matches'", async () => {
    const h = await indexed([folder("f1", "Receitas")]);
    h.paint("receitas");
    expect(h.folderRows()).toEqual(["Receitas"]);
    expect(h.gallery.querySelector(".empty")).toBeNull();
  });
});
