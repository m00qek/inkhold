// The "history of this file" menu — an ANCHORED FLOATING PANEL launched from a
// note card's ⋯ item OR the reader's Versions toolbar button (hot-cache
// versioning, phase 3). It springs from the SAME popover shell the ⋯ overflow menu
// uses (`ui/popover.ts`: the body-level `.menu-portal`, trigger-anchored fixed
// positioning, click-away/Escape/scroll dismiss, one-open-at-a-time) — NOT a modal
// <dialog> — so it reads as the same app the ⋯ menu does.
//
// It lists a file's versions newest-first, each as a two-line row (relative time +
// status on line 1; exact date + a content signal on line 2 — a note's page count
// with a delta vs the next-older version, or a pageless kind's byte size). Two
// status CHANNELS: `Current` (an outlined label on the live version) and `Viewing`
// (a rail + tint + `● Viewing` marker on the version on screen, only when opened
// mid-preview from the reader). A row CLICK previews that version — there are no
// per-row buttons; Restore lives solely in the preview banner (`runRestore`).
//
// It owns only the LIST + its states; the preview and the restore are handed out
// through {@link HistoryControllerDeps} so this module never learns how a viewer
// is activated or how the library refreshes — the same seam discipline the card
// menu and the bin follow. The restore CORE ({@link runRestore}) is a pure,
// injected-dependency function so both a card action and the reader preview's
// banner button drive one machinery, and it is unit-tested directly.

import { el } from "../ui/dom";
import { openDialog } from "../ui/confirm";
import { formatBytes } from "../core/fileKind";
import { relativeTime, absoluteTime } from "../ui/relativeTime";
import { getPortalRoot, placePop, openPopover, clearPopover, type OpenPopover } from "../ui/popover";
import { ApiError } from "../api/client";
import type { Api } from "../api/types";
import type { FileVersion, Id, RestoredVersion } from "../core/types";

export interface HistoryControllerDeps {
  api: Api;
  /** The app root — kept for the shared confirm host and any fallback anchor. */
  host: HTMLElement;
  toast: (message: string) => void;
  /** Classify a caught listing error; true when it was actionable (a dead session). */
  handled: (e: unknown) => boolean;
  /**
   * Open the reader in preview mode for `version` of `noteId`. The shell owns
   * viewer activation and the history reroute (`historyScope`), so this module
   * only says WHICH version to preview.
   */
  openPreview: (noteId: Id, version: FileVersion) => void;
  /**
   * Restore `version` as the file's current one — confirm + call + refresh +
   * toast. Resolves true on success. Provided by the shell so both the panel and
   * the preview banner run the same path. (No longer called from a row — Restore
   * is banner-only now — but kept for callers that still route through here.)
   */
  restore: (noteId: Id, version: FileVersion, noteName: string) => Promise<boolean>;
}

/** How a caller opens the version menu — WHERE it anchors, and (from the reader
 *  mid-preview) WHICH version is currently on screen so its row is marked Viewing. */
export interface HistoryOpenOptions {
  /** The element to anchor the panel to — the card's ⋯ trigger or the reader's
   *  Versions button. Focus returns here on Escape; a click on it never dismisses. */
  anchor?: HTMLElement;
  /** The md5 of the version currently being PREVIEWED, so its row shows `Viewing`.
   *  Absent when opened from a library card (nothing is on screen). */
  viewingMd5?: string;
}

export interface HistoryController {
  /** Open the version menu for one note, anchored per {@link HistoryOpenOptions}.
   *  `fileType` is the server-verified kind — the content signal reads pages ONLY
   *  for a `.note` (see {@link contentSignal}). */
  open(note: { id: Id; name: string; fileType: string }, opts?: HistoryOpenOptions): void;
}

/**
 * What line 2 of a row says — the CONTENT SIGNAL. Pure so the page-count/delta
 * arithmetic is unit-tested without a DOM:
 *   - a `.note` (`isNote`) with a resolved count (`pageCount > 0`) → its page count
 *     plus a delta vs the next-OLDER version; the OLDEST (no older row) shows
 *     `created` instead;
 *   - EVERY other kind (`.spd`, `.txt`, image, pdf, …) → the blob's byte size, no
 *     delta. `pageCount` is NOT uniformly pages off the wire (it counts a `.txt`'s
 *     paragraphs, a `.spd`'s index rows), so a "N pages" label is honest only for
 *     a `.note`.
 * `older` is the immediately older version in the newest-first list, or undefined
 * for the last (oldest) row.
 */
export interface ContentSignal {
  pagesLabel: string | null;
  deltaLabel: string | null;
  /** The delta is the oldest row's `created` sentinel — rendered faint, not accent. */
  deltaIsFirst: boolean;
  sizeLabel: string | null;
}

