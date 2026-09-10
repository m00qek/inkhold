// The SELF-SERVICE account surface's wire types (
// §5–§7): what a person may see and change about their OWN account, as opposed
// to what an admin may do to somebody else's.
//
// In a file of their own for the same structural reason `adminTypes.ts` is:
// `types.ts` is APPEND-ONLY at markers INSIDE the `Api` interface, because
// several features extend that seam in parallel, so there is nowhere in it to
// declare a top-level type without editing lines another feature is editing.
// The `Api` methods reach these through an inline `import("./accountTypes")`
// type, which needs no import statement at the top of `types.ts`.
//
// ============================================================================
// MOST OF THIS IS BACKED NOW; THE REST SAYS SO OUT LOUD.
// ============================================================================
// Four control-plane routes serve this surface — see the `--- ACCOUNT ---`
// marker in `types.ts` for the list and for what is still missing (the per-file
// retained counts, the write that sets `keep`, and verification of the current
// password). `fake.ts` implements the whole surface as it is meant to behave;
// `client.ts` throws a named `NOT_IMPLEMENTED` for what has no route rather than
// inventing a plausible number, because a page whose whole job is to be trusted
// about your own account cannot afford one.

/**
 * One tablet bound to YOUR account.
 *
 * The self-service twin of {@link import("./adminTypes").AdminDevice}, and a
 * separate type rather than a reuse, for two reasons that are both about scope:
 *
 *  - **ONLY ACTIVE BINDINGS.** The admin listing includes revoked ones because
 *    an admin is auditing; a person looking at their own account wants the list
 *    of tablets that sync, and a revoked row would read as a device still
 *    attached. Unlinking removes the row here.
 *  - **IT CARRIES A LAST-SEEN.** The admin console deliberately shows no
 *    activity for anybody — that is surveillance of a housemate (admin-console
 *    U7). Your own device's recency is not surveillance, it is the one fact that
 *    makes "is this thing actually working?" answerable, and it is what turns
 *    the row from a serial number into an object: "Nomad · last seen 20 minutes
 *    ago".
 */
export interface MyDevice {
  /** The device serial — the unlink key, and unique per binding. */
  equipmentNo: string;
  /** What the device calls itself ("Nomad"). The row's name. */
  name: string;
  model: string | null;
  firmware: string | null;
  /**
   * The last REQUEST this device made, epoch SECONDS
   * (`sessions.last_used_at` for the `device` audience), or null when it has not
   * been seen since pairing.
   *
   * **"LAST SEEN", NOT "LAST SYNCED", and the difference is the whole naming
   * decision** (§7). What the server records is the last request; that is
   * usually a sync and is not the same claim. The wider word would be right
   * almost always and wrong occasionally, which is exactly the register this app
   * has spent its time removing.
   *
   * Null must render as an absence, never as an old date: a device paired an
   * hour ago and one that has never spoken are different states.
   */
  lastSeenAt: number | null;
  /** When the binding was made, epoch SECONDS. */
  linkedAt: number;
}

/**
 * The FIVE figures the Storage section splits a total into.
 *
 * **A PARTITION OF THE CHARGED BYTES, not five overlapping counts** (§8): every
 * charged blob lands in exactly one of these, and together they equal
 * {@link StorageBreakdown.usedBytes}. That only holds with a stated precedence,
 * because one blob is reachable several ways, and the precedence is the server's
 * to apply:
 *
 *   1. **live kinds** — any blob a live file references, split by that file's
 *      kind;
 *   2. **recycle bin** — blobs reachable only from trashed files or from the
 *      versions of trashed files, and not already counted live;
 *   3. **versions** — blobs reachable only from the history of LIVE files.
 *
 * A blob shared by a live file and a trashed one frees NOTHING when the bin is
 * emptied, so counting it under the bin would make that line a lie — which is
 * why live wins. The same argument puts a blob shared by a live file and a
 * version under live.
 *
 * The client does no arithmetic to reconcile these; it draws what it is given.
 * The invariant is enforced where it can be — against the tables, by the
 * partition test §8 requires of the backend.
 */
