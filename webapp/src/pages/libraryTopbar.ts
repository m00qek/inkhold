// The library topbar: breadcrumbs, the search box, sort and view, and the
// per-place actions (Upload, Empty bin, Lock console).

import { el } from "../ui/dom";
import { ICONS, svg, type IconName } from "../ui/icons";
import { UPLOAD_ACCEPT_ATTR } from "../core/fileKind";
import { current, folderHref, go, replaceRoute, searchHref } from "../router";
import type { Id } from "../core/types";

export type SortKey = "recent" | "title" | "pages";
export type View = "grid" | "list";

export interface TopbarDeps {
  initialSort: SortKey;
  /** Where a cleared query returns to. */
  folderId: () => Id | null;
  /** Paints a query typed while already on the search route. */
  applyQuery: (q: string) => void;
  onSort: (sort: SortKey) => void;
  onView: (view: View) => void;
  onEmptyBin: () => void;
  onLockAdmin: () => void;
  onFiles: (files: File[]) => void;
}

export interface Topbar {
  el: HTMLElement;
  crumbs: HTMLElement;
  searchInput: HTMLInputElement;
  /** Both are hidden over results: they describe a folder listing. */
  sortWrap: HTMLElement;
  segmented: HTMLElement;
  uploadBtn: HTMLButtonElement;
  toolsSep: HTMLElement;
  emptyBinBtn: HTMLButtonElement;
  lockAdminBtn: HTMLButtonElement;
  setView(view: View): void;
  /** Restores the caret the arriving keystroke's navigation took from the box. */
  restoreSearchFocus(): void;
}

/** Glyph then words, never icon-only; `hidden` per `.topbar__action[hidden]`. */
function topbarAction(opts: {
  id: string;
  label: string;
  icon: IconName;
  ariaLabel?: string;
  danger?: boolean;
  /** Only for an unambiguous icon. */
  iconOnly?: boolean;
}): HTMLButtonElement {
  const b = el("button", {
    class: `btn topbar__action${opts.iconOnly ? " topbar__action--icon" : ""}${opts.danger ? " is-danger" : ""}`,
    // Two of these share `.tools`; the id tells them apart in tests.
    id: opts.id,
    type: "button",
    hidden: true,
    // Only when the label isn't the whole story; an `aria-label` that omits the
    // visible text breaks WCAG Label in Name.
    ...(opts.ariaLabel ? { "aria-label": opts.ariaLabel } : {}),
  }) as HTMLButtonElement;
  b.append(el("span", { class: "topbar__action-mark", html: svg(ICONS[opts.icon], 1.7) }));
  if (opts.iconOnly) b.title = opts.ariaLabel ?? opts.label;
  else b.append(el("span", { text: opts.label }));
  return b;
}

