// The per-card DOWNLOAD/export menu matrix — the "…" overflow a gallery card (or
// list row) carries, extracted from the library shell. It builds the sectioned
// menu (a per-type DOWNLOAD group + the neutral `Move to bin` ACTION) and owns
// the card-side export paths those rows fire: whole-note PDF, `.spd` → PNG/ORA,
// and the raw-bytes download. Everything it touches — the API seam, the shared
// exporter, the toast, the shell's failure sinks, and the one trash path — comes
// in through {@link CardActionsCtx}; the controller keeps owning the state.
//
// NOTE (Review-2 Pass-2 #3): this is near-verbatim with the reader's export
// menu (`reader.ts`, the "THE DOWNLOAD MENU" section), but that copy is built on
// a DIFFERENT component (`viewerChrome`'s `exportMenu`/`menuItem`/`rawItem` with
// `.menu__head`/`.menu__sep`) and is entangled with the open viewer's live
// layer stack, focused page and current-vs-original view — none of which a card
// has. Deduping the two would force a risky reader change, so per the task the
// library copy was extracted here and the reader's left in place. A future pass
// could hoist the shared LABELS/extensions ("Flattened image"/".png", …) into one
// place if the two menu components are ever unified.

import { el } from "../ui/dom";
import { createMenu, DEFAULT_SECTION_TITLE, type MenuItemSpec, type MenuSection } from "../ui/menu";
import { rawFileUrl, canPreviewHistory } from "../core/fileKind";
import { download, savedPdfMessage, type Exporter } from "../export/exporter";
import { exportSpdPng, exportSpdOra } from "./spdExport";
import { buildSpdExportModel } from "../export/spdModel";
import type { Api } from "../api/types";
import type { Entry, NoteSummary } from "../core/types";

/**
 * What the card-menu matrix needs from the shell. The controller keeps owning
 * every one of these — the seam-wrapped `api`, the reader's browser-side
 * exporter, the toast, the shared failure routing (`handled`/`sessionDidExpire`)
 * and the single `bin.trash` path — and hands them in so this module has no
 * hidden coupling back into it.
 */
export interface CardActionsCtx {
  api: Api;
  exporter: Exporter;
  toast: (message: string) => void;
  /** Classify a caught listing/metadata error; true when it was actionable. */
  handled: (e: unknown) => boolean;
  /** The `sn_session` cookie went invalid mid-export. */
  sessionDidExpire: () => void;
  /** The ONE soft-delete path (`bin.trash`) every surface shares. */
  onTrash: (entry: Entry) => void;
  /**
   * Open the rename dialog for `entry` (docs/scratch/rename.md). The shell owns
   * the dialog, the `api.rename` call, the optimistic listing update and the
   * toast; this seam only says which entry the ⋯ menu's Rename was chosen on.
   */
  onRename: (entry: Entry) => void;
  /**
   * Whether `entry` is a fixed category-root folder the device relies on
   * (NOTE / DOCUMENT / EXPORT / SCREENSHOT / INBOX and their pinned category
   * anchors). Rename is HIDDEN for these — the server refuses to rename them, and
   * a disabled item would only invite a fight. The shell answers this through the
   * rail's own "which folder IS a category" check, so there is one owner of it.
   */
  isCategoryRoot: (entry: Entry) => boolean;
  /**
   * Open the "history of this file" menu for a note (hot-cache versioning). The
   * shell owns the panel, the preview reroute and the restore path; this seam
   * hands over which note was chosen and the ⋯ trigger the floating panel anchors
   * to (the ⋯ menu has already closed by the time this fires, but its trigger
   * stays in the DOM as the anchor).
   */
  onHistory: (note: NoteSummary, anchor: HTMLElement) => void;
}

export interface CardActions {
  /**
   * The overflow "…" menu a card carries — in BOTH views, and for a folder as
   * well as a note.
   */
  cardMenu: (entry: Entry) => HTMLElement;
}

/**
 * A `<span>label</span><kbd>.ext</kbd>` DOWNLOAD row — the label plus its file
 * extension, laid out by the menu item's default space-between (see
 * `06-reader.css`). The same shape the reader/`.spd` export menus use, so a
 * download reads identically wherever it is offered.
 */
function downloadRow(label: string, ext: string, onSelect: () => void): MenuItemSpec {
  return { label, html: `<span>${label}</span><kbd>${ext}</kbd>`, onSelect };
}

