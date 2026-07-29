// The multi-viewer seam. A file's TYPE decides which viewer opens it, and every
// viewer — the `.note` reader, a `.spd` viewer, a `.txt` viewer — presents the
// SAME small surface to the shell. The library's `viewerFor` maps a fileType to a
// viewer, `activate` shows exactly one at a time (hiding the one it switches away
// from), and every viewer's `el` is mounted once beside the reader.
//
// WHY AN INTERFACE, not just "the reader plus special cases". The reader used to
// branch internally on `meta.fileType` for its three outcomes (note / image / no
// preview), which is fine while every branch is a raster in the same overlay. A
// `.spd` compositor and a `.txt` reader are whole different DOM and lifecycles,
// so they are separate MODULES that conform to this shape rather than more arms
// inside the reader — and the reader stays the DEFAULT viewer for note, image and
// every unrecognised kind (see `library.viewerFor`).

import type { Api } from "../api/types";
import type { NoteRenderer } from "../render/types";
import type { RenderCache } from "../cache/types";
import type { Id, NoteMeta, NoteSummary, Theme } from "../core/types";
// TYPE-ONLY, so this is a compile-time cycle the emit erases (`reader.ts` imports
// `Viewer` from here; this imports `ReaderOrigin` from there). `ReaderOrigin`
// stays defined beside the reader that authored the concept — "where was this
// opened FROM", which decides Back's word and the subtitle — and is re-exported
// here so a stub viewer depends on this seam rather than reaching into the reader.
import type { ReaderOrigin } from "./reader";

export type { ReaderOrigin };

/**
 * A viewer is any module that can display a file (a `.note` / `.spd` / `.txt`).
 * `Reader` trivially implements this because it had exactly this shape
 * already (it has `el`/`open`/`destroy` and gains `hide()`); a new viewer is any
 * module that returns this shape.
 */
export interface Viewer {
  /** The viewer's root, mounted ONCE inside the library's content area. */
  el: HTMLElement;
  /**
   * Show `summary`, starting at `page` (0-based; ignored by viewers with no pages),
   * opened FROM `origin` (Back's word + the subtitle's folder), with `query`
   * priming any in-file find. Same parameter order as the reader's `open`, so the
   * shell dispatches to every viewer identically.
   * `metaPromise` resolves with the full `NoteMeta` (page dimensions, etc)
   * shortly after `open` is called.
   */
  open(summary: NoteSummary, metaPromise: Promise<NoteMeta>, page: number, origin: ReaderOrigin, query: string): void | Promise<void>;
  /**
   * The shell is switching to a DIFFERENT viewer. Stop painting and leave the
   * layer, so two viewers never stack. A viewer with resources to drop (a decoded
   * page, a keydown listener) releases them here — the shell guarantees `open()`
   * re-primes everything before this viewer is seen again.
   */
  hide(): void;
  /** Tear down for good (the whole shell is going away). */
  destroy(): void;
}

/**
 * What every viewer is built with. Deliberately the SAME set the reader already
 * takes (`ReaderDeps`), so one object wires the reader and the stubs alike and the
 * universal actions — Back, the one `bin.trash` path behind Move to bin — cannot
 * drift between viewers. A viewer that needs less simply ignores the rest.
 */
export interface ViewerDeps {
  api: Api;
  renderer: NoteRenderer;
  cache: RenderCache;
  getTheme: () => Theme;
  /** Navigate back to where the file was opened from (the viewer never touches the hash). */
  onBack: () => void;
  toast: (message: string) => void;
  /** A page fetch 401/403'd — hand off to the shell, which re-authenticates. */
  onSessionExpired: () => void;
  /**
   * Move the open file to the recycle bin. The viewer hands the shell the file's
   * identity and does nothing else: the shell owns the ONE trash path (`bin.trash`),
   * so the undo toast, the U6 device line and the control-plane call are shared
   * with the library card's delete by construction. Hidden in the recycle-bin
   * context, where the file is already trashed and the two callbacks below take
   * over the file zone.
   */
  onMoveToBin?: (meta: NoteMeta) => void;
  /**
   * The BIN-ORIGIN file actions — shown instead of {@link onMoveToBin} when the
   * file was opened FROM the recycle bin (`origin.kind === "bin"`), because a
   * trashed file's two decisions are Restore and Delete permanently. Both hand
   * the shell the file's identity and nothing else: the shell routes them
   * through the bin controller's own `restore`/`purge`, so the toast, the
   * purge's confirm dialog (no caller reaches the destructive half without it)
   * and the badge/gallery refresh are the bin's one machinery — and the shell
   * navigates back to the bin afterwards, since the file no longer exists in the
   * bin context either way.
   */
  onRestore?: (meta: NoteMeta) => void;
  onPurge?: (meta: NoteMeta) => void;
  /**
   * Restore the version being PREVIEWED (the reader's history-preview mode). Only
   * the reader uses it — a `.spd`/`.txt` viewer has no version-preview mode and
   * ignores it — but it rides `ViewerDeps` so the one shared deps object wires it,
   * exactly like the bin-origin callbacks above.
   */
  onRestoreVersion?: (meta: NoteMeta, version: { md5: string; createdAt: number }) => void;
  /**
   * Open the file's VERSION HISTORY (hot-cache versioning) — the same panel the
   * library card's ⋯ menu opens, reached now from inside the viewer for
   * discoverability. The viewer hands over the file's meta, the toolbar button the
   * floating panel anchors to, and (in a history preview) the previewed version's
   * md5 so its row is marked `Viewing`. The reader wires it for a live `.note` and
   * mid-preview; a `.spd`/`.txt` viewer wires it only while previewing.
   */
  onVersions?: (meta: NoteMeta, anchor: HTMLElement, viewingMd5?: string) => void;
  /**
   * The viewer's position changed (page / in-file query) — the shell rewrites the
   * URL. Two mutually-exclusive flags pick WHICH form:
   *  - `versionMd5` — previewing a retained version: the shell emits the
   *    `#/note/:id/version/:short` form so a reload / copy-link reproduces it.
   *  - `bin` — opened FROM the recycle bin: the shell emits the deep
   *    `#/bin/note/:id/page/:n` form, because a trashed file's blob is not served
   *    at the live `#/note/:id` route (a reload of which would 404 to the
   *    library). No `query` rides a bin URL — it pins the file + page only.
   * Neither flag is the bare live-note URL.
   */
  onPosition?: (noteId: Id, page: number, query: string, versionMd5?: string, bin?: boolean) => void;
}
