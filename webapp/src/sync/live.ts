// `LiveChannel` over SSE on GET /api/controlplane/events. The server holds the
// stream open (with `: ping` every ~15 s), or under its stream cap sends one
// frame and closes; `EventSource` honours `retry:` either way. A clean close
// is terminal for `EventSource`, so we reopen with capped backoff, and after
// repeated failures to open we fall back to polling.
//
// Known limit: the polling fallback reads only the first (sync) frame, so a
// polling client stops hearing `event: index`.

import type { IndexStatus, LiveChannel } from "./types";

/** The subset of `EventSource` we use. */
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
  /** Default: global `EventSource` with credentials. `null`: go straight to polling. */
  create?: EventSourceFactory | null;
  /** Base reconnect delay in ms, doubling to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Consecutive terminal open failures before polling; a successful open resets it. */
  fallbackAfterFailures?: number;
  pollMs?: number;
  /** Polling fallback; defaults to the first frame of a GET on the events URL. */
  fetchVersion?: () => Promise<number | undefined>;
}

const DEFAULT_URL = "/api/controlplane/events";
const CLOSED = 2;

/**
 * Parses `{"pending":3,"version":41}`. An unreadable frame yields `undefined`
 * (keep what you knew), never "nothing pending". A missing `version` is 0.
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

/** A bare number or `{syncVersion}`. */
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

/** The last `data:` version in a raw event-stream chunk, for the polling fallback. */
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

/** Null where the runtime has no `EventSource`. */
function globalEventSourceFactory(): EventSourceFactory | null {
  return typeof EventSource === "undefined" ? null : defaultFactory;
}

/**
 * Reads incrementally and stops at the first version: a held stream never
 * ends, so `res.text()` would hang.
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
  if (!body) return parseVersionFromStream(await res.text());
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

      // Once polling, stay polling for this subscription; flapping would pile
      // failed connections onto a working poll.
      const startPolling = (): void => {
        const tick = (): void => {
          if (stopped) return;
          void fetchVersion()
            .then((version) => {
              if (!stopped && version !== undefined) onBump(version);
            })
            .catch(() => {
              /* the next tick retries */
            })
            .finally(() => {
              if (!stopped) pollTimer = setTimeout(tick, pollMs);
            });
        };
        tick();
      };

      const open = (): void => {
        if (stopped) return;
        if (!create) return startPolling();
        const es = create(url);
        source = es;

        es.onopen = () => {
          attempt = 0;
          failures = 0;
        };
        const onData = (ev: MessageEvent) => {
          const version = parseBump(String(ev.data ?? ""));
          if (version !== undefined) onBump(version);
        };
        es.addEventListener("sync", onData);
        es.addEventListener("message", onData); // defensive: unnamed frames
        // Not on "message": its JSON payload would be misread as a sync version.
        if (onIndex) {
          es.addEventListener("index", (ev: MessageEvent) => {
            const status = parseIndexStatus(String(ev.data ?? ""));
            if (status !== undefined) onIndex(status);
          });
        }
        es.onerror = () => {
          // EventSource retries transient errors itself; only CLOSED is ours.
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