export interface StorageByKind {
  /** `.note` — notebooks written on the device. */
  notebookBytes: number;
  /** `.spd` — sketches / the drawing app's files. */
  sketchBytes: number;
  /**
   * Everything else the device opens: PDF, EPUB, Word, text, CBZ, FB2, XPS —
   * and IMAGES, folded in here for now. Whether images deserve a line of their
   * own is an open question in §7 to be decided against a real household's
   * numbers.
   */
  documentBytes: number;
  /**
   * Trashed files AND THE VERSIONS OF TRASHED FILES, which keep charging.
   *
   * **THE FIGURE MEANS "WHAT EMPTYING THE BIN RETURNS"**, and it only means that
   * with the trashed files' retained versions inside it — history follows a file
   * into the bin and is purged with it. A line
   * promising 600 KB that frees 900 KB would be wrong in the user's favour,
   * which is still wrong.
   *
   * FIVE LINES, NOT FOUR, and the numbers found the fifth: against the live
   * database the three live kinds summed to 484,989,082 while `used_bytes` read
   * 485,586,098 — the difference being two trashed files. Someone who has just
   * deleted a notebook would otherwise see a full meter with hundreds of MB that
   * nothing on the page explains, and the bin is the ONE line whose remedy is a
   * click away.
   */
  binBytes: number;
  /** The retained copies behind Version history — of LIVE files (the trashed
   *  ones' copies are in {@link StorageByKind.binBytes}). */
  versionBytes: number;
}

/**
 * What Storage draws: the total, and — when the server can produce it — the
 * split by KIND.
 *
 * **Split by TYPE, not by the device's folders**, deliberately: a person asking
 * "what is using my space" is asking about kinds of thing, and a file's folder
 * is a place they chose rather than a fact about its size (§7).
 *
 * `byKind` IS SEPARATELY NULLABLE, for a server too old to answer the split:
 * the total is knowable from `GET /api/controlplane/usage` alone, and a client
 * that could report it honestly must not invent the five figures beside it. The
 * section draws what it has, exactly as the admin console renders a person whose
 * meter could not be counted.
 *
 * `usedBytes` may exceed `totalBytes` — an allotment can be lowered below what
 * is already stored — for the same reason {@link import("./adminTypes").AdminQuota}
 * says so, and it must be drawn rather than clamped.
 */
export interface StorageBreakdown {
  usedBytes: number;
  totalBytes: number;
  byKind: StorageByKind | null;
}

/**
 * How many versions of EACH FILE are kept — the hot cache's `K`, as a per-user
 * setting (§7).
 *
 * **PER FILE, NOT A POOL.** `keep` is applied to every file independently, which
 * is what `K` already means; copy that implies a shared budget of versions is
 * describing a different feature.
 *
 * **ZERO IS A REAL SETTING.** `keep = 0` turns versioning off end to end
 * (`recordHistory` never runs). Someone who would rather spend every byte on
 * live files must be able to say so, so 0 is a value the control offers rather
 * than a disabled state it falls into.
 */
export interface VersionPolicy {
  /** Versions kept per file. 0 means no version history at all. */
  keep: number;
  /**
   * The ceiling the ADMIN'S CONFIG sets, so one person cannot decide the whole
   * household's disk policy. The control clamps to it and says what it is; the
   * global `max_bytes` stays as a backstop behind both.
   */
  maxKeep: number;
  /**
   * How many versions are retained for each file that has any — one entry per
   * such file, in no particular order.
   *
   * THIS IS WHAT LETS THE CONTROL STATE ITS COST BEFORE IT IS PAID: "Keeping 3
   * will remove 8 versions now" is `Σ max(0, count − 3)` over this list, and it
   * has to be a fact stated in the interface rather than an apology afterwards,
   * because discarded versions are gone — the recycle bin does not hold them.
   * A household has tens of files with history, not millions, so shipping the
   * counts costs less than a second endpoint that answers one hypothetical at a
   * time.
   */
  retainedPerFile: readonly number[];
}

/** The result of lowering (or raising) `keep`: the new policy, and what the
 *  change actually discarded. Reported so the interface can confirm the number
 *  it predicted rather than assert it twice. */
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
   * When the password was last changed, epoch SECONDS, or null when the server
   * has no record of it.
   *
   * **NULL IS THE COMMON CASE, AND IT IS NOT "STALE".** `users` carries
   * `created_at` and nothing else today; the `password_changed_at` column is one
   * of the two additive columns §8 decides to add, and it only becomes true from
   * the day it lands — so every existing account reads as unrecorded until its
   * owner next changes one. The copy has to be honest about that rather than
   * implying the password is old (see `passwordAgeLabel`).
   */
  passwordChangedAt: number | null;
  /**
   * How many OTHER sessions are signed in — this browser excluded, which is
   * what makes the figure actionable: it is the answer to "is anyone else in my
   * account?", and counting yourself would make the honest answer read as 1.
   *
   * Server-side this is `sessions` filtered by user and `audience='controlplane'`
   * and unexpired, minus the presented token — which the handler can identify by
   * hashing it, so the client never has to name its own session.
   */
  otherSessions: number;
  /**
   * When THIS browser signed in, epoch SECONDS (`sessions.created_at` for the
   * presented token), or null when the server cannot say. It is what turns "this
   * browser" from a label into a row you can check against your own memory.
   */
  thisSessionSince: number | null;
}
