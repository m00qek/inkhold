// The common surface every file viewer (`.note` reader, `.spd`, `.txt`, PDF)
// presents to the shell, which shows exactly one at a time.

import type { Api } from "../../api/types";
import type { NoteRenderer } from "../../render/types";
import type { RenderCache } from "../../cache/types";
import type { DocSearch } from "../../search/docSearch";
import type { Id, NoteMeta, NoteSummary, Theme } from "../../core/types";
// Type-only import, so the cycle with `reader.ts` is erased at emit.
import type { ReaderOrigin } from "../reader/reader";

export type { ReaderOrigin };

/** Any module that can display a file. */
export interface Viewer {
  el: HTMLElement;
  /**
   * Show `summary` at `page` (0-based; ignored by pageless viewers), opened from
   * `origin`, with `query` priming in-file find.
   */
  open(summary: NoteSummary, metaPromise: Promise<NoteMeta>, page: number, origin: ReaderOrigin, query: string): void | Promise<void>;
  /**
   * The shell is switching to another viewer: stop painting, leave the layer and
   * release page/listener resources; `open()` re-primes everything.
   */
  hide(): void;
  destroy(): void;
}

/**
 * The file whose versions a viewer talks about: the open file, except for a PDF,
 * where it is the paired `.mark` (named after the document).
 */
export interface VersionSubject {
  id: Id;
  name: string;
  fileType: string;
  /** Set only for annotations: the document they are on (preview over the live document). */
  annotationsOn?: Id;
}

/** Shared by every viewer, so universal actions (Back, Move to bin) cannot drift. */
export interface ViewerDeps {
  api: Api;
  /** In-document search. Shared so a session reuses one wasm FTS5 instance and index. */
  docSearch: DocSearch;
  renderer: NoteRenderer;
  cache: RenderCache;
  getTheme: () => Theme;
  onBack: () => void;
  toast: (message: string) => void;
  onSessionExpired: () => void;
  /** Move the open file to the bin via the shell's single `bin.trash` path. */
  onMoveToBin?: (meta: NoteMeta) => void;
  /** Shown instead of `onMoveToBin` when opened from the bin; routed through the bin controller. */
  onRestore?: (meta: NoteMeta) => void;
  onPurge?: (meta: NoteMeta) => void;
  /** Restore the previewed version of `subject`. */
  onRestoreVersion?: (subject: VersionSubject, version: { md5: string; createdAt: number }) => void;
  /** Open the version-history panel anchored to `anchor`; `viewingMd5` marks the previewed row. */
  onVersions?: (subject: VersionSubject, anchor: HTMLElement, viewingMd5?: string) => void;
  /**
   * Position changed; the shell rewrites the URL. `versionMd5` gives the version
   * route, `bin` the `#/bin/note/:id/page/:n` form (a trashed blob is not served at
   * `#/note/:id`). Mutually exclusive.
   */
  onPosition?: (noteId: Id, page: number, query: string, versionMd5?: string, bin?: boolean) => void;
}
