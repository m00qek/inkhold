// The viewer toolbar's BIN-MODE cluster — the fourth surface of the one action
// vocabulary. When a file is open FROM the recycle bin, every viewer's toolbar
// right zone showed two bare buttons, `[Restore][Delete permanently]`; it now
// shows `|— retention —| ⋯`, so a trashed file presents the IDENTICAL controls
// whether seen as a bin ROW (bin.ts) or opened in a viewer.
//
// Two reused pieces, no new component:
//   - the countdown is the bin row's own `.life` rule (08-bin.css) in a compact
//     inline variant (`.life--inline`, 10-toolbar.css) — same tokens, same
//     neutral→`--margin` colour logic as the days tick down;
//   - the "…" is the shared floating menu (`ui/menu.ts`) with "Restore" (neutral)
//     and "Delete permanently" (the one red `menu__item--danger`), wired to the
//     SAME `onRestore`/`onPurge` the bare buttons used — so the permanent-delete
//     confirm still travels with it through the bin controller.
//
// Built ONCE per viewer and shown/hidden by `setBinMode`, so the "…" trigger it
// registers in the toolbar's roving tabindex stays a stable element.

import { el } from "./dom";
import { createMenu } from "./menu";
import type { NoteMeta } from "../core/types";

/** A trashed file's countdown, mirrored from the bin row's own `BinRow`. */
export interface BinRetention {
  daysLeft: number;
  soon: boolean;
  retentionDays: number;
}

export interface BinViewerActionsDeps {
  /** The open file, read at click time so the menu always acts on what is shown. */
  getMeta: () => NoteMeta | null;
  onRestore?: (meta: NoteMeta) => void;
  onPurge?: (meta: NoteMeta) => void;
  /**
   * Open the trashed file's version history — the bin's CARD-parity entry point to
   * the same view-only history the reader's Versions button opens. Given the "…"
   * trigger as its anchor. Omitted → no "Version history" row (a viewer whose kind
   * never previews history). See bin-parity.md.
   */
  onHistory?: (meta: NoteMeta, anchor: HTMLElement) => void;
}

export interface BinViewerActions {
  /** The cluster — countdown + "…" menu. Hidden until `setBinMode(true, …)`. */
  el: HTMLElement;
  /** The "…" trigger — the cluster's one focusable, for the toolbar roving order. */
  trigger: HTMLButtonElement;
  /**
   * Enter or leave bin mode. `on` reveals the cluster (a live file hides it, in
   * favour of Move to bin); `retention` paints the timeline, or null shows the
   * "…" alone when the bin could not resolve the countdown.
   */
  setBinMode(on: boolean, retention: BinRetention | null): void;
}

export function createBinViewerActions(deps: BinViewerActionsDeps): BinViewerActions {
  const fill = el("div", { class: "life__fill" });
  const label = el("div", { class: "life__label" });
  // The bin row's countdown, inline: the class carries the shared token + colour
  // logic (08-bin.css); `--inline` lays it out horizontally for the toolbar.
  const life = el(
    "div",
    { class: "life life--inline", hidden: true },
    el("div", { class: "life__track" }, fill),
    label,
  );

  // Declared before the menu so a menu item can anchor `onHistory` to the "…"
  // trigger the menu is about to build.
  let trigger: HTMLButtonElement;
  const menu = createMenu({
    // One "…" in the whole bar, so a generic name is unambiguous (unlike a
    // gallery column of them, where the trigger names its row).
    triggerLabel: "File actions",
    items: [
      // Card parity: the SAME "Version history" entry the library card ⋯ menu
      // offers, so a trashed file's history is reachable whether it is seen as a
      // bin row or open in a viewer. View-only in the bin (the panel lists +
      // previews; per-version restore is suppressed downstream) — restore the FILE
      // (Restore, below) to get per-version restore back. Omitted when no
      // `onHistory` is wired.
      ...(deps.onHistory
        ? [
            {
              label: "Version history",
              icon: "restore" as const,
              onSelect: (): void => {
                const m = deps.getMeta();
                if (m) deps.onHistory?.(m, trigger);
              },
            },
          ]
        : []),
      {
        label: "Restore",
        icon: "restore",
        onSelect: () => {
          const m = deps.getMeta();
          if (m) deps.onRestore?.(m);
        },
      },
      {
        // The ONE red item, and its confirm rides through `onPurge` → the bin
        // controller's dialog, exactly as the bin row's does.
        label: "Delete permanently",
        icon: "trashX",
        danger: true,
        onSelect: () => {
          const m = deps.getMeta();
          if (m) deps.onPurge?.(m);
        },
      },
    ],
  });
  trigger = menu.querySelector(".card__more") as HTMLButtonElement;
  // Starts hidden with the cluster, so the toolbar's roving tabindex skips it
  // until a bin origin reveals it (see `setBinMode`).
  trigger.hidden = true;

  const wrap = el("div", { class: "viewer__bin-actions", hidden: true }, life, menu);

  function setBinMode(on: boolean, retention: BinRetention | null): void {
    wrap.hidden = !on;
    // The toolbar's roving tabindex filters on the FOCUSABLE'S own `hidden` (it
    // cannot see an ancestor's), so the trigger must carry it too — otherwise
    // End would land on the "…" of a hidden cluster over a live file.
    trigger.hidden = !on;
    life.hidden = !on || retention === null;
    if (on && retention) {
      const pct = Math.max(2, Math.min(100, Math.round((retention.daysLeft / Math.max(1, retention.retentionDays)) * 100)));
      fill.style.width = `${pct}%`;
      label.textContent = `${retention.daysLeft} ${retention.daysLeft === 1 ? "day" : "days"} left`;
      life.classList.toggle("is-soon", retention.soon);
    }
  }

  return { el: wrap, trigger, setBinMode };
}
