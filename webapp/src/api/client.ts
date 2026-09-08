// Typed wrappers over the Zig server's HTTP API (see backend/server.zig and
// ). Sessions are carried by the HttpOnly `sn_session` cookie, so we
// never touch a token in JS — every call just sends credentials with the request.
//
// Response shape: every body is an envelope `{ success, errorCode?, errorMsg? }`
// (+ data). Auth *logic* failures (bad password, expired challenge) come back as
// HTTP 200 with `success:false`; router failures use 401/403; rate limits use
// 429. `request()` normalizes all of these into a thrown `ApiError`.

import { challengeHash, md5Hex } from "./crypto";
import { historyFileUrl } from "../core/fileKind";
import { parsePageLinks } from "../render/pdfLinks";
import type { Api, PageLinks } from "./types";
import type {
  Coverage,
  Entry,
  FileHistory,
  FileVersion,
  Hash,
  Id,
  Listing,
  LayerSlot,
  NoteMeta,
  NoteSearchBatch,
  NoteSearchResults,
  PageLayer,
  PageMatch,
  PageRef,
  PageText,
  RestoredVersion,
  SearchHit,
  SearchResults,
  TxtMatch,
  TxtSearchBatch,
  TxtSearchResults,
  WordBox,
} from "../core/types";

interface Envelope {
  success: boolean;
  errorCode?: string;
  errorMsg?: string;
}

/** A failed API call. `code` is the server's `errorCode` (or a synthetic one). */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Raised when a rename clashes with a sibling of the same name (HTTP 409).
 *
 * A distinct SUBCLASS, not just an `ApiError` with a code the caller sniffs, so
 * the rename dialog can catch it by TYPE (`instanceof NameTakenError`) and stay
 * open with the collision message. It is still an `ApiError`, so
 * `dispatchApiFailure` sees it — and deliberately finds nothing actionable in it
 * (a clash is not a dead session), leaving it for the dialog to handle. The
 * message is the interface-voice line the dialog shows verbatim.
 */
export class NameTakenError extends ApiError {
  constructor() {
    super("NAME_TAKEN", "That name's already used here.", 409);
    this.name = "NameTakenError";
  }
}

/**
 * Which of the three refusals an upload got. Data, not prose: the WORDS belong to
 * the interface (`ui/uploadZone.ts` phrases each one, naming the file and the
 * extension), and the same three reasons are produced by the CLIENT-SIDE
 * pre-flight — so a file refused before it was sent and one refused by the server
 * are described in identical language.
 */
export type UploadRefusal =
  /** 413 — the file would take the account over its quota. */
  | "quota"
  /** 415 — the extension is outside the accept list; the device could not open it. */
  | "type"
  /** 400 — an empty or unusable filename. */
  | "name";

/**
 * What to do when the destination already holds a file of this name.
 *
 * BOTH ANSWERS ARE SAFE, and that is what makes offering the choice reasonable
 * rather than dangerous: a `replace` supersedes the occupant through the same
 * path a device re-uploading an edited note takes, so the displaced blob is
 * retained in `file_history` and restorable from the version-history UI that
 * already ships. Nothing is destroyed either way.
 *
 * `rename` is the DEFAULT, and the only mode a caller may send without having
 * asked: it invents a free name (`notes (2).pdf`) and leaves the occupant
 * untouched. `replace` is sent ONLY when the user chose it — the interface
 * detects the clash before transferring and asks.
 */
export type UploadConflictMode = "rename" | "replace";

/**
 * An upload the server would not accept, by reason (see {@link UploadRefusal}).
 *
 * A distinct SUBCLASS for the same reason `NameTakenError` is one: the upload
 * queue catches it by TYPE and turns it into a per-row line, while
 * `dispatchApiFailure` still sees an `ApiError` and correctly finds nothing
 * actionable in it — a rejected file is not a dead session.
 *
 * NOT RETRYABLE and never auto-retried: all three are facts about the file, so
 * sending the same bytes again would be refused the same way.
 */
export class UploadRefusedError extends ApiError {
  constructor(
    readonly reason: UploadRefusal,
    status: number,
  ) {
    super(
      reason === "quota" ? "QUOTA_EXCEEDED" : reason === "type" ? "UNSUPPORTED_TYPE" : "INVALID_NAME",
      "That file wasn't accepted.",
      status,
    );
    this.name = "UploadRefusedError";
  }
}

/** Raised on HTTP 429. `retryAfterSeconds` comes from the `Retry-After` header. */
export class RateLimitError extends ApiError {
  constructor(readonly retryAfterSeconds: number | null) {
    super("RATE_LIMITED", "Too many attempts. Wait a moment and try again.", 429);
    this.name = "RateLimitError";
  }
}

// --- request budgets ---------------------------------------------------------
//
// WHAT THIS GUARDS AGAINST IS A STALL, NOT SLOWNESS, and the whole policy falls
// out of that distinction. A
// connection that neither delivers nor errors leaves every surface in its
// loading state forever — the bin's "Loading…", the admin's, search's
// "Searching…" — because `NETWORK` only fires on an actual rejection. But a
// 200 MB PDF arriving over wifi to a Pi legitimately takes minutes and must
// never be aborted for succeeding slowly. One number cannot serve both, so
// there are tiers.
//
// The SSE stream (sync/live.ts) is deliberately exempt: it is long-lived by
// design and carries its own heartbeat frames for liveness.

/** A control-plane GET: small responses. Past this, it is not coming. */
const CONTROL_TIMEOUT_MS = 15_000;

/**
 * A mutation. Longer, and — load-bearing — its failure is AMBIGUOUS: a rename,
 * upload, purge or restore may well have applied server-side before the answer
 * was lost. Nothing here may auto-retry, and the message must not claim it
 * failed. See `TIMEOUT_AMBIGUOUS`.
 */
const MUTATION_TIMEOUT_MS = 30_000;

/**
 * Bytes: page payloads, raw files, thumbnails, whole `.spd`/`.txt` blobs.
 *
 * A total-duration cap is the WRONG instrument here — it cannot tell a stall at
 * 5% from a slow success — and this number is deliberately far past any real
 * transfer rather than tuned. The right primitive is a stall timeout ("no bytes
 * for N seconds"), which needs a streaming reader; that is deferred so it can be
 * built once, together with the byte progress upload and the `.spd` viewer both
 * need. Until then this is a backstop against the infinite case only.
 */
const BYTES_TIMEOUT_MS = 300_000;

/**
 * An upload is the one place a TOTAL budget is actively wrong. A 200 MB PDF over
 * household wifi to a Pi can legitimately take longer than any cap worth setting,
 * and killing it at the cap punishes it for succeeding slowly — the exact failure
 * `BYTES_TIMEOUT_MS` exists to avoid, which a total cap on a big upload
 * reintroduces. So an upload is bounded by SILENCE instead: `upload.onprogress`
 * reports bytes as they leave, and only a gap with no bytes at all is a stall.
 *
 * Slow is fine, however slow. Stopped is not.
 */
const UPLOAD_STALL_MS = 30_000;

/**
 * Once the last byte is sent, progress events stop by definition — the server is
 * now hashing and linking, and the stall timer would fire on a perfectly healthy
 * request. So the budget switches at that moment from "bytes must keep moving" to
 * this plain cap on the ANSWER.
 */
const UPLOAD_RESPONSE_MS = 60_000;

const TIMEOUT_MESSAGE = "The server is taking too long to answer. Check your connection and try again.";
/** A mutation that timed out MAY HAVE APPLIED. Never say it failed. */
const TIMEOUT_AMBIGUOUS =
  "The server didn't answer in time, so we don't know whether that finished. Reload to see where things stand.";

/**
 * A signal that aborts when `caller` does OR when `ms` elapses, plus the `done()`
 * every caller must run in a `finally`.
 *
 * Composed by hand rather than with `AbortSignal.any`/`AbortSignal.timeout` for
 * two reasons: the timer has to be CLEARABLE (a 5-minute pending timer per byte
 * request, left armed after the response lands, is a leak on a gallery that
 * fetches hundreds of thumbnails), and `timedOut` has to be readable afterwards
 * so an abort can be reported as a timeout rather than as a bare `NETWORK`
 * failure — `fetch` rejects identically either way.
 */
function withTimeout(caller: AbortSignal | undefined, ms: number) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, ms);
  const onCallerAbort = (): void => ctl.abort();
  caller?.addEventListener("abort", onCallerAbort);
  if (caller?.aborted) ctl.abort();
  return {
    signal: ctl.signal,
    /** True only when WE aborted it, so a caller's own cancel is not a timeout. */
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    },
  };
}

/**
 * The BYTES budget as a signal, for the few whole-blob readers that own their
 * own `fetch` because they interpret statuses themselves (the `.spd`/`.txt`
 * viewers) rather than going through `rawFetch`. Compose it with the caller's
 * cancellation signal; run `done()` in a `finally`.
 *
 * A timeout lands as an abort, so it surfaces through whatever the caller
 * already does for a failed load — which for both viewers is an honest "couldn't
 * open this, you can still download the original" rather than a hang.
 */
export function bytesBudget(caller?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const b = withTimeout(caller, BYTES_TIMEOUT_MS);
  return { signal: b.signal, done: b.done };
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

/**
 * `signal`, where a caller passes one, is handed straight to `fetch` — which is
 * the ONLY way a superseded request stops costing anything. Dropping a response
 * on a generation token (which every caller here already does) makes it
 * unpaintable; it does not make it stop, and a browser allows about six
 * connections per origin, so an abandoned search-as-you-type request goes on
 * holding one of them against the gallery's own reads for the whole of its round
 * trip. An abort rejects `fetch`, so it lands as `NETWORK` below — which is
 * correct and never seen: a caller that aborted has, by construction, already
 * superseded the response it would have painted.
 */
async function request<T = unknown>(
  method: Method,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T & Envelope> {
  // A GET is cheap to lose and safe to repeat; a mutation is neither, so it gets
  // room and an honest message if it runs out (see the budgets above).
  const mutating = method !== "GET";
  const budget = withTimeout(signal, mutating ? MUTATION_TIMEOUT_MS : CONTROL_TIMEOUT_MS);
  // `done()` on EVERY path, including the throws below: an armed 15–30 s
  // timer left behind by each request is a real leak on a surface that makes
  // hundreds of them, and the abort it would eventually fire is meaningless
  // once the response has landed.
  try {
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: budget.signal,
      });
    } catch {
      if (budget.timedOut()) {
        throw new ApiError("TIMEOUT", mutating ? TIMEOUT_AMBIGUOUS : TIMEOUT_MESSAGE, 0);
      }
      throw new ApiError("NETWORK", "Can't reach the server. Check your connection and try again.", 0);
    }

    if (res.status === 429) {
      const header = res.headers.get("Retry-After");
      const secs = header ? Number.parseInt(header, 10) : NaN;
      throw new RateLimitError(Number.isFinite(secs) ? secs : null);
    }

    // BEFORE the 401/403 arm, and a status those two do not share, because the
    // meaning is the opposite of theirs: the session is ALIVE and valid, it just
    // has not been elevated to admin recently enough. Folded into UNAUTHORIZED it
    // would sign the user out — losing the very session the gate is about to
    // re-confirm — instead of showing the gate.
    if (res.status === 428) {
      throw new ApiError("ELEVATION_REQUIRED", "Confirm your password to continue.", 428);
    }

    if (res.status === 401 || res.status === 403) {
      throw new ApiError("UNAUTHORIZED", "Your session has ended. Sign in again.", res.status);
    }

    let data: (T & Envelope) | null = null;
    try {
      data = (await res.json()) as T & Envelope;
    } catch {
      // Endpoints like /api/version return non-JSON; only treat it as an error
      // when the transport itself failed.
      if (!res.ok) throw new ApiError("SERVER", "The server returned an unexpected response.", res.status);
      return {} as T & Envelope;
    }

    if (data && data.success === false) {
      throw new ApiError(data.errorCode ?? "ERROR", data.errorMsg ?? "Something went wrong.", res.status);
    }
    if (!res.ok) {
      throw new ApiError("SERVER", "The server returned an unexpected response.", res.status);
    }
    return data;
  } finally {
    budget.done();
  }
}

