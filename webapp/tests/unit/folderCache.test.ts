import { describe, it, expect, vi } from "vitest";
import { createFolderCache, type FolderCacheDeps } from "../../src/pages/folderCache";
import type { Entry, Folder, Id, Listing } from "../../src/core/types";

// These are the tests the extraction was FOR. The guards below — one walk at a
// time, coalesced, generation-checked — are race guards, and while they lived in
// `library.ts` the only way to reach them was through the shell, where a real
// race is not something a test can stage. Here `listFolder` is a promise the test
// holds the resolver for, so "a slower earlier walk finishes last" is three lines
// rather than a timing hope.

const folder = (id: string, name: string, itemCount = 0): Folder => ({
  kind: "folder",
  id: id as Id,
  name,
  itemCount,
  updatedAt: 0,
});

const listing = (folderId: string | null, entries: Entry[] = []): Listing => ({
  folderId: folderId as Id | null,
  path: [],
  entries,
  syncVersion: 1,
});

/**
 * A tree served folder-by-folder, with every response deferred until the test
 * releases it. `release(id)` answers exactly one pending call.
 */
function server(tree: Record<string, Entry[]>) {
  const pending = new Map<string, () => void>();
  const calls: (Id | null)[] = [];
  const listFolder = vi.fn((id: Id | null): Promise<Listing> => {
    calls.push(id);
    const k = id ?? "root";
    return new Promise<Listing>((resolve, reject) => {
      pending.set(k, () => resolve(listing(id, tree[k] ?? [])));
      pending.set(`${k}!reject`, () => reject(new Error(`boom ${k}`)));
    });
  });
  return {
    listFolder,
    calls,
    /** Answer one outstanding request. Awaits a microtask so the walk advances. */
    async release(id: string): Promise<void> {
      pending.get(id)?.();
      pending.delete(id);
      await Promise.resolve();
      await Promise.resolve();
    },
    async fail(id: string): Promise<void> {
      pending.get(`${id}!reject`)?.();
      pending.delete(id);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function make(tree: Record<string, Entry[]>, over: Partial<FolderCacheDeps> = {}) {
  const api = server(tree);
  const walked: boolean[] = [];
  const cache = createFolderCache({
    api: { listFolder: api.listFolder },
    handled: () => false,
    onWalked: (changed) => walked.push(changed),
    ...over,
  });
  return { cache, api, walked };
}

describe("folder cache: the walk", () => {
  it("BFSes the whole tree and caches every folder it reaches", async () => {
    const { cache, api } = make({
      root: [folder("a", "A"), folder("b", "B")],
      a: [folder("a1", "A1")],
      b: [],
      a1: [],
    });

    const done = cache.prefetch();
    for (const k of ["root", "a", "b", "a1"]) await api.release(k);
    await done;

    expect(cache.get(null)?.entries).toHaveLength(2);
    expect(cache.get("a1" as Id)).toBeDefined();
    expect(cache.tree.walked("a1" as Id)).toBe(true);
  });

  it("derives the rail's roots from the root listing, and only from it", async () => {
    const { cache, api } = make({
      root: [folder("a", "A"), { kind: "note", id: "n" as Id, name: "N", updatedAt: 5 } as Entry],
      a: [folder("a1", "A1")],
      a1: [],
    });

    const done = cache.prefetch();
    for (const k of ["root", "a", "a1"]) await api.release(k);
    await done;

    // Folders only, and the SUBfolder does not leak into the roots.
    expect(cache.tree.roots().map((f) => f.id)).toEqual(["a"]);
    expect(cache.tree.children("a" as Id).map((f) => f.id)).toEqual(["a1"]);
  });

  it("walks one at a time: a second caller joins the walk already running", async () => {
    const { cache, api } = make({ root: [folder("a", "A")], a: [] });

    const first = cache.prefetch();
    const second = cache.prefetch();
    expect(second).toBe(first); // the same promise, not a second walk

    for (const k of ["root", "a"]) await api.release(k);
    await first;

    expect(api.calls).toEqual([null, "a"]); // each folder asked about ONCE
  });

  it("coalesces a burst of forced walks into exactly one follow-up", async () => {
    const { cache, api } = make({ root: [], a: [] });

    const first = cache.prefetch();
    // Ten bumps land while the first walk is in flight.
    for (let i = 0; i < 10; i++) void cache.prefetch(true);
    await api.release("root");
    await first;
    await Promise.resolve();

    // One follow-up, not ten: the root is asked about twice in total.
    await api.release("root");
    expect(api.calls.filter((id) => id === null)).toHaveLength(2);
  });

  // No test for the generation guard: it is unreachable while `prefetch` is the
  // only door into the walk — see the comment on `generation`. A test staged
  // against it passes with the guard deleted, which is worse than no test.

  it("reports changed on the first walk that reached NOTHING", async () => {
    // The narrow case the null-vs-"" start guards, and the only one: an empty
    // household still signs as "\0root", so a signature is empty only when the
    // walk cached nothing — here, a root listing that failed non-fatally. It must
    // still repaint, because the rail's loaded flag flips with it.
    const { cache, api, walked } = make({});
    const done = cache.prefetch();
    await api.fail("root");
    await done;
    expect(walked).toEqual([true]);
  });

  it("reports changed on the first walk over an empty tree, then unchanged", async () => {
    const { cache, api, walked } = make({ root: [] });

    const first = cache.prefetch();
    await api.release("root");
    await first;
    expect(walked).toEqual([true]);

    const second = cache.prefetch(true);
    await api.release("root");
    await second;
    expect(walked).toEqual([true, false]);
  });

  it("reports changed when a folder is renamed, or its count moves", async () => {
    const api = server({ root: [folder("a", "A", 1)] });
    let entries: Entry[] = [folder("a", "A", 1)];
    const walked: boolean[] = [];
    const cache = createFolderCache({
      api: { listFolder: (id) => Promise.resolve(listing(id, id === null ? entries : [])) },
      handled: () => false,
      onWalked: (c) => walked.push(c),
    });
    void api; // the deferred server is not needed here

    await cache.prefetch();
    entries = [folder("a", "A renamed", 1)];
    await cache.prefetch(true);
    entries = [folder("a", "A renamed", 2)];
    await cache.prefetch(true);

    expect(walked).toEqual([true, true, true]);
  });

  it("stops the whole walk when the session expired, and keeps going otherwise", async () => {
    const expired = make({ root: [folder("a", "A")], a: [] }, { handled: () => true });
    const done = expired.cache.prefetch();
    await expired.api.fail("root");
    await done;
    // It did not go on to ask about `a`, and told nobody the walk landed.
    expect(expired.api.calls).toEqual([null]);
    expect(expired.walked).toEqual([]);

    const other = make({ root: [folder("a", "A"), folder("b", "B")], a: [], b: [] });
    const run = other.cache.prefetch();
    await other.api.release("root");
    await other.api.fail("a"); // one bad folder is skipped, not fatal
    await other.api.release("b");
    await run;
    expect(other.cache.tree.walked("b" as Id)).toBe(true);
    expect(other.walked).toEqual([true]);
  });
});

describe("folder cache: put", () => {
  it("keeps the roots in step with the listing it stores", async () => {
    // The pairing that used to be written out at two call sites, one of which
    // could be updated without the other.
    const { cache } = make({});
    cache.put(null, listing(null, [folder("a", "A")]));
    expect(cache.tree.roots().map((f) => f.id)).toEqual(["a"]);

    cache.put(null, listing(null, [folder("b", "B")]));
    expect(cache.tree.roots().map((f) => f.id)).toEqual(["b"]);
    expect(cache.get(null)?.entries.map((e) => e.id)).toEqual(["b"]);
  });

  it("a non-root put leaves the roots alone", async () => {
    const { cache } = make({});
    cache.put(null, listing(null, [folder("a", "A")]));
    cache.put("a" as Id, listing("a", [folder("a1", "A1")]));
    expect(cache.tree.roots().map((f) => f.id)).toEqual(["a"]);
  });

  it("values() exposes every cached listing, for the scans that know no id", async () => {
    const { cache } = make({});
    cache.put(null, listing(null, [folder("a", "A")]));
    cache.put("a" as Id, listing("a"));
    expect([...cache.values()]).toHaveLength(2);
  });
});
