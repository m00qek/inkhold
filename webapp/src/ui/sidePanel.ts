// The reader's docked side-panel CHROME, extracted so the "Layers" panel and the
// "Recognized text" (OCR) panel speak one design language instead of two
// hand-built copies of the same card kept in sync by comments.
//
// WHAT THIS OWNS: the right-docked `<aside>` card — its `--sheet` ground, `--line`
// border, `--radius-card` corner, padding, hidden behaviour and open/hide — plus
// the head treatment ([icon] + mono-eyebrow label) both panels share. Nothing
// format-specific: the caller fills `body` with whatever the panel actually is (a
// `<ul>` of layer rows, a transcript), and drives open/close through the feature's
// own controller.
//
// WHAT STAYS WITH THE CALLER, BY DESIGN:
//   - The glyph. `icon` is a pre-rendered SVG string off the caller's own `IC` /
//     `svg()` system, so "Layers" and "Recognized text" keep the exact geometry
//     the rest of that viewer's toolbar draws.
//   - The body's content AND its own look. The layers panel keeps its neutral
//     `layers-panel__*` row classes; the OCR body keeps its `.ocr__body` text
//     treatment. The primitive only frames them.
//   - The width. Two intents, two tokens: `--panel-w` (the OCR default) and
//     `--panel-w-wide` (the layers panel, which legitimately needs room for a
//     name + stepper + eye + thumbnail per row) via `wide`.
//
// HOOKS. A caller passes `hookPrefix` to ALSO stamp its own namespace on the card,
// head, head-icon and body (`spd-layers` → `.spd-layers`, `.spd-layers__head`,
// `.spd-layers__head-ic`, `.spd-layers__body`; `ocr` → `.ocr`, `.ocr__head`, …) —
// the stable hooks tests and format-specific rules select on. They carry no look
// of their own; the shared treatment rides the neutral `side-panel*` classes
// (styled in 15-side-panel.css).

import { el } from "./dom";

/**
 * A px-valued CSS token read off `:root`.
 *
 * A viewer's relayout has to subtract exactly the width a docked panel takes
 * from the stage, and that width is a token (`--panel-w`, `--panel-w-wide`,
 * `--panel-w-narrow`, `--panel-gap` in `00-tokens.css`). So the JS reads the very
 * value the stylesheet uses rather than duplicating it as a hand-synced constant
 * that quietly drifts. `fallback` matches the token's authored value, for any
 * environment where the property is not resolvable.
 *
 * IT LIVES HERE, with the component whose widths it reads, because the second
 * viewer needing it is exactly how the drift its own comment warns about would
 * have started: it was private to `reader.ts` until the PDF viewer grew the same
 * squeeze rule, and copying it across would have made two constants for one
 * token.
 */
export function tokenPx(name: string, fallback: number): number {
  if (typeof getComputedStyle !== "function" || typeof document === "undefined") return fallback;
  const n = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue(name), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The narrowest a paged viewer will let its own side panels squeeze the page.
 *
 * NOT A TOKEN, because nothing draws it: it is a rule about when a panel has to
 * give way, and the stylesheet has no opinion on that. Both paged viewers hold
 * the page to the same floor, which is the point of it being one number — a page
 * narrowed past this is not a page you are reading, it is a page you are looking
 * at past the furniture.
 */
export const MIN_PAGE_W = 360;

export interface SidePanelOptions {
  /** `id` for the `<aside>` — the target of an opener's `aria-controls`. */
  id?: string;
  /** Names the `<aside>` for assistive tech (the head icon is decorative). */
  ariaLabel: string;
  /** The head glyph as an inline SVG string (the caller's own `IC`/`svg()`). */
  icon: string;
  /** The mono-eyebrow label beside the glyph. */
  label: string;
  /** Use the wider `--panel-w-wide` track (the layers panel's rows need it). */
  wide?: boolean;
  /**
   * Feature namespace for hook classes (`"spd-layers"` → `.spd-layers`,
   * `.spd-layers__head`, `.spd-layers__head-ic`, `.spd-layers__body`). Purely
   * additional — the shared look stays on the neutral `side-panel*` classes.
   */
  hookPrefix?: string;
}

export interface SidePanel {
  /** The `<aside>` — mounted by the caller and shown/hidden via {@link setOpen}. */
  el: HTMLElement;
  /** The region the caller fills with the panel's own content. */
  body: HTMLElement;
  /** Show or hide the whole panel (toggles the `hidden` attribute). */
  setOpen(open: boolean): void;
}

/**
 * The three non-content states a side panel can speak — deliberately the OCR
 * panel's vocabulary, promoted so every panel says "still loading / nothing here
 * / that failed" identically. `kind` also drives a modifier for any per-state
 * tuning a feature wants.
 */
export type SidePanelStateKind = "loading" | "empty" | "error";

/** A shared state line (`.side-panel__state`), set apart from real body content. */
export function sidePanelState(kind: SidePanelStateKind, message: string): HTMLElement {
  return el("p", { class: `side-panel__state side-panel__state--${kind}`, text: message });
}

export function createSidePanel(opts: SidePanelOptions): SidePanel {
  const p = opts.hookPrefix;
  // Mechanical namespacing: the card hooks as `<prefix>`, its parts as
  // `<prefix>__head` / `<prefix>__head-ic` / `<prefix>__body`.
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