export function createCardActions(ctx: CardActionsCtx): CardActions {
  const { api, exporter, toast } = ctx;

  /**
   * Is a whole-document export already running?
   *
   * A DOCUMENT EXPORT IS NOT A CLICK, IT IS A JOB. The menu item that starts one
   * closes the instant it is chosen, so there is no control left to disable —
   * which was taken to mean no guard was needed. It is not the same thing: with
   * nothing holding the door, a second choice from a reopened menu starts a
   * SECOND full export beside the first, and the two then compete for memory.
   *
   * That is not a theoretical race. A 1703-page notebook builds ~243 MB of PDF,
   * held as heap chunks until the Blob exists, and takes long enough that
   * clicking again is the natural thing to do when nothing has downloaded yet.
   * Running that twice at once is how you turn a slow export into a failed one.
   */
  let exportingDocument = false;

  /**
   * Save the file's ORIGINAL bytes, unchanged — the `.note`/`.spd`/original-file
   * download. Navigates to the versioned raw-file endpoint with the attachment
   * flag; its `Content-Disposition` names the file. A hashless entry has no
   * addressable URL (see `rawFileUrl`), so there is nothing to hand back.
   */
  function downloadOriginal(note: NoteSummary): void {
    const href = rawFileUrl(note.id, note.fileHash, { download: true });
    if (href === null) {
      toast("That file has no stored contents to download yet.");
      return;
    }
    const a = el("a", { href, download: "", rel: "noopener" }) as HTMLAnchorElement;
    document.body.append(a);
    a.click();
    a.remove();
  }

  /**
   * Flatten a `.spd` to a PNG or an ORA, FROM A CARD — no viewer open. The bytes
   * are fetched, composited into the shared {@link buildSpdExportModel} snapshot,
   * and handed to the SAME `.spd` export matrix the viewer uses (`spdExport.ts`).
   * `original` is the only honest state from a card: there is no live layer tuning
   * to differ from the sketch as saved. A dead session routes to the shell's sink;
   * anything else degrades to a toast rather than a wedged menu.
   */
  async function exportSpdFromCard(note: NoteSummary, kind: "png" | "ora"): Promise<void> {
    const url = rawFileUrl(note.id, note.fileHash);
    if (url === null) {
      toast("That .spd has no stored contents to export yet.");
      return;
    }
    try {
      toast(`Exporting ${note.name}…`);
      const res = await fetch(url);
      if (res.status === 401 || res.status === 403) {
        ctx.sessionDidExpire();
        return;
      }
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const model = await buildSpdExportModel(new Uint8Array(await res.arrayBuffer()));
      if (model === null) {
        toast("Couldn't read that .spd sketch.");
        return;
      }
      const blob = kind === "png" ? await exportSpdPng(model, "original") : await exportSpdOra(model, "original");
      const base = note.name.replace(/\.spd$/i, "") || "sketch";
      download(`${base}.${kind}`, blob);
    } catch (e) {
      console.error("Sketch export failed", { file: note.name, kind, error: e });
      toast("Couldn't build that export. Try again.");
    }
  }

  /**
   * Export a whole note as one PDF, from the library. Reuses the reader's
   * exporter wholesale — same browser-side pipeline, same progress reporting,
   * and the same honesty about which KIND of PDF came out (a searchable one and
   * a raster-only one look identical until someone tries to select text).
   *
   * `getNoteMeta` is the one extra hop: a row only has a `NoteSummary`, and the
   * exporter needs the page list. A dead session mid-export goes to the shell's
   * failure sink, not to a "couldn't build that export" that would be a lie.
   *
   * No button to disable any more: the export is launched from an overflow-menu
   * item that the menu closes the instant it is chosen (see `ui/menu.ts`), so
   * there is no lingering control to guard against a double click — the progress
   * and result are reported through the toast instead.
   */
  async function exportDocument(note: NoteSummary): Promise<void> {
    // SAY SO RATHER THAN QUEUE IT. The one already running is the one the user
    // wants; starting a second would only make both slower and might sink both.
    if (exportingDocument) {
      toast("An export is already running — it will download when it finishes.");
      return;
    }
    exportingDocument = true;
    try {
      const meta = await api.getNoteMeta(note.id);
      if (meta.pages.length === 0) {
        toast("That file has no pages to export.");
        return;
      }
      const { blob, filename, kind } = await exporter.documentPdf(meta, (done, total) =>
        toast(`Exporting ${meta.name} — page ${done} of ${total}…`),
      );
      download(filename, blob);
      toast(savedPdfMessage(filename, kind, meta.pages.length));
    } catch (e) {
      if (ctx.handled(e)) return;
      // THE TOAST IS NOT A DIAGNOSIS. "Try again" is all the user can act on,
      // but discarding `e` left nothing behind for anyone else either — a failed
      // export was unreportable, because the one fact that would explain it never
      // reached the console. Whatever the toast says, the reason goes here.
      console.error("Whole-document PDF export failed", { file: note.name, error: e });
      toast("Couldn't build that export. Try again.");
    } finally {
      exportingDocument = false;
    }
  }

  /**
   * The per-type DOWNLOAD section (the plan's matrix). IDENTICAL wherever the file
   * is seen; reuses the EXISTING exporters one level up — never a new export path:
   *   - `.note`  → whole-doc PDF (the reader's exporter) + the original `.note`.
   *                From a card there is no "current page", so no THIS-PAGE row —
   *                the reader's own menu keeps that.
   *   - `.spd`   → Flat PNG + Layered ORA (the `.spd` export matrix) + the raw `.spd`.
   *   - other    → the original file, by its own extension.
   * `null` when nothing is downloadable (a hashless non-note with no pages).
   */
  function downloadSection(note: NoteSummary): MenuSection | null {
    const ext = note.fileType.trim().toLowerCase();
    if (ext === "note") {
      return {
        title: "DOWNLOAD",
        items: [
          downloadRow("PDF document", ".pdf", () => void exportDocument(note)),
          downloadRow("Supernote", ".note", () => downloadOriginal(note)),
        ],
      };
    }
    if (ext === "spd") {
      return {
        title: "DOWNLOAD",
        items: [
          downloadRow("Flattened image", ".png", () => void exportSpdFromCard(note, "png")),
          downloadRow("Layered image", ".ora", () => void exportSpdFromCard(note, "ora")),
          downloadRow("Atelier", ".spd", () => downloadOriginal(note)),
        ],
      };
    }
    // Every other kind (image, pdf, unknown) can only hand back its own bytes, and
    // only when it has some: a hashless file has no download and the section falls
    // away (the menu then shows ACTIONS alone).
    if (rawFileUrl(note.id, note.fileHash, { download: true }) === null) return null;
    return {
      title: "DOWNLOAD",
      items: [downloadRow("Original file", `.${ext}`, () => downloadOriginal(note))],
    };
  }

  /**
   * The overflow "…" menu a card carries — in BOTH views now, and for a folder as
   * well as a note. The grid has no room for a labelled button beside a card and a
   * list row once did, but they no longer disagree: both offer the SAME sectioned
   * set through the SAME shared component (`ui/menu.ts`, which also owns open/close,
   * one-at-a-time, outside-click, Escape-returns-focus and arrow-key behaviour),
   * so DOWNLOAD and ACTIONS read identically whichever way the gallery is laid out.
   *
   * TWO TITLED SECTIONS: a per-type DOWNLOAD group (above), then ACTIONS. On a LIVE
   * library item ACTIONS is the one recoverable, NEUTRAL soft-delete — `Move to
   * bin`, never `Delete permanently`: the irreversible verb is BIN-ONLY (the safety
   * rule), and it lives on the bin's own surfaces (`bin.ts`, `binViewerActions.ts`),
   * never on a live card. A folder has no bytes to download, so it carries ACTIONS
   * alone. `wrapClass: "card__menu"` scopes the grid card's absolute-over-the-tile
   * positioning (04-library-gallery.css); a list row overrides that back into flow.
   */
  function cardMenu(entry: Entry): HTMLElement {
    // The floating version panel anchors to THIS card's ⋯ trigger. The trigger
    // lives inside the `.menu` wrapper `createMenu` returns; a ref filled in after
    // the wrapper is built lets the (much later) onSelect find it — the wrapper
    // doesn't exist yet at the point these item closures are written.
    const wrapRef: { el: HTMLElement | null } = { el: null };
    const historyAnchor = (): HTMLElement =>
      (wrapRef.el?.querySelector(".card__more") as HTMLElement | null) ?? wrapRef.el ?? document.body;
    const sections: MenuSection[] = [];
    if (entry.kind === "note") {
      const dl = downloadSection(entry);
      if (dl) sections.push(dl);
    }
    sections.push({
      title: DEFAULT_SECTION_TITLE,
      items: [
        // "Version history" (the entry point to the hot-cache versioning UI) above
        // the trash action, on every file whose history the UI can PREVIEW
        // ({@link canPreviewHistory}: `.note`, `.spd`, `.txt` and images — each has
        // a viewer to paint a past version; a `.pdf` or unknown blob does not, so
        // it stays unlisted). A folder has no versions either. The `restore` glyph
        // (an anticlockwise return arrow) reads as "go back to a past version".
        entry.kind === "note" && canPreviewHistory(entry.fileType)
          ? { label: "Version history", icon: "restore", onSelect: () => ctx.onHistory(entry, historyAnchor()) }
          : null,
        // RENAME, directly above Move to bin — a note OR a folder (the menu serves
        // both). Hidden on the fixed category-root folders the device relies on
        // (see `isCategoryRoot`): the server refuses them, so a disabled item would
        // only pick a fight. The `edit` glyph is the mockup's pencil, the same mark
        // its "Change" controls carry.
        ctx.isCategoryRoot(entry)
          ? null
          : { label: "Rename", icon: "edit", onSelect: () => ctx.onRename(entry) },
        // SOFT, reversible, and therefore NEUTRAL (never the danger variant): it
        // acts with no dialog and the bin's toast offers the undo plus the device
        // line. Same word and glyph the reader toolbar's "Move to bin" uses.
        { label: "Move to bin", icon: "trash", onSelect: () => ctx.onTrash(entry) },
      ],
    });
    const menu = createMenu({ triggerLabel: `Actions for ${entry.name}`, wrapClass: "card__menu", sections });
    wrapRef.el = menu;
    return menu;
  }

  return { cardMenu };
}