export interface LoginResult {
  /**
   * Whether the server issued a first-login "pending" session that can only
   * reach the change-password route. Read from the `mustChangePassword` field on
   * the login response body; when true the shell routes to `#/change-password`.
   */
  mustChangePassword: boolean;
}

export interface Me {
  email: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
}

export interface ServerInfo {
  /**
   * The address the household should point their Supernote at — the server's own
   * LAN address (`host:port`), which the browser cannot determine on its own (a
   * client that connected over `localhost` has no idea what the machine's network
   * address is). Onboarding's connect step shows this verbatim.
   */
  address: string;
  /**
   * True on a brand-new server whose only account is the bootstrap admin, still
   * holding its temporary password — i.e. nobody has finished onboarding yet.
   * The login page uses it to switch to the first-run rendering (terminal
   * guidance + step dots). Deliberately reachable pre-auth: on a single-household
   * LAN tool "this server is new" is not a secret, and the whole first-run
   * experience turns on knowing it before anyone can sign in.
   */
  firstRun: boolean;
}

export const api = {
  /** Step 1 of login: fetch a single-use challenge code for an account. */
  async requestChallenge(account: string): Promise<string> {
    const r = await request<{ randomCode: string }>("POST", "/api/official/user/query/random/code", { account });
    return r.randomCode;
  },

  /**
   * Full web login: challenge -> `sha256_hex(md5_hex(pw)+code)` -> login. On
   * success the server sets the `sn_session` cookie; no token is returned to JS.
   * No `equipmentNo` is sent (that would make it a device login).
   */
  async login(account: string, plaintext: string): Promise<LoginResult> {
    const randomCode = await this.requestChallenge(account);
    const password = await challengeHash(plaintext, randomCode);
    const r = await request<{ mustChangePassword?: boolean }>(
      "POST",
      "/api/official/user/account/login/new",
      { account, password },
    );
    return { mustChangePassword: r.mustChangePassword ?? false };
  },

  /**
   * Set a new password (first-login mandatory change, or voluntary). The server
   * revokes every session and mints a fresh full web session as a new cookie.
   */
  async changePassword(newPlaintext: string): Promise<void> {
    await request("PUT", "/api/user/password", { newPassword: md5Hex(newPlaintext) });
  },

  /** End the current session and clear the cookie. */
  async logout(): Promise<void> {
    await request("POST", "/api/user/logout", {});
  },

  /**
   * Current session profile (`GET /api/user/me`, cookie-auth, reachable by full
   * and pending sessions). Used to restore auth state on reload since the
   * HttpOnly cookie is invisible to JS. Returns null when there's no valid
   * session — the server signals that either as an unauthorized status (401/403)
   * or as an envelope failure (HTTP 200 with `success:false`), and both map to
   * null here so a boot guard can simply route to login. A 404 (endpoint absent)
   * is treated the same way, defensively.
   */
  async me(): Promise<Me | null> {
    try {
      const r = await request<Me>("GET", "/api/user/me");
      return { email: r.email, isAdmin: r.isAdmin, mustChangePassword: r.mustChangePassword };
    } catch (e) {
      // 200 = envelope {success:false} (no session); 401/403 = unauthorized;
      // 404 = endpoint missing. Anything else (network, 5xx) is a real error.
      if (e instanceof ApiError && [200, 401, 403, 404].includes(e.status)) return null;
      throw e;
    }
  },

  /**
   * The server's own LAN address + whether this is a first-run server
   * (`GET /api/controlplane/server-info`, pre-auth). Returns null when the
   * endpoint is unreachable or absent (older backend that predates it) — every
   * caller treats null as "degrade gracefully": the login page stays on its
   * returning-user rendering, and the connect step falls back to the address the
   * browser is actually on. Never throws for the onboarding path's sake.
   */
  async serverInfo(): Promise<ServerInfo | null> {
    try {
      const r = await request<ServerInfo>("GET", "/api/controlplane/server-info");
      return { address: String(r.address ?? ""), firstRun: r.firstRun === true };
    } catch {
      return null;
    }
  },

  /**
   * The signed-in user's own storage usage (`GET /api/controlplane/usage`), for
   * the rail's quota bar. Null on any failure or missing fields — the bar simply
   * stays hidden, so the rail works without it.
   */
  async usage(): Promise<{ used: number; total: number } | null> {
    try {
      const r = await request<{ used_bytes?: number; total_bytes?: number }>("GET", "/api/controlplane/usage");
      if (typeof r.used_bytes !== "number" || typeof r.total_bytes !== "number") return null;
      return { used: r.used_bytes, total: r.total_bytes };
    } catch {
      return null;
    }
  },
};

// --- the browse/read Api (the `Api` seam) over the real control-plane endpoints -----
//
// These are the `.controlplane`-scope endpoints in backend/services/controlplane.zig
// + routes.zig. Unlike
// auth, the JSON here is emitted RAW (no `{success}` envelope): a listing/note is
// exactly its VO, so `request()` — which only treats an explicit `success:false`
// as an error — passes them straight through, while a `fail()` error (e.g. a note
// 404) still round-trips as an `ApiError`. Page bytes are BINARY (octet-stream),
// so they bypass `request()` and read `arrayBuffer()`; the immutable `?v={hash}`
// URL makes that response browser-HTTP-cached (layer L2).

/** Maps a raw fetch status to the same error taxonomy `request()` uses. */
function statusError(status: number): ApiError | null {
  if (status === 428) {
    return new ApiError("ELEVATION_REQUIRED", "Confirm your password to continue.", 428);
  }
  if (status === 401 || status === 403) {
    return new ApiError("UNAUTHORIZED", "Your session has ended. Sign in again.", status);
  }
  if (status === 429) return new RateLimitError(null);
  if (status === 404) {
    // A stale `?v=` (the page content moved on) — the caller should refetch note
    // metadata to pick up the new per-page hashes.
    return new ApiError("STALE_PAGE", "This page is out of date. Reopening…", 404);
  }
  if (status >= 400) return new ApiError("SERVER", "The server returned an unexpected response.", status);
  return null;
}

/**
 * The shared raw-binary fetch guard. The endpoints that carry a non-JSON body
 * (page bytes, a template, a page transcript, bin page bytes) bypass `request()`
 * and read their own body off the Response — but they all share the same three
 * checks: a network failure becomes NETWORK, a bad status maps through
 * `statusError` (so a stale `?v=` is a real STALE_PAGE, not an opaque SERVER),
 * and a non-`ok` status is SERVER. This returns a Response known to be `ok`; the
 * caller picks `arrayBuffer()`, `blob()` or `json()`.
 */
export async function rawFetch(url: string, signal?: AbortSignal): Promise<Response> {
  // The BYTES budget, not the control-plane one: this is the path a whole page
  // payload, a raw `.note`/`.pdf` or a cover travels, and killing one of those
  // for being large is worse than the stall it is meant to catch. It only rules
  // out the infinite case — see `BYTES_TIMEOUT_MS`.
  const budget = withTimeout(signal, BYTES_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin", signal: budget.signal });
  } catch {
    if (budget.timedOut()) throw new ApiError("TIMEOUT", TIMEOUT_MESSAGE, 0);
    throw new ApiError("NETWORK", "Can't reach the server. Check your connection and try again.", 0);
  } finally {
    // Cleared as soon as the RESPONSE lands: unlike `request`, the caller reads
    // the body itself (`arrayBuffer`/`blob`), so there is no later await here to
    // keep covered — and holding a 5-minute timer per thumbnail would be the
    // leak this exists to avoid.
    budget.done();
  }
  const err = statusError(res.status);
  if (err) throw err;
  if (!res.ok) throw new ApiError("SERVER", "The server returned an unexpected response.", res.status);
  return res;
}

/**
 * The two API failures a *view* must ACT on rather than swallow. Everything else
 * (a network blip, a 5xx, a decode error) stays non-fatal: the UI keeps its last
 * good paint and retries on the next intersection.
 *
 * WHY this lives at the seam: the error taxonomy is the client's, so the rule for
 * *which* codes are actionable belongs next to the code that mints them, rather
 * than being re-derived (and drifted) inside every view that catches.
 */
export interface ApiFailureSink {
  /** The session cookie is gone (401/403) — the shell must re-authenticate. */
  onSessionExpired(): void;
  /**
   * A versioned page URL 404'd: the `?v=` hash the view is holding is out of
   * date. The owner of that hash (the note's metadata, or the listing that
   * carried the thumbnail's `firstPage`) must be refetched to pick up the new
   * per-page hashes — that refetch is the contract `STALE_PAGE` promises.
   */
  onStalePage?(noteId: Id, page: PageRef): void;
  /**
   * An admin route refused because the session is not freshly elevated (428).
   * The session is FINE — the handler must open the re-confirm gate and, on
   * success, retry the call. Views that never touch admin routes omit this and
   * the failure stays non-actionable, exactly as before.
   */
  onElevationRequired?(): void;
}

/**
 * Route a caught error to `sink`. Returns true when it was actionable, so the
 * caller can skip its own fallback. Non-`ApiError` throws (a renderer failure, a
 * cache error) are deliberately *not* actionable — they stay the caller's
 * problem and must remain non-fatal.
 */
export function dispatchApiFailure(sink: ApiFailureSink, e: unknown, noteId?: Id, page?: PageRef): boolean {
  if (!(e instanceof ApiError)) return false;
  if (e.code === "UNAUTHORIZED") {
    sink.onSessionExpired();
    return true;
  }
  if (e.code === "ELEVATION_REQUIRED" && sink.onElevationRequired) {
    sink.onElevationRequired();
    return true;
  }
  if (e.code === "STALE_PAGE" && sink.onStalePage && noteId !== undefined && page !== undefined) {
    sink.onStalePage(noteId, page);
    return true;
  }
  return false;
}

/**
 * Fill in the optionals the server omits on a `PageRef`.
 *
 * `emit_null_optional_fields = false` (as with `ListingVO.folderId`): the backend
 * emits `textHash` (the md5 of the page's recognized-text block) only on pages
 * that HAVE recognized text, omitting it otherwise. `?? null` maps that absence to
 * the reader's "no recognized text" signal (the transcript toggle renders
 * disabled) rather than `undefined`, which would let the reader fetch a transcript
 * that isn't there. A real absent-optional — not a not-yet-shipped stub.
 */
function normalizePage(p: PageRef): PageRef {
  return {
    index: p.index,
    hash: p.hash,
    width: p.width,
    height: p.height,
    textHash: p.textHash ?? null,
    // Same absent-optional shape as `textHash`, and the same meaning: non-null
    // is "this page has links", so a null here is what stops the reader asking
    // about the pages that have none — which is nearly all of them.
    linksHash: p.linksHash ?? null,
    // Same absent-optional shape as `textHash`: the server omits it wherever it
    // would be `index + 1`, which is every page of every notebook. A page
    // number is 1-based, so 0 (or anything below it) is not a page and is
    // treated as absence rather than trusted onto a document.
    sourcePage: typeof p.sourcePage === "number" && p.sourcePage > 0 ? p.sourcePage : null,
    layers: normalizeLayers(p.layers),
  };
}

/** The five slot ids `LayerVO.slot` may carry — anything else is malformed. */
const LAYER_SLOTS: ReadonlySet<string> = new Set(["main", "layer1", "layer2", "layer3", "background"]);

