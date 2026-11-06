// The rail's footer: the account nameplate and the storage meter under it.

import { onPlainClick } from "../ui/link";
import { accountHref } from "../router";
import { el } from "../ui/dom";
import { ICONS, svg } from "../ui/icons";
import { formatBytes } from "../core/fileKind";
import { api as authApi } from "../api/client";

function initials(email: string): string {
  const name = (email || "").split("@")[0] ?? "";
  const parts = name.split(/[.\-_]+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "?";
  const b = parts[1]?.[0] ?? parts[0]?.[1] ?? "";
  return (a + b).toUpperCase();
}

/**
 * One link to the account page; sign out and the theme toggle live there,
 * which gives the name column room.
 */
export function createNameplate(email: string, onOpen: () => void): HTMLElement {
  const nameplate = el(
    "a",
    {
      class: "account",
      href: accountHref(),
      // Says what pressing does and who it's about.
      "aria-label": `Your account: ${email || "signed in"}`,
      title: "Your account",
    },
    el("span", { class: "avatar", "aria-hidden": "true", text: initials(email) }),
    el(
      "span",
      { class: "account__who" },
      el("span", { class: "account__name", text: (email || "").split("@")[0] || "Signed in" }),
      el("span", { class: "account__mail", text: email }),
    ),
    el("span", { class: "account__chevron", "aria-hidden": "true", html: svg(ICONS.chevron, 1.8) }),
  );
  onPlainClick(nameplate, onOpen);
  return nameplate;
}

export interface QuotaMeter {
  el: HTMLElement;
  refresh(): void;
  /**
   * Feeds the upload pre-flight, so a doomed transfer is refused on drop. Null
   * means unknown, never "no room".
   */
  remainingBytes(): number | null;
}

/** Hidden until `usage()` resolves; red over quota. */
export function createQuotaMeter(): QuotaMeter {
  const used = el("span", { class: "quota__used" });
  const total = el("span", { class: "quota__total" });
  const fill = el("div", { class: "quota__fill" });
  const meter = el(
    "div",
    { class: "quota", hidden: true, role: "img", "aria-label": "Storage used" },
    used,
    el("div", { class: "quota__track" }, fill),
    total,
  );
  let usage: { used: number; total: number } | null = null;

  return {
    el: meter,
    refresh(): void {
      void authApi.usage().then((u) => {
        usage = u && u.total > 0 ? u : null;
        if (!usage) return;
        const pct = Math.max(0, Math.min(100, (usage.used / usage.total) * 100));
        fill.style.width = `${pct}%`;
        used.textContent = formatBytes(usage.used);
        total.textContent = formatBytes(usage.total);
        meter.classList.toggle("is-over", usage.used > usage.total);
        meter.setAttribute("aria-label", `Storage used: ${formatBytes(usage.used)} of ${formatBytes(usage.total)}`);
        meter.hidden = false;
      });
    },
    remainingBytes: () => (usage === null ? null : Math.max(0, usage.total - usage.used)),
  };
}
