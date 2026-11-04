// The admin console: the elevation gate and the household as a list of people,
// with the DOM injected as an `AdminView` so the elevate-and-retry loop runs on
// plain Node. Per-person activity (last sync, note counts) is deliberately
// absent: it would be surveillance of a housemate.

import { ApiError, dispatchApiFailure, type ApiFailureSink } from "../api/client";
import type { AdminDevice, AdminHealth, AdminQuota, AdminRetention, AdminUser } from "../api/adminTypes";
import type { Api } from "../api/types";
import { displayName, RETENTION_NEVER_PURGES, GB, formatBytes, deviceTitle, failureMessage, gateMessage } from "./adminCopy";
export { displayName, initials, accountAge, RETENTION_NEVER_PURGES, GB, formatBytes, meterFor, memoryCard, deviceTitle, deviceMeta, failureMessage } from "./adminCopy";
export type { Meter } from "./adminCopy";
export { createAdminView } from "./adminView";
export { createAdminPanel } from "./adminPanel";
export type { AdminHost, AdminPanel } from "./adminPanel";

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

/** `locked` is the entry state, not an error; a lapsed elevation returns here. */
export type AdminState =
  | { kind: "locked"; error: string | null; busy: boolean }
  | { kind: "loading" }
  | { kind: "ready"; people: Person[]; server: Server; busy: boolean }
  | { kind: "failed"; message: string };

/** `quota` and `devices` are separately nullable: separate endpoints, separate failures. */
export interface Person {
  user: AdminUser;
  quota: AdminQuota | null;
  devices: AdminDevice[] | null;
}

export interface Server {
  health: AdminHealth | null;
  retention: AdminRetention | null;
}

export interface ConfirmSpec {
  title: string;
  text: string;
  /** Never "OK". */
  label: string;
  danger?: boolean;
  /**
  * Type-to-confirm, used only for deleting a person: the one action where the
  * person clicking is not the one who loses data.
  */
  confirmWord?: string;
}

export interface NewPerson {
  email: string;
  isAdmin: boolean;
}

/** In the units the value is stated in (GB, days), never raw bytes. */
export interface NumberSpec {
  title: string;
  text: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  confirmLabel: string;
  hint?: string;
}

/** Shown once and never again. */
export interface HandOver {
  email: string;
  password: string;
}

/** Questions and paints only; no decisions. */
export interface AdminView {
  render(state: AdminState): void;
  confirm(spec: ConfirmSpec): Promise<boolean>;
  askNewPerson(): Promise<NewPerson | null>;
  askNumber(spec: NumberSpec): Promise<number | null>;
  handOver(spec: HandOver): Promise<void>;
  toast(message: string): void;
}

export interface AdminDeps {
  api: AdminApi;
  view: AdminView;
  account: string;
  onSessionExpired(): void;
  /** Fired only on a real change; the rail's padlock repaints on it. */
  onElevationChanged(): void;
}

export interface AdminConsole {
  /**
  * Lists the household, which also opens the gate (428 until elevated). No
  * separate elevation probe: the server is the authority.
  */
  open(): Promise<void>;
  unlock(password: string): Promise<void>;
  lock(): Promise<void>;
  addPerson(): Promise<void>;
  resetPassword(person: AdminUser): Promise<void>;
  deletePerson(person: AdminUser): Promise<void>;
  setQuota(person: Person): Promise<void>;
  unlinkDevice(person: Person, device: AdminDevice): Promise<void>;
  setRetention(): Promise<void>;
  state(): AdminState;
  /**
  * Tracked from server evidence (a listing succeeded, or a 428), not from
  * `AdminState`: `loading` on first paint would otherwise flash an unlocked padlock.
  */
  isElevated(): boolean;
}

// ---- presentation helpers (pure) ----

// ---- the controller ----

