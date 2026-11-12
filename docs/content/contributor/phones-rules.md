---
title: "Phones and offline"
description: "Viewer bars, the phone layout, the bar that folds into ⋯, tablets, text size, installing and offline."
weight: 3074
extra:
  reader: contributor
  type: reference
---

# Phones and offline

How the app lays itself out on a phone and a tablet, how a bar folds into ⋯,
text size, installing, and what works offline. Why: [How the app fits a phone, and works offline](@/contributor/phones-and-offline.md).

## Layout

Intrinsic first: content sizes itself (grids that fill, rows that wrap, sizes
in rem), a component asks its container how much room it has, and media
queries only switch the page's shape. That shape follows the room there is
(`00-tokens.css`): a phone below 700px, a tablet up to 1099px, a desktop from
1100px. Touch is its own question, `(pointer: coarse)`, never inferred from
width.

### Viewer bars

A viewer's bar (`styles/10-toolbar.css`) is a container (`bar`). Under 60rem
of bar, Back and the file's actions drop their words (they keep their names
for assistive technology) and the controls in a zone close up; under what that
fits, the zones wrap. The title gives way first (`flex: 1 1 8rem`). The export
menu hangs from the trigger's start edge once the bar has wrapped. On a phone
the bar is not a container, so its bottom row can be fixed to the screen.

### The phone

`pages/library/libraryPhone.ts` and `styles/23-phone.css`.

- The rail is a drawer, opened from the bar's ☰. It is modal: the rest of the
  page is inert, focus goes into it and back to ☰, and Escape, the scrim or
  following a link closes it.
- The bar keeps ☰, the place's name and ⋯, which holds the bar's tools as one
  menu and is shown only when there are some.
- A tab bar holds Library, To-Do, Search and You (Digest is in the ☰ drawer,
  under Apps). Its Search opens the box
  across the bar, which stays while it holds a query. The tab bar gives way to
  a viewer's own bar.
- Cards run in two columns.
- A viewer keeps ‹, the title and ⋯ at the top, and one row at the bottom:
  paging, then the panel switches (Page text, Layers, Pages; a PDF's
  Pages, Outline, Annotations). Those stay in view because a switch's state is
  worth seeing; a text file shows its text size there.
- Zoom is a pinch, and a double tap goes back to Fit (`ui/pinchZoom.ts`). The
  page scales by a transform while the fingers move; then the viewer re-renders
  sharp at that factor of Fit, and the point under the fingers stays put.
- A quick sideways swipe turns the page, left for the next
  (`ui/swipePages.ts`). A page zoomed past the stage pans first and turns only
  from the edge it started at. The pager stays as the way to do it with one
  pointer.
- A `.txt` drops its paper card: the text fills the screen's width, the
  column-width zoom is hidden, and text size remains.
- The page opts into `viewport-fit=cover`. The shell pads itself below the
  status bar, with the band behind it in the top bar's colour, and every bottom
  bar pads above the home indicator, all by `env(safe-area-inset-*)`.
- The zoom stepper is the one-finger way (WCAG 2.5.1). It sits in ⋯ with the
  other occasional tools (`fold` in the toolbar spec: Find, zoom) and the
  file's actions; the tools are under "View", ticked while on.
- A viewer's panels start closed on a phone, and open as one sheet sitting on
  the bottom row, never beside the page: one at a time, a fixed height (Pages is
  a short strip whose thumbnails run sideways), with a × in its head. The stage
  pads itself clear of the bar (`--phone-bar-h`, measured) and of an open
  sheet, and Fit measures that padded box, so the page always lands above
  both.
- Every place below another has ‹ in ☰'s position, leading one level up (a
  folder's parent, Lists, the folder a search started from): iPhones have no
  back button.
- A viewer's Find sits beside ⋯ in the top row (`top` in the toolbar spec):
  moved there, not copied, so focus order follows what the eye sees.
- Menus are sheets along the bottom (`placePop` sets `data-sheet`).
- On a touch screen, controls are 44px.

### A bar with no room folds into ⋯

`ui/barMenu.ts` turns a bar's controls into one menu, in the bar's order, with
a divider wherever the bar has one and around each choice.

- A select becomes its options; a group of pressed buttons becomes its
  buttons, the current one ticked (`menuitemradio`).
