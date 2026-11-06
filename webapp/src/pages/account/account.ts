// The signed-in user's own account page: Appearance, Signing in, Devices,
// Storage, Versions. Each section loads and fails on its own and shows loading
// distinctly from known-empty. Quota and self-delete are deliberately absent
// (the admin decides those). Pure decisions and copy first, then the painter.

import { folderHref } from "../../router";
import { libraryTrail } from "../../ui/crumbs";
import { el } from "../../ui/dom";
import { button, deviceHint, failed, pending, row, section, type Load } from "./accountDom";
import { createPasswordForm } from "./accountPasswordForm";
import { createVersionsControl } from "./accountVersions";
import * as accountStorage from "./accountStorage";
import { openDialog } from "../../ui/confirm";
import { ICONS, svg, type IconName } from "../../ui/icons";
import { absoluteTime } from "../../ui/relativeTime";
import { currentTheme } from "../../ui/theme";
import { dispatchApiFailure, type ApiFailureSink } from "../../api/client";
import type { AccountSecurity, MyDevice, StorageBreakdown } from "../../api/accountTypes";
import type { Api } from "../../api/types";
import type { Theme } from "../../core/types";
import { passwordAgeLabel, otherSessionsLabel, deviceSeenLabel, thisBrowserLabel, failureMessage } from "./accountCopy";
export { versionsToDiscard, discardNotice, storageRows, passwordAgeLabel, otherSessionsLabel, deviceSeenLabel, thisBrowserLabel, failureMessage, passwordChangeConsequence, passwordFailureMessage } from "./accountCopy";
export type { StorageRow } from "./accountCopy";

export type AccountApi = Pick<
  Api,
  | "accountSecurity"
  | "changePassword"
  | "myDevices"
  | "unlinkMyDevice"
  | "signOutEverywhere"
  | "storageBreakdown"
  | "versionPolicy"
  | "setVersionPolicy"
>;

/** Same floor as the first-login screen; it is the same password. */
export const MIN_PASSWORD_LENGTH = 8;

// ---- the page ----

export interface AccountHost {
  api: AccountApi;
  account: string;
  content: HTMLElement;
  /** Where a modal mounts, so a scrolled panel can't clip it. */
  root: HTMLElement;
  /** Hidden, not emptied, so the folder survives the visit. */
  gallery: HTMLElement;
  crumbs: HTMLElement;
  sortWrap: HTMLElement;
  segmented: HTMLElement;
  setMode(open: boolean): void;
  toast(message: string): void;
  onLeave(): void;
  onOpenBin(): void;
  onSignOut(): void;
  onSessionExpired(): void;
  onSetTheme(theme: Theme): void;
}

export interface AccountPage {
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** The OS theme flipped while nothing was pinned. */
  themeChanged(): void;
  destroy(): void;
}


