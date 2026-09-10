// The shared viewer chrome: the back+title header, the placeholder body, the
// version banner and the find debounce, as the three viewers (`.note` reader,
// `.spd`, `.txt`) all want them. Each viewer parameterises only what
// legitimately differs — its header classes, its placeholder mark.
//
// The glyph table lives in `viewerIcons.ts`, the steppers in `viewerControls.ts`
// and the download menu in `viewerExportMenu.ts` — each imported by the consumers
// that actually want it rather than by everyone who wanted one thing from here.

import { el } from "../ui/dom";
import { relativeTime, absoluteTime } from "../ui/relativeTime";
import { svg, VIEWER_IC } from "./viewerIcons";
import type { ReaderOrigin } from "./viewer";

/**
 * Quiet period, ms, before a find query is sent / the URL settles — one value so
 * the whole app debounces search-as-you-type identically, and the address bar
 * lands with the results rather than a beat behind them. The reader's URL sync,
 * the `.txt` viewer's find, and the find controller's own default all read it.
 */
export const VIEWER_DEBOUNCE_MS = 220;

/**
 * The word Back carries — where the file was opened FROM. `search`/`bin` are
 * fixed labels; a folder resolves to its DEEPEST segment (`Note / Projects` →
 * `Projects`), and the empty/absent path is the whole `Library`.
 */
export function backWord(origin: ReaderOrigin): string {
  if (origin.kind === "search") return "Search";
  if (origin.kind === "bin") return "Recycle bin";
  const parts = (origin.folderPath ?? "").split("/").map((s) => s.trim()).filter(Boolean);
  return parts.length === 0 ? "Library" : parts[parts.length - 1]!;
}

/**
 * The header's SUBTITLE, prefixed with where the file lives.
 *
 * `rest` is whatever the viewer knows that the screen does not already say — the
 * reader uses a page count for a note and `TYPE · size` for everything else. The
 * folder path is the part no other control carries: the toolbar's Back button
 * names only the DEEPEST segment (see {@link backWord}), so `Note / Projects`
 * reads as "Projects" there and the full path appears nowhere else.
 */
export function originSubtitle(origin: ReaderOrigin, rest: string): string {
  if (origin.kind === "folder" || origin.folderPath === null) return rest;
  return `${origin.folderPath} · ${rest}`;
}

export interface ViewerBody {
  /** The `.viewer__main` element — mounted in the viewer's root. */
  main: HTMLElement;
  /** The `.viewer__placeholder` — the centred loading/error card. */
  placeholder: HTMLElement;
  /**
   * Paint the centred placeholder (a type MARK over a title over a body line) and
   * show it in `main`. Device-authored strings go in as text, never markup.
   */
  showPlaceholder(title: string, body: string): void;
}

/**
 * The `.viewer__main` + `.viewer__placeholder` body the `.spd` and `.txt` viewers
 * share: a centred card of `mark` / title / body for the loading and error
 * states. The RENDERED content is the viewer's own (spd swaps to a separate
 * `.spd-body`, txt swaps `main`'s children to the text `<pre>`), so this owns
 * only the placeholder. The reader keeps its OWN `fileStage`/`.empty` path and
 * does not use this at all.
 */
export function createViewerBody(opts: { mark: string }): ViewerBody {
  const placeholder = el("div", { class: "viewer__placeholder" });
  const main = el("div", { class: "viewer__main" }, placeholder);
  function showPlaceholder(title: string, body: string): void {
    placeholder.replaceChildren(
      el("div", { class: "viewer__mark", text: opts.mark }),
      el("h3", { text: title }),
      el("p", { text: body }),
    );
    main.replaceChildren(placeholder);
  }
  return { main, placeholder, showPlaceholder };
}

/** The "previewing an older version" banner every raw-based viewer shows in a
 *  history preview. See {@link createVersionBanner}. */
export interface VersionBanner {
  /** The `.version-banner` strip — mounted under the toolbar. */
  el: HTMLElement;
  /**
   * Show the banner for the version created at `version.createdAt` (epoch ms, its
   * absolute stamp on hover), or hide it with `null`. Toggling it is the whole of
   * a viewer's history-mode chrome switch — a live/bin open passes `null`.
   *
   * `viewOnly` (a TRASHED file's version preview) SUPPRESSES the Restore button:
   * the bin's version history is browse + preview, not restore-a-version (restore
   * the file first —). The WHEN line stays either way.
   */
  setVersion(version: { createdAt: number } | null, viewOnly?: boolean): void;
}

