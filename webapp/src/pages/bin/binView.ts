// The bin's read-scoped Api wrapper and its gallery painter.

import { folderHref } from "../../router";
import { libraryTrail } from "../../ui/crumbs";
import { el } from "../../ui/dom";
import { openDialog } from "../../ui/confirm";
import { learnsAspect, pinAspect, provisionalAspect } from "../../ui/tileAspect";
import { ICONS, svg } from "../../ui/icons";
import { createMenu } from "../../ui/menu";
import { FACADE_THUMB_TYPES } from "../galleryCards";
import { fileKind, formatBytes, rawFileUrl, fileTypeLabel } from "../../core/fileKind";
import { getDims } from "../../cache/dimsMemo";
import { type Api } from "../../api/types";
import { type LazyEngine, type LazySlotInput } from "../../render/lazy";
import { type BinEntry } from "../../core/binTypes";
import { type Hash, type Id, type PageRef, type PageText, type FileHistory, type NoteMeta } from "../../core/types";
import { type BinActions, type BinView } from "./bin";
import { preclampAspect, type BinRow, folderLabel, emptyStateBody } from "./binCopy";

// ---- the bin-scoped read seam ----

/**
* Routes reads for a trashed id through the bin's own endpoints. The server's
* `Files.get` hardcodes `deleted = 0` and stays the ownership boundary, so the
* bin has parallel routes; wrapping the shell's `Api` keeps the reader, lazy
* engine and exporter unaware. `attach` is late because the bin controller is
* built after the reader.
*/
export interface BinScope {
  wrap(api: Api): Api;
  attach(isTrashed: (id: Id) => boolean): void;
}

export function createBinScope(): BinScope {
  let isTrashed: (id: Id) => boolean = () => false;
  return {
    attach(fn) {
      isTrashed = fn;
    },
    wrap(api) {
      return {
        ...api,
        getNoteMeta: (id: Id): Promise<NoteMeta> => (isTrashed(id) ? api.getBinNoteMeta(id) : api.getNoteMeta(id)),
        getPageBytes: (id: Id, page: PageRef): Promise<ArrayBuffer> =>
          isTrashed(id) ? api.getBinPageBytes(id, page) : api.getPageBytes(id, page),
        // Trashing only tombstones, so the md5-keyed transcript survives; the bin has
        // its own text route.
        getPageText: (id: Id, page: PageRef): Promise<PageText> =>
          isTrashed(id) ? api.binPageText(id, page) : api.getPageText(id, page),
        // In-note find needs no reroute: it is keyed by blob md5, which a trashed file
        // keeps. Version history follows a file into the bin and is view-only there;
        // `historyScope` composes outside this wrapper and hits these same methods.
        noteHistory: (id: Id): Promise<FileHistory> =>
          isTrashed(id) ? api.binNoteHistory(id) : api.noteHistory(id),
        historyPageBytes: (id: Id, md5: Hash, index: number): Promise<ArrayBuffer> =>
          isTrashed(id) ? api.binHistoryPageBytes(id, md5, index) : api.historyPageBytes(id, md5, index),
        historyPageText: (id: Id, md5: Hash, index: number): Promise<PageText> =>
          isTrashed(id) ? api.binHistoryPageText(id, md5, index) : api.historyPageText(id, md5, index),
        historyRaw: (id: Id, md5: Hash): Promise<ArrayBuffer> =>
          isTrashed(id) ? api.binHistoryRaw(id, md5) : api.historyRaw(id, md5),
      };
    },
  };
}

// ---- the painter ----

/**
* The live `/file/{id}` 404s for trashed files. Null without a hash: the route
* requires `?v=`, which is what makes its `immutable` response honest.
*/
export function binFileUrl(entry: BinEntry, opts: { download?: boolean } = {}): string | null {
  return rawFileUrl(entry.id, entry.fileHash, { ...opts, bin: true });
}

export interface BinViewOptions {
  /** The bin paints into it, so `renderGallery()` closes the bin. */
  gallery: HTMLElement;
  crumbs: HTMLElement;
  sortWrap: HTMLElement;
  segmented: HTMLElement;
  root: HTMLElement;
  /** Shared with the gallery; its `reset()` on the way out is the bin's teardown. */
  engine: LazyEngine;
  /** `busy` is `Empty bin`'s own call in flight. */
  setMode(open: boolean, count: number, busy: boolean): void;
  /** Leave for the library root (the `Library` crumb); the header is otherwise a dead end. */
  onLeave(): void;
}

