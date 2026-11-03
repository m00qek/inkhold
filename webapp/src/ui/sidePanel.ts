// The reader's docked side-panel chrome shared by the Layers and OCR panels:
// the card, its head ([icon] + label) and open/hide. Callers fill `body`;
// `hookPrefix` additionally stamps a feature namespace for tests and rules.

import { el } from "./dom";

/**
 * A px-valued CSS token read off `:root`, so relayout subtracts exactly the
 * width the stylesheet gives a panel. `fallback` mirrors the authored value.
 */
export function tokenPx(name: string, fallback: number): number {
  if (typeof getComputedStyle !== "function" || typeof document === "undefined") return fallback;
  const n = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue(name), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** The narrowest a paged viewer lets its side panels squeeze the page. */
export const MIN_PAGE_W = 360;

export interface SidePanelOptions {
  id?: string;
  ariaLabel: string;
  icon: string;
  label: string;
  wide?: boolean;
  hookPrefix?: string;
}

export interface SidePanel {
  el: HTMLElement;
  body: HTMLElement;
  setOpen(open: boolean): void;
}

export type SidePanelStateKind = "loading" | "empty" | "error";

export function sidePanelState(kind: SidePanelStateKind, message: string): HTMLElement {
  return el("p", { class: `side-panel__state side-panel__state--${kind}`, text: message });
}

export function createSidePanel(opts: SidePanelOptions): SidePanel {
  const p = opts.hookPrefix;
  const hook = (part = ""): string => (p ? ` ${p}${part}` : "");

  const body = el("div", { class: `side-panel__body${hook("__body")}` });
  const root = el(
    "aside",
    {
      class: `side-panel${opts.wide ? " side-panel--wide" : ""}${hook()}`,
      ...(opts.id ? { id: opts.id } : {}),
      hidden: true,
      "aria-label": opts.ariaLabel,
    },
    el(
      "div",
      { class: `side-panel__head${hook("__head")}` },
      el("span", { class: `side-panel__head-ic${hook("__head-ic")}`, "aria-hidden": "true", html: opts.icon }),
      el("span", { text: opts.label }),
    ),
    body,
  );

  return {
    el: root,
    body,
    setOpen(open: boolean): void {
      root.hidden = !open;
    },
  };
}
