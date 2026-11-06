// The library's backup notice: a `.banner` above the gallery, for admins only,
// when the last backup failed, is late, or never happened. Households never
// read cron mail; this is where a backup that stopped gets noticed. The server
// decides what to say (`GET /api/backup-notice`); this paints it in the app's
// two tints (danger for failed and late, information for "nothing yet") and
// offers the console's backups section. Dismissing lives there, behind
// elevation. Hidden while the console is open: the panel says it all.

import { el } from "../../ui/dom";
import { ICONS, svg } from "../../ui/icons";
import type { Api } from "../../api/types";
import { backupNoticeText, exactTime, noticeTone } from "../admin/backupCopy";

/** Re-asked when the tab comes back after this long; the state moves slowly. */
const STALE_MS = 10 * 60 * 1000;

export interface BackupNoticeDeps {
  api: Pick<Api, "backupNotice">;
  isAdmin: () => boolean;
  /** Opens the admin console at its backups section. */
  onOpen: () => void;
  now?: () => number;
}

export interface BackupNoticeHandle {
  el: HTMLElement;
  /** Asks the server again; a failure hides the notice rather than alarming. */
  refresh(): Promise<void>;
  /** While the console is open the notice stands down; leaving re-asks. */
  setConsoleOpen(open: boolean): void;
  destroy(): void;
}

export function createBackupNotice(deps: BackupNoticeDeps): BackupNoticeHandle {
  const now = deps.now ?? Date.now;
  const text = el("span", { class: "banner__text" });
  const open = el("button", { class: "btn banner__act", type: "button", text: "Open backups" });
  open.addEventListener("click", () => deps.onOpen());
  // A named region in the header: a notice, not content beside the page.
  const root = el(
    "section",
    { class: "banner backup-notice", "aria-label": "Backups", hidden: true },
    el("span", { class: "banner__badge", "aria-hidden": "true", html: svg(ICONS.archive, 1.6) }),
    text,
    open,
  );

  let asked = 0;
  let token = 0;
  let consoleOpen = false;
  /** What the server last said, painted or not. */
  let line: string | null = null;

  function paint(): void {
    root.hidden = consoleOpen || line === null;
  }

  async function refresh(): Promise<void> {
    if (!deps.isAdmin()) {
      line = null;
      return paint();
    }
    const mine = ++token;
    asked = now();
    try {
      const n = await deps.api.backupNotice();
      if (mine !== token) return;
      line = backupNoticeText(n, now());
      const tone = noticeTone(n.kind);
      root.dataset.kind = n.kind;
      root.classList.toggle("banner--danger", tone === "danger");
      text.textContent = line ?? "";
      const exact = exactTime(n.at);
      if (exact) text.title = exact;
      else text.removeAttribute("title");
    } catch {
      if (mine === token) line = null;
    }
    paint();
  }

  const onVisible = (): void => {
    if (document.visibilityState === "visible" && now() - asked > STALE_MS) void refresh();
  };
  document.addEventListener("visibilitychange", onVisible);
  void refresh();

  return {
    el: root,
    refresh,
    setConsoleOpen(next: boolean): void {
      if (consoleOpen === next) return;
      consoleOpen = next;
      // Leaving the console is when a fix made there shows up here.
      if (!next) void refresh();
      paint();
    },
    destroy: () => document.removeEventListener("visibilitychange", onVisible),
  };
}
