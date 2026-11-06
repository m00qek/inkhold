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
  /**
   * Shut the panel the way its toggle does. Given, the head carries a ×, shown
   * where the panel is a sheet over the page (a phone), its toggle behind ⋯.
   */
  onClose?: () => void;
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

function closeButton(label: string, onClose: () => void): HTMLElement {
  const btn = el("button", {
    type: "button",
    class: "btn side-panel__close",
    "aria-label": `Close ${label.toLowerCase()}`,
    html: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>',
  });
  btn.addEventListener("click", onClose);
  return btn;
}

/**
 * An `onClose` that shuts a panel through its `toggle`, so every rule the toggle
 * keeps (pressed state, relayout, saved intent) still runs. Focus then goes to
 * the toggle, or to the bar's ⋯ where the toggle is folded away.
 */
export function closeWith(toggle: HTMLElement): () => void {
  return () => {
    toggle.click();
    const more = toggle.closest(".toolbar")?.querySelector<HTMLElement>(".toolbar__more");
    (toggle.offsetParent !== null ? toggle : more)?.focus();
  };
}

export function createSidePanel(opts: SidePanelOptions): SidePanel {
  const p = opts.hookPrefix;
  const hook = (part = ""): string => (p ? ` ${p}${part}` : "");

  const body = el("div", { class: `side-panel__body${hook("__body")}` });
  const root = el(
    // A named region beside the page, inside <main>: not a top-level aside.
    "section",
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
      ...(opts.onClose ? [closeButton(opts.label, opts.onClose)] : []),
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
