// One person in the admin console: who they are, their storage meter, their
// devices, and the account actions. Clicks go to the controller's handlers.

import { el } from "../../ui/dom";
import type { AdminDevice, AdminUser } from "../../api/adminTypes";
import type { Person } from "./adminModel";
import { displayName, deviceTitle, deviceMeta, accountAge, meterFor } from "./adminCopy";
import { chip, meterEl, changeBtn } from "./adminParts";
import { initials } from "../account/account";

export interface PersonHandlers {
  /** So "Reset password" is never offered on your own row. */
  account: string;
  onReset(person: AdminUser): void;
  onDelete(person: AdminUser): void;
  onQuota(person: Person): void;
  onUnlink(person: Person, device: AdminDevice): void;
}

/**
* Unlink is a labelled button, not a chip's "×": it cuts a tablet off and
* re-linking needs the device in hand.
*/
function deviceRow(person: Person, device: AdminDevice, busy: boolean, h: PersonHandlers): HTMLElement {
  const name = displayName(person.user.email);
  // A revoked binding stays on the row (soft revoke allows re-pairing), with no Unlink.
  const action = device.active
    ? (() => {
        const b = el("button", { class: "admin-device__cut", type: "button", text: "Unlink", disabled: busy });
        b.setAttribute("aria-label", `Unlink ${deviceTitle(device)} from ${name}`);
        b.title = "Stop this device syncing";
        b.addEventListener("click", () => h.onUnlink(person, device));
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

function devicesEl(person: Person, busy: boolean, h: PersonHandlers): HTMLElement {
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
  return el("div", { class: "admin-devices" }, ...person.devices.map((d) => deviceRow(person, d, busy, h)));
}

/** `busy` disables every control as feedback; the controller has the real guard. */
export function personRow(person: Person, busy: boolean, h: PersonHandlers): HTMLElement {
  const user = person.user;
  const name = displayName(user.email);
  const added = accountAge(user.createdAt);
  // No "Reset password" on your own row (it once locked a tester out); a pointer
  // to the account page instead of a disabled button.
  const isSelf = user.email === h.account;
  const reset = isSelf
    ? el("span", {
        class: "admin-selfnote",
        text: "on your account page",
        title: "Change your own password from Library / You",
      })
    : el("button", { class: "admin-btn", type: "button", text: "Reset password", disabled: busy });
  if (!isSelf) {
    reset.setAttribute("aria-label", `Reset the password for ${name}`);
    reset.addEventListener("click", () => h.onReset(user));
  }

  // No Delete on your own row: `LastAdmin` protects the household, not you.
  const remove = isSelf
      ? null
      : el("button", { class: "admin-btn admin-btn--danger", type: "button", text: "Delete", disabled: busy });
  if (remove) {
    remove.setAttribute("aria-label", `Delete ${name}`);
    remove.addEventListener("click", () => h.onDelete(user));
  }

  // An unreadable quota renders as absent, never a zero meter.
  const storage = person.quota
    ? meterEl(
        meterFor(person.quota),
        `Storage for ${name}`,
        busy ? null : changeBtn(`Change the allotment for ${name}`, () => h.onQuota(person)),
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
      devicesEl(person, busy, h),
    ),
    el("div", { class: "admin-person__acts" }, reset, remove),
  );
}