export function contentSignal(
  version: FileVersion,
  older: FileVersion | undefined,
  isNote: boolean,
): ContentSignal {
  if (isNote && version.pageCount > 0) {
    const pagesLabel = `${version.pageCount} ${version.pageCount === 1 ? "page" : "pages"}`;
    if (!older) return { pagesLabel, deltaLabel: "created", deltaIsFirst: true, sizeLabel: null };
    const delta = version.pageCount - older.pageCount;
    // Signed against the older version. A rare non-positive delta (a version that
    // removed pages, or matched) still reads honestly rather than always "+".
    const deltaLabel = delta === 0 ? "±0" : `${delta > 0 ? "+" : "−"}${Math.abs(delta)}`;
    return { pagesLabel, deltaLabel, deltaIsFirst: false, sizeLabel: null };
  }
  return { pagesLabel: null, deltaLabel: null, deltaIsFirst: false, sizeLabel: formatBytes(version.size) };
}

export function createHistoryController(deps: HistoryControllerDeps): HistoryController {
  function open(note: { id: Id; name: string; fileType: string }, opts: HistoryOpenOptions = {}): void {
    const anchor = opts.anchor ?? deps.host;
    // Pages are shown ONLY for a `.note`; every other kind reads its byte size.
    const isNote = (note.fileType || "").trim().toLowerCase() === "note";

    const list = el("ul", { class: "vh__list" });
    // The section eyebrow, exactly like the ⋯ menu's DOWNLOAD / ACTIONS: a mono,
    // uppercase, letter-spaced --ink-faint label. No file-name title, no header.
    const pop = el(
      "div",
      { class: "vh menu__pop--float", role: "menu", "aria-label": `Version history for ${note.name}` },
      el("div", { class: "vh__eyebrow", "aria-hidden": "true", text: "Version history" }),
      list,
    );

    // This panel's registration in the shared open-popover registry: a click on
    // its anchor (trigger) OR the portaled pop is "inside" and must not dismiss.
    const self: OpenPopover = {
      trigger: anchor,
      contains: (t) => anchor.contains(t) || pop.contains(t),
      close,
    };
    let open_ = false;

    function place(): void {
      placePop(anchor, pop);
    }
    function show(): void {
      getPortalRoot().appendChild(pop);
      pop.classList.add("is-open");
      place();
      openPopover(self);
      open_ = true;
    }
    function close(): void {
      pop.classList.remove("is-open");
      pop.remove();
      clearPopover(self);
      open_ = false;
    }

    /** The focusable rows in document order — the roving-focus universe. */
    let rowEls: HTMLElement[] = [];

    /** Replace the body with a single state line (loading/empty/error). */
    function state(message: string): void {
      rowEls = [];
      list.replaceChildren(el("li", { class: "vh-state", text: message }));
    }

    /** Paint the rows for a fetched version list. */
    function render(versions: FileVersion[]): void {
      if (versions.length === 0) {
        // A file always has at least its current version, so an empty list means
        // the server could not resolve one — say so plainly rather than blank.
        state("No version history for this file yet.");
        return;
      }
      rowEls = versions.map((v, i) => row(v, versions[i + 1]));
      list.replaceChildren(...rowEls);
      // Anchoring is height-sensitive; the list just changed height, so re-place.
      if (open_) place();
      rowEls[0]?.focus();
    }

    function row(version: FileVersion, older: FileVersion | undefined): HTMLElement {
      // LINE 1: relative time (left) + status (right). The status cluster can hold
      // BOTH channels — a row that is current AND being viewed shows both.
      const when = el("span", { class: "vh-when", text: relativeTime(version.createdAt) });
      when.title = absoluteTime(version.createdAt);
      const isViewing = opts.viewingMd5 != null && version.md5 === opts.viewingMd5;
      const status = el("span", { class: "vh-status" });
      if (isViewing) {
        status.append(
          el(
            "span",
            { class: "mark-viewing" },
            el("span", { class: "dot", "aria-hidden": "true" }),
            el("span", { text: "Viewing" }),
          ),
        );
      }
      if (version.current) status.append(el("span", { class: "tag-current", text: "Current" }));
      const l1 = el("div", { class: "vh-l1" }, when, status);

      // LINE 2: exact date (left) + content signal (right).
      const sig = contentSignal(version, older, isNote);
      let signalEl: HTMLElement;
      if (sig.pagesLabel !== null) {
        signalEl = el(
          "span",
          { class: "vh-pages" },
          document.createTextNode(`${sig.pagesLabel} `),
          el("span", {
            class: sig.deltaIsFirst ? "vh-delta is-first" : "vh-delta",
            text: sig.deltaLabel ?? "",
          }),
        );
      } else {
        signalEl = el("span", { class: "vh-size", text: sig.sizeLabel ?? "" });
      }
      const l2 = el("div", { class: "vh-l2" }, el("span", { class: "vh-date", text: absoluteTime(version.createdAt) }), signalEl);

      const cls =
        "vh-row" + (version.current ? " is-current" : "") + (isViewing ? " is-viewing" : "");
      const li = el("li", {
        class: cls,
        role: "menuitem",
        tabindex: "-1",
        // Names the row for a screen reader landing on it — the relative age plus
        // its status, since the visual status tags are decorative to the SR.
        "aria-label": `${relativeTime(version.createdAt)}${version.current ? ", current version" : ""}${isViewing ? ", now viewing" : ""}`,
      }) as HTMLElement;
      li.append(l1, l2);

      // Row CLICK = preview this version (there is no per-row button). The current
      // version is already what the note shows, but previewing it is harmless and
      // keeps the row uniform; the shell no-ops a same-version reopen.
      li.addEventListener("click", () => {
        close();
        deps.openPreview(note.id, version);
      });
      li.addEventListener("mouseenter", () => li.classList.add("is-hover"));
      li.addEventListener("mouseleave", () => li.classList.remove("is-hover"));
      return li;
    }

    // Roving arrow/Home/End over the rows, Enter/Space previews the focused one.
    pop.addEventListener("keydown", (e) => {
      if (rowEls.length === 0) return;
      const at = rowEls.indexOf(document.activeElement as HTMLElement);
      if (e.key === "Enter" || e.key === " ") {
        if (at >= 0) {
          e.preventDefault();
          rowEls[at]?.click();
        }
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
      let to: number;
      if (e.key === "ArrowDown") to = at < 0 ? 0 : (at + 1) % rowEls.length;
      else if (e.key === "ArrowUp") to = at <= 0 ? rowEls.length - 1 : at - 1;
      else if (e.key === "Home") to = 0;
      else to = rowEls.length - 1;
      e.preventDefault();
      rowEls[to]?.focus();
    });

    async function load(): Promise<void> {
      state("Loading versions…");
      try {
        const history = await deps.api.noteHistory(note.id);
        if (!open_) return; // closed while fetching
        render(history.versions);
      } catch (e) {
        if (!open_) return;
        if (deps.handled(e)) {
          close();
          return;
        }
        state("Couldn't load this file's history. Close and try again.");
      }
    }

    show();
    void load();
  }

  return { open };
}

// ============================================================================
// The restore CORE — pure, injected-dependency, unit-tested directly.
// ============================================================================

export interface RunRestoreOptions {
  api: Pick<Api, "restoreVersion">;
  noteId: Id;
  md5: string;
  /**
   * Show the confirm and resolve true only when the user confirmed. Injected so
   * the flow is testable without a DOM, and so the caller owns the exact copy —
   * see {@link confirmRestore} for the shared, honest framing.
   */
  confirm: () => Promise<boolean>;
  toast: (message: string) => void;
  /** Route a dead session to the shell; true = it was handled (don't toast). */
  handled: (e: unknown) => boolean;
  /** Success sink: the shell refreshes the library/reader off the new current version. */
  onRestored: (restored: RestoredVersion) => void;
}

/**
 * Confirm, then restore. The ONE restore path behind both the list row and the
 * preview banner (H9): re-point the file at a retained version, which makes it
 * current AND retains the displaced current — so the toast frames it honestly as
 * undoable, not as a destructive overwrite.
 *
 *  - a declined confirm is a no-op (returns false, no call, no toast);
 *  - a dead session routes to the shell (`handled`), not to a "couldn't restore";
 *  - a 507 (over quota) gets its OWN clear message — the restore changed nothing;
 *  - success toasts and hands the new current version to `onRestored`.
 */
export async function runRestore(opts: RunRestoreOptions): Promise<boolean> {
  if (!(await opts.confirm())) return false;
  try {
    const restored = await opts.api.restoreVersion(opts.noteId, opts.md5);
    opts.onRestored(restored);
    opts.toast("Restored — the version it replaced is kept in this file's history.");
    return true;
  } catch (e) {
    if (opts.handled(e)) return false;
    if (e instanceof ApiError && e.status === 507) {
      opts.toast("Couldn't restore: that version would put you over your storage quota.");
      return false;
    }
    opts.toast("Couldn't restore that version. Try again.");
    return false;
  }
}

/**
 * The shared restore confirm — a native <dialog> with the HONEST, undoable
 * framing the feature turns on: restoring is safe because the version it replaces
 * is kept. Not the danger variant (no red), because nothing is destroyed.
 * Resolves the promise `runRestore` awaits.
 */
export function confirmRestore(host: HTMLElement, version: { createdAt: number }): Promise<boolean> {
  const { done } = openDialog({
    host,
    classes: {
      dialog: "confirm",
      body: "confirm__body",
      actions: "confirm__actions",
      cancel: "btn",
      go: "btn",
    },
    goLabel: "Restore this version",
    cancelLabel: "Cancel",
    labelledBy: "restore-confirm-title",
    build: (body) => {
      body.append(
        el("h2", { id: "restore-confirm-title", text: "Restore this version?" }),
        el("p", {
          text:
            `This makes the version from ${relativeTime(version.createdAt)} the current one. ` +
            "The version it replaces is kept in this file's history, so you can undo this at any time by restoring that.",
        }),
      );
    },
  });
  return done;
}
