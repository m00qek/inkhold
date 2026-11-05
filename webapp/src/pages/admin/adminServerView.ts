// The admin console's Server panel: household totals (memory, disk, the
// recycle bin's window, backups) and, below, every backup folder.

import { el } from "../../ui/dom";
import type { Server } from "./adminModel";
import { memoryCard, formatBytes, RETENTION_NEVER_PURGES } from "./adminCopy";
import { backupsCard } from "./backupCopy";
import { backupsDetail } from "./adminBackupsView";
import { changeBtn, statCard } from "./adminParts";

export interface ServerHandlers {
  onRetention(): void;
  onBackupDismiss(dismissed: boolean): void;
  onBackupForget(dir: string): void;
}

/** Household totals only; no uptime or last-sync cards (activity surveillance). */
export function serverPanel(server: Server, busy: boolean, h: ServerHandlers): HTMLElement | null {
  const { health, retention, backups } = server;
  if (!health && !retention && !backups) return null; // nothing readable: draw no panel at all

  const cards: (HTMLElement | null)[] = [];
  if (health) {
    const mem = memoryCard(health);
    cards.push(statCard("Memory", mem.value, mem.sub, mem.meter, null));
    // States its denominator so it doesn't read as free space.
    cards.push(
      statCard(
        "Disk used",
        formatBytes(health.blobBytes),
        `across ${health.blobCount.toLocaleString("en-GB")} stored files, deduplicated`,
        null,
        null,
      ),
    );
  }
  if (retention) {
    cards.push(
      statCard(
        "Recycle bin",
        `${retention.retentionDays} ${retention.retentionDays === 1 ? "day" : "days"}`,
        "before deleted notes are removed for good",
        null,
        busy ? null : changeBtn("Change how long the recycle bin holds a note", () => h.onRetention()),
      ),
    );
  }

  if (backups) {
    const card = backupsCard(backups);
    cards.push(statCard("Backups", card.value, card.sub, null, null, card.danger));
  }

  return el(
    "section",
    { class: "admin-server" },
    el(
      "div",
      { class: "admin-head" },
      el("h2", { class: "admin-head__title", text: "Server" }),
      health ? el("span", { class: "admin-head__ver", text: health.version }) : null,
      el("span", { class: "admin-head__rule", "aria-hidden": "true" }),
    ),
    el("div", { class: "admin-stats" }, ...cards),
    // Right under the cards: it is about the Recycle bin card, not the backups below.
    retention
      ? el("p", {
          class: "admin-server__note",
          // Also on the card: the reader of the number needs to know lowering it is safe.
          text: RETENTION_NEVER_PURGES,
        })
      : null,
    backups
      ? backupsDetail(backups, busy, { onDismiss: h.onBackupDismiss, onForget: h.onBackupForget })
      : null,
  );
}
