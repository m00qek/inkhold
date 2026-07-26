// The admin console's wire types, in a file of their own for one structural
// reason: `types.ts` is APPEND-ONLY at a marker that sits INSIDE the `Api`
// interface, because two features extend that seam in parallel. There is
// therefore nowhere in that file to declare a top-level type without editing
// lines the other feature is editing too. The `Api` methods reach these through
// an inline `import("./adminTypes")` type, which needs no import statement at
// the top of `types.ts`.

/**
 * One household account, as the admin listing sees it.
 *
 * **CAMEL-CASED HERE, SNAKE-CASED ON THE WIRE.** `GET /api/admin/users`
 * serializes the backend's `UserInfo` struct verbatim rather than through a
 * hand-written VO, so it emits `is_admin` / `must_change` / `created_at` — the
 * one endpoint on this surface that does not speak camelCase. `createHttpApi`
 * normalizes at the seam, exactly as it does for the listing's omitted
 * optionals, so nothing above the client has to know which convention the route
 * happened to be written in.
 *
 * **What is deliberately absent:** there is no quota, no device list and no
 * activity timestamp. The first two have no backing route today, and inventing
 * a number for a console whose whole job is to be trusted about what it says
 * would be worse than omitting the section. The third is the line the console
 * does not cross at all — see U7: an admin manages accounts, they do not watch
 * the people using them.
 *
 * `createdAt` survives that rule because it is a fact about the ACCOUNT, not
 * about the person's use of it: it says when you made this login, never when
 * they last picked up their tablet.
 *
 * Quota and devices are NOT folded in here even though the console draws them on
 * the same row: they are separate endpoints per user, they fail separately, and
 * a row whose meter could not be counted must still render the person. See
 * {@link AdminQuota} and {@link AdminDevice}.
 */
export interface AdminUser {
  id: number;
  email: string;
  isAdmin: boolean;
  /**
   * The account still owes a password change — the state both a create and a
   * reset leave it in, and what makes a server-generated temporary password
   * safe to hand over: it unlocks nothing but its own replacement.
   */
  mustChangePassword: boolean;
  /** Account creation, epoch SECONDS (the server's `created_at`, not ms). */
  createdAt: number;
}

/**
 * One tablet bound to one household account.
 *
 * `model` and `firmware` are genuinely OPTIONAL, not merely omitted-when-null:
 * the device sends them at pair time and an old binding may carry neither. A
 * row renders what it has rather than printing "undefined" or inventing a dash
 * that looks like a value.
 */
export interface AdminDevice {
  /** The device serial. The unlink key, and unique per binding. */
  equipmentNo: string;
  /** What the device calls itself. */
  name: string;
  model: string | null;
  firmware: string | null;
  /**
   * The binding is live. **A REVOKED BINDING IS STILL LISTED** — revocation is a
   * soft status flip rather than a row delete, and that is precisely what makes
   * re-pairing possible. So `false` here means "unlinked, and re-pairable with
   * the device in hand", which the row must SAY rather than hide by filtering.
   */
  active: boolean;
  /** When the binding was made, epoch SECONDS — the row's "since". */
  createdAt: number;
}

/**
 * One person's storage accounting, in bytes.
 *
 * **`usedBytes` CAN EXCEED `totalBytes`, and that is not a bug to normalize.**
 * Lowering an allotment below what someone already stores is accepted, stores
 * verbatim, and deletes nothing — it stops their next sync until they free
 * space. Clamping the meter to full would hide the one state the control exists
 * to produce. See the `is-over` branch in the console's meter.
 */
export interface AdminQuota {
  usedBytes: number;
  totalBytes: number;
}

/** The recycle bin's server-wide retention window, with its own bounds. */
export interface AdminRetention {
  retentionDays: number;
  /** What the install started at, so the UI can say what "back to normal" is. */
  defaultDays: number;
  minDays: number;
  maxDays: number;
  /**
   * Epoch SECONDS of the last change, 0 if never — and also the moment the
   * non-retroactive grace period started. Changing the window never purges
   * retroactively: an entry's clock runs from the LATER of when it was trashed
   * and when the window last changed, so shortening 30 days to 7 gives every
   * entry already in the bin a full 7 more days rather than making a month of
   * them instantly due. (`settings.sweepCutoff`.)
   */
  changedAt: number;
}

/**
 * Server-wide health. Household totals only — there is deliberately no
 * per-person figure of any kind here, for the same reason the people rows carry
 * no activity.
 */
export interface AdminHealth {
  version: string;
  /**
   * Resident set size in bytes, or **null where the platform cannot report it**
   * (only Linux is wired up). It must render as "unknown", never as `0 B`: a
   * memory panel reading zero looks like a healthy server, which is the exact
   * opposite of what an unreadable figure means.
   */
  memoryBytes: number | null;
  /** The 50 MB ceiling this project holds itself to. Memory is never shown
   *  alone — "31.4 MB" means nothing without the budget it is measured against. */
  memoryBudgetBytes: number;
  /**
   * Bytes held by the content-addressed blob store. DEDUPLICATED disk, not the
   * sum of everyone's quota usage: a blob two housemates share is one row here
   * and is charged to both of them in their meters. "How full is this machine"
   * is the honest question for a server panel; the per-person figure is what the
   * quota meter is for.
   */
  blobBytes: number;
  blobCount: number;
}
