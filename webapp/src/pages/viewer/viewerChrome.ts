// Shared viewer chrome: back+title header, placeholder body, version banner and
// the find debounce.

import { el } from "../../ui/dom";
import { relativeTime, absoluteTime } from "../../ui/relativeTime";
import { svg, VIEWER_IC } from "./viewerIcons";
import type { ReaderOrigin } from "./viewer";

/** Find/URL-sync debounce, ms; one value so all search-as-you-type matches. */
export const VIEWER_DEBOUNCE_MS = 220;

/** Back's label: a folder's deepest segment, else `Library`/`Search`/`Recycle bin`. */
export function backWord(origin: ReaderOrigin): string {
  if (origin.kind === "search") return "Search";
  if (origin.kind === "bin") return "Recycle bin";
  const parts = (origin.folderPath ?? "").split("/").map((s) => s.trim()).filter(Boolean);
  return parts.length === 0 ? "Library" : parts[parts.length - 1]!;
}

/** The subtitle, prefixed with the full folder path (Back names only the last segment). */
export function originSubtitle(origin: ReaderOrigin, rest: string): string {
  if (origin.kind === "folder" || origin.folderPath === null) return rest;
  return `${origin.folderPath} · ${rest}`;
}

export interface ViewerBody {
  main: HTMLElement;
  placeholder: HTMLElement;
  /** Device-authored strings go in as text, never markup. */
  showPlaceholder(title: string, body: string): void;
}

/** The loading/error placeholder body shared by the `.spd` and `.txt` viewers. */
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

export interface VersionBanner {
  el: HTMLElement;
  /**
   * Show the banner for a version (epoch ms), or hide it with `null`. `viewOnly`
   * (a trashed file's preview) hides Restore.
   */
  setVersion(version: { createdAt: number } | null, viewOnly?: boolean): void;
}

/**
 * `"annotations"`: the document on screen is live and only the PDF's ink is old,
 * so the banner must not say "this is not the current note".
 */
export type VersionBannerKind = "note" | "annotations";

/** The "viewing an older version" strip; Restore is routed to `deps.onRestoreVersion`. */
export function createVersionBanner(opts: { onRestore: () => void; kind?: VersionBannerKind }): VersionBanner {
  const kind = opts.kind ?? "note";
  const text = el("span", { class: "banner__text version-banner__text" });
  const restore = el("button", {
    class: "btn banner__act version-banner__restore",
    type: "button",
    text: "Restore this version",
  }) as HTMLButtonElement;
  restore.addEventListener("click", () => opts.onRestore());
  const banner = el(
    "div",
    { class: "banner version-banner", role: "status", hidden: true },
    el("span", { class: "banner__badge version-banner__badge", "aria-hidden": "true", html: svg(VIEWER_IC.restore, 1.6) }),
    text,
    restore,
  );
  return {
    el: banner,
    setVersion(version, viewOnly = false) {
      banner.hidden = version === null;
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

/** Header class names: the reader keeps legacy `.backbtn`/`.reader__title`, spd/txt use `.viewer__*`. */
export interface ViewerHeaderClasses {
  back: string;
  backLabel: string;
  title: string;
}

export interface ViewerHeader {
  back: HTMLButtonElement;
  title: HTMLElement;
  setName(name: string): void;
  setSubtitle(sub: string): void;
  setBackWord(word: string): void;
}

/** `back` and `title` go into the toolbar's `leading` array as separate items. */
export function createViewerHeader(opts: {
  classes: ViewerHeaderClasses;
  onBack: () => void;
}): ViewerHeader {
  const backLabel = el("span", { class: opts.classes.backLabel, text: "Library" });
  // Separate node so the word can change without dropping the chevron icon.
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
