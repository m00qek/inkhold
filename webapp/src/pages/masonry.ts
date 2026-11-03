// CSS-grid row-span masonry (04-library-gallery.css). CSS decides heights; the
// span pass only measures, and reruns only when a height can change.

export interface Masonry {
  /** Coalesces into one pass on the next frame. */
  schedule(): void;
}

/** `active` says whether the gallery is the icon masonry right now. */
export function createMasonry(gallery: HTMLElement, active: () => boolean): Masonry {
  let scheduled = false;

  /**
   * Rows = ⌈(outer height + gap) / row unit⌉, with unit and gap read off the
   * live grid.
   */
  function spanTiles(): void {
    if (!active()) return;
    const grid = getComputedStyle(gallery);
    const unit = parseFloat(grid.gridAutoRows);
    const gap = parseFloat(grid.getPropertyValue("--masonry-gap"));
    if (!Number.isFinite(unit) || unit <= 0) return; // not the masonry right now
    for (const child of gallery.children) {
      if (!(child instanceof HTMLElement)) continue;
      const height = child.getBoundingClientRect().height;
      if (height <= 0) continue;
      const cs = getComputedStyle(child);
      const outer = height + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
      child.style.gridRowEnd = `span ${Math.max(1, Math.ceil((outer + (Number.isFinite(gap) ? gap : 0)) / unit))}`;
    }
  }

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      spanTiles();
    });
  }

  // A late webfont swap reflows captions, so span once more when fonts load.
  // `document.fonts` is absent in unit tests.
  if (typeof document !== "undefined" && document.fonts) {
    void document.fonts.ready.then(() => schedule());
  }

  return { schedule };
}
