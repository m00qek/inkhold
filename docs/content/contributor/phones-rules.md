---
title: "Phones and offline"
description: "Viewer bars, the phone layout, the bar that folds into ⋯, tablets, text size, installing and offline."
weight: 3074
extra:
  reader: contributor
  type: reference
---

# Phones and offline

Viewer bars, the phone layout, the bar that folds into ⋯, tablets, text size, installing and offline. Why they are this way: [Phone and offline decisions](@/contributor/phones-and-offline.md).

## Layout

- **Viewer bars** (`styles/10-toolbar.css`) are containers (`bar`). Under
  60rem of bar, Back and the file's actions drop their words (still named)
  and controls in a zone close up; under what that fits, the zones wrap. A
  title gives way first (`flex: 1 1 8rem`). The export menu hangs from the
  trigger's start when the bar has wrapped. On a phone the bar is no
  container, so its bottom row can be `fixed` to the screen.

- **Phone** (`pages/library/libraryPhone.ts`, `styles/23-phone.css`): the
  rail is a drawer from the bar's ☰ (modal: the rest is inert, focus goes in
  and back to ☰; Escape, the scrim or a link closes it). The bar keeps ☰, the
  place's name and ⋯ (its tools as one menu; shown only when it has some).
  A tab bar holds Library, To-Do, Search and You; its Search opens the box
  across the bar, which stays while it holds a query. The tab bar gives way
  to a viewer's own bar. Cards run two columns. Viewers keep ‹, the title and ⋯ on top and
  one row at the bottom: paging, then the panel switches (Recognized text,
  Layers, Pages; a PDF's Pages, Outline, Annotations), kept in view because
  a switch's state is worth seeing (text size for text). Zoom is a pinch,
  and a double tap back to Fit (`ui/pinchZoom.ts`): the page scales by a
  transform while the fingers move, then the viewer re-renders sharp at
  that factor of Fit and the point under the fingers stays put. A quick
  sideways swipe turns the page, left for the next (`ui/swipePages.ts`);
  a page zoomed past the stage pans first and turns only from the edge it
  started at, and the pager stays the one-pointer way. A `.txt` drops its
  paper card: the text fills the screen's width and the column-width zoom
  is hidden, leaving text size. The page opts into `viewport-fit=cover`:
  the shell pads itself below the status bar (the band behind it in the top
  bar's colour) and every bottom bar pads above the home indicator, all by
  `env(safe-area-inset-*)`. The zoom
  stepper is the one-finger way (WCAG 2.5.1), in ⋯ with the other
  occasional tools (`fold` in the toolbar spec: Find, zoom) and the file's
  actions, the tools under "View", ticked while on. A viewer's panels start
  closed on a phone and open as ONE sheet sitting on the bottom row, never
  beside the page: one open at a time, a fixed height (Pages a short strip
  whose thumbnails run sideways), a × in its head. The stage pads itself
  clear of the bar (`--phone-bar-h`, measured) and of an open sheet, and
  Fit measures that padded box, so the page always lands above both. Every place below another has
  ‹ in ☰'s place, one level up (a folder's parent, Lists, the folder a
  search started from): iPhones have no back button. A viewer's Find sits
  beside ⋯ in the top row (`top` in the toolbar spec: moved there, not
  copied, so focus order follows what you see). Menus are sheets
  along the bottom (`placePop` sets `data-sheet`). On a touch screen controls are 44px.
- **A bar with no room folds into ⋯** (`ui/barMenu.ts`): its controls become
  ONE menu, in the bar's order, a divider wherever the bar has one (and
  around each choice). A select becomes its options and a pressed-button
  group its buttons, the current one ticked (`menuitemradio`); a button
  with a menu of its own brings that menu's rows in (`setMenuRows`, else its
  in-page `.menu__pop`) when short; a long one (more than `SUBMENU_AT`, 4,
  items: a viewer's Download) is one row with ›, that opens its rows in the
  same sheet under a ‹ row back, rather than burying the rest of ⋯. An
  action is listed once (`onceEach`): a row repeats one of the same name in
  the same section, or one in no section (the file's own action), never
  merely a namesake (two views' "PDF document" are two files); any other
  button is a row with its icon and name. Rows only forward to the bar's
  control. On a phone: the library bar's tools, To-Do's (New list, the
  list's actions, Download), and each viewer's file zone. ⋯ shows only when
  there is something behind it. Sheets along the bottom stay open through
  scrolls and resizes (no trigger holds them), and a gallery repaint closes
  only menus whose trigger it replaces.
- **Tablet:** the rail is a strip of icons; names stay in the accessibility
  tree and in a tooltip.
- **Text size:** the rail's width, the account page's label gutter and the
  viewers' toolbar (which wraps) follow the text size, so 200% clips
  nothing. On touch screens the root takes Apple's body style
  (`-apple-system-body`), so iPhones follow the system's Larger Text; on a Mac
  it would shrink the app, hence touch only. A smaller system text size can put
  1rem under 16px, where iOS zooms the page when a field takes focus and stays
  zoomed after; so every field on a touch screen, sign-in included, is
  `--fs-field-touch`, `max(16px, 1rem)`: never under 16px, still growing.
- **Tests:** the guard adds a tablet in portrait (820px) and in landscape
  (1180px, desktop layout under a finger), both with touch; `tests/e2e/phone.spec.ts` holds the
  drawer, the tab bar, search, sheets and the viewer's bottom bar.

## Installing and offline

The app installs as a PWA: `public/manifest.webmanifest` (name, `standalone`,
the desk colour, icons from `icons/build.sh`) and a service worker,
`sw/sw.js`, which `vite.config.ts` writes into each build with that build's
file list and a version hashed from the files and the worker's own code.
Production builds only; dev never registers one.

- **What the device keeps.** The app's own files (cache-first), and the
  listings a person browses with: `/api/user/me`, the folder tree, the bin,
  storage use (network-first, the stored copy only when the network fails).
  That is names and counts, never a file: pages, PDFs, images, transcripts
  and to-dos always come from the server. The wasm decoders are not kept
  either; only reading needs them.
- **Forgetting.** Signing out, or the server refusing the session (401/403
  on any listing), deletes the stored listings. `server-info` is not kept,
  since the sign-in page reads it.
- **Offline.** The app opens and browses what this device has seen. Opening a
  file, a version or To-Do says it needs a connection and stays put
  (`libraryRoutes.ts`, `offline()`), instead of a viewer that never fills.
- **Updates.** A new build installs beside the old one and waits; the page
  offers "A new version of Inkhold is ready" with Reload, and only then does
  the new one take over (`src/pwa/register.ts`). It reloads once the new
  worker is `activated`, not on `controllerchange`: a reload while it is
  still activating can stall. An installed app looks for updates when it
  comes back to the foreground.
- **Server.** `sw.js` and the manifest are `no-cache` like every unhashed
  file (`backend/http/static.zig`); the manifest is served as
  `application/manifest+json`.
- **Tests.** `tests/e2e/pwa.spec.ts`, run with
  `npx playwright test -c playwright.pwa.config.ts` against a production
  build: the manifest, offline browsing, what is and is not kept, sign-out
  and a refused session, offline opening, and the update offer.