/**
 * WHAT IS OLD, in the one sentence the banner gets.
 *
 *  - `"note"` (the default): the FILE on screen is a past version of itself —
 *    "this is not the current note".
 *  - `"annotations"`: the file on screen is the LIVE document and only the
 *    handwriting over it is old. Saying "this is not the current note" there
 *    would be a straight lie about the document — there is no past version of an
 *    annotated PDF, only past versions of the ink — and the reader would have no
 *    way to know Restore leaves the document alone.
 */
export type VersionBannerKind = "note" | "annotations";

/**
 * The full-width "you're viewing an older version" strip (see
 * {@link VersionBannerKind} for what exactly is older), with the one action safe
 * on a read-only preview: Restore. The restore click is handed out
 * (`onRestore`); the viewer routes it to `deps.onRestoreVersion`, the shared
 * confirm+restore path (`runRestore`/`confirmRestore`) the reader and the
 * history list already share, so no viewer reaches restore around that
 * machinery.
 */
export function createVersionBanner(opts: { onRestore: () => void; kind?: VersionBannerKind }): VersionBanner {
  const kind = opts.kind ?? "note";
  const text = el("span", { class: "version-banner__text" });
  const restore = el("button", {
    class: "btn version-banner__restore",
    type: "button",
    text: "Restore this version",
  }) as HTMLButtonElement;
  restore.addEventListener("click", () => opts.onRestore());
  const banner = el(
    "div",
    { class: "version-banner", role: "status", hidden: true },
    el("span", { class: "version-banner__badge", "aria-hidden": "true", html: svg(VIEWER_IC.restore, 1.6) }),
    text,
    restore,
  );
  return {
    el: banner,
    setVersion(version, viewOnly = false) {
      banner.hidden = version === null;
      // View-only (trashed) previews drop Restore; the row stays a WHEN report.
      restore.hidden = viewOnly;
      if (version) {
        text.textContent =
          kind === "annotations"
            ? `You're viewing the annotations from ${relativeTime(version.createdAt)} — the document itself is current.`
            : `You're viewing a version from ${relativeTime(version.createdAt)} — this is not the current note.`;
        text.title = absoluteTime(version.createdAt);
      }
    },
  };
}

/** The class names a viewer stamps on its header parts. The reader keeps its
 *  legacy `.backbtn`/`.reader__title` names; spd/txt use the `.viewer__*` family.
 *  Parameterised rather than unified so migrating the reader is not pure CSS/e2e
 *  churn. */
export interface ViewerHeaderClasses {
  back: string;
  backLabel: string;
  title: string;
}

export interface ViewerHeader {
  /** The Back button (its onBack already wired) — a leading toolbar item. */
  back: HTMLButtonElement;
  /** The `name` + `subtitle` block — the second leading toolbar item. */
  title: HTMLElement;
  setName(name: string): void;
  setSubtitle(sub: string): void;
  /** The Back label word (see {@link backWord}). */
  setBackWord(word: string): void;
}

/**
 * The back+title header every viewer leads its toolbar with. `back` and `title`
 * are handed to the toolbar's `leading` array as SEPARATE items — this factory
 * owns their DOM and the Back click, nothing more.
 */
export function createViewerHeader(opts: {
  classes: ViewerHeaderClasses;
  onBack: () => void;
}): ViewerHeader {
  const backLabel = el("span", { class: opts.classes.backLabel, text: "Library" });
  // The label is its own node so a caller can rewrite the WORD without touching
  // the chevron beside it — `innerHTML =` on the button would drop the icon.
  const back = el(
    "button",
    { class: opts.classes.back, type: "button", html: svg(VIEWER_IC.back, 1.8) },
    backLabel,
  ) as HTMLButtonElement;
  back.addEventListener("click", () => opts.onBack());
  const titleName = el("b", { text: "—" });
  const titleSub = el("span", { text: "—" });
  const title = el("div", { class: opts.classes.title }, titleName, titleSub);
  return {
    back,
    title,
    setName: (name) => void (titleName.textContent = name),
    setSubtitle: (sub) => void (titleSub.textContent = sub),
    setBackWord: (word) => void (backLabel.textContent = word),
  };
}
