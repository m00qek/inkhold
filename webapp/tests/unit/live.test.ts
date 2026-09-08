import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseBump,
  parseIndexStatus,
  parseVersionFromStream,
  createLiveChannel,
  type EventSourceLike,
} from "../../src/sync/live";

describe("parseBump", () => {
  it("parses a bare numeric payload", () => {
    expect(parseBump("7")).toBe(7);
    expect(parseBump("  12 ")).toBe(12);
  });

  it("parses a JSON { syncVersion } payload", () => {
    expect(parseBump('{"syncVersion": 9}')).toBe(9);
  });

  it("returns undefined for empty or unparseable payloads", () => {
    expect(parseBump("")).toBeUndefined();
    expect(parseBump("   ")).toBeUndefined();
    expect(parseBump("not-a-number")).toBeUndefined();
    expect(parseBump('{"other": 1}')).toBeUndefined();
  });
});

describe("parseIndexStatus", () => {
  it("parses the server's index frame", () => {
    expect(parseIndexStatus('{"pending":3,"version":41}')).toEqual({ pending: 3, version: 41 });
    expect(parseIndexStatus('  {"pending":0,"version":0}  ')).toEqual({ pending: 0, version: 0 });
  });

  // UNDEFINED, never `{pending: 0}`. A frame that does not parse must leave the
  // UI saying what it last knew: turning it into "nothing is pending" would
  // silently drop the "still indexing" caveat off a search that needed it.
  it("returns undefined rather than zero for anything it cannot read", () => {
    expect(parseIndexStatus("")).toBeUndefined();
    expect(parseIndexStatus("3")).toBeUndefined(); // a sync frame, not an index one
    expect(parseIndexStatus("{oops")).toBeUndefined();
    expect(parseIndexStatus('{"version":41}')).toBeUndefined();
    expect(parseIndexStatus('{"pending":"3"}')).toBeUndefined();
    expect(parseIndexStatus("null")).toBeUndefined();
  });

  // `version` is not a completeness claim and nothing reads it yet, so a frame
  // missing it is still usable. `pending` is, so it is not.
  it("tolerates a missing version but never a missing pending", () => {
    expect(parseIndexStatus('{"pending":2}')).toEqual({ pending: 2, version: 0 });
    expect(parseIndexStatus('{"pending":-4,"version":1}')).toEqual({ pending: 0, version: 1 });
  });
});

// A controllable fake EventSource: the test drives open/message/error and reads
// how many were created, so reconnect behaviour is deterministic without a net.
class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  onopen: ((this: unknown, ev: Event) => unknown) | null = null;
  onerror: ((this: unknown, ev: Event) => unknown) | null = null;
  readyState = 0;
  closed = false;
  private listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  /** Emit a frame on a channel (default the server's named `sync`). */
  emitMessage(data: string, type = "sync"): void {
    for (const l of this.listeners.get(type) ?? []) l({ data } as MessageEvent);
  }
  emitError(readyState: number): void {
    this.readyState = readyState;
    this.onerror?.call(this, new Event("error"));
  }
}

