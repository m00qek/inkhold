// The reader's two bars above the page: the version-preview banner and find.

import { el } from "../../ui/dom";
import { svg, VIEWER_IC } from "../viewer/viewerIcons";

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

/** The reader's toolbar buttons: transcript, layers, pages, move to bin, versions, download. */
export function createReaderButtons() {
  // Icon-only too, same call as Download.
  const ocrToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "false",
    "aria-label": "Recognized text",
    title: "Recognized text",
    html: svg(VIEWER_IC.text, 1.7),
  });

  // Enabled only while the focused page has layers (per-page in a `.note`).
  const layersToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "false",
    "aria-expanded": "false",
    "aria-controls": "note-layers-panel",
    "aria-label": "Layers",
    title: "Layers",
    html: svg(VIEWER_IC.layers, 1.7),
  }) as HTMLButtonElement;

  // Pressed by default: the page index opens with the note.
  const pagesToggle = el("button", {
    class: "btn",
    type: "button",
    "aria-pressed": "true",
    "aria-expanded": "true",
    "aria-controls": "note-pages-panel",
    "aria-label": "Pages",
    title: "Pages",
    html: svg(VIEWER_IC.pages, 1.7),
  }) as HTMLButtonElement;

  // Neutral, not red (trash is recoverable; red is for purge), and labelled
  // because a bare trash glyph reads as danger.
  const moveBin = el("button", {
    class: "btn",
    type: "button",
    "aria-label": "Move to bin",
    title: "Move to bin",
    html: svg(VIEWER_IC.trash, 1.8) + "Move to bin",
  });

  // Shown for a `.note` and in any history preview; see `open()`.
  const versionsBtn = el("button", {
    class: "btn",
    type: "button",
    "aria-label": "Version history",
    title: "Version history",
    html: svg(VIEWER_IC.restore, 1.7),
  });

  // Non-note modes only. The server sends `Content-Disposition: attachment` for
  // this URL regardless of type.
  const downloadLink = el("a", {
    class: "btn",
    hidden: true,
    "aria-label": "Download",
    title: "Download",
    html: svg(VIEWER_IC.down, 1.8),
  }) as HTMLAnchorElement;
  return { ocrToggle, layersToggle, pagesToggle, moveBin, versionsBtn, downloadLink };
}