/**
 * Validate a page's `layers` off the wire, or degrade to `null` (= no panel).
 *
 * ALL-OR-NOTHING on purpose: the panel pairs these entries with the payload's
 * SNPG records by slot, so a list with one bad/missing/duplicated entry cannot
 * be partially trusted — a row paired with the wrong pixels is worse than no
 * panel, and `null` is exactly the reader's safe path (the device-authored
 * composite, unchanged). Absent is the common case — a page with no layers, on
 * ANY route — and normalizes to `null` like `textHash` does.
 *
 * ONE CODE PATH, DELIBERATELY. `normalizePage` is what every page ref off the
 * wire goes through, including a listing/bin entry's `firstPage` (see
 * `normalizeEntry`), so the summary the reader opens from validates its layers
 * by exactly the rules the meta's page list does. Nothing here is meta-specific.
 *
 * Exported for the unit tests; nothing else should call it directly.
 */
export function normalizeLayers(layers: PageLayer[] | null | undefined): PageLayer[] | null {
  if (!Array.isArray(layers) || layers.length === 0) return null;
  const seen = new Set<string>();
  const out: PageLayer[] = [];
  for (const l of layers) {
    if (typeof l?.slot !== "string" || !LAYER_SLOTS.has(l.slot)) return null;
    if (seen.has(l.slot)) return null; // a slot is an identity; twice is nonsense
    seen.add(l.slot);
    out.push({
      slot: l.slot as LayerSlot,
      // Device-authored text; `""` is the real "no display name" value.
      name: typeof l.name === "string" ? l.name : "",
      // `emit_null_optional_fields` never drops a bool here (the VO emits both),
      // but a missing flag still needs A reading: visible-and-not-current is the
      // one that claims nothing the composite doesn't already show.
      visible: typeof l.visible === "boolean" ? l.visible : true,
      isCurrent: l.isCurrent === true,
    });
  }
  return out;
}

/**
 * The badge's fallback: a file type derived from the note's own name, used until
 * the backend emits a verified `fileType`.
 *
 * The rule is the last dot in the name, lowercased and dot-stripped. Two cases
 * deliberately yield the neutral `"file"` rather than a guess:
 *   - no dot at all (`"Weekly review"`),
 *   - a leading dot with nothing before it (`".hidden"` — that is the whole
 *     name, not an extension), or a trailing dot with nothing after it.
 *
 * `"file"` is chosen over the old hardcoded `"note"` because it cannot be WRONG:
 * an unlabelled blob is a file, whereas calling it a note is the exact lie this
 * change exists to remove.
 */
/**
 * Keep only word boxes that could actually be placed.
 *
 * The wire values are device-authored and reach a PDF generator, so a malformed
 * one has to be dropped HERE rather than turned into a `NaN` coordinate that
 * would corrupt the whole content stream. A missing `words` is simply a page
 * with nothing positioned on it.
 */
function normalizeWords(words: WordBox[] | undefined): WordBox[] {
  if (!Array.isArray(words)) return [];
  return words
    .filter(
      (w): w is WordBox =>
        typeof w?.text === "string" &&
        [w.xMm, w.yMm, w.wMm, w.hMm].every((v) => typeof v === "number" && Number.isFinite(v)),
    )
    .map((w) => ({ text: w.text, xMm: w.xMm, yMm: w.yMm, wMm: w.wMm, hMm: w.hMm }));
}

export function fileTypeFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "file";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * The preview-shape pair a listing/bin entry may carry, made safe at the seam.
 *
 * ABSENT-SAFE by design (the field is optional on the wire — most entries have
 * no aspect fact to state), and MALFORMED-SAFE beyond that: the pair is only
 * ever consumed as a ratio, and a zero, negative, non-finite or half-missing
 * pair would reach CSS as `aspect-ratio: NaN` — which silently disables the
 * property and with it the whole reflow-free layout it exists for. Anything
 * that cannot be a shape degrades to `undefined`, which the layout reads as
 * "unknown" and answers with its 3:4 fallback.
 */
function normalizeAspect(a: { w?: number; h?: number } | undefined | null): { w: number; h: number } | undefined {
  if (!a || typeof a.w !== "number" || typeof a.h !== "number") return undefined;
  if (!Number.isFinite(a.w) || !Number.isFinite(a.h) || a.w <= 0 || a.h <= 0) return undefined;
  return { w: a.w, h: a.h };
}

/**
 * Fill in the optionals the server omits on a listing entry.
 *
 * `emit_null_optional_fields = false`: the backend emits `hasRecognizedText`
 * (a note's `recognized_page_count > 0`) and `fileType`, but OMITS them where they
 * don't apply — a folder carries no `hasRecognizedText`, and an entry may lack a
 * server-stated `fileType`. Same absent-not-null shape as `textHash`. The
 * `?? false` / `?? fileTypeFromName(name)` defaults keep the OCR marker off cards
 * that shouldn't have it and stop the badge rendering the literal `undefined`.
 */
function normalizeEntry(e: Entry): Entry {
  return e.kind === "note"
    ? {
        ...e,
        firstPage: normalizePage(e.firstPage),
        fileType: e.fileType ?? fileTypeFromName(e.name),
        // No hash → no raw-bytes URL (the route requires `?v=`), and the UI
        // renders without a preview rather than fetching a certain 404.
        fileHash: e.fileHash ?? null,
        hasRecognizedText: e.hasRecognizedText ?? false,
        // Absent for most entries (only `.note`/`.spd` state a shape); the
        // gallery reads `undefined` as "unknown" and falls back — see the type.
        thumbAspect: normalizeAspect(e.thumbAspect),
      }
    : {
        ...e,
        // Same omitted-not-null hazard as every field above, but the fallback is
        // deliberately `undefined` rather than `0`: absent means "the server did
        // not count this folder here", which the row renders as no meta at all,
        // while `0` means "counted, and it is empty" and renders as "Empty".
        // Coercing absent to 0 would make an un-counted folder claim to be empty.
        itemCount: typeof e.itemCount === "number" && e.itemCount >= 0 ? e.itemCount : undefined,
      };
}

/**
 * Fill in the fields the server may omit on a search hit.
 *
 * Same `emit_null_optional_fields = false` hazard as everywhere else on this
 * face, and it matters more here than usual because `snippet` is the one string
 * on the whole surface that reaches `innerHTML`: an `undefined` snippet would
 * paint the literal text "undefined" as though it were a transcript excerpt.
 * `pageIndex` is the other load-bearing one — it is what the deep link opens the
 * reader at, and `undefined` there would be `#/note/x/page/NaN`.
 */
function normalizeHit(h: SearchHit): SearchHit {
  return {
    noteId: h.noteId ?? "",
    noteName: h.noteName ?? "",
    pageIndex: h.pageIndex ?? 0,
    snippet: h.snippet ?? "",
    // TOLERANT by contract (see `SearchHit.kind`): the server OMITS kind 0, so
    // absent is a note page; anything that is not exactly `1` also reads as a
    // note page, so a future kind the client does not know degrades to the
    // reader rather than to a broken result. `1` is the only `.txt` signal.
    ...(h.kind === 1 ? { kind: 1 } : {}),
  };
}

/**
 * One `.txt` paragraph match, with the fields the server may omit filled in.
 *
 * `segment`/`offset`/`length` are load-bearing — the viewer scrolls to the
 * paragraph by them — so a malformed row is DROPPED (`normalizeTxtMatches`)
 * rather than defaulted to offset 0, which would scroll to the wrong place.
 * `matches` upholds "never 0" at the seam; `terms` degrades to empty (a
 * paragraph the viewer marks nothing in, never one it marks wrongly).
 */
function normalizeTxtMatch(m: TxtMatch): TxtMatch {
  return {
    segment: Math.floor(m.segment),
    offset: Math.floor(m.offset),
    length: Math.max(0, Math.floor(m.length)),
    matches: typeof m.matches === "number" && Number.isFinite(m.matches) ? Math.max(1, Math.floor(m.matches)) : 1,
    terms: Array.isArray(m.terms) ? m.terms.filter((t): t is string => typeof t === "string" && t !== "") : [],
  };
}

function normalizeTxtMatches(segments: TxtMatch[] | undefined): TxtMatch[] {
  if (!Array.isArray(segments)) return [];
  return segments
    .filter(
      (m) =>
        typeof m?.segment === "number" &&
        Number.isFinite(m.segment) &&
        m.segment >= 0 &&
        typeof m.offset === "number" &&
        Number.isFinite(m.offset) &&
        m.offset >= 0,
    )
    .map(normalizeTxtMatch)
    .sort((a, b) => a.segment - b.segment);
}

/**
 * The zero-hit coverage numbers, or null.
 *
 * ABSENT IS NOT ZERO here, which is why this cannot be a `?? 0`: the server sends
 * `coverage` only on a response with no hits, and a fabricated `{notes: 0,
 * unsearchable: 0}` would render as the confident sentence "0 of your 0 notes
 * have no recognised text" over a library that has plenty. A partial object is
 * treated the same as an absent one for the same reason — half a claim is not a
 * claim.
 */
function normalizeCoverage(c: Coverage | null | undefined): Coverage | null {
  if (!c || typeof c.notes !== "number" || typeof c.unsearchable !== "number") return null;
  if (!Number.isFinite(c.notes) || !Number.isFinite(c.unsearchable)) return null;
  // `pending` DOES default, unlike the other two — see {@link Coverage.pending}.
  // It drives a sentence shown only above zero, so a server too old to send it
  // and a library with nothing outstanding produce the same screen; defaulting
  // it asserts nothing. A negative or non-finite value is not a count.
  const pending = typeof c.pending === "number" && Number.isFinite(c.pending) ? Math.max(0, Math.floor(c.pending)) : 0;
  return { notes: c.notes, unsearchable: c.unsearchable, pending };
}

/**
 * Note-scoped match rows, in page order and with the counts made safe.
 *
 * A row exists because the index matched that page, so `matches` is never 0 —
 * `Math.max(1, …)` upholds that at the seam rather than letting a malformed row
 * become a filmstrip badge reading "0 matches", which is an absence stated as a
 * presence. Rows without a usable page index are DROPPED rather than defaulted
 * to page 0: a wrong page is a jump to the wrong place, where a missing one is
 * just one fewer badge.
 *
 * `terms` degrades to EMPTY rather than to anything invented: a page with no
 * usable terms is one the reader draws no ovals on, which is a match it cannot
 * point at — never a match it points at wrongly. The count is untouched by that,
 * because the count is the authority and the ovals are the illustration.
 */
function normalizePageMatches(pages: PageMatch[] | undefined): PageMatch[] {
  if (!Array.isArray(pages)) return [];
  return pages
    .filter((p) => typeof p?.pageIndex === "number" && Number.isFinite(p.pageIndex) && p.pageIndex >= 0)
    .map((p) => ({
      pageIndex: Math.floor(p.pageIndex),
      matches: typeof p.matches === "number" && Number.isFinite(p.matches) ? Math.max(1, Math.floor(p.matches)) : 1,
      terms: Array.isArray(p.terms) ? p.terms.filter((t): t is string => typeof t === "string" && t !== "") : [],
    }))
    .sort((a, b) => a.pageIndex - b.pageIndex);
}

/**
 * One version row off the wire, made safe.
 *
 * Same `emit_null_optional_fields = false` discipline as every VO on this face:
 * `current` is emitted only on the live version, so an ABSENT flag reads as a
 * retained version (`=== true`, the reading that makes no claim). `size` floors to
 * 0, `createdAt` (already epoch ms from the server) to 0 — a malformed stamp
 * renders as "just now" rather than "Invalid Date". A row with no usable md5 is
 * DROPPED by the caller (it can address nothing), never defaulted.
 */
