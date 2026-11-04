// The library's backup notice: one slim line above the gallery, for admins
// only, when the last backup failed, is late, or never happened. Households
// never read cron mail; this is where a backup that stopped gets noticed. The
// server decides what to say (`GET /api/backup-notice`); this paints it and
// offers the admin console. Dismissing lives in the console, behind elevation.

import { el } from "../../ui/dom";
import type { Api } from "../../api/types";
import { backupNoticeText } from "../admin/backupCopy";

/** Re-asked when the tab comes back after this long; the state moves slowly. */
const STALE_MS = 10 * 60 * 1000;

export interface BackupNoticeDeps {
  api: Pick<Api, "backupNotice">;
  isAdmin: () => boolean;
  /** Opens the admin console, where the Server panel has the details. */
  onOpen: () => void;
  now?: () => number;
}

export interface BackupNoticeHandle {
  el: HTMLElement;
  /** Asks the server again; a failure hides the notice rather than alarming. */
  refresh(): Promise<void>;
  destroy(): void;
}

export function createBackupNotice(deps: BackupNoticeDeps): BackupNoticeHandle {
  const now = deps.now ?? Date.now;
  const text = el("span", { class: "backup-notice__text" });
  const open = el("button", { class: "backup-notice__open", type: "button", text: "Open backups" });
  open.addEventListener("click", () => deps.onOpen());
  const root = el("aside", { class: "backup-notice", "aria-label": "Backups", hidden: true }, text, open);

  let asked = 0;
  let token = 0;

  async function refresh(): Promise<void> {
    if (!deps.isAdmin()) {
      root.hidden = true;
      return;
    }
    const mine = ++token;
    asked = now();
    try {
      const n = await deps.api.backupNotice();
      if (mine !== token) return;
      const line = backupNoticeText(n, now());
      root.dataset.kind = n.kind;
      text.textContent = line ?? "";
      root.hidden = line === null;
    } catch {
      if (mine === token) root.hidden = true;
    }
  }

  const onVisible = (): void => {
    if (document.visibilityState === "visible" && now() - asked > STALE_MS) void refresh();
  };
  document.addEventListener("visibilitychange", onVisible);
  void refresh();

  return {
    el: root,
    refresh,
    destroy: () => document.removeEventListener("visibilitychange", onVisible),
  };
}