export function createBinView(opts: BinViewOptions): BinView {
  const { gallery, crumbs, sortWrap, segmented, root, engine, setMode, onLeave } = opts;

  const section = el("section", { class: "bin", "aria-label": "Recycle bin" });

  // ---- the confirm dialog ----
  // Shared `ui/confirm.ts`: Cancel first and default, Esc dismisses.

  // ---- the toast ----
  // The bin's own: an undo needs a second line and a control, and must outlast
  // the shell's 2.4 s toast.
  const toastMsg = el("span", { class: "bin-toast__msg" });
  const toastSub = el("span", { class: "bin-toast__sub" });
  const toastAction = el("button", { class: "bin-toast__action", type: "button", hidden: true });
  const toastEl = el(
    "div",
    { class: "bin-toast" },
    // The lines are announced; the action beside them is not.
    el("span", { class: "bin-toast__lines", role: "status" }, toastMsg, toastSub),
    toastAction,
  );
  root.append(toastEl);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function hideToast(): void {
    if (toastTimer !== undefined) clearTimeout(toastTimer);
    toastEl.classList.remove("is-shown");
  }

  // ---- the preview overlay ----
  // For images and files with no preview only.
  const overlay = el("div", { class: "bin-preview", role: "dialog", "aria-modal": "true", hidden: true });
  root.append(overlay);

  function closePreview(): void {
    overlay.hidden = true;
    overlay.replaceChildren();
  }

  /** Its remaining length is the remaining retention. */
  function lifeEl(daysLeft: number, soon: boolean, retentionDays: number, label?: string): HTMLElement {
    const pct = Math.max(2, Math.min(100, Math.round((daysLeft / Math.max(1, retentionDays)) * 100)));
    const fill = el("div", { class: "life__fill" });
    fill.style.width = `${pct}%`;
    return el(
      "div",
      { class: soon ? "life is-soon" : "life" },
      el("div", { class: "life__track" }, fill),
      el("div", { class: "life__label", text: label ?? `${daysLeft} ${daysLeft === 1 ? "day" : "days"} left` }),
    );
  }

  /**
  * A row's tile, through the same facade and render-cache entries as the
  * gallery. `bin: true` on the hint routes raw-file strategies (including PDF
  * byte ranges) to the bin endpoint. Folders get the folder glyph, notes with
  * no renderable page the doc glyph.
  */
  function thumb(entry: BinEntry): {
    node: HTMLElement;
    target: HTMLCanvasElement | HTMLImageElement | null;
    hint?: LazySlotInput["thumb"];
  } {
    if (entry.kind === "folder") {
      return { node: el("div", { class: "bin__thumb is-folder", html: svg(ICONS.folder, 1.7) }), target: null };
    }
    const type = (entry.fileType || "").trim().toLowerCase();
    const kind = fileKind(type);
    // Same cropped `.spd` WebP as the gallery, so a bin-first view can't cache an uncropped one.
    const hint: LazySlotInput["thumb"] = {
      fileType: type || "note",
      fileHash: entry.fileHash,
      bin: true,
      aspect: entry.thumbAspect,
    };
    if (kind === "image" || FACADE_THUMB_TYPES.has(type)) {
      const img = el("img", { loading: "lazy", decoding: "async", alt: "" }) as HTMLImageElement;
      const tile = el("div", { class: "bin__thumb is-image" }, img);
      if (!preclampAspect(tile, entry) && learnsAspect(type) && entry.fileHash) {
        // Until the memo or the decoded tile answers, a `.pdf` stands on A4: an
        // `<img>` with no `src` measures square.
        const provisional = provisionalAspect(type);
        if (provisional !== null) pinAspect(tile, provisional, true);
        const correct = (w: number, h: number): void => {
          if (tile.isConnected && w > 0 && h > 0) pinAspect(tile, w / h, true);
        };
        void getDims(entry.fileHash).then((dims) => {
          if (dims) correct(dims.w, dims.h);
        });
        img.addEventListener("load", () => correct(img.naturalWidth, img.naturalHeight), { once: true });
      }
      return { node: tile, target: img, hint };
    }
    if (kind === "note" && entry.firstPage) {
      const canvas = el("canvas") as HTMLCanvasElement;
      const tile = el("div", { class: "bin__thumb is-page" }, canvas);
      preclampAspect(tile, entry);
      return { node: tile, target: canvas, hint };
    }
    return {
      node: el("div", { class: "bin__thumb" }, el("span", { class: "bin__thumb-mark", html: svg(ICONS.doc, 1.4) })),
      target: null,
    };
  }

  /**
  * The shared overflow menu. Restore is neutral; "Delete permanently" is the
  * app's one danger item and routes through `purgeConfirm`.
  */
  function actionsMenu(row: BinRow, actions: BinActions, busy: boolean): HTMLElement {
    return el(
      "div",
      { class: "bin__actions" },
      createMenu({
        triggerLabel: busy ? `Working on ${row.entry.name}` : `Actions for ${row.entry.name}`,
        // Both actions disable while one is in flight; the control stays visible.
        disabled: busy,
        items: [
          { label: "Restore", icon: "restore", onSelect: () => actions.restore(row) },
          { label: "Delete permanently", icon: "trashX", danger: true, onSelect: () => actions.purge(row) },
        ],
      }),
    );
  }

  function rowEl(row: BinRow, retentionDays: number, actions: BinActions, busy: boolean): HTMLElement {
    const e = row.entry;
    const body = el(
      "div",
      { class: "bin__body" },
      el("div", { class: "bin__name", text: e.name }),
      el(
        "div",
        { class: "bin__meta" },
        // A child's path would repeat the folder above it.
        row.child ? null : el("span", { class: "bin__path", text: folderLabel(e.path, e.name) }),
        row.child ? null : el("span", { class: "bin__dot" }),
        el("span", { text: row.detail }),
        el("span", { class: "bin__dot" }),
        // Same name, same place, deleted twice: only the time tells them apart.
        el("span", { text: row.time }),
      ),
    );

    const { node: tile, target, hint } = thumb(e);
    let lead: HTMLElement;
    if (row.openable) {
      const btn = el("button", { class: "bin__open", type: "button" }, tile, body);
      btn.addEventListener("click", () => actions.open(e));
      lead = btn;
    } else {
      lead = el("div", { class: "bin__open is-static" }, tile, body);
    }
    // `page` may be absent for facade tiles; their strategies never touch pages.
    if (target) engine.add({ target, noteId: e.id, page: e.firstPage ?? undefined, size: "thumb", thumb: hint });

    return el(
      "div",
      {
        class: `${row.child ? "bin__row is-child" : "bin__row"}${busy ? " is-busy" : ""}`,
        ...(busy ? { "aria-busy": "true" } : {}),
      },
      lead,
      lifeEl(row.daysLeft, row.soon, retentionDays),
      actionsMenu(row, actions, busy),
    );
  }

  function emptyState(title: string, bodyText: string): HTMLElement {
    return el(
      "div",
      { class: "empty" },
      el("div", { class: "empty__mark", text: "Recycle bin" }),
      el("h2", { text: title }),
      el("p", { text: bodyText }),
    );
  }

  return {
    isMounted: () => gallery.contains(section),

    render(model, actions): void {
      // Sort and view describe a folder listing; `renderGallery` restores them.
      sortWrap.hidden = true;
      segmented.hidden = true;
      // Library is a way out: the account page's `Open` sends people here directly.
      crumbs.replaceChildren(...libraryTrail("Recycle bin", () => onLeave(), folderHref(null)));
      // Told every render: the count decides whether `Empty bin` is live.
      setMode(true, model.rows.length, model.emptying);

      gallery.className = "gallery is-bin";
      // Drop slots for rows about to be replaced.
      engine.reset();
      section.replaceChildren();

      if (model.state === "error") {
        section.append(emptyState("Couldn’t load the bin", "Check your connection and try again."));
        gallery.replaceChildren(section);
        return;
      }
      if (model.state === "loading" && model.rows.length === 0) {
        section.append(emptyState("Loading…", "Fetching what you’ve deleted."));
        gallery.replaceChildren(section);
        return;
      }
      if (model.rows.length === 0) {
        // Retention quoted from the server.
        section.append(emptyState("Nothing deleted", emptyStateBody(model.retentionDays)));
        gallery.replaceChildren(section);
        return;
      }

      section.append(
        el(
          "div",
          { class: "bin__head" },
          el(
            "div",
            { class: "bin__aside" },
            el("b", { text: "Deleted files are removed from your Supernote too." }),
            document.createTextNode(
              ` Restoring one puts it back on your device at the next sync. Everything here is removed for good after ${model.retentionDays} days.`,
            ),
          ),
        ),
      );

      const busy = new Set(model.busy);
      let group: string | null = null;
      let rows: HTMLElement | null = null;
      for (const row of model.rows) {
        if (row.group !== group) {
          group = row.group;
          section.append(el("div", { class: "bin__group", text: group }));
          rows = el("div", { class: "bin__rows" });
          section.append(rows);
        }
        rows?.append(rowEl(row, model.retentionDays, actions, busy.has(row.entry.id)));
      }
      gallery.replaceChildren(section);
    },

    preview(row, retentionDays, actions): void {
      const e = row.entry;
      const src = binFileUrl(e);
      const kind = fileKind(e.fileType);
      const back = el("button", { class: "backbtn", type: "button" }, el("span", { html: svg('<path d="m15 18-6-6 6-6"/>', 1.8) }), el("span", { text: "Recycle bin" }));
      back.addEventListener("click", closePreview);

      const restore = el("button", { class: "btn", type: "button", text: "Restore", "aria-label": `Restore ${e.name}` });
      restore.addEventListener("click", () => {
        closePreview();
        actions.restore(row);
      });
      const del = el("button", { class: "btn is-danger", type: "button", text: "Delete", "aria-label": `Delete ${e.name} permanently` });
      del.addEventListener("click", () => {
        closePreview();
        actions.purge(row);
      });

      const stage =
        kind === "image" && src
          ? el("img", { class: "bin-preview__img", src, alt: e.name })
          : el(
              "div",
              { class: "empty" },
              el("div", { class: "empty__mark", text: (e.fileType || "file").toUpperCase() }),
              el("h2", { text: "No preview for this file" }),
              el("p", { text: `${fileTypeLabel(e.fileType)} · ${formatBytes(e.size)}. Download it if you need to look inside before deciding.` }),
              // No Export: a download takes a copy of what is about to go.
              src ? el("a", { class: "btn", href: binFileUrl(e, { download: true }) ?? src, download: e.name, text: "Download" }) : null,
            );

      overlay.replaceChildren(
        el(
          "div",
          { class: "bin-preview__bar" },
          back,
          el("div", { class: "bin-preview__title" }, el("b", { text: e.name }),
          el("span", { text: `${folderLabel(e.path, e.name)} · ${row.detail}` })),
          el("div", { class: "bin-preview__spacer" }),
          lifeEl(row.daysLeft, row.soon, retentionDays, `${row.group} · ${row.daysLeft} days left`),
          restore,
          del,
        ),
        el("div", { class: "bin-preview__stage" }, stage),
      );
      overlay.hidden = false;
      back.focus();
    },

    confirm(spec): Promise<boolean> {
      const frees = spec.frees
        ? el("div", { class: "confirm__frees" }, document.createTextNode("Frees "), el("b", { text: spec.frees }))
        : null;
      return openDialog({
        host: root,
        classes: {
          dialog: "confirm",
          body: "confirm__body",
          actions: "confirm__actions",
          cancel: "btn",
          go: "btn is-danger",
        },
        goLabel: spec.action,
        cancelLabel: "Cancel",
        labelledBy: "bin-confirm-title",
        build: (body, { go }) => {
          go.setAttribute("aria-label", spec.action);
          body.append(el("h2", { id: "bin-confirm-title", text: spec.title }), el("p", { text: spec.body }));
          if (frees) body.append(frees);
        },
      }).done;
    },

    toast(message, o = {}): void {
      toastMsg.textContent = message;
      toastSub.textContent = o.sub ?? "";
      toastSub.hidden = !o.sub;
      toastAction.hidden = !o.undo;
      if (o.undo) {
        toastAction.textContent = "Undo";
        toastAction.onclick = () => {
          hideToast();
          o.undo?.();
        };
      } else {
        toastAction.onclick = null;
      }
      toastEl.classList.add("is-shown");
      if (toastTimer !== undefined) clearTimeout(toastTimer);
      toastTimer = setTimeout(hideToast, o.undo ? 8000 : 2600);
    },

    destroy(): void {
      hideToast();
      closePreview();
      toastEl.remove();
      overlay.remove();
    },
  };
}