export function createTopbar(deps: TopbarDeps): Topbar {
  const crumbs = el("div", { class: "crumbs", id: "crumbs" });
  const searchInput = el("input", {
    class: "search__input",
    id: "search",
    type: "search",
    autocomplete: "off",
    placeholder: "Search across every note — typed and handwritten",
    "aria-label": "Search notes",
  }) as HTMLInputElement;
  // The first letter pushes (folder to results is a navigation); later letters
  // and clearing replace, so one search episode is one history entry.
  // Entering via a hash navigation resets focus to `<body>`, losing the caret on
  // the first keystroke; it's captured here and restored by `showSearch`, which
  // runs after the reset.
  let pendingSearchCaret: number | null = null;
  function restoreSearchFocus(): void {
    if (pendingSearchCaret === null) return;
    const caret = pendingSearchCaret;
    pendingSearchCaret = null;
    searchInput.focus();
    // Guard only for DOMs without selection ranges (headless tests).
    try {
      searchInput.setSelectionRange(caret, caret);
    } catch {
    }
  }

  searchInput.addEventListener("input", () => {
    const next = searchInput.value;
    // A blank query is the folder the shell still holds.
    const target = next.trim() === "" ? folderHref(deps.folderId()) : searchHref(next);
    if (current().name !== "search") {
      // Arm the caret restore only when entering search.
      if (next.trim() !== "") pendingSearchCaret = searchInput.selectionStart ?? next.length;
      go(target);
      return;
    }
    replaceRoute(target);
    // `replaceRoute` doesn't fire the route, so paint here.
    deps.applyQuery(next);
  });

  const sortSelect = el(
    "select",
    { id: "sort", "aria-label": "Sort notes" },
    el("option", { value: "recent", text: "Recent" }),
    el("option", { value: "title", text: "Title" }),
    el("option", { value: "pages", text: "Pages" }),
  ) as HTMLSelectElement;
  // Otherwise the select shows its first option while sorted by another.
  sortSelect.value = deps.initialSort;
  sortSelect.addEventListener("change", () => deps.onSort(sortSelect.value as SortKey));

  const gridBtn = el("button", { type: "button", "aria-label": "Grid view", "aria-pressed": "true", html: svg(ICONS.grid, 1.7) });
  const listBtn = el("button", { type: "button", "aria-label": "List view", "aria-pressed": "false", html: svg(ICONS.list, 1.7) });
  gridBtn.addEventListener("click", () => deps.onView("grid"));
  listBtn.addEventListener("click", () => deps.onView("list"));

  const sortWrap = el("span", { class: "select" }, sortSelect, el("span", { html: svg(ICONS.chevron, 1.8) }));
  const segmented = el("div", { class: "segmented", role: "group", "aria-label": "View" }, gridBtn, listBtn);

  // View-level, so beside sort and view. Red (destructive); disabled, not
  // removed, over an empty bin. The confirm rides on `bin.empty()`.
  const emptyBinBtn = topbarAction({
    id: "empty-bin",
    label: "Empty bin",
    icon: "trash",
    ariaLabel: "Delete everything in the recycle bin permanently",
    danger: true,
  });
  emptyBinBtn.addEventListener("click", () => deps.onEmptyBin());

  // Not `danger`: locking destroys nothing.
  const lockAdminBtn = topbarAction({ id: "lock-console", label: "Lock console", icon: "lock" });
  lockAdminBtn.addEventListener("click", () => deps.onLockAdmin());

  // The discoverable, keyboard- and touch-reachable twin of drag and drop; both
  // hand files to the same `uploadZone.add`. Shown only over a folder listing.
  const uploadBtn = topbarAction({
    id: "upload",
    label: "Upload",
    icon: "export",
    ariaLabel: "Upload a file to this folder",
    // Icon-only: a universal mark for a non-destructive secondary route.
    iconOnly: true,
  });
  const toolsSep = el("span", { class: "tools__sep", hidden: true, "aria-hidden": "true" });
  const filePicker = el("input", {
    class: "upload__picker",
    type: "file",
    multiple: true,
    // A hint for the OS dialog only; drag and drop bypasses it, so pre-flight always runs.
    accept: UPLOAD_ACCEPT_ATTR,
    hidden: true,
    "aria-hidden": "true",
    tabindex: "-1",
  }) as HTMLInputElement;
  filePicker.addEventListener("change", () => {
    const picked = Array.from(filePicker.files ?? []);
    // Reset first: picking the same file twice fires no `change`.
    filePicker.value = "";
    if (picked.length > 0) deps.onFiles(picked);
  });
  uploadBtn.addEventListener("click", () => filePicker.click());

  const topbar = el(
    "div",
    { class: "topbar" },
    crumbs,
    el(
      "div",
      { class: "search" },
      el("span", { class: "search__glyph-wrap", html: `<svg class="search__glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">${ICONS.search}</svg>` }),
      searchInput,
      // `aria-hidden`: the placeholder already says it.
      el("span", { class: "search__ocr", "aria-hidden": "true", text: "OCR" }),
    ),
    el("div", { class: "tools" }, sortWrap, segmented, toolsSep, uploadBtn, emptyBinBtn, lockAdminBtn),
    filePicker,
  );

  return {
    el: topbar,
    crumbs,
    searchInput,
    sortWrap,
    segmented,
    uploadBtn,
    toolsSep,
    emptyBinBtn,
    lockAdminBtn,
    setView(view) {
      gridBtn.setAttribute("aria-pressed", String(view === "grid"));
      listBtn.setAttribute("aria-pressed", String(view === "list"));
    },
    restoreSearchFocus,
  };
}
