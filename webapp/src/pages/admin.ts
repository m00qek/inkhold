// The admin console (docs/scratch/admin-console.md, U1–U8): the elevation gate,
// and the household as A LIST OF PEOPLE.
//
// Split the way `noteSearch.ts` and `rail.ts` are split — all of the state and
// all of the decisions in a controller with the DOM injected as an
// {@link AdminView}, and a painter that knows nothing about elevation. The seam
// earns its keep here more than anywhere else in the app: the load-bearing logic
// is the ELEVATE-AND-RETRY loop, which is a sequence of two API calls around a
// user interaction and would otherwise only be reachable through a browser.
//
// WHY THE CONSOLE IS A LIST OF PEOPLE. Devices and bytes belong to someone. A
// devices table plus a storage table would make an admin cross-reference three
// lists to answer one question ("whose tablet is that, and are they out of
// space?"), so everything that affects a person sits on their row.
//
// WHAT THE CONSOLE SHOWS, AND THE THREE SHAPES IT MUST DRAW HONESTLY. Each of
// these is a real server state that a tidier-looking UI would quietly hide:
//
//   1. USED CAN EXCEED ALLOTTED. Lowering someone's allotment below what they
//      already store is accepted, stores verbatim, and deletes nothing — it
//      stops their next sync until they free space. That over-quota state is the
//      whole point of the control, so the meter names it rather than clamping
//      the bar to full and saying nothing.
//   2. MEMORY CAN BE UNKNOWN. `memory_bytes` is null off Linux. A panel reading
//      "0 B of 50 MB" looks like a server using no memory at all, which is the
//      opposite of what an unreadable figure means, so it reads "unknown".
//   3. A REVOKED DEVICE IS STILL A DEVICE. Unlinking is a soft status flip, not
//      a row delete — that is exactly what makes re-pairing possible — so a
//      revoked binding stays on the row, labelled, instead of vanishing.
//
// And one thing is absent by DECISION rather than for lack of a route: there is
// no per-person activity anywhere — no last-sync, no note counts. Both read as
// operational stats and are really surveillance of a housemate. An admin manages
// accounts; they do not watch the people using them.

import { el } from "../ui/dom";
import { openDialog, type DialogButtons } from "../ui/confirm";
import { field, statusLine } from "../ui/form";
// The shell's shared icon set, not a local copy: the console's Change pencil is
// the app's one edit mark, and a glyph defined twice is what that module exists
// to prevent.
import { ICONS, svg } from "../ui/icons";
import { ApiError, RateLimitError, dispatchApiFailure, type ApiFailureSink } from "../api/client";
import type { AdminDevice, AdminHealth, AdminQuota, AdminRetention, AdminUser } from "../api/adminTypes";
import type { Api } from "../api/types";

/** The admin-only slice of the `Api` seam — all this controller may touch. */
export type AdminApi = Pick<
  Api,
  | "adminListUsers"
  | "adminCreateUser"
  | "adminDeleteUser"
  | "adminResetPassword"
  | "adminElevate"
  | "adminLock"
  | "adminListDevices"
  | "adminUnlinkDevice"
  | "adminGetQuota"
  | "adminSetQuota"
  | "adminGetRetention"
  | "adminSetRetention"
  | "adminHealth"
>;

/**
 * What the console is showing.
 *
 * `locked` IS THE ENTRY STATE, not an error state. The console asks for the
 * password before it renders anything, because it can delete another person's
 * notes and a tablet left signed in on a table must not reach it. It is also
 * where a lapsed elevation returns to mid-session — see {@link run}.
 */
export type AdminState =
  | { kind: "locked"; error: string | null; busy: boolean }
  | { kind: "loading" }
  | { kind: "ready"; people: Person[]; server: Server; busy: boolean }
  | { kind: "failed"; message: string };

/**
 * One person, with everything the console draws about them.
 *
 * `quota` and `devices` are SEPARATELY NULLABLE because they are separate
 * endpoints that fail separately. A row whose meter could not be counted still
 * renders the person, their chips and their actions — losing the whole console
 * because one detail call 404'd would be a worse answer than a row with one
 * fewer line on it.
 */
export interface Person {
  user: AdminUser;
  quota: AdminQuota | null;
  devices: AdminDevice[] | null;
}

/** The server-wide panel. Both halves are nullable for the same reason. */
export interface Server {
  health: AdminHealth | null;
  retention: AdminRetention | null;
}

/** A yes/no decision, optionally guarded by typing something out. */
export interface ConfirmSpec {
  title: string;
  text: string;
  /** The confirming button's label. Always says what it does, never "OK". */
  label: string;
  /** Paint the confirming button as destructive (red). */
  danger?: boolean;
  /**
   * When set, the confirming button stays disabled until the user has typed
   * this string exactly.
   *
   * USED IN EXACTLY ONE PLACE — deleting a person — and that is the whole rule:
   * it is the one action where the person clicking is not the person who loses
   * the data. Everywhere else it is ceremony, and ceremony everywhere is what
   * trains people to type through the prompt that actually matters.
   */
  confirmWord?: string;
}

export interface NewPerson {
  email: string;
  isAdmin: boolean;
}

/**
 * A single number to edit, in the units the value is really stated in — the
 * allotment in gigabytes, the retention window in days. Never raw bytes: nobody
 * types 10737418240.
 */
export interface NumberSpec {
  title: string;
  text: string;
  /** The field's label, and therefore the unit. */
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  confirmLabel: string;
  /** One line under the field, for a consequence the title cannot carry. */
  hint?: string;
}

/** A password to read aloud once, and then never again. */
export interface HandOver {
  email: string;
  password: string;
}

/**
 * The DOM half. Everything here is a question or a paint — no method decides
 * anything, which is what keeps the controller runnable on plain Node.
 */
export interface AdminView {
  render(state: AdminState): void;
  /** Resolves false on Cancel, on Escape, and on any other dismissal. */
  confirm(spec: ConfirmSpec): Promise<boolean>;
  askNewPerson(): Promise<NewPerson | null>;
  /** Resolves null on cancel, or when the field was left unusable. */
  askNumber(spec: NumberSpec): Promise<number | null>;
  /** Resolves when the admin has acknowledged the password. */
  handOver(spec: HandOver): Promise<void>;
  toast(message: string): void;
}

export interface AdminDeps {
  api: AdminApi;
  view: AdminView;
  /** The signed-in admin's address — the account the challenge is issued for. */
  account: string;
  /** The `sn_session` cookie died. Terminal for the whole shell, not just here. */
  onSessionExpired(): void;
  /**
   * The elevation flipped — the gate was satisfied, the admin locked it, or it
   * lapsed under them and the console parked back on the gate.
   *
   * Exists because the rail shows a padlock for this state and a padlock that
   * lies is worse than no padlock. Fired only on a genuine CHANGE (see
   * {@link setElevated}), so a shell that repaints on it is not repainting on
   * every list refresh.
   */
  onElevationChanged(): void;
}