function normalizeVersion(v: {
  md5?: unknown;
  size?: unknown;
  createdAt?: unknown;
  current?: unknown;
  pageCount?: unknown;
}): FileVersion | null {
  if (typeof v?.md5 !== "string" || v.md5 === "") return null;
  return {
    md5: v.md5,
    size: typeof v.size === "number" && Number.isFinite(v.size) && v.size > 0 ? Math.floor(v.size) : 0,
    createdAt: typeof v.createdAt === "number" && Number.isFinite(v.createdAt) && v.createdAt > 0 ? v.createdAt : 0,
    current: v.current === true,
    // Omitted / non-positive → 0 (the "no pages to count" reading the content
    // signal falls back to byte size for). The server sends it only for a `.note`.
    pageCount:
      typeof v.pageCount === "number" && Number.isFinite(v.pageCount) && v.pageCount > 0
        ? Math.floor(v.pageCount)
        : 0,
  };
}

/**
 * Walk the note-scoped keyset ONCE, in page order, calling `onBatch` with the
 * CUMULATIVE, normalized result after every network batch. This is the single
 * implementation both the drain ({@link Api.searchInNote}) and the stream
 * ({@link Api.searchInNoteStream}) run on — so batching cannot ever make them
 * disagree, which is the non-negotiable the whole feature turns on: the union of
 * all in-doc batches equals what one complete scan would have found.
 *
 * `signal` aborts BETWEEN batches (never mid-request): a superseded keystroke
 * must not keep draining a giant document. The fuzzy fallback arrives as a
 * single no-cursor batch (`done` on the first call), so a fuzzy stream is one
 * `onBatch`.
 */
async function drainNoteSearch(
  noteId: Id,
  q: string,
  onBatch: (batch: NoteSearchBatch) => void,
  signal?: AbortSignal,
): Promise<void> {
  const base = `/api/controlplane/note/${encodeURIComponent(noteId)}/search`;
  const raw: PageMatch[] = [];
  let usedFuzzy = false;
  let outQuery = q;
  let cursor: string | undefined;
  let first = true;
  for (;;) {
    if (signal?.aborted) return;
    const params = new URLSearchParams({ q });
    if (cursor) params.set("cursor", cursor);
    const r = await request<NoteSearchResults & { cursor?: string }>("GET", `${base}?${params.toString()}`);
    if (signal?.aborted) return;
    if (first) {
      // `=== true`, strictly, exactly as `searchText` reads it: anything that is
      // not literally `true` means "answered as typed". Read once, off the first
      // batch — the fuzzy fallback is a one-shot.
      usedFuzzy = r.usedFuzzy === true;
      outQuery = r.query ?? q;
      first = false;
    }
    if (Array.isArray(r.pages)) raw.push(...r.pages);
    // ABSENT / malformed cursor is the "no more results" signal, exactly as
    // `searchText` reads it — the walk ends honestly, never on `?cursor=`.
    const next = typeof r.cursor === "string" && r.cursor !== "" ? r.cursor : undefined;
    const done = !next;
    onBatch({ query: outQuery, pages: normalizePageMatches(raw), usedFuzzy, done });
    if (done) return;
    cursor = next;
  }
}

/** The `.txt` twin of {@link drainNoteSearch}: the paragraph keyset, one walk,
 *  cumulative-per-batch, shared by the drain and the stream. */
async function drainTxtSearch(
  noteId: Id,
  q: string,
  onBatch: (batch: TxtSearchBatch) => void,
  signal?: AbortSignal,
): Promise<void> {
  const base = `/api/controlplane/note/${encodeURIComponent(noteId)}/txt-search`;
  const raw: TxtMatch[] = [];
  let usedFuzzy = false;
  let outQuery = q;
  let cursor: string | undefined;
  let first = true;
  for (;;) {
    if (signal?.aborted) return;
    const params = new URLSearchParams({ q });
    if (cursor) params.set("cursor", cursor);
    const r = await request<TxtSearchResults & { cursor?: string }>("GET", `${base}?${params.toString()}`);
    if (signal?.aborted) return;
    if (first) {
      usedFuzzy = r.usedFuzzy === true;
      outQuery = r.query ?? q;
      first = false;
    }
    if (Array.isArray(r.segments)) raw.push(...r.segments);
    const next = typeof r.cursor === "string" && r.cursor !== "" ? r.cursor : undefined;
    const done = !next;
    onBatch({ query: outQuery, segments: normalizeTxtMatches(raw), usedFuzzy, done });
    if (done) return;
    cursor = next;
  }
}

