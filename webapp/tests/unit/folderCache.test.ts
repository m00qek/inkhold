import { describe, it, expect, vi } from "vitest";
import { createFolderCache, type FolderCacheDeps } from "../../src/pages/folderCache";
import type { Entry, Folder, Id, Listing } from "../../src/core/types";

// `listFolder` resolves only when the test says so, so races are staged, not timed.

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

/** A tree served folder by folder; `release(id)` answers one pending call. */
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

    expect(cache.tree.roots().map((f) => f.id)).toEqual(["a"]);
    expect(cache.tree.children("a" as Id).map((f) => f.id)).toEqual(["a1"]);
  });

  it("walks one at a time: a second caller joins the walk already running", async () => {
    const { cache, api } = make({ root: [folder("a", "A")], a: [] });

    const first = cache.prefetch();
    const second = cache.prefetch();
    expect(second).toBe(first);

    for (const k of ["root", "a"]) await api.release(k);
    await first;

    expect(api.calls).toEqual([null, "a"]);
  });

  it("joins a concurrent listing of the same folder into ONE request", async () => {
    // Regression: on cold boot at `#/` the walk and the route listed the root twice.
    const { cache, api } = make({ root: [folder("a", "A")], a: [] });

    const walk = cache.prefetch();
    const route = cache.listFolder(null);

    await api.release("root");
    const listed = await route;
    expect(listed.folderId).toBe(null);

    for (const k of ["a"]) await api.release(k);
    await walk;

    expect(api.calls).toEqual([null, "a"]);
  });

  it("does not hand a FAILED listing to the next caller", async () => {
    // A failed request must not stay joined, or one outage becomes permanent.
    const { cache, api } = make({ root: [] });

    const first = cache.listFolder(null);
    await api.fail("root");
    await expect(first).rejects.toThrow("boom root");

    const second = cache.listFolder(null);
    expect(api.calls).toEqual([null, null]);
    await api.release("root");
    expect((await second).folderId).toBe(null);
  });

  it("coalesces a burst of forced walks into exactly one follow-up", async () => {
    const { cache, api } = make({ root: [], a: [] });

    const first = cache.prefetch();
    for (let i = 0; i < 10; i++) void cache.prefetch(true);
    await api.release("root");
    await first;
    await Promise.resolve();

    await api.release("root");
    expect(api.calls.filter((id) => id === null)).toHaveLength(2);
  });

  // No generation-guard test: it is unreachable while `prefetch` is the only entry.

  it("reports changed on the first walk that reached NOTHING", async () => {
    // An empty household still signs as "\0root", so an empty signature means nothing cached.
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
    void api;

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
    expect(expired.api.calls).toEqual([null]);
    expect(expired.walked).toEqual([]);

    const other = make({ root: [folder("a", "A"), folder("b", "B")], a: [], b: [] });
    const run = other.cache.prefetch();
    await other.api.release("root");
    await other.api.fail("a");
    await other.api.release("b");
    await run;
    expect(other.cache.tree.walked("b" as Id)).toBe(true);
    expect(other.walked).toEqual([true]);
  });
});

describe("folder cache: put", () => {
  it("keeps the roots in step with the listing it stores", async () => {
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