- A button with a menu of its own brings that menu's rows in (`setMenuRows`,
  or else its in-page `.menu__pop`) when the menu is short. A long one (more
  than `SUBMENU_AT`, 4, items: a viewer's Download) is one row with ›, which
  opens its rows in the same sheet under a ‹ row leading back, rather than
  burying the rest of ⋯.
- An action is listed once (`onceEach`): a row repeats one of the same name in
  the same section, or one in no section (the file's own action), never a
  mere namesake (two views' "PDF document" are two files). Any other button is
  a row with its icon and name. Rows only forward to the bar's control.
- On a phone this covers the library bar's tools, To-Do's (New list, the
  list's actions, Download) and each viewer's file zone. ⋯ shows only when
  there is something behind it.
- Sheets along the bottom stay open through scrolls and resizes (no trigger
  holds them), and a gallery repaint closes only the menus whose trigger it
  replaces.

### Tablet

The rail is a strip of icons; the names stay in the accessibility tree and in
a tooltip.

### Text size

The rail's width, the account page's label gutter and the viewers' toolbar
(which wraps) follow the text size, so 200% clips nothing. On touch screens the
root takes Apple's body style (`-apple-system-body`), so an iPhone follows the
system's Larger Text; on a Mac that style would shrink the app, hence touch
only. A smaller system text size can put 1rem under 16px, where iOS zooms the
page when a field takes focus and stays zoomed afterwards, so every field on a
touch screen, sign-in included, is `--fs-field-touch`, that is
`max(16px, 1rem)`: never under 16px, still growing with the text size.

### Tests

The semantics guard adds a tablet in portrait (820px) and in landscape
(1180px: the desktop layout under a finger), both with touch.
`tests/e2e/phone.spec.ts` holds the drawer, the tab bar, search, sheets and the
viewer's bottom bar.

## Installing and offline

The app installs as a PWA: `public/manifest.webmanifest` (the name,
`standalone`, the desk colour, icons from `icons/build.sh`) and a service
worker, `sw/sw.js`, which `vite.config.ts` writes into each build with that
build's file list and a version hashed from the files and the worker's own
code. Production builds only; development never registers one.

- **What the device keeps.** The app's own files (cache first), and the
  listings a person browses with: `/api/user/me`, the folder tree, the bin,
  storage use (network first, the stored copy only when the network fails).
  That is names and counts, never a file: pages, PDFs, images and transcripts
  always come from the server, and the To-Do and Digest pages too. Search's
  `sqlite-core.wasm` is kept with the app's files, so a search answers offline
  from what search keeps in IndexedDB (the documents' words and text, the last
  to-dos and digests); the readers' wasm decoders are not, as only reading
  needs them.
- **Forgetting.** Signing out, or the server refusing the session (a 401 or
  403 on any listing), deletes the stored listings and everything else of the
  person's in the browser: the IndexedDB databases built from their library
  (`cache/forget.ts`, `PERSON_DATABASES`) and the one localStorage entry about
  their files. Every store closes its connection when asked
  (`cache/idbLife.ts`), or a delete would wait for ever. The app then reloads
  into sign-in, so nothing held in memory carries over. A sign-out's answer
  also empties the HTTP cache (`Clear-Site-Data: "cache"`); an expired session
  has no answer to do that with. The device's preferences (theme, sort) stay.
  `server-info` is not kept, because the sign-in page reads it.
- **Offline.** The app opens and browses what this device has seen. Opening a
  file, a version, To-Do or Digest says it needs a connection and stays where
  it is (`libraryRoutes.ts`, `offline()`), instead of showing a viewer that
  never fills.
- **Updates.** A new build installs beside the old one and waits. The page
  offers "A new version of Inkhold is ready" with Reload, and only then does
  the new one take over (`src/pwa/register.ts`). It reloads once the new
  worker is `activated`, not on `controllerchange`: a reload while the worker is
  still activating can stall. An installed app looks for updates when it comes
  back to the foreground.
- **Server.** `sw.js` and the manifest are `no-cache`, like every unhashed file
  (`backend/http/static.zig`); the manifest is served as
  `application/manifest+json`.
- **Tests.** `tests/e2e/pwa.spec.ts`, run with
  `npx playwright test -c playwright.pwa.config.ts` against a production build,
  covers the manifest, browsing offline, what is and is not kept, signing out
  and a refused session, opening offline, and the update offer.