export function createHttpApi(): Api {
  return {
    async listFolder(parentId: Id | null): Promise<Listing> {
      // Root omits `parent`; a folder passes its id. The server also accepts
      // `parent=root`, but omitting it is the canonical root request.
      const path = parentId == null
        ? "/api/controlplane/tree"
        : `/api/controlplane/tree?parent=${encodeURIComponent(parentId)}`;
      const r = await request<Listing>("GET", path);
      // `?? null` is load-bearing, not defensive noise: the server serializes with
      // `emit_null_optional_fields = false`, so a null optional is OMITTED from the
      // JSON rather than sent as `null`. `ListingVO.folderId` is the one such field
      // on this surface, and it is absent for the ROOT listing — passing it through
      // would hand the UI `undefined` where the contract says `Id | null`, and
      // `listing.folderId === null` (the root test that drives the breadcrumb)
      // would be false at the root. Normalize at the seam so every consumer, and
      // the fake, agree. Any future optional field on these VOs needs the same.
      return {
        folderId: r.folderId ?? null,
        path: r.path,
        entries: r.entries.map(normalizeEntry),
        syncVersion: r.syncVersion,
      };
    },

    async getNoteMeta(id: Id): Promise<NoteMeta> {
      const r = await request<NoteMeta>("GET", `/api/controlplane/file/metadata/${encodeURIComponent(id)}`);
      return {
        id: r.id,
        name: r.name,
        pages: r.pages.map(normalizePage),
        // Same omitted-not-null hazard as everywhere on this face. The defaults
        // are the SAFE reading in both directions: an unknown type falls back to
        // the name (never "note", which would open a blank reader — the exact bug
        // this branch exists to remove), and a missing hash means no preview URL.
        fileType: r.fileType ?? fileTypeFromName(r.name),
        fileHash: r.fileHash ?? null,
        size: r.size ?? 0,
        // Absent for everything without a `.mark` beside it, which is almost
        // everything — the same omitted-not-null shape as `fileHash`.
        annotationsId: r.annotationsId ?? null,
        // Omitted whenever the server has NOT verified this device's millimetre
        // scale, which is the common case — and `null` here is a real answer that
        // the exporter must honour, not a default standing in for a number we
        // could have derived. See `NoteMeta.pxPerMm`.
        pxPerMm: typeof r.pxPerMm === "number" && r.pxPerMm > 0 ? r.pxPerMm : null,
      };
    },

    async getPageBytes(id: Id, page: PageRef): Promise<ArrayBuffer> {
      // The renderer decodes these raw SNPG bytes; never JSON. The versioned URL
      // is immutable, so a repeat view is served from the browser HTTP cache.
      const url = `/note/${encodeURIComponent(id)}/page/${page.index}?v=${encodeURIComponent(page.hash)}`;
      return (await rawFetch(url)).arrayBuffer();
    },

    async getTemplate(id: Id, hash: Hash): Promise<Blob> {
      // A page's custom image template, content-addressed by its asset hash — an
      // immutable response the browser HTTP-caches; the reader memoizes the
      // decoded bitmap once per hash. Returned as a Blob for `createImageBitmap`.
      const url = `/note/${encodeURIComponent(id)}/template/${encodeURIComponent(hash)}`;
      return (await rawFetch(url)).blob();
    },

    async getPageText(id: Id, page: PageRef): Promise<PageText> {
      // No recognition on this page: there is no version to ask for, so there is
      // nothing to request. This is also the whole of real mode today, since the
      // backend does not emit `textHash` yet and normalizePage makes it null.
      if (page.textHash === null) return { text: "", words: [] };

      // Sibling of the page-bytes route and versioned the same way — except by
      // `textHash`, so the URL turns over precisely when the transcript does and
      // an `immutable` response can never outlive the recognition it described.
      // `rawFetch` rather than `request()`, which is what earns this call a real
      // STALE_PAGE on a 404 instead of an opaque SERVER error. The body is a raw
      // VO (`{ text }`), no `{success}` envelope, matching the rest of the
      // control-plane surface.
      const url = `/note/${encodeURIComponent(id)}/page/${page.index}/text?v=${encodeURIComponent(page.textHash)}`;
      const res = await rawFetch(url);

      let body: {
        text?: string;
        words?: WordBox[];
        success?: boolean;
        errorCode?: string;
        errorMsg?: string;
      };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        throw new ApiError("SERVER", "The server returned an unexpected response.", res.status);
      }
      if (body && body.success === false) {
        throw new ApiError(body.errorCode ?? "ERROR", body.errorMsg ?? "Something went wrong.", res.status);
      }
      // Omitted just like every other empty optional — an absent transcript is the
      // empty one, which the panel renders as its honest "no recognized text" state,
      // and absent `words` is a page with nothing placeable on it.
      return { text: body?.text ?? "", words: normalizeWords(body?.words) };
    },

    async getPageLinks(id: Id, page: PageRef): Promise<PageLinks> {
      // No link block on this page: there is no version to ask for, so there is
      // no request. This is the common case by a wide margin — only a page
      // rasterised from an imported PDF template carries links at all — and it
      // is why the hash rides on the page list.
      if (page.linksHash === null) return { links: [] };

      // The sibling of the page-text route, versioned by `linksHash` so the URL
      // turns over exactly when the links do. `rawFetch` rather than
      // `request()`, matching `getPageText`: that is what makes a 404 a real
      // STALE_PAGE ("your metadata is old, refetch it") instead of an opaque
      // server error.
      const url = `/note/${encodeURIComponent(id)}/page/${page.index}/links?v=${encodeURIComponent(page.linksHash)}`;
      const res = await rawFetch(url);

      // VALIDATED THROUGH THE SAME DOOR AS THE PDF DECODER'S OWN PAYLOAD.
      // `parsePageLinks` is a string-in, links-out parser that drops any record
      // that is not one, and this is the same shape from a different source — a
      // device file rather than a wasm decoder. Reusing it means one set of
      // rules about what counts as a link, and it costs a re-serialise of a body
      // that is kilobytes.
      const text = await res.text();
      const raw: unknown = (() => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return null;
        }
      })();
      if (raw !== null && typeof raw === "object" && (raw as { success?: boolean }).success === false) {
        const b = raw as { errorCode?: string; errorMsg?: string };
        throw new ApiError(b.errorCode ?? "ERROR", b.errorMsg ?? "Something went wrong.", res.status);
      }
      const list = (raw as { links?: unknown } | null)?.links;
      return { links: parsePageLinks(JSON.stringify(list ?? [])) };
    },

    async searchText(query: string, limit?: number, cursor?: string, signal?: AbortSignal): Promise<SearchResults> {
      // Short-circuit BEFORE the network, not after. The server does answer a
      // blank `q` with an empty 200, but search-as-you-type empties this box on
      // every backspace-to-nothing, and a request per emptying is pure waste.
      // Trimmed, so a box holding only spaces is the same nothing.
      //
      // THIS `trim()` IS ALSO WHAT MAKES EVERY LIBRARY-WIDE SEARCH A PREFIX
      // QUERY, and that is not what it was written for. The server reads a
      // TRAILING SPACE as "the user finished this word" (`isStillTyping` in
      // `backend/services/search/query.zig`); without one it turns the last
      // token into an FTS5 prefix term. Trimming here — and again in
      // `noteSearch.setQuery` — strips that signal on every request, so there is
      // no keystroke, no pause and no Enter that makes this client ask for a
      // completed term. MEASURED on the Pi (`docs/scratch/search-baseline.md`):
      // the same page of 10 costs 810.3 ms p50 as a prefix against 80.6 ms
      // completed, 10.0x, and 95% of it is the FTS posting scan. The server's
      // `vm_steps` counter is IDENTICAL (1,129) for both, so no backend test
      // sees it.
      //
      // NOT CHANGED HERE, deliberately. Sending the space once the box settles
      // is a UX decision (it changes what a half-typed word matches), and the
      // alternatives are a `prefix=` index on `segment_fts` or doing nothing.
      // The open decision lives in `docs/scratch/backlog.md`.
      const q = query.trim();
      if (q === "") return { query: "", hits: [], usedFuzzy: false, coverage: null };

      const params = new URLSearchParams({ q });
      if (limit !== undefined) params.set("limit", String(limit));
      // Handed back VERBATIM — the cursor is the server's own keyset token and
      // its meaning lives entirely on that side of the wire. See `Api.searchText`.
      if (cursor !== undefined) params.set("cursor", cursor);
      // Raw VO like the rest of the control-plane surface (no `{success}`
      // envelope), so `request()` passes it through while still turning a
      // 401/403 into UNAUTHORIZED — which is what stops a dead session from
      // looking like "no results".
      // The signal reaches `fetch`, so a superseded keystroke gives the
      // connection back rather than merely declining to paint what it returns.
      const r = await request<SearchResults>("GET", `/api/controlplane/search?${params.toString()}`, undefined, signal);
      return {
        query: r.query ?? q,
        // An absent `hits` is the empty result set, not a crash in `.map`.
        hits: (r.hits ?? []).map(normalizeHit),
        // `=== true` rather than `?? false`: this is the one field the server
        // promises never to omit (see `SearchResults.usedFuzzy`), so anything
        // that is not literally `true` means "not an approximate answer" — the
        // reading that makes no claim. A server too old to send it therefore
        // degrades to silence rather than to an accusation of guessing.
        usedFuzzy: r.usedFuzzy === true,
        coverage: normalizeCoverage(r.coverage),
        // Same `emit_null_optional_fields = false` seam rule as every optional
        // here: ABSENT means "no more results", normalized to `undefined` so
        // the fake and the real client hand the UI one shape. Anything that is
        // not a non-empty string degrades the same way — a malformed cursor
        // must end paging honestly, never become a `?cursor=undefined` request
        // or a "More" control pointing at nothing.
        cursor: typeof r.cursor === "string" && r.cursor !== "" ? r.cursor : undefined,
      };
    },

    async searchInNote(noteId: Id, query: string): Promise<NoteSearchResults> {
      // Same pre-network short-circuit as `searchText`, and for the same reason:
      // find searches as you type, so backspacing to empty must cost nothing.
      const q = query.trim();
      if (q === "") return { query: "", pages: [], usedFuzzy: false };

      // AUTO-DRAIN the keyset — the convenience API for a caller that wants the
      // WHOLE set in one await. The keyset walk itself is `drainNoteSearch`, shared
      // with the streaming variant, so the two can never disagree; here we just
      // keep the last (cumulative) batch, which is the complete result. Each batch
      // is a separate request (the fairness win on the single-core Pi: a separate
      // small db-lock window with a yield point between, never one multi-second
      // hold); `normalizePageMatches` stable-sorts by pageIndex, so a
      // legacy-scattered band still displays in reading order.
      let final: NoteSearchResults = { query: q, pages: [], usedFuzzy: false };
      await drainNoteSearch(noteId, q, (b) => {
        final = { query: b.query, pages: b.pages, usedFuzzy: b.usedFuzzy };
      });
      return final;
    },

    searchInNoteStream(
      noteId: Id,
      query: string,
      onBatch: (batch: NoteSearchBatch) => void,
      signal?: AbortSignal,
    ): Promise<void> {
      // The STREAMING variant: same keyset, same query, but each batch is handed
      // up as it lands so find can show first matches + a "N+" floor at once and
      // settle to exact on the last batch. The short-circuit costs nothing on a
      // blank box, exactly as the drain does — but it still emits ONE empty `done`
      // batch, so a consumer's "settled empty" path fires without a network hit.
      const q = query.trim();
      if (q === "") {
        onBatch({ query: "", pages: [], usedFuzzy: false, done: true });
        return Promise.resolve();
      }
      return drainNoteSearch(noteId, q, onBatch, signal);
    },

    async searchInTxt(noteId: Id, query: string): Promise<TxtSearchResults> {
      // Same pre-network short-circuit as `searchInNote`: the viewer searches
      // as you type, so backspacing to empty must cost nothing. Drains the shared
      // paragraph keyset to the exact, complete set — the `.txt` pathology (a
      // 9000-paragraph file) is precisely why the walk chunks into small lock
      // windows rather than one scan.
      const q = query.trim();
      if (q === "") return { query: "", segments: [], usedFuzzy: false };

      let final: TxtSearchResults = { query: q, segments: [], usedFuzzy: false };
      await drainTxtSearch(noteId, q, (b) => {
        final = { query: b.query, segments: b.segments, usedFuzzy: b.usedFuzzy };
      });
      return final;
    },

    searchInTxtStream(
      noteId: Id,
      query: string,
      onBatch: (batch: TxtSearchBatch) => void,
      signal?: AbortSignal,
    ): Promise<void> {
      const q = query.trim();
      if (q === "") {
        onBatch({ query: "", segments: [], usedFuzzy: false, done: true });
        return Promise.resolve();
      }
      return drainTxtSearch(noteId, q, onBatch, signal);
    },

    // --- WRITES (append-only, at your own marker — see `types.ts`) ---
    // --- BIN WRITES ---
    //
    // Same normalize-at-the-seam discipline as every read above: the server
    // serializes with `emit_null_optional_fields = false`, so an optional that
    // is null is OMITTED rather than sent as `null`, and every field the UI
    // treats as `X | null` has to be defaulted here or the fake and the real
    // client hand the pages two different shapes.

    async listBin(): Promise<import("../core/binTypes").Bin> {
      const r = await request<{
        entries?: {
          kind?: string;
          id?: string;
          name?: string;
          path?: string;
          deletedAt?: number;
          size?: number;
          parentId?: string;
          isRoot?: boolean;
          fileType?: string;
          fileHash?: string;
          firstPage?: PageRef;
          thumbAspect?: { w?: number; h?: number };
        }[];
        totalBytes?: number;
        retentionDays?: number;
        syncVersion?: number;
      }>("GET", "/api/controlplane/bin");
      return {
        entries: (r.entries ?? []).map((e) => ({
          kind: e.kind === "folder" ? ("folder" as const) : ("note" as const),
          id: String(e.id ?? ""),
          name: e.name ?? "",
          path: e.path ?? "",
          deletedAt: typeof e.deletedAt === "number" ? e.deletedAt : 0,
          // Folders carry 0 by contract; a missing number is 0 for the same
          // reason — a row that cannot say what it weighs must not inflate the
          // figure the purge dialog promises to free.
          size: typeof e.size === "number" && Number.isFinite(e.size) ? e.size : 0,
          parentId: e.parentId ?? null,
          isRoot: e.isRoot !== false,
          // A folder has no type of its own; a file with none named falls back
          // to its extension, exactly as the listing seam does.
          fileType: e.kind === "folder" ? "" : (e.fileType ?? fileTypeFromName(e.name ?? "")),
          fileHash: e.fileHash ?? null,
          // Omitted means "nothing renderable", which the row draws as its doc
          // glyph — never as an empty canvas waiting on a page that isn't there.
          firstPage: e.firstPage ? normalizePage(e.firstPage) : null,
          // Same shape, same seam rule as the listing's `thumbAspect`.
          thumbAspect: normalizeAspect(e.thumbAspect),
        })),
        totalBytes: typeof r.totalBytes === "number" ? r.totalBytes : 0,
        // `?? 30` is a floor, not a policy: the number is the server's and the
        // UI quotes it verbatim, but a countdown rendered from `undefined` days
        // would be worse than one rendered from the shipped default.
        retentionDays: typeof r.retentionDays === "number" && r.retentionDays > 0 ? r.retentionDays : 30,
        syncVersion: typeof r.syncVersion === "number" ? r.syncVersion : 0,
      };
    },

    async getBinNoteMeta(id: Id): Promise<NoteMeta> {
      // Byte-identical body to `getNoteMeta`'s (`NoteMetaVO` on both routes), so
      // the normalization has to be identical too — including `pxPerMm`, which
      // the exporter reads as a hard "do not place text" when null.
      const r = await request<NoteMeta>("GET", `/api/controlplane/bin/file/metadata/${encodeURIComponent(id)}`);
      return {
        // The bin never pairs: trashing a PDF does not trash its mark, so
        // annotations here would be a live file's ink on a deleted document.
        annotationsId: null,
        id: r.id,
        name: r.name,
        pages: r.pages.map(normalizePage),
        fileType: r.fileType ?? fileTypeFromName(r.name),
        fileHash: r.fileHash ?? null,
        size: r.size ?? 0,
        pxPerMm: typeof r.pxPerMm === "number" && r.pxPerMm > 0 ? r.pxPerMm : null,
      };
    },

    async getBinPageBytes(id: Id, page: PageRef): Promise<ArrayBuffer> {
      // The live twin's URL with `/api/controlplane/bin` in front of it, and the
      // same contract: `?v=` is the page content hash, so the response is
      // `immutable` and a stale version is a 404 meaning "refetch the metadata".
      const url = `/api/controlplane/bin/note/${encodeURIComponent(id)}/page/${page.index}?v=${encodeURIComponent(page.hash)}`;
      return (await rawFetch(url)).arrayBuffer();
    },

    async trashEntry(id: Id): Promise<import("../core/binTypes").Trashed> {
      const r = await request<{ id?: string; name?: string; isFolder?: boolean; entries?: number }>(
        "DELETE",
        `/api/controlplane/entry/${encodeURIComponent(id)}`,
      );
      return {
        id: String(r.id ?? id),
        name: r.name ?? "",
        isFolder: r.isFolder === true,
        // Never below 1: the clicked row is always one of them, and a 0 would
        // make the undo toast claim nothing happened when something did.
        entries: typeof r.entries === "number" && r.entries > 0 ? Math.floor(r.entries) : 1,
      };
    },

    async restoreEntry(id: Id): Promise<import("../core/binTypes").Restored> {
      const r = await request<{ name?: string; renamed?: boolean; ancestors?: number; descendants?: number }>(
        "POST",
        `/api/controlplane/bin/${encodeURIComponent(id)}/restore`,
      );
      return {
        name: r.name ?? "",
        // `=== true`, strictly. An omitted `renamed` must read as "kept its
        // name" — the claim that says nothing — rather than as a rename the
        // toast would then have to invent a new name for.
        renamed: r.renamed === true,
        ancestors: typeof r.ancestors === "number" && r.ancestors > 0 ? Math.floor(r.ancestors) : 0,
        descendants: typeof r.descendants === "number" && r.descendants > 0 ? Math.floor(r.descendants) : 0,
      };
    },

    async purgeEntry(id: Id): Promise<void> {
      await request("DELETE", `/api/controlplane/bin/${encodeURIComponent(id)}`);
    },

    async emptyBin(): Promise<number> {
      const r = await request<{ entries?: number }>("DELETE", "/api/controlplane/bin");
      return typeof r.entries === "number" && r.entries > 0 ? Math.floor(r.entries) : 0;
    },

    // --- ADMIN WRITES ---
    //
    // `require_admin` on every one of these but `adminElevate`/`adminLock`, so
    // any of them can come back 428 — which `request()` has already turned into
    // an `ApiError` with code `ELEVATION_REQUIRED`, distinct from UNAUTHORIZED
    // so the shell opens the gate instead of signing the admin out. Nothing is
    // caught here: the console owns that decision.

    async adminListUsers() {
      // The ONE endpoint on this surface that answers in snake_case: `UsersVO`
      // serializes the backend's `UserInfo` struct verbatim rather than through
      // a hand-written camelCase VO. Normalized here, at the seam, for the same
      // reason `folderId ?? null` is — so no consumer, and no fake, has to know
      // which convention a given route happened to be written in.
      const r = await request<{
        users?: { id: number; email: string; is_admin?: boolean; must_change?: boolean; created_at?: number }[];
      }>("GET", "/api/admin/users");
      return (r.users ?? []).map((u) => ({
        id: u.id,
        email: u.email,
        // `=== true`, not `??`: an absent flag is the SAFE reading in both
        // directions here — not an admin, and not owing a password change — and
        // a truthy coercion of some future non-boolean would put an `admin` chip
        // on a row that has not earned one.
        isAdmin: u.is_admin === true,
        mustChangePassword: u.must_change === true,
        // Absent reads as 0 rather than NaN, which the row renders as no date at
        // all instead of the literal string "Invalid Date".
        createdAt: typeof u.created_at === "number" ? u.created_at : 0,
      }));
    },

    async adminCreateUser(email: string, isAdmin: boolean): Promise<string> {
      // No password field, by design: the server picks it. See `Api`.
      const r = await request<{ temporaryPassword?: string }>("POST", "/api/admin/users", { email, isAdmin });
      // An empty string would be handed over as though it were a credential, so
      // a response missing the one field the whole flow exists to carry is an
      // error rather than a silent success.
      if (!r.temporaryPassword) throw new ApiError("SERVER", "The server returned an unexpected response.", 200);
      return r.temporaryPassword;
    },

    async adminDeleteUser(id: number): Promise<void> {
      await request("DELETE", `/api/admin/users/${encodeURIComponent(String(id))}`);
    },

    async adminResetPassword(id: number): Promise<string> {
      // Empty body: the server generates the password. It used to take
      // `{password: md5(temp)}` from the caller, which left nothing to show once.
      const r = await request<{ temporaryPassword?: string }>(
        "POST",
        `/api/admin/users/${encodeURIComponent(String(id))}/reset`,
        {},
      );
      if (!r.temporaryPassword) throw new ApiError("SERVER", "The server returned an unexpected response.", 200);
      return r.temporaryPassword;
    },

    async adminElevate(account: string, plaintext: string): Promise<void> {
      // The SAME challenge flow as `api.login`, deliberately re-walked rather
      // than a "just POST the password" shortcut: on a plaintext-HTTP LAN
      // anything replayable is exposed, and this endpoint's whole purpose is to
      // be the thing a stolen session cannot get past.
      const challenge = await request<{ randomCode: string }>(
        "POST",
        "/api/official/user/query/random/code",
        { account },
      );
      const password = await challengeHash(plaintext, challenge.randomCode);
      // No account in the body: the session says who the caller is, and letting
      // a body name a different one would be a way to re-authenticate as
      // somebody else.
      await request("POST", "/api/admin/elevate", { password });
    },

    async adminLock(): Promise<void> {
      await request("POST", "/api/admin/lock", {});
    },

    // F6–F9. Same convention split as the listing above and worth stating once:
    // RESPONSES are snake_case (the service structs are serialized verbatim),
    // REQUEST bodies are camelCase (they are hand-written req structs). Both are
    // normalized here so nothing above the seam has to hold that distinction.

    async adminListDevices(userId: number) {
      const r = await request<{
        devices?: {
          equipment_no: string;
          name?: string;
          model?: string;
          firmware?: string;
          active?: boolean;
          created_at?: number;
        }[];
      }>("GET", `/api/admin/users/${encodeURIComponent(String(userId))}/devices`);
      return (r.devices ?? []).map((d) => ({
        equipmentNo: d.equipment_no,
        // The serial is the one field that always exists, so it stands in for a
        // name the device never sent — better than an empty row.
        name: d.name || d.equipment_no,
        // `?? null`, and load-bearing: `emit_null_optional_fields = false` means
        // a device that never reported a model OMITS the field. Passing that
        // through would print the literal "undefined" on the row.
        model: d.model ?? null,
        firmware: d.firmware ?? null,
        // `!== false` rather than `=== true`: absent must read as ACTIVE here,
        // the opposite of the default everywhere else on this surface. A live
        // binding shown as revoked would invite an admin to "fix" it by
        // re-pairing a tablet that was working.
        active: d.active !== false,
        createdAt: typeof d.created_at === "number" ? d.created_at : 0,
      }));
    },

    async adminUnlinkDevice(userId: number, equipmentNo: string): Promise<void> {
      await request("POST", `/api/admin/users/${encodeURIComponent(String(userId))}/devices/unlink`, {
        equipmentNo,
      });
    },

    async adminGetQuota(userId: number) {
      const r = await request<{ used_bytes?: number; total_bytes?: number }>(
        "GET",
        `/api/admin/users/${encodeURIComponent(String(userId))}/quota`,
      );
      return quotaOf(r);
    },

    async adminSetQuota(userId: number, totalBytes: number) {
      const r = await request<{ used_bytes?: number; total_bytes?: number }>(
        "PUT",
        `/api/admin/users/${encodeURIComponent(String(userId))}/quota`,
        { totalBytes },
      );
      return quotaOf(r);
    },

    async adminGetRetention() {
      return retentionOf(await request<Record<string, number>>("GET", "/api/admin/settings/retention"));
    },

    async adminSetRetention(days: number) {
      return retentionOf(
        await request<Record<string, number>>("PUT", "/api/admin/settings/retention", { retentionDays: days }),
      );
    },

    async adminHealth() {
      const r = await request<{
        health?: {
          version?: string;
          memory_bytes?: number;
          memory_budget_bytes?: number;
          blob_bytes?: number;
          blob_count?: number;
        };
      }>("GET", "/api/admin/health");
      const h = r.health ?? {};
      return {
        version: h.version ?? "unknown",
        // THE ONE FIELD THAT MUST NOT DEFAULT TO A NUMBER. It is `?i64` on the
        // wire and null is OMITTED, so "the platform cannot say" arrives as an
        // absent key — indistinguishable from any other omission. `?? 0` here
        // would paint a panel reading "0 B of 50 MB", which looks like a server
        // using no memory at all: the opposite of what an unreadable figure
        // means. Null travels all the way to the card, which prints "unknown".
        memoryBytes: typeof h.memory_bytes === "number" ? h.memory_bytes : null,
        memoryBudgetBytes: h.memory_budget_bytes ?? 0,
        blobBytes: h.blob_bytes ?? 0,
        blobCount: h.blob_count ?? 0,
      };
    },

    // --- HISTORY (hot-cache versioning) ---
    //
    // Raw VOs like the rest of the control-plane surface (no `{success}`
    // envelope), so `request()` passes them through while still turning a 401/403
    // into UNAUTHORIZED and a `fail()` (404 no-such-version, 507 over-quota) into
    // a real `ApiError`. Page bytes bypass `request()` for `rawFetch`, exactly as
    // the live page route does.

    async noteHistory(id: Id): Promise<FileHistory> {
      const r = await request<{ id?: string; versions?: unknown[] }>(
        "GET",
        `/api/controlplane/note/${encodeURIComponent(id)}/history`,
      );
      return {
        id: r.id ?? id,
        // Newest-first order is the server's; the client never re-sorts (a stable
        // `createdAt` tie between the current blob and a just-restored row would
        // reorder them and lie about which is live). Malformed rows fall away.
        versions: (Array.isArray(r.versions) ? r.versions : [])
          .map((v) => normalizeVersion(v as Record<string, unknown>))
          .filter((v): v is FileVersion => v !== null),
      };
    },

    async historyMeta(id: Id, md5: Hash): Promise<NoteMeta> {
      // The version's OWN page list, from its retained `note_index` (H7) — same
      // `NoteMetaVO` body and same normalization as `getNoteMeta`, only the URL
      // names the version. This is what makes a preview render the version's real
      // page count/dims rather than the live note's.
      const r = await request<NoteMeta>(
        "GET",
        `/api/controlplane/note/${encodeURIComponent(id)}/history/${encodeURIComponent(md5)}/meta`,
      );
      return {
        // A version PREVIEW shows the bytes of a past blob; the mark beside
        // the file today annotates the CURRENT one, so it is not this one's.
        annotationsId: null,
        id: r.id,
        name: r.name,
        pages: r.pages.map(normalizePage),
        fileType: r.fileType ?? fileTypeFromName(r.name),
        fileHash: r.fileHash ?? null,
        size: r.size ?? 0,
        pxPerMm: typeof r.pxPerMm === "number" && r.pxPerMm > 0 ? r.pxPerMm : null,
      };
    },

    async historyPageBytes(id: Id, md5: Hash, index: number): Promise<ArrayBuffer> {
      // No `?v=`: the `:md5` already pins the immutable blob, so the response is
      // content-addressed on its own and browser-HTTP-cached like the live route.
      const url = `/api/controlplane/note/${encodeURIComponent(id)}/history/${encodeURIComponent(md5)}/page/${index}`;
      return (await rawFetch(url)).arrayBuffer();
    },

    async historyPageText(id: Id, md5: Hash, index: number): Promise<PageText> {
      // The version's per-page transcript — the same `{ text, words }` VO as the
      // live `getPageText`, decoded the same way, so the reader's ovals, find's
      // word boxes and the exporter's PDF text layer all light up unchanged when
      // the history scope reroutes here. NO `?v=`: the `:md5` already pins the
      // immutable version, so the transcript is content-addressed with it (unlike
      // the live route, which versions by `textHash`). `rawFetch` rather than
      // `request()`, matching `getPageText`, so a 404 is a real STALE_PAGE.
      const url = `/api/controlplane/note/${encodeURIComponent(id)}/history/${encodeURIComponent(md5)}/page/${index}/text`;
      const res = await rawFetch(url);

      let body: {
        text?: string;
        words?: WordBox[];
        success?: boolean;
        errorCode?: string;
        errorMsg?: string;
      };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        throw new ApiError("SERVER", "The server returned an unexpected response.", res.status);
      }
      if (body && body.success === false) {
        throw new ApiError(body.errorCode ?? "ERROR", body.errorMsg ?? "Something went wrong.", res.status);
      }
      // Same absent-optional reading as `getPageText`: a missing transcript is the
      // empty one, and absent `words` is a page with nothing placeable on it.
      return { text: body?.text ?? "", words: normalizeWords(body?.words) };
    },

    async searchHistory(id: Id, md5: Hash, query: string): Promise<NoteSearchResults> {
      // Same pre-network short-circuit as `searchInNote`: find-in-preview searches
      // as you type, so backspacing to empty must cost nothing.
      const q = query.trim();
      if (q === "") return { query: "", pages: [], usedFuzzy: false };
      const base = `/api/controlplane/note/${encodeURIComponent(id)}/history/${encodeURIComponent(md5)}/search`;
      const r = await request<NoteSearchResults>("GET", `${base}?${new URLSearchParams({ q }).toString()}`);
      return {
        query: r.query ?? q,
        pages: normalizePageMatches(r.pages),
        // The history search NEVER fuzzes (H8) — it is a one-document scan, no
        // corpus vocabulary to widen against. Pinned false so no fuzzy affordance
        // can ever appear on a preview even if a future server sent the flag.
        usedFuzzy: false,
      };
    },

    async restoreVersion(id: Id, md5: Hash): Promise<RestoredVersion> {
      // A 507 (over quota) is thrown by `request()` as `ApiError("QUOTA_EXCEEDED",
      // …, 507)` — the caller surfaces it; the restore changed nothing.
      const r = await request<{ md5?: string; size?: number; createdAt?: number }>(
        "POST",
        `/api/controlplane/note/${encodeURIComponent(id)}/history/${encodeURIComponent(md5)}/restore`,
      );
      return {
        // The restored version IS the one we asked for, so its md5 is the request's
        // — falling back to it keeps the response honest if the server omits it.
        md5: typeof r.md5 === "string" && r.md5 !== "" ? r.md5 : md5,
        size: typeof r.size === "number" && Number.isFinite(r.size) && r.size > 0 ? Math.floor(r.size) : 0,
        createdAt: typeof r.createdAt === "number" && Number.isFinite(r.createdAt) && r.createdAt > 0 ? r.createdAt : 0,
        current: true,
      };
    },

    async historyRaw(id: Id, md5: Hash): Promise<ArrayBuffer> {
      // The version's whole raw blob — same `rawFetch` bypass the per-version page
      // route uses (a non-JSON body), and NO `?v=`: the `:md5` pins the immutable
      // version, so the response is content-addressed and browser-HTTP-cached on
      // its own. `historyFileUrl` is the one author of this route's shape.
      const url = historyFileUrl(id, md5);
      if (url === null) throw new Error("historyRaw requires an md5");
      return (await rawFetch(url)).arrayBuffer();
    },

    // --- BIN-SCOPED READS (recycle-bin viewer parity) ---
    //
    // The `/bin/…` twins of `getPageText`, `searchInNote` and the history reads,
    // for a file that is in the recycle bin. Each is the live implementation with
    // `/api/controlplane/bin` in front of the URL — a trashed file's transcript,
    // matches and version history are fully retained (md5-keyed, gated `deleted =
    // 1`), so the bodies and normalizations are byte-identical to their live
    // twins. `createBinScope` reroutes a trashed id's reads onto these.

    async binPageText(id: Id, page: PageRef): Promise<PageText> {
      // The bin twin of `getPageText`. No `?v=` and no `textHash` short-circuit:
      // the trashed route resolves the transcript from the file's current md5
      // server-side, so the client asks unconditionally (the reader only calls it
      // for a page whose meta already carried a `textHash`, as it does live).
      const url = `/api/controlplane/bin/note/${encodeURIComponent(id)}/page/${page.index}/text`;
      const res = await rawFetch(url);
      let body: { text?: string; words?: WordBox[]; success?: boolean; errorCode?: string; errorMsg?: string };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        throw new ApiError("SERVER", "The server returned an unexpected response.", res.status);
      }
      if (body && body.success === false) {
        throw new ApiError(body.errorCode ?? "ERROR", body.errorMsg ?? "Something went wrong.", res.status);
      }
      return { text: body?.text ?? "", words: normalizeWords(body?.words) };
    },

    async binSearchInNote(noteId: Id, query: string): Promise<NoteSearchResults> {
      // The bin twin of `searchInNote`, shaped like `searchHistory`: one complete
      // response, no cursor, exact-only (`usedFuzzy` pinned false). Same
      // pre-network short-circuit — find-in-a-trashed-note searches as you type.
      const q = query.trim();
      if (q === "") return { query: "", pages: [], usedFuzzy: false };
      const base = `/api/controlplane/bin/note/${encodeURIComponent(noteId)}/search`;
      const r = await request<NoteSearchResults>("GET", `${base}?${new URLSearchParams({ q }).toString()}`);
      return { query: r.query ?? q, pages: normalizePageMatches(r.pages), usedFuzzy: false };
    },

    async binNoteHistory(id: Id): Promise<FileHistory> {
      const r = await request<{ id?: string; versions?: unknown[] }>(
        "GET",
        `/api/controlplane/bin/note/${encodeURIComponent(id)}/history`,
      );
      return {
        id: r.id ?? id,
        versions: (Array.isArray(r.versions) ? r.versions : [])
          .map((v) => normalizeVersion(v as Record<string, unknown>))
          .filter((v): v is FileVersion => v !== null),
      };
    },

    async binHistoryPageBytes(id: Id, md5: Hash, index: number): Promise<ArrayBuffer> {
      const url = `/api/controlplane/bin/note/${encodeURIComponent(id)}/history/${encodeURIComponent(md5)}/page/${index}`;
      return (await rawFetch(url)).arrayBuffer();
    },

    async binHistoryPageText(id: Id, md5: Hash, index: number): Promise<PageText> {
      const url = `/api/controlplane/bin/note/${encodeURIComponent(id)}/history/${encodeURIComponent(md5)}/page/${index}/text`;
      const res = await rawFetch(url);
      let body: { text?: string; words?: WordBox[]; success?: boolean; errorCode?: string; errorMsg?: string };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        throw new ApiError("SERVER", "The server returned an unexpected response.", res.status);
      }
      if (body && body.success === false) {
        throw new ApiError(body.errorCode ?? "ERROR", body.errorMsg ?? "Something went wrong.", res.status);
      }
      return { text: body?.text ?? "", words: normalizeWords(body?.words) };
    },

    async binSearchHistory(id: Id, md5: Hash, query: string): Promise<NoteSearchResults> {
      const q = query.trim();
      if (q === "") return { query: "", pages: [], usedFuzzy: false };
      const base = `/api/controlplane/bin/note/${encodeURIComponent(id)}/history/${encodeURIComponent(md5)}/search`;
      const r = await request<NoteSearchResults>("GET", `${base}?${new URLSearchParams({ q }).toString()}`);
      return { query: r.query ?? q, pages: normalizePageMatches(r.pages), usedFuzzy: false };
    },

    async binHistoryRaw(id: Id, md5: Hash): Promise<ArrayBuffer> {
      const url = historyFileUrl(id, md5, { bin: true });
      if (url === null) throw new Error("binHistoryRaw requires an md5");
      return (await rawFetch(url)).arrayBuffer();
    },

    // --- RENAME (control-plane) ---
    async rename(id: Id, name: string): Promise<Entry> {
      // `entry/:id` is the same generic per-item noun the trash `DELETE` uses.
      // The server returns the updated entry as a raw VO (no `{success}`
      // envelope), so `normalizeEntry` fills the omitted optionals exactly as a
      // listing entry's are — the reconciled row must be the same shape a
      // `listFolder` would have produced.
      try {
        const r = await request<Entry>(
          "POST",
          `/api/controlplane/entry/${encodeURIComponent(id)}/rename`,
          { name },
        );
        return normalizeEntry(r);
      } catch (e) {
        // The one failure the DIALOG owns rather than the shell: a sibling clash.
        // Mapped to the typed error here, at the seam, so the rule for "which
        // status means the name was taken" lives next to the other status
        // mappings and no view re-derives it. Everything else (a dead session,
        // a category-root refusal, a 5xx) keeps its `ApiError` and routes the
        // usual way.
        if (e instanceof ApiError && e.status === 409) throw new NameTakenError();
        throw e;
      }
    },

    // --- UPLOAD (control-plane) ---
    upload(
      folderId: Id | null,
      file: File,
      onProgress?: (fraction: number) => void,
      signal?: AbortSignal,
      onConflict: UploadConflictMode = "rename",
    ): Promise<Entry> {
      // `XMLHttpRequest`, AND THIS IS THE ONE PLACE IT IS RIGHT. Every other call
      // on this seam is `fetch`; this one needs bytes SENT, and `xhr.upload`'s
      // progress events are the only portable source of them — a `fetch` request
      // body cannot be observed. The consequence
      // is that the envelope/status handling `request()` owns has to be restated
      // below; it is kept deliberately parallel to it, statuses in the same order.
      return new Promise<Entry>((resolve, reject) => {
        const form = new FormData();
        // ONE part, named `file`, with the filename in the part header — the whole
        // of the body contract. The server reads the name from there, sanitizes it
        // and answers 400 if nothing usable survives.
        form.append("file", file, file.name);

        const xhr = new XMLHttpRequest();
        // `root` for the library root: a folder id is an opaque server string, so
        // a sentinel in the PATH is what keeps "no folder" addressable without a
        // second route. `onConflict` rides as a query parameter because it
        // modifies how the body is APPLIED rather than being part of it — and the
        // server defaults it to `rename`, so an old client and a new one differ
        // only in what they can ask for.
        const query = onConflict === "rename" ? "" : `?onConflict=${encodeURIComponent(onConflict)}`;
        xhr.open("POST", `/api/controlplane/folder/${encodeURIComponent(folderId ?? "root")}/upload${query}`);
        xhr.withCredentials = true; // same-origin already sends the cookie; explicit anyway
        xhr.responseType = "text";
        // NO `xhr.timeout`: that is a TOTAL cap, and a total cap is what makes a
        // big upload fail for being big. The budget is silence — see
        // `UPLOAD_STALL_MS`.
        let stalled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const disarm = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
        };
        /** (Re)start the countdown. Every byte that leaves buys another full one. */
        const arm = (ms: number): void => {
          disarm();
          timer = setTimeout(() => {
            stalled = true;
            xhr.abort(); // surfaces through `onabort`, which reads `stalled`
          }, ms);
        };

        // Cancel means STOP SENDING, not "stop looking": an abandoned upload that
        // ran to completion would still have created the file.
        const onAbort = (): void => xhr.abort();
        signal?.addEventListener("abort", onAbort);
        const cleanup = (): void => {
          disarm();
          signal?.removeEventListener("abort", onAbort);
        };

        // ALWAYS bound, whether or not the caller wants a progress bar: this
        // handler is the liveness signal, and reporting progress is the extra.
        xhr.upload.onprogress = (e: ProgressEvent): void => {
          arm(UPLOAD_STALL_MS); // bytes moved — the clock starts over
          // `lengthComputable` is false until the browser knows the body size;
          // reporting a fraction of an unknown total would draw a bar that means
          // nothing, so those events are simply not passed on.
          if (onProgress && e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
        };
        // The last byte is gone; the server is hashing and linking, and no further
        // progress event will ever arrive. Swap the stall budget for a plain one
        // on the answer, or a healthy request would be aborted mid-commit.
        xhr.upload.onload = (): void => arm(UPLOAD_RESPONSE_MS);

        xhr.onerror = (): void => {
          cleanup();
          reject(new ApiError("NETWORK", "Can't reach the server. Check your connection and try again.", 0));
        };
        xhr.ontimeout = (): void => {
          cleanup();
          // A MUTATION that ran out of time is AMBIGUOUS — the file may well have
          // landed — so the message says we do not know, and nothing retries.
          reject(new ApiError("TIMEOUT", TIMEOUT_AMBIGUOUS, 0));
        };
        xhr.onabort = (): void => {
          cleanup();
          // A stall aborts the same way a user does, so the reason has to be
          // carried out of band — otherwise a dead link reads as "you cancelled".
          if (stalled) return reject(new ApiError("TIMEOUT", TIMEOUT_AMBIGUOUS, 0));
          reject(new ApiError("CANCELLED", "Upload cancelled.", 0));
        };
        xhr.onload = (): void => {
          cleanup();
          const status = xhr.status;
          // The three refusals, mapped HERE at the seam so the rule for "which
          // status means which refusal" lives with the other status mappings and
          // no view re-derives it.
          if (status === 413) return reject(new UploadRefusedError("quota", 413));
          if (status === 415) return reject(new UploadRefusedError("type", 415));
          if (status === 400) return reject(new UploadRefusedError("name", 400));
          // The destination is gone, foreign or trashed — deliberately one
          // answer. NOT routed through `statusError`, which reads a 404 as a
          // stale `?v=` (`STALE_PAGE`) and would have the shell refetch a
          // listing to chase page hashes that were never the problem.
          if (status === 404) {
            return reject(new ApiError("NOT_FOUND", "That folder isn't there any more.", 404));
          }
          const known = statusError(status);
          if (known) return reject(known);
          let body: (Entry & Envelope) | null = null;
          try {
            body = JSON.parse(xhr.responseText) as Entry & Envelope;
          } catch {
            body = null;
          }
          if (body && (body as Envelope).success === false) {
            const env = body as Envelope;
            return reject(new ApiError(env.errorCode ?? "ERROR", env.errorMsg ?? "Something went wrong.", status));
          }
          if (status < 200 || status >= 300 || body === null) {
            return reject(new ApiError("SERVER", "The server returned an unexpected response.", status));
          }
          // A raw `EntryVO`, the same shape `rename` answers with, so the row the
          // caller splices into the listing is the row a `listFolder` would have
          // produced.
          resolve(normalizeEntry(body));
        };

        // Aborting BEFORE send would leave the request in a state `send` throws
        // on, so a caller that arrives already-cancelled is answered directly.
        if (signal?.aborted) {
          cleanup();
          reject(new ApiError("CANCELLED", "Upload cancelled.", 0));
          return;
        }
        arm(UPLOAD_STALL_MS); // a connection that never sends a single byte still ends
        xhr.send(form);
      });
    },

    // --- ACCOUNT (self-service) ---
    //
    // See the matching marker in `types.ts` for what each of these is for. What
    // matters HERE is which of them the server can actually answer:
    //
    //   accountSecurity    GET  /api/controlplane/account
    //   myDevices          GET  /api/controlplane/account          (same request)
    //   storageBreakdown   GET  /api/controlplane/account/storage
    //   unlinkMyDevice     POST /api/controlplane/account/devices/unlink
    //   signOutEverywhere  POST /api/controlplane/account/sign-out-others
    //   changePassword     PUT  /api/user/password — the route exists, and it
    //                      IGNORES the current password (see the method)
    //   versionPolicy      GET  /api/controlplane/account          (same request)
    //   setVersionPolicy   PUT  /api/controlplane/account/versions
    //
    // THE SESSION IS THE TARGET on every one of them: not a single route here
    // takes a user id, which is the whole difference between this face and
    // `/api/admin/*`, where every verb names somebody else with an `:id`.
    //
    // Every one of them is now backed by a real route. `changePassword` is the
    // one that is only PARTLY honest: the route exists and the password does
    // change, but the current-password check the form implies is not performed
    // server-side (see the method). `pages/account.ts` still renders each
    // section's failure separately, which is what let this file ship seams ahead
    // of their endpoints without a half-dead page.

    async accountSecurity() {
      const r = await accountRequest();
      return {
        // ABSENT, not null: the backend omits null optionals
        // (`emit_null_optional_fields = false`), so every `?` field has to be
        // read as "the fact does not exist" rather than as 0.
        passwordChangedAt: typeof r.passwordChangedAt === "number" ? r.passwordChangedAt : null,
        otherSessions: typeof r.otherBrowsers === "number" ? r.otherBrowsers : 0,
        thisSessionSince: typeof r.thisSessionSince === "number" ? r.thisSessionSince : null,
      };
    },

    async myDevices() {
      const r = await accountRequest();
      return (r.devices ?? [])
        // ACTIVE ONLY, and the filter belongs here. The route is the admin
        // console's own `listUserDevices`, which INCLUDES revoked bindings so an
        // admin auditing an account can see them; a person looking at their own
        // account wants the list of tablets that sync, and a revoked row there
        // would read as a device still attached.
        .filter((d) => d.active !== false)
        .map((d) => ({
          equipmentNo: d.equipment_no,
          name: d.name ?? "",
          model: d.model ?? null,
          firmware: d.firmware ?? null,
          lastSeenAt: typeof d.last_seen === "number" ? d.last_seen : null,
          linkedAt: d.created_at ?? 0,
        }));
    },

    async unlinkMyDevice(equipmentNo: string): Promise<void> {
      // NOT `/api/controlplane/equipment/unlink`, which is the caller-scoped
      // device-management call and answers 200 for a serial that matched nothing.
      // This one asserts the binding is the caller's and 404s when it is not, so
      // "done" on a row a person is acting on means something happened.
      await request("POST", "/api/controlplane/account/devices/unlink", { equipmentNo });
    },

    async signOutEverywhere(): Promise<number> {
      const r = await request<{ revoked?: number }>("POST", "/api/controlplane/account/sign-out-others");
      return typeof r.revoked === "number" ? r.revoked : 0;
    },

    async storageBreakdown(): Promise<import("./accountTypes").StorageBreakdown> {
      const r = await request<{
        used_bytes?: number;
        total_bytes?: number;
        notebooks?: number;
        sketches?: number;
        documents?: number;
        recycle_bin?: number;
        versions?: number;
      }>("GET", "/api/controlplane/account/storage");
      if (typeof r.used_bytes !== "number" || typeof r.total_bytes !== "number") {
        throw new ApiError("SERVER", "The server returned an unexpected response.", 200);
      }
      // THE FIVE ARE A PARTITION of `used_bytes`, enforced against the tables by
      // the backend's partition audit. Nothing here re-derives or reconciles
      // them: a client that summed the parts and disagreed with the meter would
      // be a second opinion about the one number that must not have two.
      const byKind =
        typeof r.notebooks === "number" &&
        typeof r.sketches === "number" &&
        typeof r.documents === "number" &&
        typeof r.recycle_bin === "number" &&
        typeof r.versions === "number"
          ? {
              notebookBytes: r.notebooks,
              sketchBytes: r.sketches,
              documentBytes: r.documents,
              binBytes: r.recycle_bin,
              versionBytes: r.versions,
            }
          : null;
      return { usedBytes: r.used_bytes, totalBytes: r.total_bytes, byKind };
    },

    async versionPolicy() {
      const r = await accountRequest();
      return readPolicy(r.versions);
    },

    async setVersionPolicy(keep: number) {
      const r = await request<{
        policy?: AccountResponse["versions"];
        removedVersions?: number;
        freedBytes?: number;
      }>("PUT", "/api/controlplane/account/versions", { keep });
      return {
        policy: readPolicy(r.policy),
        // What the change ACTUALLY discarded, so the page confirms the number it
        // predicted rather than repeating its own arithmetic back to itself.
        removedVersions: r.removedVersions ?? 0,
        freedBytes: r.freedBytes ?? 0,
      };
    },

    async changePassword(currentPlaintext: string, newPlaintext: string): Promise<void> {
      // `currentPassword` is REQUIRED of this caller and VERIFIED by the server.
      // `PUT /api/user/password` splits it in two: the handler demands the field
      // of a `controlplane` caller (the policy — a live session is not proof
      // enough, §4), and the service verifies it whenever it is present, before
      // it writes anything and before it revokes a single session. A wrong one
      // costs a wrong one: the account, and every session on it, is left exactly
      // as it was. The refusal comes back as `INVALID_CREDENTIALS`, which
      // `passwordFailureMessage` renders as "That isn't your current password."
      //
      // The route is rate-limited 5 per 5 minutes PER ACCOUNT, because a route
      // that verifies is a route that answers "was that the password?" from any
      // signed-in window. Over that, `request` throws `RateLimitError`.
      //
      // The first-login caller is the other half of the split and lives on the
      // `api` object above: it sends `newPassword` alone, from a `pending` token
      // that has nothing to check a current password against.
      //
      // Hashed at the seam exactly as the new one is, so the plaintext of an
      // existing password is no more exposed on the wire than a new one.
      await request("PUT", "/api/user/password", {
        currentPassword: md5Hex(currentPlaintext),
        newPassword: md5Hex(newPlaintext),
      });
    },
  };
}

