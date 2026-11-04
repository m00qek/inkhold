// The account page's DOM vocabulary: sections, rows, buttons and the two
// placeholder states, plus the per-section load state.

import { el } from "../../ui/dom";

export type Load<T> = { kind: "loading" } | { kind: "ready"; data: T } | { kind: "failed"; message: string };

export function section(label: string, ...children: (Node | null)[]): HTMLElement {
  return el(
    "section",
    { class: "acct-sec" },
    el("h2", { class: "acct-sec__label", text: label }),
    el("div", { class: "acct-sec__body" }, ...children),
  );
}

export function deviceHint(): HTMLElement {
  return el("p", {
    class: "acct-hint",
    text: "Unlinking stops sync until the device is paired again. Nothing already synced is removed.",
  });
}

// ---- generic row ----
export interface Row {
  node: HTMLElement;
  value: HTMLElement;
  actions: HTMLElement;
}

export function row(label: string): Row {
  const value = el("div", { class: "acct-row__v acct-data" });
  const actions = el("div", { class: "acct-row__acts" });
  return {
    node: el("div", { class: "acct-row" }, el("div", { class: "acct-row__k", text: label }), value, actions),
    value,
    actions,
  };
}

export function button(label: string, onClick: () => void, opts: { danger?: boolean; ariaLabel?: string } = {}): HTMLButtonElement {
  const b = el("button", {
    class: opts.danger ? "acct-btn acct-btn--danger" : "acct-btn",
    type: "button",
    text: label,
  });
  if (opts.ariaLabel) b.setAttribute("aria-label", opts.ariaLabel);
  b.addEventListener("click", onClick);
  return b;
}

/** Never a zero, empty list or dash while still fetching. */
export function pending(): HTMLElement {
  return el("p", { class: "acct-pending", text: "Loading…" });
}

export function failed(message: string): HTMLElement {
  return el("p", { class: "acct-failed", role: "status", text: message });
}
