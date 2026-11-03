// The admin destination inside the shell: a loading stand-in over the
// `import("./admin")` round trip, then the console itself, built once.

import { el } from "../ui/dom";
import { folderHref, go } from "../router";
import type { Api } from "../api/types";
// Type only, so the console stays a separate chunk loaded by `import("./admin")`.
import type { AdminPanel } from "./admin";

export interface AdminDestinationDeps {
  api: Api;
  account: string;
  content: HTMLElement;
  gallery: HTMLElement;
  crumbs: HTMLElement;
  sortWrap: HTMLElement;
  segmented: HTMLElement;
  lockBtn: HTMLButtonElement;
  setMode: (open: boolean) => void;
  /** Repaints the rail highlight and the padlock. */
  rebuildRail: () => void;
  /** Whether the route still names the console; a route change can land mid-import. */
  isCurrent: () => boolean;
  toast: (message: string) => void;
  onSessionExpired: () => void;
}

export interface AdminDestination {
  /**
   * A cold start always builds a fresh panel and shows the gate; re-entry in one
   * session reuses it, since elevation is the server's fact.
   */
  open(): void;
  /**
   * Called on user-driven navigation only, not from `renderGallery`, which also
   * runs on a live sync bump and must not eject an admin mid-confirmation.
   */
  leave(): void;
  /** Locked before the console was ever imported, which is also what the gate shows. */
  isElevated(): boolean;
  lock(): void;
  destroy(): void;
}

function adminNotice(title: string, text: string): HTMLElement {
  return el(
    "section",
    { class: "admin-notice" },
    el("h2", { class: "admin-notice__title", text: title }),
    el("p", { class: "admin-notice__text", text }),
  );
}

export function createAdminDestination(deps: AdminDestinationDeps): AdminDestination {
  /** Created on first entry (dynamic import) and kept for the shell's life. */
  let admin: AdminPanel | null = null;

  /**
   * Stand-in painted over the import, so the old gallery doesn't linger under the
   * Admin highlight. Reuses `.admin-notice` so the swap is a change of words.
   * Built lazily, once.
   */
  let booting: HTMLElement | null = null;

  function showBooting(): void {
    if (!booting) {
      booting = el("section", { class: "admin-booting" });
      deps.content.append(booting);
    }
    booting.replaceChildren(adminNotice("Loading…", "Opening the admin console."));
    booting.hidden = false;
    // Same as `AdminPanel.chrome(true)`; `lockBtn` stays hidden.
    deps.gallery.hidden = true;
    deps.sortWrap.hidden = true;
    deps.segmented.hidden = true;
    deps.setMode(true);
    const home = el("button", { type: "button", text: "Library" });
    home.addEventListener("click", () => go(folderHref(null)));
    deps.crumbs.replaceChildren(
      home,
      el("span", { class: "crumbs__sep", text: "/" }),
      el("span", { class: "crumbs__here", text: "Admin" }),
    );
    deps.rebuildRail(); // the highlight reads the shell's destination, already admin
  }

  /** `handOver`: the real console takes this chrome as is, so don't flash the gallery. */
  function hideBooting(handOver: boolean): void {
    if (!booting || booting.hidden) return;
    booting.hidden = true;
    if (handOver) return;
    deps.gallery.hidden = false;
    deps.sortWrap.hidden = false;
    deps.segmented.hidden = false;
    deps.setMode(false);
  }

  return {
    open(): void {
      if (admin) {
        admin.open();
        deps.rebuildRail();
        return;
      }
      // Painted before the import is issued.
      showBooting();
      void import("./admin")
        .then((m) => {
          admin = m.createAdminPanel({
            api: deps.api,
            account: deps.account,
            content: deps.content,
            gallery: deps.gallery,
            crumbs: deps.crumbs,
            sortWrap: deps.sortWrap,
            segmented: deps.segmented,
            lockBtn: deps.lockBtn,
            setMode: deps.setMode,
            // Elevation changes only inside the panel (unlock, lock, 428); rebuild the
            // rail so the padlock never lies.
            onElevationChanged: () => deps.rebuildRail(),
            toast: deps.toast,
            onSessionExpired: deps.onSessionExpired,
          });
          if (!deps.isCurrent()) {
            hideBooting(false);
            return;
          }
          // Hand over rather than tear down, to avoid flashing the gallery.
          hideBooting(true);
          admin.open();
          deps.rebuildRail(); // the console is open now; repaint the highlight
        })
        .catch(() => {
          // The chunk failed (dropped link, or a stale tab after a redeploy); a loading
          // state must not outlive what it describes.
          if (!deps.isCurrent() || !booting) return;
          booting.replaceChildren(
            adminNotice("The console could not be loaded", "Check your connection and try again."),
          );
        });
    },
    leave(): void {
      // Also drop the import stand-in, or it would sit over the requested folder.
      hideBooting(false);
      admin?.close();
    },
    isElevated: () => admin?.isElevated() ?? false,
    lock: () => void admin?.lock(),
    destroy: () => admin?.destroy(),
  };
}
