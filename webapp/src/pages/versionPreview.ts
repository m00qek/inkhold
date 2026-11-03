// Read-only previews of a retained version, and the one restore path behind the
// history panel and the preview banner.

import { fileKind } from "../core/fileKind";
import { noteVersionHref, replaceRoute } from "../router";
import { shortMd5 } from "./versionShort";
import { versionMeta, rawVersionMeta, type HistoryScope } from "./historyScope";
import { runRestore, confirmRestore } from "./historyPanel";
import type { Api } from "../api/types";
import type { FileVersion, Id, NoteMeta, NoteSummary } from "../core/types";
import type { ReaderOrigin } from "./reader";
import type { ViewerSet } from "./viewerSet";

export interface VersionPreviewDeps {
  api: Api;
  viewers: ViewerSet;
  historyScope: HistoryScope;
  host: HTMLElement;
  isTrashed: (id: Id) => boolean;
  currentFolderPath: () => string | null;
  /** Where Back leaves a preview for: the current folder. */
  folderHref: () => string;
  setReaderBack: (href: string) => void;
  setReading: (reading: boolean) => void;
  /** Starts a route transition; a late answer for an older one is dropped. */
  nextRoute: () => number;
  isRoute: (token: number) => boolean;
  synthesizeSummary: (meta: NoteMeta) => NoteSummary;
  /** After a restore: refetch, repaint the rail and open `returnTo`. */
  onRestored: (returnTo: Id) => void;
  toast: (message: string) => void;
  handled: (e: unknown) => boolean;
}

export interface VersionPreviews {
  /**
   * A retained version in the reused viewer, read-only. The URL is replaced (not
   * pushed) with `#/note/:id/version/:short` so reload and copy-link reproduce
   * it. `.note` uses the version's own meta (`historyMeta`), falling back to live
   * geometry; the reroute is armed before the first paint.
   */
  openHistory(noteId: Id, version: FileVersion, startPage?: number): Promise<void>;
  /**
   * A past version of a PDF's `.mark`: the live document opens unchanged and only
   * the mark's page bytes are rerouted through `historyScope`. Not addressable:
   * the version belongs to the mark's history, so a document version URL could
   * only answer "no longer available".
   */
  openAnnotations(documentId: Id, markId: Id, version: FileVersion): Promise<void>;
  /**
   * `runRestore` owns the toast and 507 message. `returnTo` differs only for PDF
   * annotations: the `.mark` is restored, the document reopens.
   */
  restore(noteId: Id, version: { md5: string; createdAt: number }, returnTo?: Id): Promise<boolean>;
}

export function createVersionPreviews(deps: VersionPreviewDeps): VersionPreviews {
  const { api, viewers, historyScope } = deps;

  return {
    async openHistory(noteId, version, startPage = 0) {
      const mine = deps.nextRoute();
      try {
        const base = await api.getNoteMeta(noteId);
        if (!deps.isRoute(mine)) return; // navigated away while fetching
        const type = base.fileType.trim().toLowerCase();
        const origin: ReaderOrigin = {
          kind: "history",
          folderPath: deps.currentFolderPath(),
          version: { md5: version.md5, createdAt: version.createdAt },
          // A trashed file's version preview is view-only (restore the file first);
          // raw viewers read the bin-scoped history route.
          viewOnly: deps.isTrashed(noteId),
        };

        // Raw kinds decode the version blob (`historyFileUrl`): no reroute, no
        // `historyMeta`. Seed the canonical URL before opening.
        if (type === "spd" || type === "txt" || fileKind(type) === "image") {
          deps.setReaderBack(deps.folderHref());
          const viewer = viewers.viewerFor(base.fileType);
          viewers.activate(viewer);
          replaceRoute(noteVersionHref(noteId, shortMd5(version.md5), startPage));
          const meta = rawVersionMeta(base, version);
          viewer.open(deps.synthesizeSummary(meta), Promise.resolve(meta), startPage, origin, "");
          deps.setReading(true);
          return;
        }

        let template = base;
        try {
          const vmeta = await api.historyMeta(noteId, version.md5);
          if (!deps.isRoute(mine)) return;
          template = vmeta;
        } catch {
          // Degraded preview (live geometry) beats none.
        }
        deps.setReaderBack(deps.folderHref()); // Back leaves the preview for the folder
        viewers.activate(viewers.reader);
        // After activate (may hide a prior viewer), before open (first paint reads through it).
        historyScope.setActive(noteId, version.md5);
        replaceRoute(noteVersionHref(noteId, shortMd5(version.md5), startPage));
        const meta = versionMeta(template, version.md5);
        viewers.reader.open(deps.synthesizeSummary(meta), Promise.resolve(meta), startPage, origin, "");
        deps.setReading(true);
      } catch (e) {
        historyScope.clear();
        if (deps.handled(e)) return;
        deps.toast("Couldn't open that version.");
      }
    },

    async openAnnotations(documentId, markId, version) {
      const mine = deps.nextRoute();
      try {
        const base = await api.getNoteMeta(documentId);
        if (!deps.isRoute(mine)) return; // navigated away while fetching
        const origin: ReaderOrigin = {
          kind: "history",
          folderPath: deps.currentFolderPath(),
          version: { md5: version.md5, createdAt: version.createdAt },
          // Defensive: the bin nulls `annotationsId` in practice.
          viewOnly: deps.isTrashed(documentId),
        };
        deps.setReaderBack(deps.folderHref()); // Back leaves the preview for the folder
        const viewer = viewers.viewerFor(base.fileType);
        viewers.activate(viewer);
        // Armed on the mark, not the document; after activate, before open.
        historyScope.setActive(markId, version.md5);
        viewer.open(deps.synthesizeSummary(base), Promise.resolve(base), 0, origin, "");
        deps.setReading(true);
      } catch (e) {
        historyScope.clear();
        if (deps.handled(e)) return;
        deps.toast("Couldn't open those annotations.");
      }
    },

    restore(noteId, version, returnTo = noteId) {
      return runRestore({
        api,
        noteId,
        md5: version.md5,
        confirm: () => confirmRestore(deps.host, version),
        toast: deps.toast,
        handled: deps.handled,
        onRestored: () => {
          historyScope.clear();
          deps.onRestored(returnTo);
        },
      });
    },
  };
}
