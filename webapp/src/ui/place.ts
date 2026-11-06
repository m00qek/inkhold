// Where you are, said once for everyone: the browser tab's title and the
// page's one <h1>. The heading is read by screen readers and by the outline,
// not drawn: the top bar already shows the place. Library screens take their
// name from the breadcrumbs' current place; a viewer or To-Do names itself
// while it is open (an overlay). On a change of screen focus moves to the
// heading, so a keyboard or screen reader starts at the top of what changed,
// but never while someone is typing.

import { el } from "./dom";

const APP = "Inkhold";

export interface Place {
  /** The <h1>, first in <main>. */
  readonly heading: HTMLElement;
  /** The library's place, from the breadcrumbs. */
  set(name: string): void;
  /** A viewer's or To-Do's own name while it is open; null when it closes. */
  overlay(name: string | null): void;
}

function typing(): boolean {
  const a = document.activeElement;
  return a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement || (a instanceof HTMLElement && a.isContentEditable);
}

/** Set by the first click or key: before it, the page is still loading and no focus moves. */
let acted = false;
if (typeof document !== "undefined") {
  const mark = () => (acted = true);
  document.addEventListener("pointerdown", mark, { capture: true, once: true });
  document.addEventListener("keydown", mark, { capture: true, once: true });
}

export function createPlace(): Place {
  const heading = el("h1", { class: "sr-only", id: "place", tabindex: "-1" });
  let base = "";
  let over: string | null = null;
  let shown: string | null = null;

  function show(focus: boolean): void {
    const name = over ?? base;
    if (name === shown) return;
    shown = name;
    heading.textContent = name;
    document.title = name ? `${name} · ${APP}` : APP;
    // Not before anyone did anything (the page is loading), not mid-typing, not in a dialog.
    if (focus && acted && !typing() && !document.activeElement?.closest("dialog")) heading.focus({ preventScroll: true });
  }

  return {
    heading,
    set(name) {
      base = name;
      show(over === null);
    },
    overlay(name) {
      over = name;
      // A viewer moves focus into itself; when it closes, the library's place takes it back.
      show(name === null);
    },
  };
}
