// The library's view mode and theme switching.

import { currentTheme, setTheme } from "../../ui/theme";
import type { Theme } from "../../core/types";
import { type View } from "./libraryTopbar";
import type { LibraryCtx } from "./libraryContext";

export interface LibraryView {
  setView(next: View): void;
  /** Drop off-theme bitmaps and repaint what's on screen; the rest re-lazy. */
  repaintForTheme(previous: Theme): void;
  /** A no-op if already in force; the first press of the followed theme still pins it. */
  setThemeTo(next: Theme): void;
}

export function createLibraryView(ctx: LibraryCtx): LibraryView {
  const { st } = ctx;
  function setView(next: View): void {
    st.view = next;
    ctx.topbar.setView(next);
    ctx.render.renderGallery();
  }

  /** Drop off-theme bitmaps and repaint what's on screen; the rest re-lazy. */
  function repaintForTheme(previous: Theme): void {
    void ctx.cache.evictTheme?.(previous);
    ctx.thumbnails.evictTheme(previous);
    // The Appearance control claims a theme, including on the OS-flip path.
    st.accountPage?.themeChanged();
    ctx.galleryEngine.bumpTheme();
    ctx.viewers.reader.bumpTheme();
  }

  /**
  * A no-op if already in force. The first press of the followed theme still
  * pins it, which stops following the OS.
  */
  function setThemeTo(next: Theme): void {
    const previous = currentTheme();
    setTheme(next);
    if (previous === next) {
      st.accountPage?.themeChanged();
      return;
    }
    repaintForTheme(previous);
  }

  return { setView, repaintForTheme, setThemeTo };
}