export interface AdminConsole {
  /**
   * Enter the console. Lists the household — which is also what OPENS THE GATE
   * on a first visit, because the listing is `require_admin` and answers 428
   * until the session has been elevated. There is deliberately no separate "am I
   * elevated?" probe: the server is the authority, and asking it twice would
   * leave two answers that can disagree.
   */
  open(): Promise<void>;
  /** Submit the gate's password. */
  unlock(password: string): Promise<void>;
  /** Drop the elevation and return to the gate. */
  lock(): Promise<void>;
  addPerson(): Promise<void>;
  resetPassword(person: AdminUser): Promise<void>;
  deletePerson(person: AdminUser): Promise<void>;
  /** Edit one person's allotment. Below their current usage is allowed. */
  setQuota(person: Person): Promise<void>;
  /** Cut one tablet off from syncing. Re-pairing needs the device in hand. */
  unlinkDevice(person: Person, device: AdminDevice): Promise<void>;
  /** Edit the server-wide recycle-bin window. Never purges retroactively. */
  setRetention(): Promise<void>;
  state(): AdminState;
  /**
   * Is the session elevated right now?
   *
   * NOT derivable from {@link AdminState}. `locked` does mean not elevated, but
   * the converse fails on the first paint: `open()` sets `loading` before the
   * server has said anything, and reading that as "elevated" would flash an
   * unlocked padlock at somebody who is about to be shown the gate. So this is
   * tracked from what the SERVER answered — a successful listing is proof, a 428
   * is proof of the opposite — and never inferred from what is on screen.
   */
  isElevated(): boolean;
}

// --- presentation helpers (pure, shared by controller copy and painter) ------

/**
 * What to CALL someone. The server stores an address and nothing else, so the
 * local part is the whole of the name we have — the same reading the rail's
 * account footer already takes, so one person is not "Ana" in one corner of the
 * app and "ana@household.lan" in another.
 */
export function displayName(email: string): string {
  return email.split("@")[0] || email;
}

