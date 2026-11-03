// The self-service account surface's wire types: what a person may see and
// change about their own account. Kept out of `types.ts`, like `adminTypes.ts`.

/**
 * One tablet bound to your account. Unlike `AdminDevice`: only active
 * bindings, and it carries a last-seen (own-device recency is not the
 * surveillance U7 forbids).
 */
export interface MyDevice {
  equipmentNo: string;
  name: string;
  model: string | null;
  firmware: string | null;
  /**
   * The last request this device made, epoch seconds
   * (`sessions.last_used_at`, `device` audience), or null if unseen since
   * pairing. "Last seen", not "last synced": the server records requests.
   */
  lastSeenAt: number | null;
  linkedAt: number;
}

/**
 * The five figures the Storage section splits a total into: a partition of
 * charged bytes summing to {@link StorageBreakdown.usedBytes}. The server
 * applies precedence live kinds > bin > versions, since a blob shared with a
 * live file frees nothing when the bin is emptied. The client draws as given.
 */
export interface StorageByKind {
  /** `.note` — notebooks written on the device. */
  notebookBytes: number;
  /** `.spd` — sketches / the drawing app's files. */
  sketchBytes: number;
  /** Everything else the device opens, images included for now. */
  documentBytes: number;
  /**
   * Trashed files and their retained versions, i.e. what emptying the bin
   * returns.
   */
  binBytes: number;
  /** Retained versions of live files. */
  versionBytes: number;
}

/**
 * What Storage draws: the total and, when the server can produce it, the split
 * by kind. `byKind` is null for a server too old to split; don't invent it.
 * `usedBytes` may exceed `totalBytes`; don't clamp.
 */
export interface StorageBreakdown {
  usedBytes: number;
  totalBytes: number;
  byKind: StorageByKind | null;
}

/**
 * Versions kept per file (the hot cache's `K`), applied to each file
 * independently, not as a pool. `keep = 0` turns versioning off entirely.
 */
export interface VersionPolicy {
  /** Versions kept per file. 0 means no version history at all. */
  keep: number;
  /** The admin's ceiling; the global `max_bytes` remains a backstop. */
  maxKeep: number;
  /**
   * Retained count for each file that has history, so the control can state
   * "will remove N versions" (`Σ max(0, count − keep)`) before it happens:
   * discarded versions do not go to the bin.
   */
  retainedPerFile: readonly number[];
}

/** The result of changing `keep`, so the UI can confirm the number it predicted. */
export interface VersionPolicyChange {
  policy: VersionPolicy;
  /** Versions discarded by this change. 0 when raising or unchanged. */
  removedVersions: number;
  /** Bytes those discarded versions were occupying. */
  freedBytes: number;
}

/** What the "Signing in" section knows beyond the password itself. */
export interface AccountSecurity {
  /**
   * Last password change, epoch seconds, or null when unrecorded, which is
   * common (accounts predating `password_changed_at`) and does not mean stale.
   */
  passwordChangedAt: number | null;
  /**
   * Other signed-in control-plane sessions, this browser excluded (the server
   * identifies the presented token by hashing it).
   */
  otherSessions: number;
  /** When this browser signed in, epoch seconds, or null. */
  thisSessionSince: number | null;
}
