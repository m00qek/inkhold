---
title: "Design language"
description: "The web app's tokens, type, components and the rules every screen follows."
weight: 3070
extra:
  reader: contributor
  type: reference
---

# Design language

The browser app's markup and style rules, and what holds them. Every screen follows them, and so does this site.

Held by `tests/e2e/semantics.spec.ts` (every main screen, at desktop in both
themes and at phone width): axe-core's WCAG 2.2 AA and best-practice rules,
plus the structure axe doesn't judge (`helpers/semantics.ts`). Both must find
nothing. `tests/e2e/focus.spec.ts` holds that every Tab stop shows focus.

## Structure

- **Landmarks:** one `<main>` (the content area; pre-auth screens have their
  own), the top bar a `<header>`, the search box a search landmark, the rail
  the navigation landmark ("Library"), breadcrumbs a "Breadcrumb" navigation.
  Panels inside `<main>` are named regions, not asides. A "Skip to content"
  link comes first.
- **Where you are:** one `<h1>` per screen, and the tab's title with it
  (`ui/place.ts`): library screens are named by the breadcrumbs' current
  place, a viewer or To-Do by itself. Focus moves to the heading on a change of
  screen, only after the person has acted and never while typing. Sections
  are `<h2>`s.
- **Links and buttons:** anything that goes somewhere is an `<a href>` (it
  opens in a new tab, says where it leads); a plain click still runs the app's
  own action (`ui/link.ts`). Buttons are actions. A place with no address (a
  category the tablet hasn't created) is a button marked `data-no-address`.
- **Collections are lists.** Gallery cards are `<li>`s in `ul.cards`, which is
  `display: contents` so each card stays a grid cell (`masonry.ts` looks
  inside).
- **A repaint keeps your place.** The gallery is rebuilt whenever an answer
  lands (search results fill in by phases), so the rebuild gives focus back
  to the same control (`ui/dom.ts` `keepingFocus`: a link by where it leads),
  and a disclosure the person opened stays open, read from the element, not
  from its late `toggle` event.
## One design language

- **One design language** (`tests/e2e/designLanguage.spec.ts`): the same
  thing looks and sits the same on every screen.
  - Every folder is the device's folder silhouette (`thumb--folder-shape`), a
    pinned category with its glyph inside; files are sheets.
  - A file's type in text is its extension (`core/fileKind.ts`
    `fileTypeLabel`: `.note`, `.pdf`), never upper-cased; only the big
    placeholder mark shouts.
  - A viewer's subtitle is the file's folder when it was opened from elsewhere
    (`originSubtitle`), then pages for a paged document or type and size.
  - A viewer's file actions run: history, download, the bin. Every viewer puts
    focus on ‹ when it opens.
  - A place in the shell that isn't a folder reads "Library / place" (the bin,
    your account, the admin console); Search reads "Search" and highlights no
    rail folder, since results span the library; To-Do, an app, titles itself.
  - Buttons speak in sentence case everywhere; capitals are for small labels.
  - On a phone, a top bar's buttons are quiet glyphs (‹ ☰ 🔍 ⋯), framed only
    in the bottom bar's controls; the Search tab on a page without a search
    box goes to search, and a query left in the box never blanks a title.
## Accessibility

- **Announcements** are small status regions holding the message only, never
  the buttons beside it. Icons are hidden from screen readers (`svg()` emits
  `aria-hidden`).
- **Targets:** at least 24px with a mouse and 44px on a touch screen
  (`pointer: coarse` grows the control tokens; a zero-specificity rule gives
  anything pressable a minimum).
- **Toggles** say their state with `aria-pressed`, and show it: ON is filled
  in ink with the icon in the paper colour, OFF has no fill, so the two never
  differ by a shade of grey. Never the accent: that is the focus ring, and a
  focused button must not look switched on. A menu trigger's open state
  (`aria-expanded`) stays the quieter outline.
- **Contrast:** 4.5:1 for all text in both themes; the soft and faint greys
  are tuned to it on every surface they sit on.
## Styles and proof

- **Styles** (`scripts/lint-styles.mjs` enforces): sizes from tokens; type,
  spacing and control heights in rem (they follow the reader's text size;
  touch minimums keep a px floor); start/end, never left/right; z-index only
  from the `--z-…` scale; colours and shadows only from tokens; no class the
  app never sets (the few built at runtime are listed). Breakpoints are the set
  written in `00-tokens.css`: phone below 700px, tablet to 1099px, desktop
  from 1100px.
- **Pixel proof:** `VISUAL_DIR=<dir> npx playwright test visual` and
  `scripts/visual-diff.sh <before> <after>` show a change that must move
  nothing moved nothing.
- **Engines:** Chromium runs everything; `E2E_BROWSER=webkit` runs Safari's
  engine (every iPhone browser) on devlab's inkhold-ci, since WebKit needs
  Debian/Ubuntu libraries.
