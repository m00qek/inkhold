---
title: "File types"
description: "Which files open in the browser, which are searchable, and what each exports to."
weight: 3030
extra:
  reader: operator, household
  type: reference
---

# File types

What Inkhold does with each kind of file the tablet syncs. Every file syncs,
downloads and goes to the recycle bin; the difference is what the browser can
show of it.

| File | Opens in the browser | Searchable | Download as |
|---|---|---|---|
| Notebook (`.note`) | Page by page, with layers and recognised text | Its recognised handwriting | `.png`, `.ora` or `.pdf` per page; the whole notebook as `.pdf`; the original `.note` |
| PDF (`.pdf`) | With its outline, selectable text, and your handwriting on it (`.mark`) | Its own text, not your handwriting | `.png` or `.ora` per page, with your handwriting; the original `.pdf` |
| Sketch (`.spd`) | With its layers and their opacity | No | `.png` or `.ora`; the original `.spd` |
| Text (`.txt`) | As text, with its own size control | Its text | The original |
| Image (`.png`, `.jpg`, `.webp`, `.gif`) | As an image | Its name only | The original |
| EPUB, Office documents and anything else | No viewer | Its name only | The original |

Every file's name is searchable. Version history keeps earlier versions of
every file; notebooks, sketches, text files and images can be previewed there.

Why some handwriting isn't searchable: [What doesn't work yet](@/manual/limits.md).
