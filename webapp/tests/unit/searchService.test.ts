// The search box's service (`search/searchService.ts`): the sync lifecycle
// around the local index, and the phrase check over stored text.

import { describe, expect, it, vi } from "vitest";
import { createSearchService } from "../../src/search/searchService";
import type { LiveChannel } from "../../src/sync/types";
import { fakeSync, spyLoader, LIVE } from "./searchService.shared";
import type { ManifestRow } from "../../src/search/manifestCodec";
import type { TextPrefetch } from "../../src/search/textPrefetch";

describe("createSearchService", () => {
  it("coalesces a burst of triggers into one sync", async () => {
    vi.useFakeTimers();
    try {
      const { sync, state } = fakeSync();
      const { load } = spyLoader();
      const service = createSearchService({ sync, load });

      for (let i = 0; i < 100; i += 1) service.refresh();
      expect(state.syncs).toBe(0);
      await vi.advanceTimersByTimeAsync(2000);
      expect(state.syncs).toBe(1);

      service.refresh();
      await vi.advanceTimersByTimeAsync(2000);
      expect(state.syncs).toBe(2);
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues exactly one re-run for triggers that arrive during a sync", async () => {
    const { sync, state } = fakeSync();
    const { load } = spyLoader();
    const service = createSearchService({ sync, load, coalesceMs: 0 });

    // Hold the first sync open; frames now describe documents its manifest lacks.
    state.hold = true;
    const first = service.syncNow();
    await Promise.resolve();
    for (let i = 0; i < 10; i += 1) service.refresh();
    state.gate?.();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(state.syncs).toBe(2);
    service.dispose();
  });

  it("swallows a failed sync, and then cannot answer — there is nothing behind it", async () => {
    const { load } = spyLoader();
    const failing: IndexSync = {
      store: { available: true } as TermsStore,
      async documents() {
        return [];
      },
      async sync() {
        throw new Error("offline");
      },
    };
    const service = createSearchService({ sync: failing, load, coalesceMs: 0 });

    await expect(service.syncNow()).resolves.toBeUndefined();
    // No server fallback: the query raises, never a quiet "no matches".
    await expect(service.search("reuniao")).rejects.toThrow();
    service.dispose();
  });

  it("answers locally once a sync has landed", async () => {
    const { sync } = fakeSync();
    const { load, loads } = spyLoader();
    const service = createSearchService({ sync, load, coalesceMs: 0 });

    await service.syncNow();
    expect(loads()).toBe(0);
    const results = await service.search("reuniao");
    expect(results.documents).toHaveLength(3);
    service.dispose();
  });

  it("subscribes both of §3.3's triggers to the one connection", async () => {
    vi.useFakeTimers();
    try {
      const { sync, state } = fakeSync();
      const { load } = spyLoader();
      const service = createSearchService({ sync, load });

      let onBump: ((v: number) => void) | undefined;
      let onIndex: ((s: { pending: number; version: number }) => void) | undefined;
      let subscriptions = 0;
      let closed = 0;
      const live: LiveChannel = {
        subscribe(bump, index) {
          subscriptions += 1;
          onBump = bump;
          onIndex = index;
          return () => {
            closed += 1;
          };
        },
      };

      const off = service.attachLive(live);
      // One subscription: the server allows four held streams per user.
      expect(subscriptions).toBe(1);

      onBump?.(7);
      onIndex?.({ pending: 3, version: 2 });
      await vi.advanceTimersByTimeAsync(2000);
      expect(state.syncs).toBe(1);

      off();
      expect(closed).toBe(1);
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});


describe("createSearchService and the scope", () => {
  it("follows a switch: the answer is stale at once, a sync runs now, and it is stale again after", async () => {
    const { sync, state } = fakeSync();
    const service = createSearchService({ sync, load: spyLoader().load });
    let fire = () => {};
    const stale = vi.fn();
    service.attachScope((listener) => {
      fire = listener;
      return () => {};
    }, stale);

    fire();
    expect(stale).toHaveBeenCalledTimes(1);
    expect(state.syncs).toBe(1);
    await vi.waitFor(() => expect(stale).toHaveBeenCalledTimes(2));
    service.dispose();
  });

  it("after a switch during a sync, asks again only once the sync that runs under the new scope has", async () => {
    const { sync, state } = fakeSync();
    const service = createSearchService({ sync, load: spyLoader().load });
    let fire = () => {};
    const stale = vi.fn();
    service.attachScope((listener) => {
      fire = listener;
      return () => {};
    }, stale);

    // A sync begun before the switch (the live channel's, say) is running.
    state.hold = true;
    const before = service.syncNow();
    await Promise.resolve();
    fire();
    expect(stale).toHaveBeenCalledTimes(1);
    // The re-run it queued is held in turn.
    state.hold = true;
    state.gate?.();
    await before;
    await vi.waitFor(() => expect(state.syncs).toBe(2));
    expect(stale).toHaveBeenCalledTimes(1);
    state.gate?.();
    await vi.waitFor(() => expect(stale).toHaveBeenCalledTimes(2));
    service.dispose();
  });

  it("asks nothing of a shell disposed while the sync a switch started is still running", async () => {
    const { sync, state } = fakeSync();
    const service = createSearchService({ sync, load: spyLoader().load });
    let fire = () => {};
    const stale = vi.fn();
    service.attachScope((listener) => {
      fire = listener;
      return () => {};
    }, stale);

    // Another tab switched; this one leaves (for /connect, say) before the sync settles.
    state.hold = true;
    fire();
    expect(stale).toHaveBeenCalledTimes(1);
    service.dispose();
    state.gate?.();
    await vi.waitFor(() => expect(state.syncs).toBe(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(stale).toHaveBeenCalledTimes(1);
  });

  it("stops following the scope once disposed", () => {
    const { sync, state } = fakeSync();
    const service = createSearchService({ sync, load: spyLoader().load });
    const listeners = new Set<() => void>();
    const stale = vi.fn();
    service.attachScope((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }, stale);
    service.dispose();
    expect(listeners.size).toBe(0);
    expect(stale).not.toHaveBeenCalled();
    expect(state.syncs).toBe(0);
  });

  it("hands Find's text prefetch every row, whatever the scope: Find inside a document reads every kind", async () => {
    const rows = LIVE.map((r, i) => (i === 0 ? r : { ...r, tier: "other" as const }));
    const { sync } = fakeSync({ rows });
    const seen: (readonly ManifestRow[])[] = [];
    const textPrefetch = { prefetch: async (r: readonly ManifestRow[]) => (seen.push(r), { stored: 0 }) } as unknown as TextPrefetch;
    const service = createSearchService({ sync, load: spyLoader().load, textPrefetch, scope: () => ({ documents: false }) });
    await service.syncNow();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.map((r) => r.md5)).toEqual(rows.map((r) => r.md5));
    service.dispose();
  });
});
