// The live-freshness channel (layer L1) over Server-Sent Events. Wraps
// `EventSource` on GET /api/controlplane/events and implements `LiveChannel`: each event
// carries the user's current `syncVersion`, which the library/reader use to
// revalidate listings the instant a note syncs from the device.
//
// The server HOLDS this connection open and pushes a frame when the version
// changes, plus a `: ping` comment frame every ~15s so a dead link surfaces
// instead of parking silently. It may also answer with a single frame and close
// (its degraded shape, when the per-user/global stream cap is reached) — the
// client cannot tell, and does not need to: `EventSource` honours the `retry:`
// the server sends and reopens, which turns the degraded shape into a poll all
// by itself.
//
// SSE reconnects on its own for transient drops, but a *clean* server close
// (readyState → CLOSED) is terminal — so we add a capped-backoff reopen for that
// case, and after `fallbackAfterFailures` consecutive failures to open we stop
// trusting SSE at all and fall back to plain polling (see `startPolling`). This
// deployment is plaintext HTTP on a LAN, where `EventSource` works fine — but a
// reverse proxy that buffers, or a browser without `EventSource`, would
// otherwise leave the app with no freshness signal at all.
//
// `subscribe` returns an unsubscribe that closes the socket, cancels any pending
// reconnect AND any pending poll, leaving nothing running. The `EventSource`
// constructor and the poll fetch are injectable so tests can drive both without
// a network.
//
// TWO NAMED FRAMES now ride this one connection: `event: sync` (the version) and
// `event: index` (how much of the library is still being derived). One socket,
// because a held stream costs one of four per-user slots on the server and a
// second subscription would halve how many tabs can stay live.
//
// KNOWN LIMIT OF THE POLLING FALLBACK: it reads only the FIRST frame of the
// response, which is the sync one, so a client that has fallen back to polling
// stops hearing about indexing — and this channel is now the ONLY source for
// that count, since a query is answered locally and no response comes back with
// one attached. Both the empty state's "still being indexed" and the "results
// may grow" line therefore go quiet there. Fixing it means teaching
// `fetchVersionOnce` to drain the whole one-shot body, and nobody has needed it:
// the fallback is for a browser with no `EventSource` at all.

import type { IndexStatus, LiveChannel } from "./types";

/** The subset of `EventSource` we depend on — lets tests supply a fake. The
 * server emits a **named** `event: sync` frame (see handlers/controlplane.zig
 * `controlplaneEvents`), so we subscribe via `addEventListener` for both the named
 * `sync` event and the default unnamed `message` (defensive, in case the frame's
 * `event:` line is dropped). */
export interface EventSourceLike {
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void;
  onopen: ((this: unknown, ev: Event) => unknown) | null;
  onerror: ((this: unknown, ev: Event) => unknown) | null;
  readonly readyState: number;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface LiveChannelOptions {
  url?: string;
  /** Defaults to the global `EventSource` with `withCredentials` (cookie auth).
   * `null` means "there is no EventSource here" — go straight to polling. */
  create?: EventSourceFactory | null;
  /** Base reconnect delay in ms (grows to `maxBackoffMs`). Default 1000. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /**
   * Consecutive terminal failures to open the stream before abandoning SSE for
   * the polling fallback. A successful open resets the count, so a flaky link
   * keeps using SSE; only a channel that never works at all is written off.
   */
  fallbackAfterFailures?: number;
  /** Poll interval in ms once in fallback mode. Default 15000. */
  pollMs?: number;
  /**
   * Fetches the current `syncVersion` for the polling fallback. Defaults to a
   * plain GET of the same events URL, reading just the first frame — the server
   * always leads with one carrying the current version, on both the held and the
   * degraded shape, so no second endpoint is needed.
   */
  fetchVersion?: () => Promise<number | undefined>;
}

const DEFAULT_URL = "/api/controlplane/events";
const CLOSED = 2; // EventSource.CLOSED

/**
 * Parse an `event: index` payload — `{"pending":3,"version":41}`.
 *
 * TOLERANT ONLY WHERE ABSENCE IS NOT A CLAIM. A frame that does not parse, or
 * whose `pending` is not a finite number, yields `undefined` and the UI keeps
 * whatever it last knew: an unreadable frame must never be turned into
 * "nothing is pending", which is the reading that would silently drop the
 * "still indexing" line off a search that needs it. `version` is allowed to be
 * missing (0) — nothing in this app reads it yet, and it is not a claim about
 * completeness the way `pending` is.
 */
export function parseIndexStatus(data: string): IndexStatus | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.trim());
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { pending, version } = parsed as { pending?: unknown; version?: unknown };
  if (typeof pending !== "number" || !Number.isFinite(pending)) return undefined;
  return {
    pending: Math.max(0, Math.floor(pending)),
    version: typeof version === "number" && Number.isFinite(version) ? version : 0,
  };
}