/** Two letters for the avatar disc, from the same local part. */
export function initials(email: string): string {
  const name = displayName(email);
  const parts = name.split(/[.\-_]+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "?";
  const b = parts[1]?.[0] ?? parts[0]?.[1] ?? "";
  return (a + b).toUpperCase();
}

/**
 * When the ACCOUNT was made. Epoch seconds from the server, and `0` means the
 * field was absent — rendered as nothing at all rather than as 1 Jan 1970.
 *
 * This is the only date on the screen, and it survives the no-activity rule
 * because it is a fact about the login, not about the person: it says when you
 * created this account, never when they last picked up their tablet.
 */
export function accountAge(createdAtSeconds: number): string {
  if (!Number.isFinite(createdAtSeconds) || createdAtSeconds <= 0) return "";
  return new Date(createdAtSeconds * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * The one sentence the retention control cannot ship without.
 *
 * Changing the window NEVER purges retroactively: an entry's clock runs from the
 * later of when it was trashed and when the window last changed, so shortening
 * 30 days to 7 gives every entry already in the bin a full 7 more days rather
 * than making a month of them instantly due (`settings.sweepCutoff`).
 *
 * Without saying so, an admin lowering the number reasonably fears they have
 * just destroyed everything recoverable — and so does not touch the control at
 * all. A setting nobody dares change is not a setting.
 */
export const RETENTION_NEVER_PURGES =
  "Nothing already in the bin is removed early: everything in it gets a full new window from the moment you change this.";

export const GB = 1024 ** 3;

/**
 * Bytes in the largest unit that leaves a number worth reading.
 *
 * One decimal at GB and whole numbers below it: "5.4 GB" is a figure an admin
 * reasons about, "5.42 GB" and "5793 MB" are both noise. Deliberately binary
 * (1024), matching what the device and the server count in.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

/** What the storage rule draws and what its label says. */
export interface Meter {
  /**
   * The drawn length, 0..100 — CLAMPED, because a track has no room beyond its
   * own length. The over-quota fact is carried by {@link Meter.tone} and by
   * {@link Meter.label}, never by a bar silently pinned at full and saying
   * nothing: a rule that looks identical at 100% and at 140% is the exact lie
   * this console cannot afford.
   */
  fill: number;
  /**
   * `tight` at 90% because a device at 96% is about to fail a sync — that is
   * danger, not decoration — and `over` once the allotment has actually been
   * passed, which is a state an admin creates deliberately by lowering it.
   */
  tone: "normal" | "tight" | "over";
  /** Bytes stored beyond the allotment; 0 when within it. */
  overBytes: number;
  label: string;
}

/**
 * The storage rule for one person.
 *
 * NO CLAMPING OF THE NUMBERS, only of the drawn length. `used > total` is a real
 * and deliberate server state — lowering an allotment below current usage is
 * accepted, deletes nothing, and stops the owner's next sync until they free
 * space — so the label states the overage in bytes rather than letting a full
 * bar imply "exactly full".
 *
 * A zero allotment is the degenerate case of the same thing and gets the same
 * treatment: it is not "no limit", it is a limit of nothing.
 */
export function meterFor(quota: AdminQuota): Meter {
  const used = Math.max(0, quota.usedBytes);
  const total = Math.max(0, quota.totalBytes);

  if (total === 0) {
    return used === 0
      ? { fill: 0, tone: "normal", overBytes: 0, label: "No allotment set" }
      : { fill: 100, tone: "over", overBytes: used, label: `${formatBytes(used)} stored, with no allotment` };
  }

  const ratio = used / total;
  const tone = ratio > 1 ? "over" : ratio >= 0.9 ? "tight" : "normal";
  const base = `${formatBytes(used)} of ${formatBytes(total)}`;
  return {
    fill: Math.min(100, Math.round(ratio * 100)),
    tone,
    overBytes: tone === "over" ? used - total : 0,
    // The overage is spelled out in bytes rather than as a percentage: "400 MB
    // over" is something the owner can act on, "104%" is not.
    label: tone === "over" ? `${base} — ${formatBytes(used - total)} over` : base,
  };
}

/**
 * The memory card's value and its meter, or the honest absence of both.
 *
 * `memoryBytes` is null wherever the platform cannot report it (only Linux is
 * wired up), and that must NOT render as `0 B`: a memory panel reading zero
 * looks like a server using none, which is the opposite of what an unreadable
 * figure means. Memory is also never shown alone — "31.4 MB" says nothing
 * without the 50 MB ceiling this project holds itself to.
 */
export function memoryCard(health: AdminHealth): { value: string; sub: string; meter: Meter | null } {
  const budget = health.memoryBudgetBytes;
  const sub = budget > 0 ? `of ${formatBytes(budget)} budget` : "no budget reported";
  if (health.memoryBytes === null) {
    return { value: "unknown", sub: "this platform does not report it", meter: null };
  }
  return {
    value: formatBytes(health.memoryBytes),
    sub,
    meter: budget > 0 ? meterFor({ usedBytes: health.memoryBytes, totalBytes: budget }) : null,
  };
}

/**
 * How a device row names itself.
 *
 * `model` and `firmware` are genuinely optional on an older binding, so each
 * piece is dropped rather than replaced with a dash that reads like a value.
 */
export function deviceTitle(device: AdminDevice): string {
  return device.model ? `${device.name} (${device.model})` : device.name;
}

export function deviceMeta(device: AdminDevice): string {
  const parts = [device.equipmentNo];
  if (device.firmware) parts.push(`fw ${device.firmware}`);
  const since = accountAge(device.createdAt);
  if (since) parts.push(`since ${since}`);
  return parts.join(" · ");
}

/**
 * A caught failure as one sentence a household admin can act on.
 *
 * The two codes with their own wording are the two the server raises as ordinary
 * outcomes rather than faults — you asked for something it will not do, and it
 * says which. Everything else keeps the client's own message, which already
 * distinguishes "can't reach the server" from a 5xx.
 */
export function failureMessage(e: unknown): string {
  if (e instanceof RateLimitError) {
    const wait = e.retryAfterSeconds ? ` Try again in ${e.retryAfterSeconds}s.` : "";
    return `Too many attempts.${wait}`;
  }
  if (e instanceof ApiError) {
    if (e.code === "EMAIL_EXISTS") return "There is already an account with that address.";
    if (e.code === "LAST_ADMIN") return "That is the last administrator. Make someone else an admin first.";
    return e.message;
  }
  return "Something went wrong. Try again.";
}

/** The gate's own wording. Deliberately does not distinguish its refusals. */
function gateMessage(e: unknown): string {
  if (e instanceof RateLimitError) {
    const wait = e.retryAfterSeconds ? ` Try again in ${e.retryAfterSeconds}s.` : "";
    // Keyed by ACCOUNT on the server, not by IP, so this is genuinely "you have
    // fumbled it five times" and never "a housemate did".
    return `Too many attempts.${wait}`;
  }
  // INVALID_CREDENTIALS covers a wrong password, a non-admin, and a session that
  // still owes a password change — one code, so the endpoint cannot be used to
  // learn who the administrators are. The message keeps that conflation.
  return e instanceof ApiError && (e.code === "INVALID_CREDENTIALS" || e.code === "NO_CHALLENGE")
    ? "That password doesn't match."
    : failureMessage(e);
}

// --- the controller ----------------------------------------------------------

export function createAdminConsole(deps: AdminDeps): AdminConsole {
  const { api, view } = deps;

  let state: AdminState = { kind: "locked", error: null, busy: false };

  function set(next: AdminState): void {
    state = next;
    view.render(state);
  }

  /**
   * Whether the SERVER currently accepts this session's admin calls.
   *
   * Deliberately a separate variable from {@link state} rather than a projection
   * of it — see {@link AdminConsole.isElevated}. It is set from evidence in both
   * directions and never from a guess: a listing that came back is proof we are
   * elevated, a 428 or a lock is proof we are not.
   */
  let elevated = false;

  /** Only a real change notifies, so a shell repainting on it is not repainting
   *  on every refresh of a list that has not changed hands. */
  function setElevated(next: boolean): void {
    if (elevated === next) return;
    elevated = next;
    deps.onElevationChanged();
  }

  /**
   * Callers parked in {@link requireElevation}, waiting to learn whether the
   * gate they opened was satisfied.
   *
   * A LIST, not a single slot, because one interaction can have more than one
   * call in flight — and because a second 428 arriving while the gate is already
   * up must join the queue rather than reset the field the admin is typing into.
   */
  let gateWaiters: ((elevated: boolean) => void)[] = [];

  /** Bumped by every {@link refresh}; only the newest one is allowed to paint. */
  let refreshToken = 0;

  function settleGate(elevated: boolean): void {
    const waiting = gateWaiters;
    gateWaiters = [];
    for (const resolve of waiting) resolve(elevated);
  }

  /**
   * The 428 handler, and the reason `ApiFailureSink` grew an
   * `onElevationRequired` at all.
   *
   * It is NOT folded into `onSessionExpired`: 428 means the session is alive and
   * merely not freshly elevated, and treating it as a dead session would sign
   * the admin out — destroying the very session the gate is about to re-confirm.
   */
  const failures: ApiFailureSink = {
    onSessionExpired: () => {
      // Terminal. Anything parked on the gate is released as "not elevated" so
      // no retry is left hanging on a promise that can never settle.
      settleGate(false);
      // Elevation cannot outlive the session that carried it (the server drops
      // it with the row), so the padlock closes here too — a dead session that
      // still advertised "unlocked" would be the worst version of the lie.
      setElevated(false);
      deps.onSessionExpired();
    },
    onElevationRequired: () => {
      // Back to the entry state, with no error: nothing has gone wrong, the
      // fifteen minutes simply ran out.
      //
      // Bumping the token first is what stops a refresh that was already in
      // flight from repainting the household OVER the gate a moment later. The
      // gate is a state transition that supersedes any pending paint: once the
      // console is locked, nothing that started before the lock may draw.
      refreshToken++;
      setElevated(false);
      set({ kind: "locked", error: null, busy: false });
    },
  };

  /**
   * Park until the gate the sink just opened is settled.
   *
   * The waiter is registered BEFORE the dispatch, because `onElevationRequired`
   * runs synchronously — registering after it would be a race against a gate
   * that could, in a test with a synchronous view, already be satisfied.
   *
   * Note what this does not do: re-derive "428 means the gate". That mapping is
   * the client's, in `dispatchApiFailure`, and a second copy of it here is
   * exactly the drift the sink exists to prevent.
   */
  function requireElevation(e: unknown): Promise<boolean> {
    const waiting = new Promise<boolean>((resolve) => void gateWaiters.push(resolve));
    dispatchApiFailure(failures, e);
    return waiting;
  }

  function isElevationLapsed(e: unknown): boolean {
    return e instanceof ApiError && e.code === "ELEVATION_REQUIRED";
  }

  /**
   * THE ELEVATE-AND-RETRY LOOP — every admin call goes through here.
   *
   * An elevation lapses on a fifteen-minute idle timer, so the natural failure is
   * an admin who read the list, went to make tea, and came back to click Delete.
   * Making them re-enter the password is the point; making them then find the row
   * again and re-click the button is just a worse way of saying the same thing.
   * So the call that hit the gate is the call that resumes.
   *
   * EXACTLY ONE RETRY, never a loop. A second 428 immediately after a successful
   * elevate is not a stale window — it is a clock skew, a revoked session, or a
   * server that disagrees with itself — and retrying that forever would spin the
   * gate at the user until they close the tab.
   *
   * Returns null for "did not happen", which every caller treats as "change
   * nothing": a failed reset must not flip a row to must-change, and a failed
   * delete must not remove one.
   */
  async function run<T>(op: () => Promise<T>): Promise<T | null> {
    try {
      return await op();
    } catch (e) {
      if (!isElevationLapsed(e)) return report(e);
      if (!(await requireElevation(e))) return null;
      try {
        return await op();
      } catch (again) {
        return report(again);
      }
    }
  }

  /**
   * A failure that is not the gate. Session death is handed to the shell; a
   * merely broken call is shown where the user was looking — as the gate's error
   * line if we are behind the gate, and as the console's own failure state
   * otherwise, since a console that quietly shows a stale list after a failed
   * refresh is claiming something it does not know.
   */
  function report(e: unknown): null {
    if (dispatchApiFailure(failures, e)) return null;
    if (state.kind === "locked") set({ kind: "locked", error: failureMessage(e), busy: false });
    else if (state.kind === "ready") {
      set({ kind: "ready", people: state.people, server: state.server, busy: false });
      view.toast(failureMessage(e));
    } else set({ kind: "failed", message: failureMessage(e) });
    return null;
  }

  /**
   * Re-list the household. The one place `people` is ever set.
   *
   * NOT through {@link run}, and that is the one deliberate exception to "every
   * call goes through the loop". A 428 here only has to RAISE the gate: `unlock`
   * re-lists on success anyway, so parking this call to resume it would list the
   * household twice on every entry — and, worse, leave a promise parked on a
   * gate that an admin who simply walked away will never satisfy.
   *
   * Resuming is for work the user asked for by name. Opening the console is not
   * that; deleting a person is.
   */
  async function refresh(): Promise<void> {
    // GENERATION TOKEN, the same device `library.ts` uses for route changes, and
    // load-bearing rather than defensive: a refresh is a chain of awaits, and two
    // of them overlap on the ordinary path — unlocking the gate re-lists while
    // the call the gate interrupted is resuming and will re-list when it lands.
    // Without this the older chain can finish last and repaint the list as it was
    // BEFORE the action completed, so a deleted person reappears.
    const mine = ++refreshToken;
    if (state.kind !== "ready") set({ kind: "loading" });
    try {
      const users = await api.adminListUsers();
      // THE PROOF. `adminListUsers` is `require_admin` and answers 428 until the
      // session has been elevated, so a listing that came back is the server
      // saying we are in — and it covers the case no explicit unlock does: an
      // admin re-entering the console on a still-live elevation, who is never
      // shown a gate and so never calls `unlock`.
      setElevated(true);
      if (mine !== refreshToken) return; // a newer refresh owns the paint

      // SEQUENTIAL, not `Promise.all`, and that is deliberate rather than lazy.
      // The server serialises every connection on one coarse `db_lock`, so
      // firing 2N requests at once would only make them queue on a mutex — while
      // the browser's ~6-per-origin cap turned the queue into something the
      // gallery's own reads have to contend with. A household is three or four
      // people; a handful of round-trips on a LAN is not the cost worth
      // optimising, and this way a 428 stops at the first call rather than after
      // eight of them have already failed.
      const people: Person[] = [];
      for (const user of users) {
        people.push({
          user,
          quota: await detail(() => api.adminGetQuota(user.id)),
          devices: await detail(() => api.adminListDevices(user.id)),
        });
      }

      const server: Server = {
        health: await detail(() => api.adminHealth()),
        retention: await detail(() => api.adminGetRetention()),
      };
      if (mine !== refreshToken) return;
      set({ kind: "ready", people, server, busy: false });
    } catch (e) {
      // THE SAME GUARD THE TWO SUCCESS POINTS ABOVE KEEP, missing here only
      // because a failure did not look like a paint. It is one: `report` writes
      // the failure onto whatever state is CURRENT, and when the console is
      // locked that means the gate's error line. Two refreshes overlap on the
      // ordinary path (unlocking re-lists while the call the gate interrupted
      // resumes and re-lists), and `onElevationRequired` bumps this token
      // deliberately — so without this, a superseded refresh failing on a dropped
      // connection could write "Can't reach the server" onto the elevation gate
      // the admin is at that moment typing their password into, or replace a
      // newer household with a `failed` screen about an older one.
      //
      // Dropped WHOLE, including session death, which is the same reading the
      // recycle bin's refresh takes (`bin.ts`: the token check precedes
      // `handled`): a dead session fails every subsequent call identically, so it
      // reaches the shell through the chain that still has a reader.
      if (mine !== refreshToken) return;
      report(e);
    }
  }

  /**
   * A detail call that may fail WITHOUT taking the console down — one person's
   * meter, one person's devices, the server panel.
   *
   * The two exceptions are re-thrown, because they are facts about the whole
   * console rather than about one row: a lapsed elevation has to reach the gate,
   * and a dead session has to reach the shell. Swallowing either would leave an
   * admin looking at a page of blank meters with no idea why.
   */
  async function detail<T>(op: () => Promise<T>): Promise<T | null> {
    try {
      return await op();
    } catch (e) {
      if (isElevationLapsed(e) || (e instanceof ApiError && e.code === "UNAUTHORIZED")) throw e;
      return null;
    }
  }

  /** Guard against a second click while a dialog-driven flow is in flight. */
  function busy(on: boolean): void {
    if (state.kind === "ready") set({ kind: "ready", people: state.people, server: state.server, busy: on });
  }

  return {
    state: () => state,
    isElevated: () => elevated,

    async open(): Promise<void> {
      await refresh();
    },

    async unlock(password: string): Promise<void> {
      if (state.kind !== "locked" || state.busy) return;
      set({ kind: "locked", error: null, busy: true });
      try {
        await api.adminElevate(deps.account, password);
      } catch (e) {
        // The session itself can die here too, and that is not a gate failure.
        if (dispatchApiFailure(failures, e)) return;
        set({ kind: "locked", error: gateMessage(e), busy: false });
        return;
      }
      // Release anything parked on the gate FIRST, so a retry resumes with the
      // elevation it was waiting for — then paint. A caller that was mid-flight
      // repaints over `loading` when it lands.
      set({ kind: "loading" });
      settleGate(true);
      // Whoever opened the gate may not have been the listing (a Delete can trip
      // it), so the list is always refreshed: it is what the console shows, and
      // an elevate is exactly the moment it becomes readable again.
      await refresh();
    },

    async lock(): Promise<void> {
      // Painted immediately rather than after the round-trip. "Lock console" is
      // a safety action and it must never appear to hesitate; the server call is
      // idempotent and its failure changes nothing the user can see, since the
      // console is behind the gate either way and the next call will 428.
      refreshToken++; // same rule as the gate: nothing in flight may paint over this
      // Closed IMMEDIATELY, for the same reason the gate paints immediately: the
      // padlock is the answer to "did that work?", and a rail still showing
      // unlocked while the gate is on screen would contradict it.
      setElevated(false);
      set({ kind: "locked", error: null, busy: false });
      settleGate(false);
      try {
        await api.adminLock();
      } catch (e) {
        dispatchApiFailure(failures, e);
      }
    },

    async addPerson(): Promise<void> {
      if (state.kind !== "ready" || state.busy) return;
      const person = await view.askNewPerson();
      if (!person) return;
      busy(true);
      const password = await run(() => api.adminCreateUser(person.email, person.isAdmin));
      if (password === null) {
        busy(false);
        return;
      }
      await refresh();
      // The hand-over is part of creating the account, not a courtesy after it:
      // the server stores only a hash, so this is the single moment the password
      // can be read. Skipping it would leave an account nobody can sign in to.
      await view.handOver({ email: person.email, password });
    },

    async resetPassword(person: AdminUser): Promise<void> {
      if (state.kind !== "ready" || state.busy) return;
      const ok = await view.confirm({
        title: `Reset the password for ${displayName(person.email)}?`,
        text:
          "They will be signed out everywhere and must choose a new password the next time they sign in. " +
          "Their notes are untouched.",
        label: "Reset password",
        // Not destructive: nothing is lost, and painting it red would spend the
        // danger colour on an action the admin can simply do again.
        danger: false,
      });
      if (!ok) return;
      busy(true);
      const password = await run(() => api.adminResetPassword(person.id));
      if (password === null) {
        busy(false);
        return;
      }
      await refresh();
      await view.handOver({ email: person.email, password });
    },

    async deletePerson(person: AdminUser): Promise<void> {
      if (state.kind !== "ready" || state.busy) return;
      const ok = await view.confirm({
        title: `Delete ${displayName(person.email)} permanently?`,
        text:
          "This removes the account and everything in it. It cannot be undone, and the recycle bin does not hold it.",
        label: "Delete permanently",
        danger: true,
        // THE ONE type-to-confirm in the whole app. The address rather than the
        // display name because it is unambiguous, and because it is printed on
        // the row directly above the box the admin is typing into.
        confirmWord: person.email,
      });
      if (!ok) return;
      busy(true);
      const done = await run(() => api.adminDeleteUser(person.id));
      if (done === null) {
        busy(false);
        return;
      }
      await refresh();
      view.toast(`Deleted ${displayName(person.email)}`);
    },

    async setQuota(person: Person): Promise<void> {
      if (state.kind !== "ready" || state.busy) return;
      const name = displayName(person.user.email);
      const current = person.quota;
      const gb = await view.askNumber({
        title: `Allotment for ${name}`,
        text:
          "How much of the server they may fill. Lowering it below what they already store " +
          "does not delete anything — it stops new syncs until they free space.",
        label: "Gigabytes",
        // One decimal, because the meter reads in tenths of a gigabyte and a
        // control that could not express what the row displays would be a
        // different unit from the number it is editing.
        value: current ? round1(current.totalBytes / GB) : 0,
        min: 0,
        max: 65536,
        step: 0.1,
        hint: current ? `They are storing ${formatBytes(current.usedBytes)} today.` : undefined,
        confirmLabel: "Save allotment",
      });
      if (gb === null) return;
      busy(true);
      // Rounded to whole bytes: the server takes an i64 and a fractional byte is
      // not a quantity.
      const saved = await run(() => api.adminSetQuota(person.user.id, Math.round(gb * GB)));
      if (saved === null) {
        busy(false);
        return;
      }
      await refresh();
      // Says what actually happened, including the case the admin may not have
      // meant: they are now over it, and their next sync will be refused.
      const over = saved.usedBytes > saved.totalBytes;
      view.toast(
        over
          ? `${name} is now ${formatBytes(saved.usedBytes - saved.totalBytes)} over their allotment`
          : `Allotment for ${name} is now ${formatBytes(saved.totalBytes)}`,
      );
    },

    async unlinkDevice(person: Person, device: AdminDevice): Promise<void> {
      if (state.kind !== "ready" || state.busy) return;
      const name = displayName(person.user.email);
      const ok = await view.confirm({
        title: `Unlink ${deviceTitle(device)} from ${name}?`,
        text:
          "It stops syncing immediately. Their notes stay on the server, and the copies already " +
          "on the tablet stay there too. Linking it again needs the device in hand.",
        label: "Unlink device",
        // Destructive: it cuts a tablet off, and undoing it is not a click.
        danger: true,
      });
      if (!ok) return;
      busy(true);
      const done = await run(() => api.adminUnlinkDevice(person.user.id, device.equipmentNo));
      if (done === null) {
        busy(false);
        return;
      }
      await refresh();
      view.toast(`Unlinked ${deviceTitle(device)}`);
    },

    async setRetention(): Promise<void> {
      if (state.kind !== "ready" || state.busy) return;
      const current = state.server.retention;
      if (!current) return; // no window to edit; the card is not drawn either
      const days = await view.askNumber({
        title: "How long should the recycle bin hold a note?",
        text:
          "Deleted notes stay recoverable for this long, then they are removed for good. " +
          "They keep counting against their owner's allotment while they wait.",
        label: "Days",
        value: current.retentionDays,
        min: current.minDays,
        max: current.maxDays,
        step: 1,
        // THE SENTENCE THIS CONTROL CANNOT SHIP WITHOUT. An admin lowering 30 to
        // 7 otherwise reasonably fears they have just destroyed a month of
        // recoverable notes, and would not touch the control at all.
        hint: RETENTION_NEVER_PURGES,
        confirmLabel: "Save",
      });
      if (days === null) return;
      busy(true);
      const saved = await run(() => api.adminSetRetention(Math.round(days)));
      if (saved === null) {
        busy(false);
        return;
      }
      await refresh();
      view.toast(`Notes now wait ${saved.retentionDays} days before being removed`);
    },
  };
}

/** Whole tenths — the unit the allotment field edits in. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// --- the painter -------------------------------------------------------------

/**
 * The console's confirm dialog: the shared `openDialog` (src/ui/confirm.ts) with
 * the console's own class set (`admin-dialog*`, `admin-btn`) bound in, so its CSS
 * and e2e selectors carry over unchanged. The invariants — Cancel first, focused
 * and Enter-activated; the destructive button never the default; built per call
 * so a type-to-confirm listener never leaks into the next prompt — live there.
 */
function dialog(
  host: HTMLElement,
  build: (body: HTMLElement, actions: DialogButtons) => void,
  goLabel: string,
  cancelLabel: string,
): { node: HTMLDialogElement; done: Promise<boolean> } {
  return openDialog({
    host,
    classes: {
      dialog: "admin-dialog",
      body: "admin-dialog__body",
      actions: "admin-dialog__actions",
      cancel: "admin-btn",
      go: "admin-btn admin-btn--go",
    },
    goLabel,
    cancelLabel,
    build,
  });
}

/**
 * The console's DOM.
 *
 * `host` is where the dialogs are appended and `body` is what the state paints
 * into; they are separate because a `<dialog>` must survive the wholesale
 * repaint that closing it triggers.
 */
export function createAdminView(opts: {
  host: HTMLElement;
  body: HTMLElement;
  toast(message: string): void;
  onUnlock(password: string): void;
  onAdd(): void;
  onReset(person: AdminUser): void;
  onDelete(person: AdminUser): void;
  onQuota(person: Person): void;
  onUnlink(person: Person, device: AdminDevice): void;
  onRetention(): void;
}): AdminView {
  const { host, body } = opts;

  function gate(state: Extract<AdminState, { kind: "locked" }>): HTMLElement {
    // The app's REAL auth language — `ui/form.ts`'s underlined field and status
    // line, the same components login and change-password are built from. A gate
    // that invented its own password field would be the one password box in the
    // app that looks like somebody else's.
    const password = field({
      id: "admin-elevate",
      label: "Password",
      type: "password",
      autocomplete: "current-password",
      autofocus: true,
    });
    const status = statusLine();
    if (state.error) status.error(state.error);

    // NOT the auth pages' `.button`, and this is a real cascade hazard rather
    // than a preference. `02-app-shell-rail.css`'s control reset —
    // `.sn-root :where(button, input, select) { color: inherit }` — scores the
    // same (0,1,0) as `.button` and is declared later in the manifest, so inside
    // the shell it WINS: the auth button's `color: var(--sheet)` loses and the
    // label paints `--ink` on an `--ink` background, an unreadable black block.
    // (The same reset once did exactly this to the reader's Export button.) The
    // console's own stylesheet is last in the manifest, so its class is the one
    // that holds — and it is outlined rather than filled, because a solid black
    // slab is not this app's language.
    const submit = el("button", {
      class: "admin-gate__submit",
      type: "submit",
      text: state.busy ? "Confirming…" : "Unlock console",
      disabled: state.busy,
    });

    const form = el(
      "form",
      { class: "admin-gate__form" },
      el("p", { class: "admin-gate__mark", text: "Admin console" }),
      el("h1", { class: "admin-gate__title", text: "Confirm your password" }),
      el("p", {
        class: "admin-gate__why",
        // States the reason rather than the rule. Someone who understands why
        // this box is here does not experience it as an obstacle.
        text:
          "This console can delete another person's notes and reset their password, " +
          "so it asks again — a tablet left signed in on a table cannot reach it.",
      }),
      password.row,
      submit,
      status.node,
      el("p", {
        class: "admin-gate__note",
        // Both halves are the server's real numbers (`elevation_idle_s`,
        // `elevation_absolute_s`), not a rounded reassurance.
        text: "Access ends after 15 minutes of inactivity, an hour at the most, or when you lock it.",
      }),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      opts.onUnlock(password.input.value);
      password.input.value = "";
    });
    return el("section", { class: "admin-gate" }, form);
  }

  function chip(text: string, kind: "admin" | "pending"): HTMLElement {
    return el("span", { class: `admin-chip admin-chip--${kind}`, text });
  }

  /**
   * The storage rule. The SAME idiom the recycle bin uses for its retention
   * countdown, so "how much is left" reads the same way in both places instead
   * of the console inventing a second visual language for the same question.
   */
  function meterEl(meter: Meter, label: string, control: HTMLElement | null, bare = false): HTMLElement {
    const fill = el("div", { class: "admin-meter__fill" });
    fill.style.width = `${meter.fill}%`;
    return el(
      "div",
      { class: `admin-meter is-${meter.tone}` },
      el(
        "div",
        {
          class: "admin-meter__track",
          role: "img",
          // The bar is decorative once the label says the same thing in words;
          // naming it keeps a screen reader from having to infer a width.
          "aria-label": `${label}: ${meter.label}`,
        },
        fill,
      ),
      // `bare` in a stat card, where the value and its sub-line already say the
      // same thing in the same words — repeating it under the bar would read as
      // two different figures at a glance.
      bare ? null : el("div", { class: "admin-meter__label" }, el("span", { text: meter.label }), control),
    );
  }

  /**
   * The small bordered "Change" beside the value it changes — ONE editing idiom,
   * used by the allotment and by the retention window alike.
   *
   * GLYPH THEN WORDS, as every other labelled action in this app reads (Empty
   * bin, Unlink, Export, Add person). These two were the only text-only controls
   * left, which made them scan as a link among a row of buttons rather than as
   * the same kind of thing. The pencil is DECORATION — the word already says
   * what happens, and `aria-label` already says what it happens to — so it is
   * `aria-hidden` and a screen reader hears one control, not a mark and a label.
   */
  function changeBtn(ariaLabel: string, onClick: () => void): HTMLButtonElement {
    const b = el(
      "button",
      { class: "admin-change", type: "button" },
      el("span", { class: "admin-change__mark", "aria-hidden": "true", html: svg(ICONS.edit, 1.9) }),
      el("span", { text: "Change" }),
    );
    b.setAttribute("aria-label", ariaLabel);
    b.addEventListener("click", onClick);
    return b;
  }

  /**
   * One tablet. Uniform width, one per line, so a person's devices read as a
   * LIST — pills sized to their own text made two devices look like two
   * different kinds of thing.
   *
   * Unlink is a LABELLED BUTTON, not a chip's dismiss glyph. A bare "×" on a
   * pill reads as "remove this from a selection": harmless, local, undoable by
   * clicking again. This cuts a tablet off from syncing and re-linking needs the
   * device in hand, so it says what it does — and clears the 24px target the
   * bare glyph missed.
   */
  function deviceRow(person: Person, device: AdminDevice, busy: boolean): HTMLElement {
    const name = displayName(person.user.email);
    // A revoked binding gets NO Unlink button — there is nothing left to cut —
    // but it stays on the row, labelled, because the row surviving is exactly
    // what makes re-pairing possible.
    const action = device.active
      ? (() => {
          const b = el("button", { class: "admin-device__cut", type: "button", text: "Unlink", disabled: busy });
          b.setAttribute("aria-label", `Unlink ${deviceTitle(device)} from ${name}`);
          b.title = "Stop this device syncing";
          b.addEventListener("click", () => opts.onUnlink(person, device));
          return b;
        })()
      : el("span", { class: "admin-chip admin-chip--muted", text: "unlinked" });

    return el(
      "div",
      { class: `admin-device${device.active ? "" : " is-revoked"}` },
      el("span", { class: "admin-device__name", text: deviceTitle(device) }),
      el("span", { class: "admin-device__meta", text: deviceMeta(device) }),
      action,
    );
  }

  function devicesEl(person: Person, busy: boolean): HTMLElement {
    // NULL IS NOT EMPTY. A failed device call must not render as the confident
    // "no device linked yet" — that sentence is a claim about the household, and
    // making it from a request that never answered is exactly the invented fact
    // this console avoids.
    if (person.devices === null) {
      return el("div", { class: "admin-devices__none", text: "Devices could not be listed." });
    }
    if (person.devices.length === 0) {
      return el("div", {
        class: "admin-devices__none",
        text: "No device linked yet. One appears here after their first sync.",
      });
    }
    return el("div", { class: "admin-devices" }, ...person.devices.map((d) => deviceRow(person, d, busy)));
  }

  /**
   * One household account.
   *
   * `busy` is the console's in-flight flag, and every control this row owns
   * honours it — exactly as `Add person` already does. NOT a double-submission
   * guard: the controller has one (`busy(true)` around each dialog-driven flow),
   * and it works. This is the FEEDBACK half of it, which was missing: a button
   * that looks pressable, is pressed, and silently does nothing reads as an app
   * that has stopped responding, and the natural next move is to press it again.
   * The server never saw the second click either — so the only thing the gap ever
   * produced was doubt.
   */
  function personRow(person: Person, busy: boolean): HTMLElement {
    const user = person.user;
    const name = displayName(user.email);
    const added = accountAge(user.createdAt);
    const reset = el("button", { class: "admin-btn", type: "button", text: "Reset password", disabled: busy });
    reset.setAttribute("aria-label", `Reset the password for ${name}`);
    reset.addEventListener("click", () => opts.onReset(user));

    const remove = el("button", { class: "admin-btn admin-btn--danger", type: "button", text: "Delete", disabled: busy });
    remove.setAttribute("aria-label", `Delete ${name}`);
    remove.addEventListener("click", () => opts.onDelete(user));

    // Same rule as the devices above: a quota that could not be read renders as
    // an absence, never as a meter at zero. The allotment control stands down
    // while busy the same way the Server panel's retention control does — through
    // absence rather than a disabled state, because it is a bare glyph inside a
    // meter with nowhere to show one.
    const storage = person.quota
      ? meterEl(
          meterFor(person.quota),
          `Storage for ${name}`,
          busy ? null : changeBtn(`Change the allotment for ${name}`, () => opts.onQuota(person)),
        )
      : el("div", { class: "admin-devices__none", text: "Storage could not be counted." });

    return el(
      "article",
      { class: "admin-person" },
      el("span", { class: "admin-avatar", "aria-hidden": "true", text: initials(user.email) }),
      el(
        "div",
        { class: "admin-person__id" },
        el(
          "div",
          { class: "admin-person__name" },
          // TEXT, never markup: an address is user-supplied and reaches this row
          // straight off the wire.
          el("span", { text: name }),
          user.isAdmin && chip("admin", "admin"),
          user.mustChangePassword && chip("must set password", "pending"),
        ),
        el("div", { class: "admin-person__mail", text: user.email }),
        // An empty string means the server did not send a date; the line is then
        // omitted entirely rather than rendered blank.
        added ? el("div", { class: "admin-person__since", text: `Added ${added}` }) : null,
        storage,
        devicesEl(person, busy),
      ),
      el("div", { class: "admin-person__acts" }, reset, remove),
    );
  }

  /** One card in the Server panel. */
  function statCard(k: string, value: string, sub: string, meter: Meter | null, control: HTMLElement | null): HTMLElement {
    return el(
      "div",
      { class: "admin-stat" },
      el("div", { class: "admin-stat__k", text: k }),
      el("div", { class: "admin-stat__v" }, el("span", { text: value }), control),
      el("div", { class: "admin-stat__sub", text: sub }),
      meter ? meterEl(meter, k, null, true) : null,
    );
  }

  /**
   * The server panel. HOUSEHOLD TOTALS ONLY — there is no per-person figure of
   * any kind here, which is the same line the people rows draw.
   *
   * Two cards the mockup once had were cut and stay cut: UPTIME answered "has it
   * crashed?", which in a household you would already know, and LAST SYNC told
   * an admin who had been using their tablet and when — an operational stat's
   * clothes on activity surveillance of a housemate.
   */
  function serverPanel(server: Server, busy: boolean): HTMLElement | null {
    const { health, retention } = server;
    if (!health && !retention) return null; // nothing readable: draw no panel at all

    const cards: (HTMLElement | null)[] = [];
    if (health) {
      const mem = memoryCard(health);
      cards.push(statCard("Memory", mem.value, mem.sub, mem.meter, null));
      // "Disk / 15.0 GB" was read as how much there IS rather than how much is
      // gone, so this states its own denominator the way Memory does.
      cards.push(
        statCard(
          "Disk used",
          formatBytes(health.blobBytes),
          `across ${health.blobCount.toLocaleString("en-GB")} stored files, deduplicated`,
          null,
          null,
        ),
      );
    }
    if (retention) {
      cards.push(
        statCard(
          "Recycle bin",
          `${retention.retentionDays} ${retention.retentionDays === 1 ? "day" : "days"}`,
          "before deleted notes are removed for good",
          null,
          busy ? null : changeBtn("Change how long the recycle bin holds a note", () => opts.onRetention()),
        ),
      );
    }

    return el(
      "section",
      { class: "admin-server" },
      el(
        "div",
        { class: "admin-head" },
        el("h2", { class: "admin-head__title", text: "Server" }),
        // The version identifies the thing being described rather than padding a
        // fourth card, which is where the mockup put it.
        health ? el("span", { class: "admin-head__ver", text: health.version }) : null,
        el("span", { class: "admin-head__rule", "aria-hidden": "true" }),
      ),
      el("div", { class: "admin-stats" }, ...cards),
      retention
        ? el("p", {
            class: "admin-server__note",
            // Said HERE as well as in the dialog: an admin reading the number is
            // the one who needs to know that lowering it is safe, and they read
            // the card before they ever open the control.
            text: RETENTION_NEVER_PURGES,
          })
        : null,
    );
  }

  function ready(state: Extract<AdminState, { kind: "ready" }>): HTMLElement {
    const add = el("button", { class: "admin-btn", type: "button", text: "Add person", disabled: state.busy });
    add.addEventListener("click", () => opts.onAdd());
    // LOCK CONSOLE IS NOT HERE ANY MORE. It moved to the topbar, beside sort and
    // the view toggle, where `Empty bin` already sits: both are VIEW-LEVEL — they
    // act on the whole destination rather than on any row — and a view-level
    // control buried in a section heading called "People" reads as an action on
    // the people. See `lockAdminBtn` in library.ts and `AdminHost.lockBtn`.

    return el(
      "section",
      { class: "admin-wrap", "aria-busy": String(state.busy) },
      el(
        "div",
        { class: "admin-head" },
        el("h2", { class: "admin-head__title", text: "People" }),
        el("span", { class: "admin-head__rule", "aria-hidden": "true" }),
        el("div", { class: "admin-head__acts" }, add),
      ),
      el("div", { class: "admin-people" }, ...state.people.map((p) => personRow(p, state.busy))),
      serverPanel(state.server, state.busy),
    );
  }

  function notice(title: string, text: string): HTMLElement {
    return el(
      "section",
      { class: "admin-notice" },
      el("h2", { class: "admin-notice__title", text: title }),
      el("p", { class: "admin-notice__text", text }),
    );
  }

  return {
    render(state: AdminState): void {
      if (state.kind === "locked") body.replaceChildren(gate(state));
      else if (state.kind === "loading") body.replaceChildren(notice("Loading…", "Fetching the household."));
      else if (state.kind === "ready") body.replaceChildren(ready(state));
      else body.replaceChildren(notice("The console could not be loaded", state.message));
    },

    confirm(spec: ConfirmSpec): Promise<boolean> {
      const { done } = dialog(
        host,
        (content, { go }) => {
          content.append(
            el("h2", { class: "admin-dialog__title", text: spec.title }),
            el("p", { class: "admin-dialog__text", text: spec.text }),
          );
          go.classList.toggle("admin-btn--danger", spec.danger === true);
          if (!spec.confirmWord) return;

          const word = spec.confirmWord;
          // NOT autofocused, on purpose. `dialog` puts the focus on Cancel, and
          // this is the one dialog where that is the whole point: a person who
          // meant to click Reset and hit Delete should land on the way out, not
          // in the box that completes the deletion.
          const typed = field({ id: "admin-confirm-word", label: "Type the address to confirm" });
          // The label is uppercased for rhythm, so the literal the user must
          // reproduce is shown separately, in its own case — an instruction
          // reading "TYPE RUI@HOUSEHOLD.LAN" would not match what it asks for.
          // Inserted ABOVE the input, not appended: the thing to copy has to be
          // read before the box, not found underneath it.
          typed.row.insertBefore(el("code", { class: "admin-dialog__word", text: word }), typed.input);
          go.disabled = true;
          typed.input.addEventListener("input", () => {
            // Trimmed, because a trailing space from a paste is not a different
            // answer; case-exact, because an address is what it is.
            go.disabled = typed.input.value.trim() !== word;
          });
          content.append(typed.row);
        },
        spec.label,
        "Cancel",
      );
      return done;
    },

    async askNewPerson(): Promise<NewPerson | null> {
      // Address only: the server's create takes an email and an admin flag and
      // stores no name. A "Name" box the backend discards would be a field that
      // silently does nothing, which is worse than not asking.
      const email = field({ id: "admin-new-email", label: "Email", type: "email", autofocus: true });
      email.input.placeholder = "name@household.lan";
      const makeAdmin = el("input", { id: "admin-new-admin", type: "checkbox" });

      const { done } = dialog(
        host,
        (content) => {
          content.append(
            el("h2", { class: "admin-dialog__title", text: "Add a person" }),
            el("p", {
              class: "admin-dialog__text",
              text: "They get a temporary password and choose their own the first time they sign in.",
            }),
            email.row,
            el(
              "label",
              { class: "admin-check" },
              makeAdmin,
              el("span", { text: "Also an administrator" }),
              el("small", { text: "Administrators can add, reset and delete household accounts." }),
            ),
          );
        },
        "Add person",
        "Cancel",
      );
      // Read the field BEFORE the promise resolves the dialog out of the DOM.
      const ok = await done;
      const address = email.input.value.trim();
      if (!ok || address === "") return null;
      return { email: address, isAdmin: makeAdmin.checked };
    },

    async askNumber(spec: NumberSpec): Promise<number | null> {
      const input = field({ id: "admin-number", label: spec.label, type: "number", hint: spec.hint });
      input.input.value = String(spec.value);
      input.input.min = String(spec.min);
      input.input.max = String(spec.max);
      input.input.step = String(spec.step);
      input.input.inputMode = "decimal";

      const { done } = dialog(
        host,
        (content, { go }) => {
          content.append(
            el("h2", { class: "admin-dialog__title", text: spec.title }),
            el("p", { class: "admin-dialog__text", text: spec.text }),
            input.row,
          );
          // Disabled the moment the field cannot produce a value the server
          // would accept, so an out-of-range number is refused HERE rather than
          // as a 400 the admin has to interpret. The bounds are the server's own
          // (`minDays`/`maxDays`), carried on the read for exactly this.
          const check = (): void => {
            const v = Number(input.input.value);
            go.disabled = input.input.value.trim() === "" || !Number.isFinite(v) || v < spec.min || v > spec.max;
          };
          input.input.addEventListener("input", check);
          check();
        },
        spec.confirmLabel,
        "Cancel",
      );

      // Read BEFORE the promise takes the dialog out of the DOM.
      const ok = await done;
      const value = Number(input.input.value);
      if (!ok || !Number.isFinite(value) || value < spec.min || value > spec.max) return null;
      return value;
    },

    handOver(spec: HandOver): Promise<void> {
      const { done } = dialog(
        host,
        (content) => {
          content.append(
            el("h2", { class: "admin-dialog__title", text: `Temporary password for ${displayName(spec.email)}` }),
            el("p", {
              class: "admin-dialog__text",
              // TRUE, not theatrical: the server generated this and stored only
              // its hash, so no later request can produce it again.
              text:
                "Give them this. They choose their own the first time they sign in. " +
                "It cannot be shown again.",
            }),
            // `user-select: all` in the CSS, so one click selects the whole
            // secret — this is a string that gets read aloud or copied, and a
            // half-selected password is a support call.
            el("code", { class: "admin-secret", text: spec.password }),
          );
        },
        "Done",
        "Close",
      );
      return done.then(() => undefined);
    },

    toast: opts.toast,
  };
}

// --- mounting into the shell -------------------------------------------------

/**
 * What `library.ts` hands over from its own closure. Every field is something
 * the shell already owns; the panel creates nothing in the shell but its own
 * `<section>`.
 */
export interface AdminHost {
  api: AdminApi;
  /** The signed-in admin's address — the account the challenge is issued for. */
  account: string;
  /** The shell's content area. The panel mounts here, over the gallery. */
  content: HTMLElement;
  /** Hidden while the console is up, shown again when it closes. */
  gallery: HTMLElement;
  /** The topbar breadcrumb — the console names where you are, as the bin does. */
  crumbs: HTMLElement;
  /** Sort and the view toggle describe a FOLDER LISTING. The console is not one,
   *  so they stand down while it is up — the same call the bin makes. */
  sortWrap: HTMLElement;
  segmented: HTMLElement;
  /**
   * The topbar's `Lock console` button — the shell's node, in `.tools` beside
   * `Empty bin`, shown only while the console is up.
   *
   * THE SHELL OWNS THE PLACEMENT AND THE CONSOLE OWNS THE BEHAVIOUR, which is
   * the same split as `sortWrap`/`segmented` above: the topbar is not the
   * console's DOM to append to, and the shell has no business knowing what
   * locking means. It is handed over here rather than created here for the one
   * reason that matters — a control the console appended to the topbar would
   * outlive `close()`, and the shell has no teardown hook for foreign nodes.
   */
  lockBtn: HTMLElement;
  /**
   * The console took (or gave back) the topbar's destination mode — see
   * `setDestinationMode` in library.ts. The same call the bin makes, for the
   * same reason: the search box searches a library that is not on screen.
   */
  setMode(open: boolean): void;
  toast(message: string): void;
  onSessionExpired(): void;
  /** The elevation flipped. The shell repaints the rail's padlock. */
  onElevationChanged(): void;
}

/**
 * The shell's handle on the console.
 *
 * Deliberately the same shape as {@link BinController}'s open/isOpen pair, so
 * `library.ts` treats the two destinations alike — `place()` asks both the same
 * question and the rail highlights whichever answers yes.
 */
export interface AdminPanel {
  open(): void;
  /** Leave the console. Idempotent; the elevation is untouched. */
  close(): void;
  isOpen(): boolean;
  /**
   * Drop the elevation and put the gate back. What the topbar's `Lock console`
   * does; the shell owns that button's placement, not what it means.
   */
  lock(): Promise<void>;
  /** Is the session elevated? What the rail's padlock draws. */
  isElevated(): boolean;
  /** Drop listeners and DOM. Called from the shell's own teardown. */
  destroy(): void;
}

export function createAdminPanel(host: AdminHost): AdminPanel {
  const panel = el("section", { class: "admin", "aria-label": "Admin console", hidden: true });
  const bodyEl = el("div", { class: "admin__body" });
  panel.append(bodyEl);
  host.content.append(panel);

  const view = createAdminView({
    host: panel,
    body: bodyEl,
    toast: host.toast,
    onUnlock: (password) => void console_.unlock(password),
    onAdd: () => void console_.addPerson(),
    onReset: (person) => void console_.resetPassword(person),
    onDelete: (person) => void console_.deletePerson(person),
    onQuota: (person) => void console_.setQuota(person),
    onUnlink: (person, device) => void console_.unlinkDevice(person, device),
    onRetention: () => void console_.setRetention(),
  });

  const console_ = createAdminConsole({
    api: host.api,
    view,
    account: host.account,
    onSessionExpired: host.onSessionExpired,
    onElevationChanged: host.onElevationChanged,
  });

  let open = false;

  /**
   * Take over (or hand back) the topbar. Three things, all of them the shell's
   * nodes rather than the console's:
   *
   *  - sort and the view toggle describe a FOLDER LISTING, and this is not one;
   *  - `Lock console` is a view-level control, so it exists only on the view;
   *  - the destination mode takes the search box away — see `setDestinationMode`
   *    in library.ts, and 03's `.sn-root.is-destination`.
   *
   * `hidden` for the two controls rather than the mode class, because that is
   * already how they stand down over search results and one mechanism per rule
   * is enough.
   */
  function chrome(mine: boolean): void {
    host.sortWrap.hidden = mine;
    host.segmented.hidden = mine;
    host.lockBtn.hidden = !mine;
    host.setMode(mine);
    if (mine) host.crumbs.replaceChildren(el("span", { class: "crumbs__here", text: "Admin" }));
  }

  return {
    open(): void {
      if (open) {
        // Re-entering must NOT rebuild anything: the elevation is a fact about
        // the session, and a fresh console would repaint the gate over a session
        // the server is perfectly happy with. It does re-list, because somebody
        // else's tablet may have synced while the admin was away.
        void console_.open();
        return;
      }
      open = true;
      panel.hidden = false;
      // The gallery is HIDDEN rather than emptied: the shell's listing, its lazy
      // engine and every bitmap already drawn survive, so leaving the console
      // lands back on the folder the admin was in without a refetch.
      host.gallery.hidden = true;
      chrome(true);
      void console_.open();
    },

    close(): void {
      if (!open) return;
      open = false;
      panel.hidden = true;
      host.gallery.hidden = false;
      // The shell rewrites the breadcrumb on its next paint; the caller that
      // closes us is always about to do exactly that.
      chrome(false);
    },

    isOpen: () => open,

    // Straight through: the shell owns where the button is, the console owns
    // what pressing it does.
    lock: () => console_.lock(),
    isElevated: () => console_.isElevated(),

    destroy(): void {
      panel.remove();
      host.gallery.hidden = false;
      if (open) chrome(false);
    },
  };
}
