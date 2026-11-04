// The Server panel's backup detail: one row per backup folder, in the
// console's own vocabulary (a red chip for trouble, as for a pending password;
// the device list's quiet remove button), and the one setting an admin has
// here. Starting a backup is the server's command line, never this page.

import { el } from "../../ui/dom";
import type { AdminBackups } from "../../api/adminTypes";
import { BACKUP_COMMAND, backupRunLine } from "./backupCopy";

export interface BackupsActions {
  onDismiss(dismissed: boolean): void;
  onForget(dir: string): void;
}

export function backupsDetail(b: AdminBackups, busy: boolean, act: BackupsActions, nowMs: number = Date.now()): HTMLElement {
  const rows = b.runs.map((r) => {
    const line = backupRunLine(r, nowMs);
    const forget = el("button", {
      class: "admin-row-act",
      type: "button",
      text: "Forget",
      disabled: busy,
      "aria-label": `Forget ${r.dir}`,
    });
    forget.addEventListener("click", () => act.onForget(r.dir));
    return el(
      "li",
      { class: "admin-backup", "data-status": line.status },
      el("code", { class: "admin-backup__dir", text: r.dir, title: r.dir }),
      el(
        "span",
        { class: "admin-backup__detail" },
        line.chip ? el("span", { class: "admin-chip admin-chip--danger", text: line.chip }) : null,
        el("span", { text: line.detail, title: line.title }),
      ),
      forget,
    );
  });

  // A setting, so a checkbox like "Also an administrator", offered while it
  // means something: nothing has succeeded yet, or it is already off.
  let setting: HTMLElement | null = null;
  if (b.neverDismissed || !b.runs.some((r) => r.lastOkAt !== null)) {
    const box = el("input", { type: "checkbox", id: "admin-backup-remind", disabled: busy }) as HTMLInputElement;
    box.checked = !b.neverDismissed;
    box.addEventListener("change", () => act.onDismiss(!box.checked));
    setting = el(
      "label",
      { class: "admin-check admin-backups__setting" },
      box,
      el("span", { text: "Remind admins when nothing is backed up" }),
      el("small", { text: "Turn this off if the server is backed up some other way. A failing backup is always shown." }),
    );
  }

  return el(
    "section",
    { class: "admin-backups", "aria-labelledby": "admin-backups-title" },
    // Focusable, so "Open backups" can land here.
    el("h3", { class: "admin-backups__title", id: "admin-backups-title", tabindex: "-1", text: "Backup folders" }),
    rows.length
      ? el("ul", { class: "admin-backups__list", "aria-label": "Backup directories" }, ...rows)
      : el(
          "div",
          { class: "admin-backups__empty" },
          el("p", { class: "admin-server__note", text: "No backup has been recorded. Run this on the server, nightly from cron; the README has the details:" }),
          el("pre", { class: "admin-backups__cmd" }, el("code", { text: BACKUP_COMMAND })),
        ),
    setting,
  );
}
