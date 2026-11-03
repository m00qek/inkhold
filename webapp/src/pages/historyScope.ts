// Wraps the shell's `Api` so the same reader previews a retained version (as
// `createBinScope` does for the bin): while active, page bytes and page text for
// the previewed note come from the per-version routes; everything else is live.
// In-note search needs no reroute: `versionMeta` sets `fileHash` to the version md5.

import type { Api } from "../api/types";
import type { Id, NoteMeta, PageRef, PageText } from "../core/types";

export interface HistoryScope {
  wrap(api: Api): Api;
  /** Set BEFORE `reader.open(previewMeta)`. */
  setActive(noteId: Id, md5: string): void;
  clear(): void;
  isActive(): boolean;
}

export function createHistoryScope(): HistoryScope {
  let active: { noteId: Id; md5: string } | null = null;

  return {
    setActive(noteId, md5) {
      active = { noteId, md5 };
    },
    clear() {
      active = null;
    },
    isActive() {
      return active !== null;
    },
    wrap(api) {
      // Only the previewed note; a background read of another note stays live.
      const on = (id: Id): boolean => active !== null && active.noteId === id;

      return {
        ...api,
        getPageBytes: (id: Id, page: PageRef): Promise<ArrayBuffer> =>
          on(id) ? api.historyPageBytes(id, active!.md5, page.index) : api.getPageBytes(id, page),
        getPageText: (id: Id, page: PageRef): Promise<PageText> =>
          on(id) ? api.historyPageText(id, active!.md5, page.index) : api.getPageText(id, page),
      };
    },
  };
}

/**
* Re-keys a version's meta (`Api.historyMeta`, or the live meta as a fallback
* template) for preview: `pages[].hash` becomes `{md5}:{index}` so it cannot
* collide with the live page's render-cache entry, `layers` is nulled
* (view-only), `textHash` is kept because it enables the find bar, and
* `fileHash` is the version md5 (raw address and in-document search key).
*/
export function versionMeta(base: NoteMeta, md5: string): NoteMeta {
  return {
    ...base,
    fileHash: md5,
    pages: base.pages.map((p) => ({
      index: p.index,
      hash: `${md5}:${p.index}`,
      width: p.width,
      height: p.height,
      textHash: p.textHash,
      // Links have no per-version endpoint, so a hash here would only 404.
      linksHash: null,
      sourcePage: p.sourcePage,
      layers: null,
    })),
  };
}

/**
* Minimal meta for raw-rendered kinds (`.spd`/`.txt`/image), which decode the
* whole blob from `historyFileUrl`: no page list and no `historyMeta` call
* (that route is `.note`-only).
*/
export function rawVersionMeta(
  file: { id: Id; name: string; fileType: string },
  version: { md5: string; size: number },
): NoteMeta {
  return {
    id: file.id,
    name: file.name,
    fileType: file.fileType,
    // The annotation mark belongs to the current blob, not a past one.
    annotationsId: null,
    fileHash: version.md5,
    pages: [],
    size: version.size,
    pxPerMm: null,
  };
}