// `notImplemented` lived here — the refusal an unbacked seam answered with. It is
// gone because it has no callers: every method under the ACCOUNT marker now
// reaches a real route. Bring it back verbatim from history if a seam is ever
// added ahead of its endpoint again; throwing beat returning a plausible zero,
// which is indistinguishable from the truth.

/** The wire shape of `GET /api/controlplane/account`. Snake-cased inside
 *  `devices` because those rows are the auth service's `DeviceInfo` struct
 *  serialized verbatim — the same convention the admin device listing has. */
interface AccountResponse {
  passwordChangedAt?: number;
  thisSessionSince?: number;
  otherBrowsers?: number;
  devices?: {
    equipment_no: string;
    name?: string;
    model?: string | null;
    firmware?: string | null;
    active?: boolean;
    created_at?: number;
    last_seen?: number;
  }[];
  versions?: {
    keep?: number;
    maxKeep?: number;
    retainedPerFile?: number[];
  };
}

/**
 * `GET /api/controlplane/account`, with CONCURRENT CALLERS SHARING ONE REQUEST.
 *
 * The server deliberately answers identity, sign-in and devices in a single
 * response; the `Api` seam deliberately keeps them as separate methods, so the
 * account page can load and fail each section on its own. Both are right, and
 * the join belongs here — otherwise opening the page fires the same GET twice in
 * the same tick for no reason.
 *
 * The promise is held only while it is IN FLIGHT, never cached: re-entering the
 * page must re-read (a housemate's tablet may have synced, a session may have
 * gone), and a cache here would quietly make the refresh a no-op.
 */
