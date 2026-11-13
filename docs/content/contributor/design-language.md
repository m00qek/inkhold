---
title: "Design language"
description: "The web app's tokens, type, components and the rules every screen follows."
weight: 3070
extra:
  reader: contributor
  type: reference
---

# Design language

The browser app's markup and style rules, and what holds them. Every screen
follows them, and so does this site.

Two end-to-end specs hold the rules. `tests/e2e/semantics.spec.ts` visits
every main screen, on a desktop in both themes and at phone width, and runs
axe-core's WCAG 2.2 AA and best-practice rules plus the structural checks axe
does not make (`helpers/semantics.ts`); both must find nothing.
`tests/e2e/focus.spec.ts` holds that every Tab stop shows its focus.

## Structure

- **Landmarks.** One `<main>` (the content area; the pre-sign-in screens have
  their own), the top bar a `<header>`, the search box a search landmark, the
  rail the navigation landmark ("Library"), and the breadcrumbs a "Breadcrumb"
  navigation. A panel inside `<main>` is a named region, not an aside. A "Skip
  to content" link comes first.
- **Where you are.** One `<h1>` per screen, and the tab's title says the same
  (`ui/place.ts`): a library screen is named by the breadcrumbs' current
  place, a viewer or To-Do names itself. Focus moves to the heading when the
  screen changes, only after the person acted and never while they are typing.
  Sections are `<h2>`s.
- **Links and buttons.** Anything that goes somewhere is an `<a href>`: it
  opens in a new tab and says where it leads, and a plain click still runs the
  app's own action (`ui/link.ts`). A button is an action. A place with no
  address (a category the tablet has not created) is a button marked
  `data-no-address`.
- **Collections are lists.** Gallery cards are `<li>`s in `ul.cards`, which is
  `display: contents` so each card stays a grid cell (`masonry.ts` looks
  inside).
- **A repaint keeps your place.** The gallery is rebuilt whenever an answer
  lands (search results fill in by phases), so the rebuild gives focus back to
  the same control (`ui/dom.ts`, `keepingFocus`: a link by where it leads), and
  a disclosure the person opened stays open, read from the element rather than
  from its late `toggle` event.

## One design language

`tests/e2e/designLanguage.spec.ts` holds that the same thing looks and sits the
same on every screen.

- Every folder is the tablet's folder silhouette (`thumb--folder-shape`), a
  pinned category with its glyph inside; files are sheets.
- A tablet app lives in the browser one way, To-Do's: its fixed views are
  rows under it in the rail, its own places (To-Do's lists, Digest's
  categories and sources) an overview of cards (`ui/appCard.ts`), each with
  its **⋯**, and the top bar names the place and holds its tools (**+** where
  places are made, **⋯** for the one on screen), with **‹** before the name
  going up to the overview, named for it, as a viewer's does (the phone's ‹
  sits in ☰'s place). On a desktop a Digest list opens with its first digest
  beside it, in place of the list's history entry, so Back still leaves the
  list; one the person closed stays closed when they come back to it. A
  Digest category has a glyph of its own: the folder glyph is for folders.
  An item's **Move to…** is one builder (`ui/moveTo.ts`): every place but
  its own, then **New …** that makes a place and moves the item into it.
- An app's page sits where To-Do's does (its padding, its 760px centred
  column, the overview's cards in it). A list is one sheet of ruled rows with
  square corners, as To-Do's tasks, search's results and the bin are; the open
  row carries the rail's accent stroke. Where an open item has a panel beside
  the list, a desktop keeps the panel's place, empty or not, so opening and
  closing moves nothing. Handwriting in a row is To-Do's framed chip.
- Something deleted goes to the bin the one way, with the bin's toast: the
  device line and **Undo**, a digest as a file.
- One recycle bin: what an app deletes (a digest) waits there beside the
  files, by the day it went.
- A file's type in text is its extension (`core/fileKind.ts`,
  `fileTypeLabel`: `.note`, `.pdf`), never upper-cased; only the large
  placeholder mark shouts.
- A viewer's subtitle is the file's folder when it was opened from elsewhere
  (`originSubtitle`), then the page count for a paged document, or the type and
  size.
- A viewer's file actions run in one order: history, download, the bin. Every
  viewer puts focus on ‹ when it opens.
- A place in the shell that is not a folder reads "Library / place" (the bin,
  your account, the admin console). Search reads "Search" and highlights no
  folder in the rail, since results span the library. To-Do and Digest, the
  tablet's apps, title themselves.
- Buttons speak in sentence case everywhere; capitals are for small labels.
- On a phone, a top bar's buttons are quiet glyphs (‹ ☰ 🔍 ⋯), framed only in
  the bottom bar's controls. The Search tab on a page without a search box goes
  to search, and a query left in the box never blanks a title.

## Accessibility

- **Announcements** are small status regions that hold only the message, never
  the buttons beside it. Icons are hidden from screen readers: `svg()` emits
  `aria-hidden`.
- **Targets** are at least 24px with a mouse and 44px on a touch screen.
  `pointer: coarse` grows the control tokens, and a zero-specificity rule gives
  anything pressable a minimum.
- **Toggles** say their state with `aria-pressed` and show it: on is filled
  with ink and the icon in the paper colour, off has no fill, so the two never
  differ by a shade of grey. Never the accent: that is the focus ring, and a
  focused button must not look switched on. A menu trigger's open state
  (`aria-expanded`) keeps the quieter outline.
- **Contrast** is 4.5:1 for all text in both themes; the soft and faint greys
  are tuned to it on every surface they sit on.

## Styles and proof

- **Styles** (`scripts/lint-styles.mjs` enforces): sizes come from tokens;
  type, spacing and control heights are in rem, so they follow the reader's
  text size, with touch minimums keeping a floor in px; start and end, never
  left and right; z-index only from the `--z-…` scale; colours and shadows only
  from tokens; no class the app never sets (the few built at runtime are
  listed). The breakpoints are the set written in `00-tokens.css`: a phone
  below 700px, a tablet to 1099px, a desktop from 1100px.
- **Pixel proof.** `VISUAL_DIR=<dir> npx playwright test visual` and
  `scripts/visual-diff.sh <before> <after>` show that a change which must move
  nothing moved nothing.
- **Engines.** Chromium runs everything; `E2E_BROWSER=webkit` runs Safari's
  engine, which every iPhone browser uses, in a Debian or Ubuntu container
  ([Run long test jobs in a container](@/contributor/tests-in-a-container.md)).
