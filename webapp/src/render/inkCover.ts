// A tile's page-1 ink: the mark's page with that hash, drawn over the page as
// the viewer's strip draws it; a trashed document's mark through the bin's
// routes. The thumbnail facade's `inkCover` (`ThumbnailsDeps.inkCover`).

import type { Api } from "../api/types";
import type { Hash, Id, NoteMeta } from "../core/types";
import { compositeInk, type InkRaster } from "./inkComposite";

export type InkCover = (
  page: ImageBitmap,
  ink: { markId: Id; hash: Hash },
  opts: { bin?: boolean },
) => Promise<ImageBitmap | null>;

/**
 * A mark's page list is asked once per mark and ink, so a gallery of annotated
 * documents costs one request each, on a miss. Only a mark's latest ink is
 * kept: new ink replaces the old list, so the cache is one entry per mark, not
 * one per scribble. Null: the page is not in the mark, or has no ink to draw
 * (the tile keeps the plain page for that ink). A throw: anything that may pass
 * (the network, the decoder, a canvas), so the tile tries again.
 */
export function createInkCover(
  api: Pick<Api, "getNoteMeta" | "getBinNoteMeta" | "getPageBytes" | "getBinPageBytes">,
  inkRaster: InkRaster,
): InkCover {
  const metas = new Map<string, { hash: Hash; meta: Promise<NoteMeta> }>();
  return async (page, ink, opts) => {
    const key = `${opts.bin ? "bin:" : ""}${ink.markId}`;
    let entry = metas.get(key);
    if (!entry || entry.hash !== ink.hash) {
      const meta = opts.bin ? api.getBinNoteMeta(ink.markId) : api.getNoteMeta(ink.markId);
      const fresh = { hash: ink.hash, meta };
      entry = fresh;
      metas.set(key, fresh);
      meta.catch(() => {
        if (metas.get(key) === fresh) metas.delete(key);
      });
    }
    const ref = (await entry.meta).pages.find((p) => p.hash === ink.hash);
    if (!ref) return null;
    const bytes = opts.bin ? await api.getBinPageBytes(ink.markId, ref) : await api.getPageBytes(ink.markId, ref);
    return compositeInk(page, { width: ref.width, height: ref.height }, bytes, inkRaster);
  };
}