export function createAdminConsole(deps: AdminDeps): AdminConsole {
  const { api, view } = deps;

  let state: AdminState = { kind: "locked", error: null, busy: false };

  function set(next: AdminState): void {
    state = next;
    view.render(state);
  }

  let elevated = false;

  function setElevated(next: boolean): void {
    if (elevated === next) return;
    elevated = next;
    deps.onElevationChanged();
  }

  /** A list: several calls can be parked, and a second 428 must not reset the gate. */
  let gateWaiters: ((elevated: boolean) => void)[] = [];

  /** Only the newest refresh may paint. */
  let refreshToken = 0;

  function settleGate(elevated: boolean): void {
    const waiting = gateWaiters;
    gateWaiters = [];
    for (const resolve of waiting) resolve(elevated);
  }

  /**
  * 428 means the session is alive but not freshly elevated; folding it into
  * `onSessionExpired` would sign the admin out.
  */
  const failures: ApiFailureSink = {
    onSessionExpired: () => {
      // Release parked waiters so no retry hangs forever.
      settleGate(false);
      // Elevation dies with the session.
      setElevated(false);
      deps.onSessionExpired();
    },
    onElevationRequired: () => {
      // The idle window ran out. Bump the token first so an in-flight refresh can't
      // repaint the household over the gate.
      refreshToken++;
      setElevated(false);
      set({ kind: "locked", error: null, busy: false });
    },
  };

  /**
  * The waiter is registered before the dispatch because `onElevationRequired`
  * runs synchronously. The 428 mapping stays in `dispatchApiFailure`.
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
  * Every admin call goes through here. Elevation lapses after 15 idle minutes,
  * so the call that hit the gate resumes after the password, exactly once (a
  * second 428 is skew or revocation, not staleness). Null means "did not
  * happen" and callers change nothing.
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
  * Session death goes to the shell; other failures show on the gate's error
  * line or as the console's failure state, never a stale list.
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
  * The only writer of `people`. Not through `run`: a 428 here only raises the
  * gate (`unlock` re-lists), and a parked listing could wait forever.
  */
  async function refresh(): Promise<void> {
    // Two refreshes overlap on the ordinary path (unlock re-lists while the
    // interrupted call resumes); without the token, a deleted person could reappear.
    const mine = ++refreshToken;
    if (state.kind !== "ready") set({ kind: "loading" });
    try {
      const users = await api.adminListUsers();
      // A successful `require_admin` listing proves elevation, including a still-live
      // one where `unlock` never ran.
      setElevated(true);
      if (mine !== refreshToken) return; // a newer refresh owns the paint

      // Sequential: the server serialises on one `db_lock`, so parallel requests only
      // queue while using browser connections; and a 428 stops at the first call.
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
      // A superseded refresh's failure must not land on the gate or a newer list;
      // dropped whole, session death included (a dead session fails the next call too).
      if (mine !== refreshToken) return;
      report(e);
    }
  }

  /**
  * A per-row detail that may fail alone. Elevation and session failures are
  * re-thrown: they concern the whole console.
  */
  async function detail<T>(op: () => Promise<T>): Promise<T | null> {
    try {
      return await op();
    } catch (e) {
      if (isElevationLapsed(e) || (e instanceof ApiError && e.code === "UNAUTHORIZED")) throw e;
      return null;
    }
  }

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
        if (dispatchApiFailure(failures, e)) return;
        set({ kind: "locked", error: gateMessage(e), busy: false });
        return;
      }
      // Release parked waiters first, then paint.
      set({ kind: "loading" });
      settleGate(true);
      // Whatever opened the gate, the list is refreshed.
      await refresh();
    },

    async lock(): Promise<void> {
      // Painted at once: lock must never seem to hesitate, and the call is idempotent.
      refreshToken++; // same rule as the gate: nothing in flight may paint over this
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
      // The server stores only a hash, so this is the one moment the password can be read.
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
        // Not destructive: nothing is lost.
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
        // The address: unambiguous, and printed on the row above.
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
        // One decimal, matching what the meter displays.
        value: current ? round1(current.totalBytes / GB) : 0,
        min: 0,
        max: 65536,
        step: 0.1,
        hint: current ? `They are storing ${formatBytes(current.usedBytes)} today.` : undefined,
        confirmLabel: "Save allotment",
      });
      if (gb === null) return;
      busy(true);
      const saved = await run(() => api.adminSetQuota(person.user.id, Math.round(gb * GB)));
      if (saved === null) {
        busy(false);
        return;
      }
      await refresh();
      // Says if they're now over it and their next sync will be refused.
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

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---- mounting into the shell ----
