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
  folder in the rail, since results span the library. To-Do, an app, titles
  itself.
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
