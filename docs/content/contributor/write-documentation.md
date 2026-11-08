---
title: "Write documentation"
description: "Add or change a page, preview it, draw a diagram, and take its screenshots."
weight: 2080
extra:
  reader: contributor
  type: how-to
---

# Write documentation

Add or change a page of this site. The rules every page follows are in
[Documentation rules](@/contributor/documentation-rules.md).

## Preview as you write

```sh
make docs          # http://127.0.0.1:1111, reloading as you save
```

## Add a page

1. Choose its reader (`operator`, `household` or `contributor`) and its type
   (tutorial, how-to, reference or explanation), and so its folder:
   `docs/content/manual/` or `docs/content/contributor/`.
2. Create the file with its front matter:

   ```yaml
   ---
   title: "Restore a deleted note"
   description: "Bring a deleted notebook back from the recycle bin."
   weight: 2150
   extra:
     reader: household
     type: how-to
   ---
   ```

   The weight places it: thousands by type (1000s tutorials, 2000s how-to,
   3000s reference, 4000s explanation), then its order among them.
3. Start the page with `# The title`, then the sentence that says what it is
   for. Use the app's labels in bold, exactly as on screen.

A page planned but not written yet carries `stub: true` under `extra`.

## Diagrams

A fenced `mermaid` block, top to bottom (`flowchart TD`), with a sentence
before it saying what it shows. The site draws it in both themes.

## Screenshots

From the app, by script, never by hand:

```sh
cd webapp && npm run screenshots
```

`tests/screenshots/shots.spec.ts` lists them; each is taken in both themes into
`docs/static/screenshots/`. Add one there, then show it on a page as a
Markdown image alone in its paragraph, with alt text that says what matters in
it:

```markdown
![The recycle bin, with the days each file has left.](screenshots/bin.png)
```

The build turns it into the light and dark versions; the page's theme shows one.

The tablet's own screens are the one exception: no script reaches them. With
the tablet on USB, open the screen and capture it over `adb`, cropped to the
part that matters, in grey:

```sh
adb exec-out screencap -p > full.png
magick full.png -crop 999x440+405+0 +repage -colorspace Gray -strip \
  docs/static/screenshots/tablet-private-cloud.png
```

A name starting `tablet-` is one picture, shown in either theme in the
tablet's bezel. Only open screens to look at them: don't log out, change a
setting or start a sync on a tablet that holds real notes.

## Generated pages

**config.zon settings**, **Command line** and **HTTP API** are written by
`docs/tools/generate.mjs` from the code. Change the code (its comments, its
help text, its route table), never the page.

## Before you commit

```sh
make -C docs test
```

Every page at four widths, light and dark: accessibility, no sideways scroll,
target sizes, line length. The docs CI runs it too, and fails a generated page
that no longer matches its source.
