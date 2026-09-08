// Parameterizes the reader's DATA source onto a retained version, so the SAME
// reader instance previews a past version without a fork — the exact pattern the
// bin uses (`createBinScope`), for the exact same reason: the reader (and the
// lazy render engine, and the exporter) all pull page bytes and page text
// through the `Api` seam, and none of them should learn that "version history"
// exists. So the shell's `Api` is wrapped once and every consumer downstream is
// unchanged; a mutable `active` pointer (only ONE preview is ever open) says which
// version, if any, the reroute is for.
//
// While a preview is active, for THE previewed note only:
//   - page bytes come from the per-version history endpoint (H7), keyed by the
//     version md5 + page index rather than the live `?v=` hash;
//   - page TEXT comes from the per-version transcript route (`historyPageText`),
//     keyed the same way — so the OCR panel, the on-page recognized-text ovals,
//     find-in-preview's word rectangles and a version's PDF text layer all read the
//     version's real transcript rather than degrading to empty.
//
// Every other note (and the same note when no preview is active) passes straight
// through — a live read is byte-identical to having no wrapper at all.
//
// In-note search is NOT rerouted here, and must not be: the in-document index is
// keyed by blob md5 (`golden-search.md` §1.1 — "history and bin are other
// md5s"), and the find controllers read `fileHash`, which {@link versionMeta}
// already rewrites to the version's md5. A preview searches its own retained
// blob because the meta says which blob it is.

import type { Api } from "../api/types";
import type { Id, NoteMeta, PageRef, PageText } from "../core/types";

export interface HistoryScope {
  /** Wrap the shell's `Api` once, at construction; hand the result to the reader. */
  wrap(api: Api): Api;
  /** Enter preview mode for `md5` of `noteId` — set BEFORE `reader.open(previewMeta)`. */
  setActive(noteId: Id, md5: string): void;
  /** Leave preview mode — the reroute goes quiet and every read is live again. */
  clear(): void;
  /** Whether a preview reroute is currently armed. */
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
      // Armed only for the previewed note — a stray read of a DIFFERENT note while
      // a preview is up (a background freshness poll) must stay live.
      const on = (id: Id): boolean => active !== null && active.noteId === id;

      return {
        ...api,
        getPageBytes: (id: Id, page: PageRef): Promise<ArrayBuffer> =>
          on(id) ? api.historyPageBytes(id, active!.md5, page.index) : api.getPageBytes(id, page),
        // The per-version transcript route: a retained version keeps its own
        // recognized text, so the preview reads it through `historyPageText`
        // rather than degrading to empty. This one reroute lights up all three
        // `getPageText` consumers at once — the reader's on-page ovals, find-in-
        // preview's word rectangles, and the invisible text layer in a version's
        // PDF export.
        getPageText: (id: Id, page: PageRef): Promise<PageText> =>
          on(id) ? api.historyPageText(id, active!.md5, page.index) : api.getPageText(id, page),
      };
    },
  };
}

/**
 * Rewrite a `NoteMeta` into the preview shape for version `md5`.
 *
 * The primary caller now passes the VERSION's OWN meta (`Api.historyMeta`, H7),
 * so `base` already carries the version's real page count + dims and this only
 * re-keys it for the render cache. It is ALSO the graceful fallback: when
 * `historyMeta` fails, the preview path passes the file's LIVE meta as `base`
 * instead — a degraded template (a retained version is an edit of the same note,
 * so page count and dims match in the overwhelming case, and the history page
 * endpoint is keyed by index, not hash, so a hash never has to be right).
 *
 * Two fields are rewritten, and both are load-bearing:
 *   - `pages[].hash` becomes `{md5}:{index}` — a cache key UNIQUE to this version,
 *     so previewing v1 page 0 cannot poison (or be served) the live page 0's
 *     render-cache entry. The rerouted `getPageBytes` ignores it (it uses md5 +
 *     index), so a synthetic hash costs nothing.
 *   - `pages[].hash` becomes `{md5}:{index}` (see above);
 *   - `layers` becomes null — the composite paint is the safe, simplest preview
 *     (a retained version is view-only, never layer-toggled).
 *
 * `textHash` is CARRIED from the live meta, not nulled: it is what ENABLES the
 * find bar (a note with no recognised page can't be searched). The word
 * RECTANGLES come from `getPageText`, which the reroute answers from the
 * per-version transcript route (`historyPageText`).
 *
 * `fileHash` is the version md5 and does TWO jobs: the raw/thumbnail address is
 * the version's, and it is what find-in-preview searches — the in-document
 * index is keyed by blob md5 (`golden-search.md` §1.1), so this one field is
 * the whole of "search the version, not the live file".
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
      // A VERSION PREVIEW SHOWS NO LINKS, and that is a route fact rather than a
      // choice: the transcript has a per-version endpoint and links do not, so a
      // hash here would send the reader to `/note/:id/page/:n/links?v=` with a
      // version's hash — an address that can only 404. Null is "do not ask".
      linksHash: null,
      sourcePage: p.sourcePage,
      layers: null,
    })),
  };
}

/**
 * The minimal {@link NoteMeta} a RAW-based viewer (`.spd`/`.txt`/image) needs to
 * preview a retained version. Unlike {@link versionMeta} — the `.note` path, which
 * carries a page list the reader reroutes per page — these kinds render CLIENT-SIDE
 * from the whole raw blob (`historyFileUrl`), so there is nothing to page through:
 * `spd_decode` reads its own dims, `.txt` is `.text()`, an image is an `<img>`.
 * So no page list and NO `historyMeta` call (that route is `.note`-only, keyed on a
 * retained render index the raw kinds never have). It carries only the file's
 * id/name/type plus the VERSION's md5 (as `fileHash`) and size — the "carry the md5
 * so the raw address is the version's" half of the note path, and nothing more.
 */
export function rawVersionMeta(
  file: { id: Id; name: string; fileType: string },
  version: { md5: string; size: number },
): NoteMeta {
  return {
    id: file.id,
    name: file.name,
    fileType: file.fileType,
    // A version preview is a past blob; the mark beside the file annotates the
    // current one.
    annotationsId: null,
    fileHash: version.md5,
    pages: [],
    size: version.size,
    pxPerMm: null,
  };
}