/**
 * The `versions` object, read defensively into a `VersionPolicy`.
 *
 * `retainedPerFile` drives a control that DESTROYS data, so it is filtered to
 * finite non-negative numbers rather than trusted: a stray null in that array
 * makes `Σ max(0, count − keep)` read `NaN`, and "Keeping 3 will remove NaN
 * versions now" is worse than no notice at all — it is the notice, broken, in
 * front of someone about to press the button.
 *
 * A missing `keep`/`maxKeep` falls back to 0, which reads as "versioning off"
 * and offers to discard nothing. That is the safe direction to be wrong in.
 */
function readPolicy(v: AccountResponse["versions"]): import("./accountTypes").VersionPolicy {
  const counts = Array.isArray(v?.retainedPerFile) ? v.retainedPerFile : [];
  return {
    keep: Number.isFinite(v?.keep) ? (v?.keep as number) : 0,
    maxKeep: Number.isFinite(v?.maxKeep) ? (v?.maxKeep as number) : 0,
    retainedPerFile: counts.filter((n): n is number => Number.isFinite(n) && n >= 0),
  };
}

let accountInFlight: Promise<AccountResponse> | null = null;
function accountRequest(): Promise<AccountResponse> {
  if (accountInFlight) return accountInFlight;
  const p = request<AccountResponse>("GET", "/api/controlplane/account").finally(() => {
    if (accountInFlight === p) accountInFlight = null;
  });
  accountInFlight = p;
  return p;
}

