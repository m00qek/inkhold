// The one deps object every viewer shares, so Back, Move to bin and position reporting are the same closures.

import { currentTheme } from "../../ui/theme";
import { go, replaceBinNotePosition, replaceNotePosition, replaceNoteVersionPosition } from "../../router";
import { shortMd5 } from "../versionShort";
import type { ViewerDeps } from "../viewer/viewer";
import { createDocSearch } from "../../search/docSearch";
import type { LibraryCtx } from "./libraryContext";

export function createLibraryViewerDeps(ctx: LibraryCtx): ViewerDeps {
  const { st } = ctx;
  // One deps object for every viewer, so Back, Move to bin and position
  // reporting are literally the same closures.
  const viewerDeps: ViewerDeps = {
    api: ctx.api,
    // In-document search: the same wasm FTS5 engine on one document's
    // `text/<md5>`, built once and shared by every viewer. `text/<md5>` is
    // `immutable`, so `index_version` from the manifest rides the query string to
    // bust the cache on re-derivation; read fresh per call.
    docSearch: createDocSearch({
      indexVersion: (md5) => ctx.searchService.indexVersion(md5),
      derivation: (md5) => ctx.searchService.derivation(md5),
    }),
    renderer: ctx.renderer,
    cache: ctx.cache,
    getTheme: currentTheme,
    // Back to where the note was opened from; see `readerBack`.
    onBack: () => go(st.readerBack),
    toast: ctx.toast,
    onSessionExpired: ctx.sessionDidExpire,
    // The same `bin.trash` as the card menu (toast, device line), then leave like
    // Back. `kind: "note"` is right for any file type.
    onMoveToBin: (meta) => {
      void ctx.bin.trash({ id: meta.id, name: meta.name, kind: "note" });
      go(st.readerBack);
    },
    // Bin-origin Restore / Delete through the bin controller's by-id methods (the
    // purge confirm included). Navigation waits for the outcome: a cancel or
    // failure leaves the viewer open; success returns to `#/bin`.
    onRestore: (meta) => {
      void ctx.bin.restore(meta.id).then((done) => {
        if (done) go(st.readerBack);
      });
    },
    onPurge: (meta) => {
      void ctx.bin.purge(meta.id).then((done) => {
        if (done) go(st.readerBack);
      });
    },
    // The same `restoreVersion` as the panel. For a PDF's annotations the `.mark`
    // is restored but the document is what reopens.
    onRestoreVersion: (subject, version) =>
      void ctx.previews.restoreVersion(subject.id, version, subject.name, subject.annotationsOn ?? subject.id),
    // The same history panel as the card menu; a forward reference, only called on click.
    onVersions: (subject, anchor, viewingMd5) =>
      ctx.features.historyController.open(
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

  return viewerDeps;
}
