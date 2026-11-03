// The API's error taxonomy, and routing a failure to the UI that handles it.

import type { Id, PageRef } from "../core/types";

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

/** A rename clash (409), a subclass so the rename dialog can catch it by type. */
export class NameTakenError extends ApiError {
  constructor() {
    super("NAME_TAKEN", "That name's already used here.", 409);
    this.name = "NameTakenError";
  }
}

/** Why an upload was refused. The client pre-flight produces the same reasons, so both read alike. */
export type UploadRefusal =
  /** 413 — the file would take the account over its quota. */
  | "quota"
  /** 415 — the extension is outside the accept list; the device could not open it. */
  | "type"
  /** 400 — an empty or unusable filename. */
  | "name";

/**
 * `rename` (the default) picks a free name; `replace` supersedes the occupant,
 * whose blob stays restorable in `file_history`. Send `replace` only when the
 * user chose it.
 */
export type UploadConflictMode = "rename" | "replace";

/** A refused upload, caught by type in the queue. A fact about the file, so never retried. */
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


/**
 * The failures a view must act on rather than swallow; everything else stays
 * non-fatal and the view keeps its last good paint.
 */
export interface ApiFailureSink {
  /** Session gone (401/403): re-authenticate. */
  onSessionExpired(): void;
  /** A `?v=` 404'd: refetch whatever owns that hash (meta or listing). */
  onStalePage?(noteId: Id, page: PageRef): void;
  /** 428: the session is fine; open the re-confirm gate and retry on success. */
  onElevationRequired?(): void;
}

/** Route a caught error to `sink`; true when actionable. Non-`ApiError` throws never are. */
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
