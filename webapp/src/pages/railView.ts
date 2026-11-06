// The rail's painter: rows to DOM. Knows nothing about categories, padlocks or
// To-Do; split from `rail.ts` so the model stays readable on its own.

import { el } from "../ui/dom";
import { ICONS, svg } from "../ui/icons";
import { onPlainClick } from "../ui/link";
import type { RailBadge, RailRow, RailView } from "./rail";

// ---- the painter ----

/**
* The DOM half. Knows nothing about categories or padlocks. Names are always
* set as text: device text must never take a markup path.
*/
export function createRailView(nav: HTMLElement): RailView {
  /** Null paints nothing (the admin row has nothing to count). */
  function badgeEl(badge: RailBadge | null): HTMLElement | null {
    if (badge === null) return null;
    if (badge.kind === "count") return el("span", { class: "nav__count", text: String(badge.value) });
    // The label moves with the state; the glyph swap alone isn't accessible.
    return el("span", {
      class: "nav__state",
      role: "img",
      "aria-label": badge.label,
      title: badge.label,
      html: svg(ICONS[badge.icon], 1.7),
    });
  }

  return {
    render(rows: readonly RailRow[]): void {
      nav.replaceChildren(
        ...rows.map((row) => {
          if (row.kind === "label") return el("div", { class: "nav__label", text: row.text });
          const cls = row.depth > 0 ? "nav__item is-nested" : "nav__item";
          const parts = [
            el("span", { class: "nav__glyph", html: svg(ICONS[row.icon]) }),
            el("span", { class: "nav__name", text: row.name }),
            badgeEl(row.badge),
          ];
          // A row with an address is a link: it can open in a new tab and says
          // where it goes. A plain click still runs the row's own action.
          const item =
            row.href !== null
              ? el("a", { class: cls, href: row.href, "aria-current": row.current ? "page" : null }, ...parts)
              : el("button", { class: cls, type: "button", "aria-current": String(row.current), "data-no-address": "" }, ...parts);
          item.style.setProperty("--depth", String(row.depth));
          if (row.href !== null) onPlainClick(item, () => row.select());
          else item.addEventListener("click", () => row.select());
          if (!row.toggle) return item;
          const t = row.toggle;
          const toggle = el("button", {
            class: "nav__toggle",
            type: "button",
            "aria-expanded": String(t.expanded),
            "aria-label": t.label,
            title: t.label,
            html: svg(ICONS.chevron),
          });
          toggle.addEventListener("click", () => t.onToggle());
          return el("div", { class: "nav__row" }, item, toggle);
        }),
      );
    },

    setBusy(busy: boolean): void {
      nav.setAttribute("aria-busy", String(busy));
    },
  };
}
