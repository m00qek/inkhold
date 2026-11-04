// Version and annotation previews, and the one restore path, wired to the shell.

import { folderHref, go, noteHref } from "../router";
import { createFolderCache } from "./folderCache";
import type { Api } from "../api/types";
import type { Id } from "../core/types";
import { type ViewerSet } from "./viewerSet";
import { createVersionPreviews, type VersionPreviews } from "./versionPreview";
import { createHistoryScope } from "./historyScope";
import type { FileVersion } from "../core/types";
// The breadcrumb is painted here, but its flattening rule is the rail's.
import { type RailController } from "./rail";
// Paints into `gallery`; `renderGallery()` closes it, so no teardown hook.
import { type BinController } from "./bin";
// Static, unlike the console: small, and every user has one.
import type { LibraryState } from "./libraryState";
import { createLibraryData } from "./libraryData";
import { createLibraryRoutes } from "./libraryRoutes";

import { synthesizeSummary } from "./library";

export interface LibraryPreviewsParts {
  handled: (e: unknown) => boolean;
  toast: (message: string) => void;
  setReading: (reading: boolean) => void;
  historyScope: () => ReturnType<typeof createHistoryScope>;
  api: () => Api;
  refetch: () => ReturnType<typeof createLibraryData>["refetch"];
  folderCache: () => ReturnType<typeof createFolderCache>;
  rail: () => RailController;
  viewers: () => ViewerSet;
  root: () => HTMLElement;
  bin: () => BinController;
  currentFolderPath: () => ReturnType<typeof createLibraryRoutes>["currentFolderPath"];
}

export function createLibraryPreviews(st: LibraryState, p: LibraryPreviewsParts) {
  const previews: VersionPreviews = createVersionPreviews({
    api: p.api(),
    viewers: p.viewers(),
    historyScope: p.historyScope(),
    host: p.root(),
    isTrashed: (id) => p.bin().isTrashed(id),
    currentFolderPath: () => p.currentFolderPath()(),
    folderHref: () => folderHref(st.folderId),
    setReaderBack: (href) => {
      st.readerBack = href;
    },
    setReading: p.setReading,
    nextRoute: () => ++st.routeToken,
    isRoute: (token) => token === st.routeToken,
    synthesizeSummary,
    onRestored: (returnTo) => {
      void p.refetch()(st.folderId, p.folderCache().get(st.folderId));
      p.rail().build();
      go(noteHref(returnTo));
    },
    toast: p.toast,
    handled: p.handled,
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

  return { previews, openHistoryPreview, openAnnotationsPreview, restoreVersion };
}
