// The admin console: the elevation gate and the household as a list of people,
// with the DOM injected as an `AdminView` so the elevate-and-retry loop runs on
// plain Node. Per-person activity (last sync, note counts) is deliberately
// absent: it would be surveillance of a housemate.

import { el } from "../ui/dom";
import { openDialog, type DialogButtons } from "../ui/confirm";
import { field, statusLine } from "../ui/form";
import { ICONS, svg } from "../ui/icons";
import { ApiError, RateLimitError, dispatchApiFailure, type ApiFailureSink } from "../api/client";
import type { AdminDevice, AdminHealth, AdminQuota, AdminRetention, AdminUser } from "../api/adminTypes";
import type { Api } from "../api/types";

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

/** The address's local part; the server stores no name. Same as the rail footer. */
export function displayName(email: string): string {
  return email.split("@")[0] || email;
}

export function initials(email: string): string {
  const name = displayName(email);
  const parts = name.split(/[.\-_]+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "?";
  const b = parts[1]?.[0] ?? parts[0]?.[1] ?? "";
  return (a + b).toUpperCase();
}

/** Epoch seconds; `0` means absent and renders nothing. A fact about the login, not activity. */
export function accountAge(createdAtSeconds: number): string {
  if (!Number.isFinite(createdAtSeconds) || createdAtSeconds <= 0) return "";
  return new Date(createdAtSeconds * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
* An entry's clock runs from the later of trashing and the last window change
* (`settings.sweepCutoff`), so shortening never makes old entries instantly due.
*/
export const RETENTION_NEVER_PURGES =
  "Nothing already in the bin is removed early: everything in it gets a full new window from the moment you change this.";

export const GB = 1024 ** 3;

/** Binary units; one decimal at GB, whole numbers below. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

export interface Meter {
  /** Clamped drawn length; overage is carried by `tone` and `label`. */
  fill: number;
  /** `tight` at 90% (a sync is about to fail); `over` once the allotment is passed. */
  tone: "normal" | "tight" | "over";
  overBytes: number;
  label: string;
}

/**
* Only the drawn length is clamped. `used > total` is a real state (lowering an
* allotment deletes nothing and stops the next sync), stated in bytes. A zero
* allotment is a limit of nothing, not "no limit".
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
    label: tone === "over" ? `${base} — ${formatBytes(used - total)} over` : base,
  };
}

/**
* `memoryBytes` is null off Linux and must not render as `0 B`. Always shown
* against the 50 MB ceiling.
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

/** `model` and `firmware` may be missing on older bindings; dropped, not dashed. */
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

/** The two server outcomes with their own wording; others keep the client's message. */
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

/** Deliberately doesn't distinguish its refusals. */
function gateMessage(e: unknown): string {
  if (e instanceof RateLimitError) {
    const wait = e.retryAfterSeconds ? ` Try again in ${e.retryAfterSeconds}s.` : "";
    // Keyed by account on the server, not IP.
    return `Too many attempts.${wait}`;
  }
  // One code for wrong password, non-admin and pending password change, so the
  // endpoint can't reveal who the admins are.
  return e instanceof ApiError && (e.code === "INVALID_CREDENTIALS" || e.code === "NO_CHALLENGE")
    ? "That password doesn't match."
    : failureMessage(e);
}

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

// ---- the painter ----

/**
* The shared `openDialog` (`ui/confirm.ts`) with the console's classes:
* Cancel first and default, built per call.
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

/** `host` holds dialogs, `body` the state; a `<dialog>` must survive repaint. */
export function createAdminView(opts: {
  host: HTMLElement;
  body: HTMLElement;
  /** So "Reset password" is never offered on your own row. */
  account: string;
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
    // The app's real auth field, from `ui/form.ts`.
    const password = field({
      id: "admin-elevate",
      label: "Password",
      type: "password",
      autocomplete: "current-password",
      autofocus: true,
    });
    const status = statusLine();
    if (state.error) status.error(state.error);

    // Not the auth pages' `.button`: the shell's control reset
    // (`.sn-root :where(button, input, select) { color: inherit }`) has the same
    // specificity and comes later, painting ink on ink. The console's sheet is last.
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
        text:
          "This console can delete another person's notes and reset their password, " +
          "so it asks again — a tablet left signed in on a table cannot reach it.",
      }),
      password.row,
      submit,
      status.node,
      el("p", {
        class: "admin-gate__note",
        // The server's `elevation_idle_s` and `elevation_absolute_s`.
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

  /** Same idiom as the bin's retention countdown. */
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
          "aria-label": `${label}: ${meter.label}`,
        },
        fill,
      ),
      // `bare` in a stat card, whose value already says it.
      bare ? null : el("div", { class: "admin-meter__label" }, el("span", { text: meter.label }), control),
    );
  }

  /** Glyph then words, like every labelled action; the pencil is `aria-hidden`. */
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
  * Unlink is a labelled button, not a chip's "×": it cuts a tablet off and
  * re-linking needs the device in hand.
  */
  function deviceRow(person: Person, device: AdminDevice, busy: boolean): HTMLElement {
    const name = displayName(person.user.email);
    // A revoked binding stays on the row (soft revoke allows re-pairing), with no Unlink.
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
    // Null is not empty: a failed call must not read "no device linked yet".
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

  /** `busy` disables every control as feedback; the controller has the real guard. */
  function personRow(person: Person, busy: boolean): HTMLElement {
    const user = person.user;
    const name = displayName(user.email);
    const added = accountAge(user.createdAt);
    // No "Reset password" on your own row (it once locked a tester out); a pointer
    // to the account page instead of a disabled button.
    const isSelf = user.email === opts.account;
    const reset = isSelf
      ? el("span", {
          class: "admin-selfnote",
          text: "on your account page",
          title: "Change your own password from Library / You",
        })
      : el("button", { class: "admin-btn", type: "button", text: "Reset password", disabled: busy });
    if (!isSelf) {
      reset.setAttribute("aria-label", `Reset the password for ${name}`);
      reset.addEventListener("click", () => opts.onReset(user));
    }

    // No Delete on your own row: `LastAdmin` protects the household, not you.
    const remove = isSelf
        ? null
        : el("button", { class: "admin-btn admin-btn--danger", type: "button", text: "Delete", disabled: busy });
    if (remove) {
      remove.setAttribute("aria-label", `Delete ${name}`);
      remove.addEventListener("click", () => opts.onDelete(user));
    }

    // An unreadable quota renders as absent, never a zero meter.
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
          el("span", { text: name }),
          user.isAdmin && chip("admin", "admin"),
          user.mustChangePassword && chip("must set password", "pending"),
        ),
        el("div", { class: "admin-person__mail", text: user.email }),
        added ? el("div", { class: "admin-person__since", text: `Added ${added}` }) : null,
        storage,
        devicesEl(person, busy),
      ),
      el("div", { class: "admin-person__acts" }, reset, remove),
    );
  }

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

  /** Household totals only; no uptime or last-sync cards (activity surveillance). */
  function serverPanel(server: Server, busy: boolean): HTMLElement | null {
    const { health, retention } = server;
    if (!health && !retention) return null; // nothing readable: draw no panel at all

    const cards: (HTMLElement | null)[] = [];
    if (health) {
      const mem = memoryCard(health);
      cards.push(statCard("Memory", mem.value, mem.sub, mem.meter, null));
      // States its denominator so it doesn't read as free space.
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
        health ? el("span", { class: "admin-head__ver", text: health.version }) : null,
        el("span", { class: "admin-head__rule", "aria-hidden": "true" }),
      ),
      el("div", { class: "admin-stats" }, ...cards),
      retention
        ? el("p", {
            class: "admin-server__note",
            // Also on the card: the reader of the number needs to know lowering it is safe.
            text: RETENTION_NEVER_PURGES,
          })
        : null,
    );
  }

  function ready(state: Extract<AdminState, { kind: "ready" }>): HTMLElement {
    const add = el("button", { class: "admin-btn", type: "button", text: "Add person", disabled: state.busy });
    add.addEventListener("click", () => opts.onAdd());
    // Lock console lives in the topbar (`lockAdminBtn` in library.ts): view-level.

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
          // Not autofocused: focus stays on Cancel, the way out.
          const typed = field({ id: "admin-confirm-word", label: "Type the address to confirm" });
          // The literal is shown separately because the label is uppercased.
          typed.row.insertBefore(el("code", { class: "admin-dialog__word", text: word }), typed.input);
          go.disabled = true;
          typed.input.addEventListener("input", () => {
            // Trimmed (pasted spaces), case-exact.
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
      // Address only: the server stores no name.
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
      // Read the field before the dialog leaves the DOM.
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
          // Disabled out of the server's own bounds (`minDays`/`maxDays`), not a 400 later.
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
              // True: only the hash is stored.
              text:
                "Give them this. They choose their own the first time they sign in. " +
                "It cannot be shown again.",
            }),
            // `user-select: all` in the CSS: one click selects the whole secret.
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

// ---- mounting into the shell ----

/** Nodes the shell owns; the panel creates only its own `<section>`. */
export interface AdminHost {
  api: AdminApi;
  account: string;
  content: HTMLElement;
  gallery: HTMLElement;
  crumbs: HTMLElement;
  /** Stand down while up: they describe a folder listing. */
  sortWrap: HTMLElement;
  segmented: HTMLElement;
  /**
  * The shell's node: the shell owns placement, the console behaviour. Created
  * by the shell so it can't outlive `close()`.
  */
  lockBtn: HTMLElement;
  /** The search box searches a library that isn't on screen. */
  setMode(open: boolean): void;
  toast(message: string): void;
  onSessionExpired(): void;
  onElevationChanged(): void;
}

/** Same open/isOpen shape as `BinController`, so the shell treats both alike. */
export interface AdminPanel {
  open(): void;
  /** Idempotent; the elevation is untouched. */
  close(): void;
  isOpen(): boolean;
  lock(): Promise<void>;
  isElevated(): boolean;
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
    account: host.account,
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
  * Sort/view are hidden (not a listing), `Lock console` shown, and the
  * destination mode removes search.
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
        // Re-entering rebuilds nothing (that would repaint the gate over a live
        // elevation), but re-lists.
        void console_.open();
        return;
      }
      open = true;
      panel.hidden = false;
      // Hidden rather than emptied, so leaving needs no refetch.
      host.gallery.hidden = true;
      chrome(true);
      void console_.open();
    },

    close(): void {
      if (!open) return;
      open = false;
      panel.hidden = true;
      host.gallery.hidden = false;
      chrome(false);
    },

    isOpen: () => open,

    lock: () => console_.lock(),
    isElevated: () => console_.isElevated(),

    destroy(): void {
      panel.remove();
      host.gallery.hidden = false;
      if (open) chrome(false);
    },
  };
}
