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

  // An unparseable frame is `undefined`, never `{pending: 0}`.
  it("returns undefined rather than zero for anything it cannot read", () => {
    expect(parseIndexStatus("")).toBeUndefined();
    expect(parseIndexStatus("3")).toBeUndefined();
    expect(parseIndexStatus("{oops")).toBeUndefined();
    expect(parseIndexStatus('{"version":41}')).toBeUndefined();
    expect(parseIndexStatus('{"pending":"3"}')).toBeUndefined();
    expect(parseIndexStatus("null")).toBeUndefined();
  });

  it("tolerates a missing version but never a missing pending", () => {
    expect(parseIndexStatus('{"pending":2}')).toEqual({ pending: 2, version: 0 });
    expect(parseIndexStatus('{"pending":-4,"version":1}')).toEqual({ pending: 0, version: 1 });
  });
});

// A controllable fake EventSource, so reconnect behaviour is deterministic.
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
    es.emitMessage("3");  // the real server frame
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
    // One socket, two named frames: the server allows a user four streams across tabs.
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
    es.emitMessage("9");
    es.emitMessage('{"pending":0,"version":42}', "index");
    es.emitMessage("{not json}", "index");

    expect(seen).toEqual([
      { pending: 3, version: 41 },
      { pending: 0, version: 42 },
    ]);
    expect(bumps).toEqual([9]);
  });

  // An index payload is JSON; the unnamed handler must not read a version from it.
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
    first.emitError(0);
    vi.advanceTimersByTime(5000);
    expect(FakeEventSource.instances).toHaveLength(1);

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
    const bumps: number[] = [];
    let version = 5;
    const channel = createLiveChannel({
      create: null,
      pollMs: 1000,
      fetchVersion: () => Promise.resolve(version),
    });
    const unsubscribe = channel.subscribe((v) => bumps.push(v));

    await vi.advanceTimersByTimeAsync(0);
    expect(bumps).toEqual([5]);
    expect(FakeEventSource.instances).toHaveLength(0);

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

    FakeEventSource.instances[0]!.emitError(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.instances[1]!.emitError(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeEventSource.instances).toHaveLength(3);
    expect(bumps).toEqual([]);

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
    // A good open resets the count, or weekly drops would abandon SSE forever.
    const channel = createLiveChannel({
      create: (url) => new FakeEventSource(url),
      backoffMs: 1000,
      fallbackAfterFailures: 2,
      fetchVersion: () => Promise.resolve(1),
    });
    const unsubscribe = channel.subscribe(() => {});

    for (let i = 0; i < 5; i++) {
      const es = FakeEventSource.instances[i]!;
      es.onopen?.call(es, new Event("open"));
      es.emitError(2);
      await vi.advanceTimersByTimeAsync(1000);
    }
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
    expect(polls).toBe(1);
  });
});
