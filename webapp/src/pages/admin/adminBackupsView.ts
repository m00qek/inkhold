// The Server panel's backup detail: one line per backup directory, what last
// happened there, and the two things an admin can do about it here (forget a
// directory no longer used; say they back up another way). Starting a backup
// is the server's command line, never this page.

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
      class: "admin-btn admin-btn--quiet",
      type: "button",
      text: "Forget",
      disabled: busy,
      "aria-label": `Forget ${r.dir}`,
    });
    forget.addEventListener("click", () => act.onForget(r.dir));
    return el(
      "li",
      { class: "admin-backup", "data-ok": String(line.ok) },
      el("code", { class: "admin-backup__dir", text: r.dir }),
      el("span", { class: "admin-backup__detail", text: line.detail }),
      forget,
    );
  });

  // Offered while it means something: nothing has succeeded, or it was said already.
  const showToggle = b.neverDismissed || !b.runs.some((r) => r.lastOkAt !== null);
  const toggle = showToggle
    ? el("button", {
        class: "admin-btn admin-btn--quiet",
        type: "button",
        disabled: busy,
        text: b.neverDismissed ? "Remind me when nothing is backed up" : "I back up another way",
      })
    : null;
  toggle?.addEventListener("click", () => act.onDismiss(!b.neverDismissed));

  return el(
    "div",
    { class: "admin-backups" },
    el("h3", { class: "admin-backups__title", text: "Backup folders" }),
    rows.length
      ? el("ul", { class: "admin-backups__list", "aria-label": "Backup directories" }, ...rows)
      : el(
          "p",
          { class: "admin-server__note" },
          "No backup has been recorded. On the server, run ",
          el("code", { text: BACKUP_COMMAND }),
          ", nightly from cron; the README has the details.",
        ),
    toggle ? el("div", { class: "admin-backups__acts" }, toggle) : null,
  );
}
