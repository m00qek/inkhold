// Version and annotation previews, and the one restore path, wired to the shell.

import { folderHref, go, noteHref } from "../../router";
import type { Id } from "../../core/types";
import { createVersionPreviews, type VersionPreviews } from "../versionPreview";
import type { FileVersion } from "../../core/types";
import type { LibraryCtx } from "./libraryContext";
import { synthesizeSummary } from "./library";

export interface LibraryPreviews {
  openHistoryPreview(noteId: Id, version: FileVersion, startPage?: number): Promise<void>;
  openAnnotationsPreview(documentId: Id, markId: Id, version: FileVersion): Promise<void>;
  /** True when restored; `returnTo` is the file that reopens (a PDF for its `.mark`). */
  restoreVersion(noteId: Id, version: { md5: string; createdAt: number }, noteName: string, returnTo?: Id): Promise<boolean>;
}

export function createLibraryPreviews(ctx: LibraryCtx): LibraryPreviews {
  const { st } = ctx;
  const previews: VersionPreviews = createVersionPreviews({
    api: ctx.api,
    viewers: ctx.viewers,
    historyScope: ctx.historyScope,
    host: ctx.root,
    isTrashed: (id) => ctx.bin.isTrashed(id),
    currentFolderPath: () => ctx.routes.currentFolderPath(),
    folderHref: () => folderHref(st.folderId),
    setReaderBack: (href) => {
      st.readerBack = href;
    },
    setReading: ctx.setReading,
    nextRoute: () => ++st.routeToken,
    isRoute: (token) => token === st.routeToken,
    synthesizeSummary,
    onRestored: (returnTo) => {
      void ctx.data.refetch(st.folderId, ctx.folderCache.get(st.folderId));
      ctx.rail.build();
      go(noteHref(returnTo));
    },
    toast: ctx.toast,
    handled: ctx.handled,
  });

  function openHistoryPreview(noteId: Id, version: FileVersion, startPage = 0): Promise<void> {
    return previews.openHistory(noteId, version, startPage);
  }

  function openAnnotationsPreview(documentId: Id, markId: Id, version: FileVersion): Promise<void> {
    return previews.openAnnotations(documentId, markId, version);
  }

  function restoreVersion(
    noteId: Id,
    version: { md5: string; createdAt: number },
    _noteName: string,
    returnTo: Id = noteId,
  ): Promise<boolean> {
    return previews.restore(noteId, version, returnTo);
  }

  return { openHistoryPreview, openAnnotationsPreview, restoreVersion };
}
