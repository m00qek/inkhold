// The PDF viewer's chrome pieces: the copy control and the dock layout that
// keeps the page from being squeezed.

import { el } from "../../ui/dom";
import { copyText } from "../../ui/clipboard";
import { tokenPx, MIN_PAGE_W } from "../../ui/sidePanel";
import { svg, VIEWER_IC } from "../viewer/viewerIcons";

export interface CopyControl {
  btn: HTMLButtonElement;
  /** The "Copied" / "Could not copy" status line. */
  live: HTMLElement;
}

/** Copy for the selection layer's text; `selectedText` is read at click time. */
export function createCopyControl(selectedText: () => string): CopyControl {
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

/** Pages, Outline and Digests share the left dock, so one value makes two open unrepresentable. */
export type LeftDock = "pages" | "outline" | "digests";

/** A panel the docks open and shut, its element what a docked one takes from the page. */
interface DockPanel {
  el: HTMLElement;
  setOpen(open: boolean): void;
}

/** The panels and their toggles; a toggle's click opens or shuts its panel. */
export interface PdfDocksDeps {
  pagesPanel: DockPanel;
  outlinePanel: DockPanel;
  digestsPanel: DockPanel;
  layersPanel: { el: HTMLElement };
  pagesToggle: HTMLElement;
  outlineToggle: HTMLElement;
  digestsToggle: HTMLElement;
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
  /** The panels open now, left to right. */
  open(): HTMLElement[];
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
    if (left === "outline" || left === "digests") return dockPx("--panel-w", 268);
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
    deps.digestsPanel.setOpen(left === "digests");
    deps.layersPanel.el.hidden = !right;
    deps.pagesToggle.setAttribute("aria-pressed", String(left === "pages"));
    deps.outlineToggle.setAttribute("aria-pressed", String(left === "outline"));
    deps.digestsToggle.setAttribute("aria-pressed", String(left === "digests"));
    deps.layersToggle.setAttribute("aria-pressed", String(right));
    if (repaint) deps.repaint();
  }

  const lefts: [LeftDock, HTMLElement][] = [["pages", deps.pagesToggle], ["outline", deps.outlineToggle], ["digests", deps.digestsToggle]];
  for (const [dock, toggle] of lefts) toggle.addEventListener("click", () => setDocks(leftDock === dock ? null : dock, rightDock, "left"));
  deps.layersToggle.addEventListener("click", () => setDocks(leftDock, !rightDock, "right"));

  const leftPanel = { pages: deps.pagesPanel, outline: deps.outlinePanel, digests: deps.digestsPanel };
  return {
    set: setDocks,
    left: () => leftDock,
    right: () => rightDock,
    open: () => [leftDock === null ? null : leftPanel[leftDock].el, rightDock ? deps.layersPanel.el : null].filter((p): p is HTMLElement => p !== null),
  };
}
