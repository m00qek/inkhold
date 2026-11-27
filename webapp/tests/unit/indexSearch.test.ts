// The library-wide search over the browser's index (`search/indexSearch.ts`):
// the build, the join with the live set, the item rows, and recovery.

import { describe, expect, it } from "vitest";
import { createIndexSearch } from "../../src/search/indexSearch";
import { fakeCore, fakeSync, spyLoader, row, manifest, ALFA, BRAVO, CHARLIE, DOCS, LIVE } from "./searchService.shared";

describe("createIndexSearch", () => {
  it("does not instantiate the engine until the first query", async () => {
    const { load, loads } = spyLoader();
    const { sync } = fakeSync();
    const local = createIndexSearch({ sync, load });

    // Nothing here may allocate the 16.13 MB engine.
    expect(loads()).toBe(0);
    await local.sync();
    expect(loads()).toBe(0);

    await local.search("reuniao");
    expect(loads()).toBe(1);
  });

  it("builds once and reuses the instance across searches", async () => {
    const { load, loads } = spyLoader();
    const { sync } = fakeSync();
    const local = createIndexSearch({ sync, load });
    await local.sync();

    await local.search("reuniao");
    await local.search("orcamento");
    expect(loads()).toBe(1);
  });

  it("finds item rows set before the engine exists, and their replacements at once", async () => {
    const { load, loads } = spyLoader();
    const { sync } = fakeSync();
    const local = createIndexSearch({ sync, load });
    await local.sync();
    local.setItems("todo", [{ key: "t1", text: "comprar reuniao" }]);

    const first = await local.search("comprar");
    expect(first.items).toEqual({ name: [], todo: ["t1"], digest: [] });
    expect(first.documents).toEqual([]);

    local.setItems("todo", [{ key: "t2", text: "vender reuniao" }]);
    expect((await local.search("comprar")).items.todo).toEqual([]);
    expect((await local.search("vender")).items.todo).toEqual(["t2"]);
    expect(loads()).toBe(1);
  });

  it("keeps an item change that lands while the first build is still running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { sync } = fakeSync();
    const local = createIndexSearch({ sync, load: async () => (await gate, fakeCore()) });
    await local.sync();
    local.setItems("todo", [{ key: "t1", text: "old title" }]);
    const first = local.search("old");
    await new Promise((r) => setTimeout(r, 0));
    local.setItems("todo", [{ key: "t1", text: "new title" }]);
    release();
    await first;
    expect((await local.search("new")).items.todo).toEqual(["t1"]);
    expect((await local.search("old")).items.todo).toEqual([]);
  });

  it("a drop during the first build publishes nothing: the next search starts afresh", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let loads = 0;
    const { sync } = fakeSync();
    const local = createIndexSearch({ sync, load: async () => (loads++, await gate, fakeCore()) });
    await local.sync();
    local.setItems("todo", [{ key: "t1", text: "ana reuniao" }]);
    const first = local.search("ana");
    await new Promise((r) => setTimeout(r, 0));
    local.drop();
    release();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect((await local.search("ana")).items.todo).toEqual(["t1"]);
    expect(loads).toBe(2);
  });

  it("a failed item write starts the engine over at the next search, rows and all", async () => {
    const { sync } = fakeSync();
    let failWrites = false;
    let loads = 0;
    const local = createIndexSearch({
      sync,
      load: async () => {
        loads++;
        const core = fakeCore();
        const add = core.idx_add;
        core.idx_add = (rowid, ptr, len) => (failWrites && rowid >= 2 ** 28 ? -1 : add(rowid, ptr, len));
        return core;
      },
    });
    await local.sync();
    await local.search("reuniao");
    failWrites = true;
    local.setItems("todo", [{ key: "t1", text: "ana" }]);
    await new Promise((r) => setTimeout(r, 0));
    failWrites = false;
    expect((await local.search("ana")).items.todo).toEqual(["t1"]);
    expect(loads).toBe(2);
  });

  it("a failed query starts the engine over at the next search", async () => {
    const { sync } = fakeSync();
    let loads = 0;
    let broken = false;
    const local = createIndexSearch({
      sync,
      load: async () => {
        loads++;
        const core = fakeCore();
        const run = core.idx_fuzzy;
        core.idx_fuzzy = (ptr, len, limit) => (broken ? -11 : run(ptr, len, limit));
        return core;
      },
    });
    await local.sync();
    local.setItems("todo", [{ key: "t1", text: "ana" }]);
    await local.search("ana");
    broken = true;
    await expect(local.search("ana")).rejects.toThrow();
    broken = false;
    expect((await local.search("ana")).items.todo).toEqual(["t1"]);
    expect(loads).toBe(2);
  });

  it("writes the items again into an engine made after a drop", async () => {
    const { load } = spyLoader();
    const { sync } = fakeSync();
    const local = createIndexSearch({ sync, load });
    await local.sync();
    local.setItems("digest", [{ key: "d1", text: "baleia branca" }]);
    await local.search("baleia");
    local.drop();
    expect((await local.search("baleia")).items.digest).toEqual(["d1"]);
  });

  it("groups pages by document, joins the manifest, and ranks by how much of each matched", async () => {
    const { load } = spyLoader();
    const { sync } = fakeSync();
    const local = createIndexSearch({ sync, load });
    await local.sync();

    const results = await local.search("reuniao");
    expect(results.query).toBe("reuniao");
    expect(results.totalPages).toBe(6);
    // 2 of 5 pages, then 1 of 2, then 3 of 12: density, not the count of pages.
    expect(results.documents.map((d) => d.md5)).toEqual([CHARLIE, BRAVO, ALFA]);
    // Ascending: the row deep-links to the first matching page in the document.
    expect(results.documents[2]).toEqual({ md5: ALFA, fileId: 10, pages: [0, 4, 11], updatedAt: 1000, tier: "note", pageCount: 12 });
    expect(results.documents[1]).toEqual({ md5: BRAVO, fileId: 20, pages: [1], updatedAt: 5000, tier: "note", pageCount: 2 });
  });

  it("breaks a tie on match count by recency", async () => {
    const { load } = spyLoader();
    const docs: StoredTermsDocument[] = [
      { md5: BRAVO, indexVersion: 3, pageCount: 1, pages: [{ p: 0, t: "acta" }], storedAt: 1 },
      { md5: CHARLIE, indexVersion: 3, pageCount: 1, pages: [{ p: 0, t: "acta" }], storedAt: 1 },
    ];
    const { sync } = fakeSync({ docs });
    const local = createIndexSearch({ sync, load });
    await local.sync();

    const results = await local.search("acta");
    expect(results.documents.map((d) => d.md5)).toEqual([CHARLIE, BRAVO]);
  });

  it("never returns a document the manifest has stopped naming", async () => {
    const { load } = spyLoader();
    const { sync, state } = fakeSync();
    const local = createIndexSearch({ sync, load });
    await local.sync();
    expect((await local.search("reuniao")).documents.map((d) => d.md5)).toContain(CHARLIE);

    // Trashed: its rows stay in the index (clean-up rides blob GC), but must not return.
    state.rows = LIVE.filter((r) => r.md5 !== CHARLIE);
    state.received = 0;
    await local.sync();

    const results = await local.search("reuniao");
    expect(results.documents.map((d) => d.md5)).toEqual([BRAVO, ALFA]);
    expect(results.totalPages).toBe(4);
  });

  it("rebuilds when a sync brought rows, and not when it only dropped some", async () => {
    const { load, loads } = spyLoader();
    const { sync, state } = fakeSync();
    const local = createIndexSearch({ sync, load });
    await local.sync();
    expect((await local.search("reuniao")).documents).toHaveLength(3);

    state.received = 0;
    await local.sync();
    await local.search("reuniao");

    // On the same instance (`reset`), so the loader is still called once.
    const delta = "d".repeat(32);
    state.docs = [
      ...DOCS,
      { md5: delta, indexVersion: 1, pageCount: 1, pages: [{ p: 0, t: "reuniao" }], storedAt: 1 },
    ];
    state.rows = [...LIVE, row(delta, 40, 200)];
    state.received = 1;
    await local.sync();

    expect((await local.search("reuniao")).documents).toHaveLength(4);
    expect(loads()).toBe(1);
  });

  it("says how many documents the budget left out, and takes a let-go document out of the index", async () => {
    const { load } = spyLoader();
    const { sync, state } = fakeSync();
    const local = createIndexSearch({ sync, load });
    await local.sync();
    const first = await local.search("reuniao");
    expect(first.documents).toHaveLength(3);
    expect(first).not.toHaveProperty("leftOut");

    // CHARLIE let go for room: still live, so only a rebuild takes its matches away.
    state.docs = DOCS.filter((d) => d.md5 !== CHARLIE);
    state.received = 0;
    state.letGo = 1;
    state.leftOut = [33];
    await local.sync();
    const after = await local.search("reuniao");
    expect(after.documents.map((d) => d.md5)).not.toContain(CHARLIE);
    expect(after.leftOut).toEqual([33]);
  });

  it("answers a session that never synced, from the cached listing alone", async () => {
    const { load } = spyLoader();
    const { sync } = fakeSync();
    const listing = () => [
      { md5: ALFA, fileId: 10, updatedAt: 1000 },
      { md5: BRAVO, fileId: 20, updatedAt: 5000 },
    ];
    const local = createIndexSearch({ sync, load, listing });

    const results = await local.search("reuniao");
    expect(results.documents.map((d) => d.md5)).toEqual([BRAVO, ALFA]);
    // Offline: no manifest, so no tier; nothing is penalised for it.
    expect(results.documents.every((d) => d.tier === null)).toBe(true);
    expect(results.totalPages).toBe(4);
  });

  it("raises when there is neither a manifest nor a listing to intersect with", async () => {
    const { load } = spyLoader();
    const local = createIndexSearch({ sync: fakeSync().sync, load });
    await expect(local.search("reuniao")).rejects.toThrow();
  });

  it("raises rather than answering when the search was superseded mid-build", async () => {
    const { load } = spyLoader();
    const { sync } = fakeSync();
    const local = createIndexSearch({ sync, load });
    await local.sync();

    const controller = new AbortController();
    const pending = local.search("reuniao", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

// The scope (`searchScope.ts`): a kind left out matches nothing at once,
// before the sync that lets its terms go, and is never said to be left out.
describe("createIndexSearch with a scope", () => {
  const tiered = (tier: "note" | "marked" | "other") => (r: ReturnType<typeof row>) => ({ ...r, tier });

  it("with documents off, drops documents and annotated documents from the answer and keeps the notebooks", async () => {
    let scope = { documents: false };
    const rows = [row(ALFA, 10, 1000), tiered("marked")(row(BRAVO, 20, 5000)), tiered("other")(row(CHARLIE, 30, 9000))];
    const { sync } = fakeSync({ rows });
    const local = createIndexSearch({ sync, load: spyLoader().load, scope: () => scope });
    await local.sync();
    expect((await local.search("reuniao")).documents.map((d) => d.md5)).toEqual([ALFA]);

    // On again: the same index answers in full, before any sync.
    scope = { documents: true };
    expect((await local.search("reuniao")).documents.map((d) => d.md5).sort()).toEqual([ALFA, BRAVO, CHARLIE].sort());
  });

  it("offline, before any sync, drops the documents the listing says aren't notebooks", async () => {
    const { sync } = fakeSync();
    const listing = () => [
      { md5: ALFA, fileId: 10, updatedAt: 1000, notebook: true },
      { md5: BRAVO, fileId: 20, updatedAt: 5000, notebook: false },
      { md5: CHARLIE, fileId: 30, updatedAt: 9000 },
    ];
    const local = createIndexSearch({ sync, load: spyLoader().load, listing, scope: () => ({ documents: false }) });
    // Never synced: the listing stands in for the manifest; one it can't tell is searched.
    expect((await local.search("reuniao")).documents.map((d) => d.md5).sort()).toEqual([ALFA, CHARLIE].sort());
  });

  it("rebuilds from the store when the scope changes, even when no sync reported letting go", async () => {
    let scope = { documents: true };
    const rows = [row(ALFA, 10, 1000), row(BRAVO, 20, 5000), tiered("other")(row(CHARLIE, 30, 9000))];
    const { sync, state } = fakeSync({ rows });
    const local = createIndexSearch({ sync, load: spyLoader().load, scope: () => scope });
    await local.sync();
    expect((await local.search("reuniao")).documents.map((d) => d.md5)).toContain(CHARLIE);

    // Switched off, the sync dropped CHARLIE's terms and then tore: it reported nothing.
    state.docs = DOCS.filter((d) => d.md5 !== CHARLIE);
    scope = { documents: false };
    await local.search("reuniao");
    // Back on before any sync: the store has no CHARLIE, so neither may the answer.
    scope = { documents: true };
    expect((await local.search("reuniao")).documents.map((d) => d.md5)).not.toContain(CHARLIE);
  });

  it("never says a document the scope leaves out was left out by the budget", async () => {
    let scope = { documents: true };
    const rows = [row(ALFA, 10, 1000), row(BRAVO, 20, 5000), tiered("other")(row(CHARLIE, 30, 9000))];
    const { sync, state } = fakeSync({ rows });
    state.leftOut = [30, 20];
    const local = createIndexSearch({ sync, load: spyLoader().load, scope: () => scope });
    await local.sync();
    expect((await local.search("reuniao")).leftOut).toEqual([30, 20]);

    // Switched off, before the next sync: the last one's list still names it.
    scope = { documents: false };
    expect((await local.search("reuniao")).leftOut).toEqual([20]);
  });
});
