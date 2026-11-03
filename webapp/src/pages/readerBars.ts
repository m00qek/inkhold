// The reader's two bars above the page: the version-preview banner and find.

import { el } from "../ui/dom";
import { svg, VIEWER_IC } from "./viewerIcons";

/** History mode only; Restore is the one mutating action on this surface. */
export function createVersionBanner() {
  const versionBannerText = el("span", { class: "version-banner__text" });
  const restoreVersionBtn = el("button", {
    class: "btn version-banner__restore",
    type: "button",
    text: "Restore this version",
  }) as HTMLButtonElement;
  const versionBanner = el(
    "div",
    { class: "version-banner", role: "status", hidden: true },
    el("span", { class: "version-banner__badge", "aria-hidden": "true", html: svg(VIEWER_IC.restore, 1.6) }),
    versionBannerText,
    restoreVersionBtn,
  );
  return { el: versionBanner, text: versionBannerText, restore: restoreVersionBtn };
}

export function createFindBarView() {
  const findToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "false",
    "aria-label": "Find in this note",
    title: "Find in this note (Ctrl+F)",
    html: svg(VIEWER_IC.find, 1.8),
  });
  const findInput = el("input", {
    type: "text",
    autocomplete: "off",
    placeholder: "Find in this note",
    "aria-label": "Find in this note",
  }) as HTMLInputElement;
  const findCount = el("span", { class: "findbar__count", role: "status", "aria-live": "polite" });
  // Shown when ovals cannot be drawn (unverified or mismatched `pxPerMm`), so a
  // correct count beside an unmarked page is explained.
  const findNote = el("span", {
    class: "findbar__note",
    hidden: true,
    text: "Match positions aren't available for this device.",
  });
  // Said once beside the counter, never per match.
  const findFuzzy = el("span", {
    class: "findbar__fuzzy",
    role: "status",
    hidden: true,
    text: "No exact match — showing close matches.",
  });
  // Offered when the exact find is empty but a fuzzy one would match; reveals
  // the fuzzy result already returned.
  const findAsk = el("button", {
    class: "findbar__ask",
    type: "button",
    hidden: true,
    text: "Search similar",
  }) as HTMLButtonElement;
  const findPrev = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Previous match",
    title: "Previous match",
    html: svg(VIEWER_IC.prev, 1.9),
  }) as HTMLButtonElement;
  const findNext = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Next match",
    title: "Next match",
    html: svg(VIEWER_IC.next, 1.9),
  }) as HTMLButtonElement;
  const findClose = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Close find",
    title: "Close find",
    html: svg(VIEWER_IC.close, 1.9),
  });
  const findBar = el(
    "div",
    { class: "findbar" },
    el("span", { class: "findbar__field", html: svg(VIEWER_IC.find, 1.8) }, findInput),
    findCount,
    findAsk,
    findFuzzy,
    findNote,
    findPrev,
    findNext,
    findClose,
  );
  return {
    el: findBar,
    toggle: findToggle,
    input: findInput,
    count: findCount,
    note: findNote,
    fuzzy: findFuzzy,
    ask: findAsk,
    prev: findPrev,
    next: findNext,
    close: findClose,
  };
}
