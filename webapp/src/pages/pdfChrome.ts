// The PDF viewer's chrome pieces: the dimmable opener, the find bar's DOM, the
// copy control and the dock layout that keeps the page from being squeezed.

import { el } from "../ui/dom";
import { copyText } from "../ui/clipboard";
import { tokenPx, MIN_PAGE_W } from "../ui/sidePanel";
import { svg, VIEWER_IC } from "./viewerIcons";

/**
 * A toolbar control that is always present, dimmed with the reason on its
 * accessible name when unavailable, so the bar keeps its shape per document.
 */
export function contextualOpener(spec: {
  icon: string;
  label: string;
  reason: string;
  attrs?: Record<string, string>;
}): { el: HTMLButtonElement; setAvailable(has: boolean): void } {
  const dimmed = `${spec.label} — ${spec.reason}`;
  const button = el("button", {
    class: "btn",
    type: "button",
    ...spec.attrs,
    "aria-label": dimmed,
    title: dimmed,
    disabled: true,
    html: svg(spec.icon, 1.8),
  }) as HTMLButtonElement;
  return {
    el: button,
    setAvailable(has: boolean): void {
      button.disabled = !has;
      const name = has ? spec.label : dimmed;
      button.setAttribute("aria-label", name);
      button.title = name;
    },
  };
}

export function createPdfFindBarView() {
  const findInput = el("input", {
    type: "text",
    autocomplete: "off",
    placeholder: "Find in this file",
    "aria-label": "Find in this file",
  }) as HTMLInputElement;
  const findCount = el("span", { class: "pdfbar__count", role: "status", "aria-live": "polite" });
  const findAsk = el("button", {
    class: "pdfbar__ask",
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
  }) as HTMLButtonElement;
  const findBar = el(
    "div",
    { class: "pdfbar", hidden: true },
    el("span", { class: "pdfbar__field", html: svg(VIEWER_IC.find, 1.8) }, findInput),
    findCount,
    findAsk,
    findPrev,
    findNext,
    findClose,
  );
  return { bar: findBar, input: findInput, count: findCount, ask: findAsk, prev: findPrev, next: findNext, close: findClose };
}

/** Copy for the selection layer's text; `selectedText` is read at click time. */
export function createCopyControl(selectedText: () => string) {
  /**
   * Shown only with a selection. Reports failure: on plain HTTP the async
   * clipboard is unavailable and `copyText` falls back, which can still fail.
   */
  const copyBtn = el("button", {
    class: "btn",
    type: "button",
    "aria-label": "Copy selected text",
    title: "Copy selected text",
    html: svg(VIEWER_IC.copy, 1.7),
    hidden: true,
  }) as HTMLButtonElement;
  const copyLive = el("span", { class: "pdf-copy__live", role: "status" });
  let copyLabelTimer = 0;
  async function runCopy(): Promise<void> {
    const text = selectedText();
    if (text === "") return;
    const ok = await copyText(text);
    copyLive.textContent = ok ? "Copied" : "Could not copy";
    copyBtn.classList.toggle("is-failed", !ok);
    window.clearTimeout(copyLabelTimer);
    copyLabelTimer = window.setTimeout(() => {
      copyLive.textContent = "";
      copyBtn.classList.remove("is-failed");
    }, 1800);
  }
  copyBtn.addEventListener("click", () => void runCopy());
  return { btn: copyBtn, live: copyLive };
}

/** Pages and Outline share the left dock, so one value makes both-open unrepresentable. */
export type LeftDock = "pages" | "outline";

export interface PdfDocksDeps {
  pagesPanel: { setOpen(open: boolean): void };
  outlinePanel: { setOpen(open: boolean): void };
  layersPanel: { el: HTMLElement };
  pagesToggle: HTMLElement;
  outlineToggle: HTMLElement;
  layersToggle: HTMLElement;
  /** The stage's inner width now; 0 before layout. */
  stageWidth: () => number;
  /** Repaint after a user toggle; panels narrow a Fit page. */
  repaint: () => void;
}

export interface PdfDocks {
  set(left: LeftDock | null, right: boolean, asked: "left" | "right" | null, repaint?: boolean): void;
  left(): LeftDock | null;
  right(): boolean;
}

export function createPdfDocks(deps: PdfDocksDeps): PdfDocks {
  let leftDock: LeftDock | null = null;
  let rightDock = false;

  /**
   * A dock's width from the CSS tokens: unlike `availableBox`, this answers
   * whether a not-yet-mounted panel would fit.
   */
  function dockPx(track: string, fallback: number): number {
    return tokenPx(track, fallback) + tokenPx("--panel-gap", 22);
  }
  function leftDockPx(left: LeftDock | null): number {
    if (left === "pages") return dockPx("--panel-w-narrow", 180);
    if (left === "outline") return dockPx("--panel-w", 268);
    return 0;
  }
  function rightDockPx(right: boolean): number {
    return right ? dockPx("--panel-w-wide", 320) : 0;
  }
  /** Below {@link MIN_PAGE_W} with these docks? An unlaid-out stage protects nothing. */
  function tooTight(left: number, right: number): boolean {
    const w = deps.stageWidth();
    return w > 0 && w - left - right < MIN_PAGE_W;
  }

  /**
   * The one place any panel opens or shuts. The page is never squeezed from both
   * sides: if both docks together would leave it under {@link MIN_PAGE_W}, the
   * side the user just touched (`asked`) wins. Repaint is needed on a toggle since
   * panels narrow a Fit page; skipped only for programmatic closes.
   */
  function setDocks(
    left: LeftDock | null,
    right: boolean,
    asked: "left" | "right" | null,
    repaint = true,
  ): void {
    if (asked === "left" && left !== null && tooTight(leftDockPx(left), rightDockPx(right))) {
      right = false;
    }
    if (asked === "right" && right && tooTight(leftDockPx(left), rightDockPx(right))) {
      left = null;
    }
    leftDock = left;
    rightDock = right;
    deps.pagesPanel.setOpen(left === "pages");
    deps.outlinePanel.setOpen(left === "outline");
    deps.layersPanel.el.hidden = !right;
    deps.pagesToggle.setAttribute("aria-pressed", String(left === "pages"));
    deps.outlineToggle.setAttribute("aria-pressed", String(left === "outline"));
    deps.layersToggle.setAttribute("aria-pressed", String(right));
    if (repaint) deps.repaint();
  }

  return { set: setDocks, left: () => leftDock, right: () => rightDock };
}
