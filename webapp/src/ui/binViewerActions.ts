// The viewer toolbar's bin-mode cluster (retention countdown + "…" menu), so a
// trashed file shows the same controls opened in a viewer as on its bin row.
// Built once per viewer and toggled by `setBinMode`, keeping the "…" a stable
// element in the toolbar's roving tabindex.

import { el } from "./dom";
import { createMenu } from "./menu";
import type { NoteMeta } from "../core/types";

export interface BinRetention {
  daysLeft: number;
  soon: boolean;
  retentionDays: number;
}

export interface BinViewerActionsDeps {
  getMeta: () => NoteMeta | null;
  onRestore?: (meta: NoteMeta) => void;
  onPurge?: (meta: NoteMeta) => void;
  /** Open the view-only version history, anchored to the "…" trigger. */
  onHistory?: (meta: NoteMeta, anchor: HTMLElement) => void;
}

export interface BinViewerActions {
  el: HTMLElement;
  trigger: HTMLButtonElement;
  /** Enter or leave bin mode; null `retention` shows the "…" alone. */
  setBinMode(on: boolean, retention: BinRetention | null): void;
}

export function createBinViewerActions(deps: BinViewerActionsDeps): BinViewerActions {
  const fill = el("div", { class: "life__fill" });
  const label = el("div", { class: "life__label" });
  const life = el(
    "div",
    { class: "life life--inline", hidden: true },
    el("div", { class: "life__track" }, fill),
    label,
  );

  let trigger: HTMLButtonElement;
  const menu = createMenu({
    triggerLabel: "File actions",
    items: [
      // View-only in the bin; restore the file to get per-version restore back.
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
  trigger.hidden = true;

  const wrap = el("div", { class: "viewer__bin-actions", hidden: true }, life, menu);

  function setBinMode(on: boolean, retention: BinRetention | null): void {
    wrap.hidden = !on;
    // The roving tabindex filters on the focusable's own `hidden`, not an ancestor's.
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
