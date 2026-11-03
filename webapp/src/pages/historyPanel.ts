// The "history of this file" panel: a floating popover (`ui/popover.ts`, not a
// modal) listing a file's versions newest-first. A row click previews; Restore
// lives only in the preview banner. Preview and restore come in through
// `HistoryControllerDeps`; `runRestore` is the shared restore core.

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
  host: HTMLElement;
  toast: (message: string) => void;
  handled: (e: unknown) => boolean;
  /**
  * The shell owns viewer activation and the `historyScope` reroute. When
  * `annotationsOn` is set, `noteId` is a `.mark` and the document it annotates
  * is opened live with the ink rerouted to this version.
  */
  openPreview: (noteId: Id, version: FileVersion, annotationsOn?: Id) => void;
  /** Confirm, call, refresh and toast; resolves true on success. */
  restore: (noteId: Id, version: FileVersion, noteName: string) => Promise<boolean>;
}

export interface HistoryOpenOptions {
  /** Focus returns here on Escape; a click on it never dismisses. */
  anchor?: HTMLElement;
  /** The previewed version's md5, so its row shows `Viewing`. */
  viewingMd5?: string;
  /**
  * Set when these versions are a `.mark` on that document: changes the eyebrow
  * and caption and is passed back to `openPreview`. Passed in rather than read
  * off `fileType`, since a standalone `.mark` has a history of its own.
  */
  annotationsOn?: Id;
}

export interface HistoryController {
  /** `fileType` is server-verified; only a `.note` shows page counts. */
  open(note: { id: Id; name: string; fileType: string }, opts?: HistoryOpenOptions): void;
}

/**
* Line 2 of a row. A `.note` shows pages and a delta vs the next-older version
* (`created` on the oldest); every other kind shows byte size, since
* `pageCount` means paragraphs or index rows there.
*/
export interface ContentSignal {
  pagesLabel: string | null;
  deltaLabel: string | null;
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
    const deltaLabel = delta === 0 ? "±0" : `${delta > 0 ? "+" : "−"}${Math.abs(delta)}`;
    return { pagesLabel, deltaLabel, deltaIsFirst: false, sizeLabel: null };
  }
  return { pagesLabel: null, deltaLabel: null, deltaIsFirst: false, sizeLabel: formatBytes(version.size) };
}

export function createHistoryController(deps: HistoryControllerDeps): HistoryController {
  function open(note: { id: Id; name: string; fileType: string }, opts: HistoryOpenOptions = {}): void {
    const anchor = opts.anchor ?? deps.host;
    const isNote = (note.fileType || "").trim().toLowerCase() === "note";

    // The eyebrow must say the ink is versioned, not the document.
    const annotations = opts.annotationsOn != null;
    const heading = annotations ? "Annotation history" : "Version history";

    const list = el("ul", { class: "vh__list" });
    const pop = el(
      "div",
      { class: "vh menu__pop--float", role: "menu", "aria-label": `${heading} for ${note.name}` },
      el("div", { class: "vh__eyebrow", "aria-hidden": "true", text: heading }),
      list,
    );
    // Scopes Restore to the handwriting, not the document.
    if (annotations) {
      pop.insertBefore(
        el("p", {
          class: "vh__caption",
          text: "The handwriting on this document. Restoring changes only the annotations — the document itself is untouched.",
        }),
        list,
      );
    }

    // A click on the anchor or the portaled pop counts as inside.
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

    let rowEls: HTMLElement[] = [];

    function state(message: string): void {
      rowEls = [];
      list.replaceChildren(el("li", { class: "vh-state", text: message }));
    }

    function render(versions: FileVersion[]): void {
      if (versions.length === 0) {
        // A file always has a current version, so empty means the server failed.
        state(
          annotations
            ? "No annotation history for this document yet."
            : "No version history for this file yet.",
        );
        return;
      }
      rowEls = versions.map((v, i) => row(v, versions[i + 1]));
      list.replaceChildren(...rowEls);
      // Anchoring is height-sensitive.
      if (open_) place();
      rowEls[0]?.focus();
    }

    function row(version: FileVersion, older: FileVersion | undefined): HTMLElement {
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
        "aria-label": `${relativeTime(version.createdAt)}${version.current ? ", current version" : ""}${isViewing ? ", now viewing" : ""}`,
      }) as HTMLElement;
      li.append(l1, l2);

      // The shell no-ops a same-version reopen.
      li.addEventListener("click", () => {
        close();
        deps.openPreview(note.id, version, opts.annotationsOn);
      });
      li.addEventListener("mouseenter", () => li.classList.add("is-hover"));
      li.addEventListener("mouseleave", () => li.classList.remove("is-hover"));
      return li;
    }

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

// ---- restore core ----

export interface RunRestoreOptions {
  api: Pick<Api, "restoreVersion">;
  noteId: Id;
  md5: string;
  /** Injected so the caller owns the copy (see `confirmRestore`). */
  confirm: () => Promise<boolean>;
  toast: (message: string) => void;
  handled: (e: unknown) => boolean;
  onRestored: (restored: RestoredVersion) => void;
}

/**
* Restore keeps the displaced current version, so it is framed as undoable. A
* declined confirm is a no-op, a dead session routes to the shell, and a 507
* (over quota) gets its own message.
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

/** Not the danger variant: nothing is destroyed. */
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
