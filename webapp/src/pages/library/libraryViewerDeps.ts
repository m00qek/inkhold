// The one deps object every viewer shares, so Back, Move to bin and position reporting are the same closures.

import { currentTheme } from "../../ui/theme";
import { go, replaceBinNotePosition, replaceNotePosition, replaceNoteVersionPosition } from "../../router";
import { shortMd5 } from "../versionShort";
import type { Api } from "../../api/types";
import type { Id } from "../../core/types";
import type { ViewerDeps } from "../viewer/viewer";
import { createDocSearch } from "../../search/docSearch";
// The breadcrumb is painted here, but its flattening rule is the rail's.
// Paints into `gallery`; `renderGallery()` closes it, so no teardown hook.
import { type BinController } from "../bin/bin";
// Static, unlike the console: small, and every user has one.
import type { LibraryState } from "./libraryState";
import { createLibraryFeatures } from "./libraryFeatures";
import { createLibraryEngines } from "./libraryEngines";

import type { AppDeps } from "./library";

export interface LibraryViewerDepsParts {
  sessionDidExpire: () => void;
  toast: (message: string) => void;
  restoreVersion: (noteId: Id, version: { md5: string; createdAt: number }, _noteName: string, returnTo?: Id) => Promise<boolean>;
  renderer: () => AppDeps["renderer"];
  cache: () => AppDeps["cache"];
  api: () => Api;
  searchService: () => ReturnType<typeof createLibraryEngines>["searchService"];
  bin: () => BinController;
  historyController: () => ReturnType<typeof createLibraryFeatures>["historyController"];
}

export function createLibraryViewerDeps(st: LibraryState, p: LibraryViewerDepsParts) {
  // One deps object for every viewer, so Back, Move to bin and position
  // reporting are literally the same closures.
  const viewerDeps: ViewerDeps = {
    api: p.api(),
    // In-document search: the same wasm FTS5 engine on one document's
    // `text/<md5>`, built once and shared by every viewer. `text/<md5>` is
    // `immutable`, so `index_version` from the manifest rides the query string to
    // bust the cache on re-derivation; read fresh per call.
    docSearch: createDocSearch({ indexVersion: (md5) => p.searchService().indexVersion(md5) }),
    renderer: p.renderer(),
    cache: p.cache(),
    getTheme: currentTheme,
    // Back to where the note was opened from; see `readerBack`.
    onBack: () => go(st.readerBack),
    toast: p.toast,
    onSessionExpired: p.sessionDidExpire,
    // The same `bin.trash` as the card menu (toast, device line), then leave like
    // Back. `kind: "note"` is right for any file type.
    onMoveToBin: (meta) => {
      void p.bin().trash({ id: meta.id, name: meta.name, kind: "note" });
      go(st.readerBack);
    },
    // Bin-origin Restore / Delete through the bin controller's by-id methods (the
    // purge confirm included). Navigation waits for the outcome: a cancel or
    // failure leaves the viewer open; success returns to `#/bin`.
    onRestore: (meta) => {
      void p.bin().restore(meta.id).then((done) => {
        if (done) go(st.readerBack);
      });
    },
    onPurge: (meta) => {
      void p.bin().purge(meta.id).then((done) => {
        if (done) go(st.readerBack);
      });
    },
    // The same `restoreVersion` as the panel. For a PDF's annotations the `.mark`
    // is restored but the document is what reopens.
    onRestoreVersion: (subject, version) =>
      void p.restoreVersion(subject.id, version, subject.name, subject.annotationsOn ?? subject.id),
    // The same history panel as the card menu; a forward reference, only called on click.
    onVersions: (subject, anchor, viewingMd5) =>
      p.historyController().open(
        { id: subject.id, name: subject.name, fileType: subject.fileType },
        { anchor, viewingMd5, annotationsOn: subject.annotationsOn },
      ),
    // Rewrites the hash without a history entry. Bin wins first (a trashed version
    // preview is still reached through the bin), then version preview, then live.
    onPosition: (noteId, page, q, versionMd5, bin) =>
      bin
        ? replaceBinNotePosition(noteId, page)
        : versionMd5
          ? replaceNoteVersionPosition(noteId, shortMd5(versionMd5), page)
          : replaceNotePosition(noteId, page, q),
  };

  return { viewerDeps };
}
