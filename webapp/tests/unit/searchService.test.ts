// The search box's service (`search/searchService.ts`): the sync lifecycle
// around the local index, and the phrase check over stored text.

import { describe, expect, it, vi } from "vitest";
import { createSearchService } from "../../src/search/searchService";
import type { LiveChannel } from "../../src/sync/types";
import { fakeSync, spyLoader } from "./searchService.shared";

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

