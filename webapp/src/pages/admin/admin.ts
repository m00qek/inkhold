// The admin console: the elevation gate and the household as a list of people,
// with the DOM injected as an `AdminView` so the elevate-and-retry loop runs on
// plain Node. Per-person activity (last sync, note counts) is deliberately
// absent: it would be surveillance of a housemate.

import { ApiError, dispatchApiFailure, type ApiFailureSink } from "../../api/client";
import { failureMessage, gateMessage } from "./adminCopy";
import { adminActions } from "./adminActions";
import type { AdminConsole, AdminDeps, AdminState, Person, Server } from "./adminModel";
export { displayName, initials, accountAge, RETENTION_NEVER_PURGES, GB, formatBytes, meterFor, memoryCard, deviceTitle, deviceMeta, failureMessage } from "./adminCopy";
export type { Meter } from "./adminCopy";
export { createAdminView } from "./adminView";
export { createAdminPanel } from "./adminPanel";
export type { AdminHost, AdminPanel } from "./adminPanel";

export type {
  AdminApi,
  AdminState,
  Person,
  Server,
  ConfirmSpec,
  NewPerson,
  NumberSpec,
  HandOver,
  AdminView,
  AdminDeps,
  AdminConsole,
} from "./adminModel";

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
        backups: await detail(() => api.adminBackups()),
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

    ...adminActions({
      api,
      view,
      state: () => state,
      busy,
      run,
      refresh,
      onBackupsChanged: () => deps.onBackupsChanged(),
    }),
  };
}
