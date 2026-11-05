// The admin console's small element builders, shared by the people rows and
// the Server panel: chips, meters, the "Change" button and the stat cards.

import { el } from "../../ui/dom";
import { ICONS, svg } from "../../ui/icons";
import type { Meter } from "./adminCopy";

export function chip(text: string, kind: "admin" | "pending"): HTMLElement {
  return el("span", { class: `admin-chip admin-chip--${kind}`, text });
}

/** Same idiom as the bin's retention countdown. */
export function meterEl(meter: Meter, label: string, control: HTMLElement | null, bare = false): HTMLElement {
  const fill = el("div", { class: "admin-meter__fill" });
  fill.style.width = `${meter.fill}%`;
  return el(
    "div",
    { class: `admin-meter is-${meter.tone}` },
    el(
      "div",
      {
        class: "admin-meter__track",
        role: "img",
        "aria-label": `${label}: ${meter.label}`,
      },
      fill,
    ),
    // `bare` in a stat card, whose value already says it.
    bare ? null : el("div", { class: "admin-meter__label" }, el("span", { text: meter.label }), control),
  );
}

/** Glyph then words, like every labelled action; the pencil is `aria-hidden`. */
export function changeBtn(ariaLabel: string, onClick: () => void): HTMLButtonElement {
  const b = el(
    "button",
    { class: "admin-change", type: "button" },
    el("span", { class: "admin-change__mark", "aria-hidden": "true", html: svg(ICONS.edit, 1.9) }),
    el("span", { text: "Change" }),
  );
  b.setAttribute("aria-label", ariaLabel);
  b.addEventListener("click", onClick);
  return b;
}

/** `danger`: the value reads in the console's danger colour, like an overfull meter's label. */
export function statCard(k: string, value: string, sub: string, meter: Meter | null, control: HTMLElement | null, danger = false): HTMLElement {
  return el(
    "div",
    { class: danger ? "admin-stat admin-stat--danger" : "admin-stat" },
    el("div", { class: "admin-stat__k", text: k }),
    el("div", { class: "admin-stat__v" }, el("span", { text: value }), control),
    el("div", { class: "admin-stat__sub", text: sub }),
    meter ? meterEl(meter, k, null, true) : null,
  );
}