describe("createLiveChannel", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers sync-version bumps from the server's named `sync` frames", () => {
    const bumps: number[] = [];
    const channel = createLiveChannel({ create: (url) => new FakeEventSource(url) });
    channel.subscribe((v) => bumps.push(v));

    const es = FakeEventSource.instances[0]!;
    es.emitMessage("3"); // event: sync, data: 3  (the real server frame)
    es.emitMessage('{"syncVersion": 4}');
    es.emitMessage("garbage");
    expect(bumps).toEqual([3, 4]);
  });

  it("also accepts an unnamed `message` frame (defensive)", () => {
    const bumps: number[] = [];
    const channel = createLiveChannel({ create: (url) => new FakeEventSource(url) });
    channel.subscribe((v) => bumps.push(v));

    FakeEventSource.instances[0]!.emitMessage("7", "message");
    expect(bumps).toEqual([7]);
  });

  it("delivers index frames on the SAME connection as the sync ones", () => {
    // One socket, two named frames. A second `subscribe` would be a second held
    // stream, and the server allows a user only four across every tab.
    const bumps: number[] = [];
    const seen: Array<{ pending: number; version: number }> = [];
    const channel = createLiveChannel({ create: (url) => new FakeEventSource(url) });
    channel.subscribe(
      (v) => bumps.push(v),
      (s) => seen.push(s),
    );
    expect(FakeEventSource.instances).toHaveLength(1);

    const es = FakeEventSource.instances[0]!;
    es.emitMessage('{"pending":3,"version":41}', "index");
    es.emitMessage("9"); // still the sync channel
    es.emitMessage('{"pending":0,"version":42}', "index");
    es.emitMessage("{not json}", "index"); // dropped, not delivered as zero

    expect(seen).toEqual([
      { pending: 3, version: 41 },
      { pending: 0, version: 42 },
    ]);
    expect(bumps).toEqual([9]);
  });

  // The two frames must not be read by one listener: an index payload is JSON
  // and the defensive unnamed handler would try to read a version out of it.
  it("never lets an index frame arrive as a sync bump", () => {
    const bumps: number[] = [];
    const channel = createLiveChannel({ create: (url) => new FakeEventSource(url) });
    channel.subscribe(
      (v) => bumps.push(v),
      () => {},
    );
    FakeEventSource.instances[0]!.emitMessage('{"pending":3,"version":41}', "index");
    expect(bumps).toEqual([]);
  });

  // A caller that does not ask for index frames must not break, and must not be
  // handed them by some other route.
  it("is optional — a subscriber that wants only freshness still works", () => {
    const bumps: number[] = [];
    const channel = createLiveChannel({ create: (url) => new FakeEventSource(url) });
    channel.subscribe((v) => bumps.push(v));
    const es = FakeEventSource.instances[0]!;
    expect(() => es.emitMessage('{"pending":3,"version":41}', "index")).not.toThrow();
    es.emitMessage("5");
    expect(bumps).toEqual([5]);
  });

  it("reconnects with backoff only on a terminal CLOSED error", () => {
    const channel = createLiveChannel({ create: (url) => new FakeEventSource(url), backoffMs: 1000 });
    channel.subscribe(() => {});

    const first = FakeEventSource.instances[0]!;
    // Transient error (still CONNECTING): no manual reopen.
    first.emitError(0);
    vi.advanceTimersByTime(5000);
    expect(FakeEventSource.instances).toHaveLength(1);

    // Terminal close: reopens after the backoff delay.
    first.emitError(2);
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("closes the socket and cancels reconnects on unsubscribe", () => {
    const channel = createLiveChannel({ create: (url) => new FakeEventSource(url), backoffMs: 1000 });
    const unsubscribe = channel.subscribe(() => {});

    const es = FakeEventSource.instances[0]!;
    unsubscribe();
    expect(es.closed).toBe(true);

    // A pending reconnect after unsubscribe must not spawn a new source.
    es.emitError(2);
    vi.advanceTimersByTime(10000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

describe("parseVersionFromStream", () => {
  it("reads the version out of a raw text/event-stream chunk", () => {
    expect(parseVersionFromStream("retry: 5000\nevent: sync\ndata: 12\n\n")).toBe(12);
  });

  it("ignores comment and retry lines, and takes the newest data line", () => {
    const raw = "retry: 5000\nevent: sync\ndata: 3\n\n: ping\n\nevent: sync\ndata: 4\n\n";
    expect(parseVersionFromStream(raw)).toBe(4);
  });

  it("returns undefined when no frame carries a version yet", () => {
    expect(parseVersionFromStream("retry: 5000\n")).toBeUndefined();
    expect(parseVersionFromStream(": ping\n\n")).toBeUndefined();
    expect(parseVersionFromStream("")).toBeUndefined();
  });
});

describe("createLiveChannel polling fallback", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls instead of opening a stream when the runtime has no EventSource", async () => {
    // An old browser, or anything that strips SSE. Without the fallback the app
    // would simply never learn about a new note.
    const bumps: number[] = [];
    let version = 5;
    const channel = createLiveChannel({
      create: null,
      pollMs: 1000,
      fetchVersion: () => Promise.resolve(version),
    });
    const unsubscribe = channel.subscribe((v) => bumps.push(v));

    await vi.advanceTimersByTimeAsync(0);
    expect(bumps).toEqual([5]); // polled immediately, not after the first interval
    expect(FakeEventSource.instances).toHaveLength(0); // never tried to open one

    version = 6;
    await vi.advanceTimersByTimeAsync(1000);
    expect(bumps).toEqual([5, 6]);
    unsubscribe();
  });

  it("falls back to polling after repeated terminal failures to open the stream", async () => {
    const bumps: number[] = [];
    const channel = createLiveChannel({
      create: (url) => new FakeEventSource(url),
      backoffMs: 1000,
      fallbackAfterFailures: 3,
      pollMs: 5000,
      fetchVersion: () => Promise.resolve(9),
    });
    const unsubscribe = channel.subscribe((v) => bumps.push(v));

    // Two terminal failures still reopen the stream (a flaky link keeps SSE).
    FakeEventSource.instances[0]!.emitError(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.instances[1]!.emitError(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeEventSource.instances).toHaveLength(3);
    expect(bumps).toEqual([]);

    // The third gives up on SSE: no fourth source, and the poll takes over.
    FakeEventSource.instances[2]!.emitError(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeEventSource.instances).toHaveLength(3);
    expect(FakeEventSource.instances[2]!.closed).toBe(true);
    expect(bumps).toEqual([9]);

    await vi.advanceTimersByTimeAsync(5000);
    expect(bumps).toEqual([9, 9]);
    unsubscribe();
  });

  it("a successful open resets the fallback countdown", async () => {
    // Otherwise a long-lived connection that drops once a week would eventually
    // accumulate enough failures to abandon SSE forever.
    const channel = createLiveChannel({
      create: (url) => new FakeEventSource(url),
      backoffMs: 1000,
      fallbackAfterFailures: 2,
      fetchVersion: () => Promise.resolve(1),
    });
    const unsubscribe = channel.subscribe(() => {});

    for (let i = 0; i < 5; i++) {
      const es = FakeEventSource.instances[i]!;
      es.onopen?.call(es, new Event("open")); // healthy connection
      es.emitError(2); // ...then a terminal drop
      await vi.advanceTimersByTimeAsync(1000);
    }
    // Still on SSE after five drops, because each one followed a good open.
    expect(FakeEventSource.instances).toHaveLength(6);
    unsubscribe();
  });

  it("unsubscribe stops the poll loop", async () => {
    let polls = 0;
    const channel = createLiveChannel({
      create: null,
      pollMs: 1000,
      fetchVersion: () => {
        polls++;
        return Promise.resolve(1);
      },
    });
    const unsubscribe = channel.subscribe(() => {});

    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toBe(1);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(60000);
    expect(polls).toBe(1); // nothing left running
  });
});