/** Parse a sync-version out of an SSE payload: a bare number or `{syncVersion}`. */
export function parseBump(data: string): number | undefined {
  const raw = data.trim();
  if (raw === "") return undefined;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) return asNumber;
  try {
    const parsed = JSON.parse(raw) as { syncVersion?: unknown };
    const v = parsed?.syncVersion;
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The version carried by the last `data:` line in a raw `text/event-stream`
 * chunk — how the polling fallback reads a response it fetched as plain text
 * rather than through `EventSource`. Comment frames (`: ping`) and the `retry:`
 * line are ignored, being neither.
 */
export function parseVersionFromStream(text: string): number | undefined {
  let found: number | undefined;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const v = parseBump(line.slice("data:".length));
    if (v !== undefined) found = v;
  }
  return found;
}

function defaultFactory(url: string): EventSourceLike {
  return new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike;
}

/** The global `EventSource`, or null where the runtime has none (an old browser,
 * a non-DOM test environment) — in which case we never even try to open one. */
function globalEventSourceFactory(): EventSourceFactory | null {
  return typeof EventSource === "undefined" ? null : defaultFactory;
}

/**
 * Poll the events endpoint once and return the version in its first frame.
 *
 * Reads INCREMENTALLY and stops as soon as a version is in hand, because the
 * endpoint may be either shape: a degraded one-shot response ends by itself, but
 * a held stream never does, and `res.text()` on one of those would hang for the
 * connection's whole lifetime. The `AbortSignal` also lets an unsubscribe cut a
 * poll short instead of leaving a request running behind a closed page.
 */
async function fetchVersionOnce(url: string, signal: AbortSignal): Promise<number | undefined> {
  const res = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "text/event-stream" },
    signal,
  });
  if (!res.ok) return undefined;

  const body = res.body;
  if (!body) return parseVersionFromStream(await res.text()); // no streams in this runtime
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffered += decoder.decode(value, { stream: true });
      const version = parseVersionFromStream(buffered);
      if (version !== undefined) return version;
      if (done) return undefined;
    }
  } finally {
    // Held stream or not, we are done with it — never leave one draining.
    void reader.cancel().catch(() => {});
  }
}

export function createLiveChannel(opts: LiveChannelOptions = {}): LiveChannel {
  const url = opts.url ?? DEFAULT_URL;
  const create = opts.create === undefined ? globalEventSourceFactory() : opts.create;
  const baseBackoff = opts.backoffMs ?? 1000;
  const maxBackoff = opts.maxBackoffMs ?? 30000;
  const fallbackAfter = opts.fallbackAfterFailures ?? 3;
  const pollMs = opts.pollMs ?? 15000;

  return {
    subscribe(onBump: (syncVersion: number) => void, onIndex?: (status: IndexStatus) => void): () => void {
      let source: EventSourceLike | null = null;
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      let aborter: AbortController | undefined;
      let attempt = 0;
      let failures = 0;
      let stopped = false;

      const fetchVersion =
        opts.fetchVersion ??
        ((): Promise<number | undefined> => {
          aborter = new AbortController();
          return fetchVersionOnce(url, aborter.signal);
        });

      // The fallback. Once here we stay here for the life of the subscription: an
      // SSE channel that failed to open `fallbackAfter` times running is not going
      // to start working, and flapping between the two would pile failed
      // connections on top of a poll that already works.
      const startPolling = (): void => {
        const tick = (): void => {
          if (stopped) return;
          void fetchVersion()
            .then((version) => {
              if (!stopped && version !== undefined) onBump(version);
            })
            .catch(() => {
              /* a failed poll is a skipped poll; the next tick retries */
            })
            .finally(() => {
              if (!stopped) pollTimer = setTimeout(tick, pollMs);
            });
        };
        tick();
      };

      const open = (): void => {
        if (stopped) return;
        if (!create) return startPolling(); // no EventSource in this runtime
        const es = create(url);
        source = es;

        es.onopen = () => {
          attempt = 0; // healthy connection — reset backoff
          failures = 0; // ...and the fallback countdown
        };
        const onData = (ev: MessageEvent) => {
          const version = parseBump(String(ev.data ?? ""));
          if (version !== undefined) onBump(version);
        };
        es.addEventListener("sync", onData); // the server's named frame
        es.addEventListener("message", onData); // defensive: unnamed frames
        // The index frame. NOT on "message" as well: its payload is JSON and the
        // unnamed handler above would read it as a sync-version, so a shared
        // listener would let one frame answer two questions.
        if (onIndex) {
          es.addEventListener("index", (ev: MessageEvent) => {
            const status = parseIndexStatus(String(ev.data ?? ""));
            if (status !== undefined) onIndex(status);
          });
        }
        es.onerror = () => {
          // Transient errors: EventSource retries itself while readyState stays
          // CONNECTING (that is also how the server's degraded one-shot shape
          // turns into a poll, via the `retry:` it sends). Only a terminal
          // CLOSED needs our own handling.
          if (stopped) return;
          if (es.readyState !== CLOSED) return;
          failures++;
          if (failures >= fallbackAfter) {
            es.close();
            source = null;
            startPolling();
            return;
          }
          const delay = Math.min(maxBackoff, baseBackoff * 2 ** attempt);
          attempt++;
          reconnectTimer = setTimeout(open, delay);
        };
      };

      open();

      return () => {
        stopped = true;
        if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
        if (pollTimer !== undefined) clearTimeout(pollTimer);
        aborter?.abort();
        source?.close();
        source = null;
      };
    },
  };
}
