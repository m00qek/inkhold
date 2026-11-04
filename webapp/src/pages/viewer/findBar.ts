// The find bar every paged viewer mounts above its page: a field, the match
// count, the "Search similar" opt-in and prev/next/close. Each viewer names its
// own block class, so its stylesheet styles it and the e2e locators for one
// viewer's bar never see another's.

import { el } from "../../ui/dom";
import { svg, VIEWER_IC } from "./viewerIcons";

export interface FindBarOptions {
  /** The block the viewer's stylesheet styles: `findbar`, `pdfbar`, `txtbar`. */
  block: string;
  /** The field's placeholder and accessible name. */
  label: string;
  /** Mounted hidden until the viewer opens it (default); the reader shows it through a class instead. */
  hidden?: boolean;
  /** Status lines placed between the opt-in and the stepper (the reader's fuzzy and positions notes). */
  extras?: HTMLElement[];
}

export interface FindBar {
  el: HTMLElement;
  input: HTMLInputElement;
  count: HTMLElement;
  /** Offered when the exact find is empty but a fuzzy one would match. */
  ask: HTMLButtonElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  close: HTMLButtonElement;
}

export function createFindBar(o: FindBarOptions): FindBar {
  const input = el("input", {
    type: "text",
    autocomplete: "off",
    placeholder: o.label,
    "aria-label": o.label,
  });
  const count = el("span", { class: `${o.block}__count`, role: "status", "aria-live": "polite" });
  const ask = el("button", { class: `${o.block}__ask`, type: "button", hidden: true, text: "Search similar" });
  const prev = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Previous match",
    title: "Previous match",
    html: svg(VIEWER_IC.prev, 1.9),
  });
  const next = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Next match",
    title: "Next match",
    html: svg(VIEWER_IC.next, 1.9),
  });
  const close = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Close find",
    title: "Close find",
    html: svg(VIEWER_IC.close, 1.9),
  });
  const bar = el(
    "div",
    { class: o.block, hidden: o.hidden ?? true },
    el("span", { class: `${o.block}__field`, html: svg(VIEWER_IC.find, 1.8) }, input),
    count,
    ask,
    ...(o.extras ?? []),
    prev,
    next,
    close,
  );
  return { el: bar, input, count, ask, prev, next, close };
}
