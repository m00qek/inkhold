// The library's view mode and theme switching.

import { currentTheme, setTheme } from "../../ui/theme";
import type { Theme } from "../../core/types";
import { type LazyEngine } from "../../render/lazy";
import { type Thumbnails } from "../../render/thumbnails";
import { type Topbar, type View } from "./libraryTopbar";
// The breadcrumb is painted here, but its flattening rule is the rail's.
// Paints into `gallery`; `renderGallery()` closes it, so no teardown hook.
// Static, unlike the console: small, and every user has one.
import type { LibraryState } from "./libraryState";
import { createLibraryRender } from "./libraryRender";
import { type AppDeps } from "./library";

import type { ViewerSet } from "../viewer/viewerSet";

export interface LibraryViewParts {
  cache: () => AppDeps["cache"];
  renderGallery: () => ReturnType<typeof createLibraryRender>["renderGallery"];
  topbar: () => Topbar;
  thumbnails: () => Thumbnails;
  galleryEngine: () => LazyEngine;
  reader: () => ViewerSet["reader"];
}

export function createLibraryView(st: LibraryState, p: LibraryViewParts) {
  function setView(next: View): void {
    st.view = next;
    p.topbar().setView(next);
    p.renderGallery()();
  }

  /** Drop off-theme bitmaps and repaint what's on screen; the rest re-lazy. */
  function repaintForTheme(previous: Theme): void {
    void p.cache().evictTheme?.(previous);
    p.thumbnails().evictTheme(previous);
    // The Appearance control claims a theme, including on the OS-flip path.
    st.accountPage?.themeChanged();
    p.galleryEngine().bumpTheme();
    p.reader().bumpTheme();
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
