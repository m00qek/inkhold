// The gallery card's "…" menu: a per-type Download section plus Actions, and
// the card-side export paths (whole-note PDF, `.spd` to PNG/ORA, raw bytes).
// Deliberately not shared with the reader's menu, which is built on
// `viewerChrome` and depends on viewer state a card lacks.

import { el } from "../ui/dom";
import { createMenu, DEFAULT_SECTION_TITLE, type MenuItemSpec, type MenuSection } from "../ui/menu";
import { rawFileUrl, canPreviewHistory } from "../core/fileKind";
import { download, savedPdfMessage, type Exporter } from "../export/exporter";
import { exportSpdPng, exportSpdOra } from "./spd/spdExport";
import { buildSpdExportModel } from "../export/spdModel";
import type { Api } from "../api/types";
import type { Entry, Id, NoteSummary } from "../core/types";

export interface CardActionsCtx {
  api: Api;
  exporter: Exporter;
  toast: (message: string) => void;
  handled: (e: unknown) => boolean;
  sessionDidExpire: () => void;
  onTrash: (entry: Entry) => void;
  onRename: (entry: Entry) => void;
  /** Fixed category-root folders, whose Rename is hidden (the server refuses it). */
  isCategoryRoot: (entry: Entry) => boolean;
  /** The ⋯ trigger stays in the DOM after the menu closes, as the panel anchor. */
  onHistory: (note: NoteSummary, anchor: HTMLElement) => void;
  /** A paired `.mark`'s versions, listed under `doc`'s name. */
  onAnnotationHistory: (doc: NoteSummary, annotationsId: Id, anchor: HTMLElement) => void;
}

export interface CardActions {
  cardMenu: (entry: Entry) => HTMLElement;
}

function downloadRow(label: string, ext: string, onSelect: () => void): MenuItemSpec {
  return { label, html: `<span>${label}</span><kbd>${ext}</kbd>`, onSelect };
}

export function createCardActions(ctx: CardActionsCtx): CardActions {
  const { api, exporter, toast } = ctx;

  /**
  * A whole-document export is a job, not a click: the menu closes on select,
  * so this guard stops a second concurrent export (a 1703-page note is ~243 MB
  * of PDF in heap).
  */
  let exportingDocument = false;

  /** The original bytes via the raw endpoint; a hashless entry has no URL. */
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

  /** From a card the only honest state is `original`: no live layer tuning. */
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
  * Reuses the reader's exporter; `getNoteMeta` supplies the page list a
  * `NoteSummary` lacks. A dead session goes to the shell's sink.
  */
  async function exportDocument(note: NoteSummary): Promise<void> {
    // Say so rather than queue a second one.
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
      // The toast says "try again"; the reason goes to the console.
      console.error("Whole-document PDF export failed", { file: note.name, error: e });
      toast("Couldn't build that export. Try again.");
    } finally {
      exportingDocument = false;
    }
  }

  /**
  * The same per type wherever a file is seen: `.note` gives PDF and original
  * (no this-page row from a card), `.spd` gives PNG, ORA and original, others
  * the original. `null` when nothing is downloadable.
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
    if (rawFileUrl(note.id, note.fileHash, { download: true }) === null) return null;
    return {
      title: "DOWNLOAD",
      items: [downloadRow("Original file", `.${ext}`, () => downloadOriginal(note))],
    };
  }

  /**
  * The same sectioned menu in grid and list views, folders included. Actions
  * offers only the neutral, reversible Move to bin; permanent delete is bin-only.
  */
  function cardMenu(entry: Entry): HTMLElement {
    // Filled after `createMenu` builds the wrapper, so onSelect can find the trigger.
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
        // Only kinds with a viewer for a past version (`canPreviewHistory`).
        entry.kind === "note" && canPreviewHistory(entry.fileType)
          ? { label: "Version history", icon: "restore", onSelect: () => ctx.onHistory(entry, historyAnchor()) }
          : null,
        // A `.mark` has no card of its own, so its retained (quota-charged) versions
        // are reached here. Labelled as annotation history: the PDF itself has no
        // versions, and the panel opens under the document's name.
        entry.kind === "note" && entry.annotationsId !== null
          ? {
              label: "Annotation history",
              icon: "restore",
              onSelect: () => ctx.onAnnotationHistory(entry, entry.annotationsId!, historyAnchor()),
            }
          : null,
        ctx.isCategoryRoot(entry)
          ? null
          : { label: "Rename", icon: "edit", onSelect: () => ctx.onRename(entry) },
        // Soft and reversible, so neutral (no danger variant); the toast offers undo.
        { label: "Move to bin", icon: "trash", onSelect: () => ctx.onTrash(entry) },
      ],
    });
    const menu = createMenu({ triggerLabel: `Actions for ${entry.name}`, wrapClass: "card__menu", sections });
    wrapRef.el = menu;
    return menu;
  }

  return { cardMenu };
}