export function createAccountPage(host: AccountHost): AccountPage {
  const failureSink: ApiFailureSink = { onSessionExpired: host.onSessionExpired };
  const handled = (e: unknown): boolean => dispatchApiFailure(failureSink, e);

  // ---- state ----
  let open_ = false;
  /** Bumped per open; a previous visit's response must not paint over this one. */
  let generation = 0;
  let security: Load<AccountSecurity> = { kind: "loading" };
  let devices: Load<MyDevice[]> = { kind: "loading" };
  let storage: Load<StorageBreakdown> = { kind: "loading" };
  /** In-flight guards against a second write. */
  let signingOutEverywhere = false;
  const unlinking = new Set<string>();

  // ---- DOM: built once and filled ----
  // Not re-rendered wholesale: a late response would wipe a half-typed form.

  const name = (host.account || "").split("@")[0] || "You";

  const securityBody = el("div", { class: "acct-rows" });
  const devicesBody = el("div", { class: "acct-rows" });
  const storageBody = el("div", { class: "acct-rows" });
  const versionsBody = el("div", { class: "acct-versions" });
  const appearanceBody = el("div", { class: "acct-rows" });
  const versions = createVersionsControl({
    api: host.api,
    body: versionsBody,
    toast: host.toast,
    handled,
    generation: () => generation,
    onSaved: (mine) => void loadStorage(mine),
  });
  const renderStorage = (): void => accountStorage.renderStorage(storageBody, storage, host.onOpenBin);


  const body = el(
    "div",
    { class: "acct__body" },
    el(
      "header",
      { class: "acct__head" },
      el("span", { class: "avatar acct__avatar", "aria-hidden": "true", text: initials(host.account) }),
      el(
        "div",
        {},
        el("h2", { class: "acct__title", text: name }),
        el("p", { class: "acct__mail acct-data", text: host.account }),
      ),
    ),
    // First: a preference with no round trip, so the page opens with something resolved.
    section("Appearance", appearanceBody),
    section("Signing in", securityBody),
    section("Devices", devicesBody, deviceHint()),
    section("Storage", storageBody),
    // Its own section: Storage reports, this one discards data.
    section("Versions", versionsBody),
  );

  const panel = el("section", { class: "acct", "aria-label": "Your account", hidden: true }, body);
  host.content.append(panel);



  // ---- Signing in ----

  const passwordRow = row("Password");
  const passwordForm = createPasswordForm({
    api: host.api,
    handled,
    generation: () => generation,
    onCancel: () => togglePasswordForm(false),
    onChanged: () => {
      togglePasswordForm(false);
      security = {
        kind: "ready",
        data: { ...currentSecurity(), passwordChangedAt: Math.floor(Date.now() / 1000), otherSessions: 0 },
      };
      renderSecurity();
      host.toast("Password changed. Your other browsers are signed out.");
    },
  });
  const sessionsRow = row("Other sessions");
  const thisBrowserRow = row("This browser");

  // A disclosure: `aria-expanded` plus `.is-open`.
  const passwordToggle = button("Change", () => togglePasswordForm(passwordForm.node.hidden), {
    ariaLabel: "Change your password",
  });
  // A lone button's fill can't read as pressed, so a chevron carries the state.
  passwordToggle.append(
    // `html:`, not a child: `svg()` returns markup, and as a child it renders as text.
    el("span", { class: "acct-btn__chevron", "aria-hidden": "true", html: svg(ICONS.chevron) }),
  );
  passwordToggle.setAttribute("aria-expanded", "false");
  passwordToggle.setAttribute("aria-controls", "acct-pw-form");
  passwordRow.actions.append(passwordToggle);
  thisBrowserRow.actions.append(
    button("Sign out", () => host.onSignOut()),
  );

  securityBody.append(passwordRow.node, passwordForm.node, sessionsRow.node, thisBrowserRow.node);

  function renderSecurity(): void {
    if (security.kind === "loading") {
      passwordRow.value.textContent = "Loading…";
      sessionsRow.value.textContent = "Loading…";
      thisBrowserRow.value.textContent = "Loading…";
      sessionsRow.actions.replaceChildren();
      return;
    }
    if (security.kind === "failed") {
      passwordRow.value.textContent = security.message;
      sessionsRow.value.textContent = security.message;
      // Sign out stays reachable even when sessions couldn't be read.
      thisBrowserRow.value.textContent = "Signed in here";
      sessionsRow.actions.replaceChildren();
      return;
    }
    const data = security.data;
    passwordRow.value.textContent = passwordAgeLabel(data.passwordChangedAt);
    if (data.passwordChangedAt !== null && data.passwordChangedAt > 0) {
      passwordRow.value.title = absoluteTime(data.passwordChangedAt * 1000);
    } else {
      passwordRow.value.removeAttribute("title");
    }
    sessionsRow.value.textContent = otherSessionsLabel(data.otherSessions);
    thisBrowserRow.value.textContent = thisBrowserLabel(data.thisSessionSince);
    if (data.thisSessionSince !== null && data.thisSessionSince > 0) {
      thisBrowserRow.value.title = absoluteTime(data.thisSessionSince * 1000);
    }
    sessionsRow.actions.replaceChildren();
    // Offered only when it would do something.
    if (data.otherSessions > 0) {
      const b = button("Sign out everywhere", () => void signOutEverywhere(), { danger: true });
      b.disabled = signingOutEverywhere;
      sessionsRow.actions.append(b);
    }
  }

  async function signOutEverywhere(): Promise<void> {
    if (signingOutEverywhere) return;
    signingOutEverywhere = true;
    renderSecurity();
    const mine = generation;
    try {
      const ended = await host.api.signOutEverywhere();
      if (mine !== generation) return;
      security = { kind: "ready", data: { ...currentSecurity(), otherSessions: 0 } };
      host.toast(ended === 1 ? "Signed out 1 other browser." : `Signed out ${ended} other browsers.`);
    } catch (e) {
      if (mine !== generation) return;
      if (!handled(e)) host.toast(failureMessage(e));
    } finally {
      signingOutEverywhere = false;
      if (mine === generation) renderSecurity();
    }
  }

  function currentSecurity(): AccountSecurity {
    return security.kind === "ready"
      ? security.data
      : { passwordChangedAt: null, otherSessions: 0, thisSessionSince: null };
  }


  function togglePasswordForm(show: boolean): void {
    passwordForm.node.hidden = !show;
    passwordToggle.setAttribute("aria-expanded", String(show));
    passwordToggle.classList.toggle("is-open", show);
    // Suppress the row's bottom rule so the form reads as the password row's.
    passwordRow.node.classList.toggle("is-expanded", show);
    if (show) {
      passwordForm.reset();
      passwordForm.focus();
    }
  }

  // ---- Devices ----

  function renderDevices(): void {
    if (devices.kind === "loading") {
      devicesBody.replaceChildren(pending());
      return;
    }
    if (devices.kind === "failed") {
      devicesBody.replaceChildren(failed(devices.message));
      return;
    }
    if (devices.data.length === 0) {
      // Only claimed once the data that could disprove it has arrived.
      devicesBody.replaceChildren(
        el("p", { class: "acct-empty", text: "No Supernote is linked to this account yet." }),
      );
      return;
    }
    devicesBody.replaceChildren(...devices.data.map(deviceRow));
    // The password warning names the tablet, so it learns about devices here.
    passwordForm.syncConsequence(devices.data);
  }

  function deviceRow(device: MyDevice): HTMLElement {
    const unlink = button("Unlink", () => void unlinkDevice(device), {
      danger: true,
      ariaLabel: `Unlink ${device.name || device.equipmentNo}`,
    });
    unlink.disabled = unlinking.has(device.equipmentNo);
    const seen = el("span", { class: "acct-device__sync acct-data", text: deviceSeenLabel(device) });
    if (device.lastSeenAt !== null) seen.title = absoluteTime(device.lastSeenAt * 1000);
    return el(
      "div",
      { class: "acct-row acct-device" },
      // Named as an object; the serial only when the device never sent its name.
      el(
        "div",
        { class: "acct-row__k acct-device__name" },
        el("span", { text: device.name || device.equipmentNo }),
        el("span", { class: "acct-device__dot", "aria-hidden": "true", text: "·" }),
        seen,
      ),
      el("div", { class: "acct-row__v acct-data acct-device__serial", text: device.name ? device.equipmentNo : "" }),
      el("div", { class: "acct-row__acts" }, unlink),
    );
  }

  async function unlinkDevice(device: MyDevice): Promise<void> {
    if (unlinking.has(device.equipmentNo)) return;

    // Confirmed because it can't be undone here: re-pairing happens on the tablet.
    // Cancel is the autofocused default.
    const name = device.name || device.equipmentNo;
    const ok = await openDialog({
      host: host.root,
      classes: { dialog: "confirm", body: "confirm__body", actions: "confirm__actions", cancel: "btn", go: "btn is-danger" },
      goLabel: "Unlink",
      cancelLabel: "Cancel",
      labelledBy: "acct-unlink-title",
      build: (body, { go }) => {
        go.setAttribute("aria-label", `Unlink ${name}`);
        body.append(
          el("h2", { id: "acct-unlink-title", text: `Unlink ${name}?` }),
          // Both halves: what stops and what is safe.
          el("p", {
            text: `${name} will stop syncing until you pair it again from the device itself. Nothing already synced is removed.`,
          }),
        );
      },
    }).done;
    if (!ok) return;

    unlinking.add(device.equipmentNo);
    renderDevices();
    const mine = generation;
    try {
      await host.api.unlinkMyDevice(device.equipmentNo);
      if (mine !== generation) return;
      host.toast(`${device.name || device.equipmentNo} won't sync until it's paired again.`);
      // Re-read rather than splice: the server's answer is what's bound.
      await loadDevices(mine);
    } catch (e) {
      if (mine !== generation) return;
      if (!handled(e)) host.toast(failureMessage(e));
    } finally {
      unlinking.delete(device.equipmentNo);
      if (mine === generation) renderDevices();
    }
  }



  // ---- Appearance ----
  // A set-once override of `prefers-color-scheme`; a two-option control, since a
  // toggle never says whether it shows the current or the next state. Nothing is
  // pinned until one is pressed.

  const themeButtons = new Map<Theme, HTMLButtonElement>();
  function themeChoice(theme: Theme, label: string, icon: IconName): HTMLButtonElement {
    const b = el("button", {
      class: "acct-theme__opt",
      type: "button",
      "aria-pressed": "false",
      html: svg(ICONS[icon]),
    });
    b.append(el("span", { text: label }));
    b.addEventListener("click", () => host.onSetTheme(theme));
    themeButtons.set(theme, b);
    return b;
  }

  appearanceBody.append(
    el(
      "div",
      { class: "acct-row" },
      el("div", { class: "acct-row__k", text: "Theme" }),
      el(
        "div",
        { class: "acct-row__v acct-theme", role: "group", "aria-label": "Theme" },
        themeChoice("light", "Paper", "sun"),
        themeChoice("dark", "Paper Dark", "moon"),
      ),
    ),
  );

  function renderTheme(): void {
    const active = currentTheme();
    for (const [theme, b] of themeButtons) b.setAttribute("aria-pressed", String(theme === active));
  }
  renderTheme();

  // ---- loading ----
  // Four independent calls painted as each lands; one missing endpoint costs
  // only its own section.

  function loadSecurity(mine: number): Promise<void> {
    return host.api.accountSecurity().then(
      (data) => {
        if (mine !== generation) return;
        security = { kind: "ready", data };
        renderSecurity();
      },
      (e: unknown) => {
        if (mine !== generation) return;
        if (handled(e)) return;
        security = { kind: "failed", message: failureMessage(e) };
        renderSecurity();
      },
    );
  }

  function loadDevices(mine: number): Promise<void> {
    return host.api.myDevices().then(
      (data) => {
        if (mine !== generation) return;
        devices = { kind: "ready", data };
        renderDevices();
      },
      (e: unknown) => {
        if (mine !== generation) return;
        if (handled(e)) return;
        devices = { kind: "failed", message: failureMessage(e) };
        renderDevices();
      },
    );
  }

  function loadStorage(mine: number): Promise<void> {
    return host.api.storageBreakdown().then(
      (data) => {
        if (mine !== generation) return;
        storage = { kind: "ready", data };
        renderStorage();
      },
      (e: unknown) => {
        if (mine !== generation) return;
        if (handled(e)) return;
        storage = { kind: "failed", message: failureMessage(e) };
        renderStorage();
      },
    );
  }

  function loadPolicy(mine: number): Promise<void> {
    return host.api.versionPolicy().then(
      (data) => {
        if (mine !== generation) return;
        versions.set({ kind: "ready", data });
      },
      (e: unknown) => {
        if (mine !== generation) return;
        if (handled(e)) return;
        versions.set({ kind: "failed", message: failureMessage(e) });
      },
    );
  }

  /** Sort, view and search go: this is not a folder listing. */
  function chrome(mine: boolean): void {
    host.sortWrap.hidden = mine;
    host.segmented.hidden = mine;
    host.setMode(mine);
    if (!mine) return;
    host.crumbs.replaceChildren(...libraryTrail("Your account", () => host.onLeave(), folderHref(null)));
  }

  return {
    open(): void {
      const mine = ++generation;
      if (!open_) {
        open_ = true;
        panel.hidden = false;
        // Hidden rather than emptied, so leaving needs no refetch.
        host.gallery.hidden = true;
      }
      chrome(true);
      // Re-entering re-reads; previous answers stay up meanwhile.
      if (security.kind !== "ready") renderSecurity();
      if (devices.kind !== "ready") renderDevices();
      if (storage.kind !== "ready") renderStorage();
      if (!versions.isReady()) versions.render();
      renderTheme();
      void loadSecurity(mine);
      void loadDevices(mine);
      void loadStorage(mine);
      void loadPolicy(mine);
    },

    close(): void {
      if (!open_) return;
      open_ = false;
      generation++; // orphan everything still in flight
      panel.hidden = true;
      host.gallery.hidden = false;
      togglePasswordForm(false);
      chrome(false);
    },

    isOpen: () => open_,

    themeChanged: renderTheme,

    destroy(): void {
      generation++;
      panel.remove();
      host.gallery.hidden = false;
      if (open_) chrome(false);
      open_ = false;
    },
  };
}

/** Same derivation as the rail's nameplate. */
export function initials(email: string): string {
  const name = (email || "").split("@")[0] ?? "";
  const parts = name.split(/[.\-_]+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "?";
  const b = parts[1]?.[0] ?? parts[0]?.[1] ?? "";
  return (a + b).toUpperCase();
}