/**
 * The quota pair, made safe.
 *
 * `usedBytes` is NOT clamped to `totalBytes`, deliberately: over-quota is a real
 * server state (an allotment lowered below current usage) and the meter is built
 * to draw it. Only non-numbers are floored to 0.
 */
function quotaOf(r: { used_bytes?: number; total_bytes?: number }): { usedBytes: number; totalBytes: number } {
  const n = (v: number | undefined): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return { usedBytes: n(r.used_bytes), totalBytes: n(r.total_bytes) };
}

/**
 * The retention window and its bounds.
 *
 * The bounds are what the edit field validates against BEFORE it posts, so a
 * server too old to send them must not collapse them to 0 — that would make
 * every value look out of range and disable the control entirely. They fall back
 * to the server's own documented 1..365.
 */
function retentionOf(r: Record<string, number>): {
  retentionDays: number;
  defaultDays: number;
  minDays: number;
  maxDays: number;
  changedAt: number;
} {
  const n = (v: number | undefined, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    retentionDays: n(r.retentionDays, 30),
    defaultDays: n(r.defaultDays, 30),
    minDays: n(r.minDays, 1),
    maxDays: n(r.maxDays, 365),
    // 0 is a real answer here — "never changed" — not a missing one.
    changedAt: n(r.changedAt, 0),
  };
}
