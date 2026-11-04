// Mounting the admin console into the library shell.

import { el } from "../../ui/dom";
import { type AdminApi, createAdminConsole } from "./admin";
import { createAdminView } from "./adminView";

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
  onBackupsChanged(): void;
}

/** Same open/isOpen shape as `BinController`, so the shell treats both alike. */
export interface AdminPanel {
  open(): void;
  /** Idempotent; the elevation is untouched. */
  close(): void;
  isOpen(): boolean;
  lock(): Promise<void>;
  isElevated(): boolean;
  /** Scrolls to the Server panel's backups once the household is shown. */
  revealBackups(): void;
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
    onBackupDismiss: (dismissed) => void console_.setBackupDismissed(dismissed),
    onBackupForget: (dir) => void console_.forgetBackupDir(dir),
  });

  const console_ = createAdminConsole({
    api: host.api,
    view,
    account: host.account,
    onSessionExpired: host.onSessionExpired,
    onElevationChanged: host.onElevationChanged,
    onBackupsChanged: host.onBackupsChanged,
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
    revealBackups: () => view.revealBackups(),

    destroy(): void {
      panel.remove();
      host.gallery.hidden = false;
      if (open) chrome(false);
    },
  };
}
