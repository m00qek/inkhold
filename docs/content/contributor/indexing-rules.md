---
title: "Indexing and derived data"
description: "The .note index, index_version, the derived stores, and what each format yields."
weight: 3052
extra:
  reader: contributor
  type: reference
---

# Indexing and derived data

What the server derives from each file and the rules it keeps while doing so:
the `.note` index, `index_version`, the derived stores, and what each format
yields. Why it is this way: [How indexing works](@/contributor/indexing.md).

## The `.note` index

- Parse with the lock released, write with it held. Parsing is pure CPU over
  addressed ranges of the file (a 40 MB note allocates kilobytes); the rows are
  written inside the caller's transaction.
- Rows are keyed by the blob's md5, so they are never stale and every
  deduplicated copy of a file shares them. Any read joins through `files` for
  ownership.
- The index heals itself; there are no backfill migrations. A missing row, or
  one at an old `index_version`, is parsed again on read. Two concurrent heals
  are harmless, because every write is an upsert.
- A landscape page (`ORIENTATION = 1090`) stores its raster in landscape; the
  effective dimensions are stored per page. A wrong width shears the image
  silently.

## `index_version`

The browser caches derived text under `(md5, index_version)`. Bump the version
**only** when what that key names changes, which is the content of the derived
`terms/` and `text/` files. A bump re-derives every document. A new column
whose derived bytes are unchanged does not bump it: it heals through a tenant
instead.

## Derived stores

- The `terms/` and `text/` files carry `index_version` in their names. A
  database column may cache whether one exists, but is never the authority. A
  crash between writing the new version and retiring the old leaves both, which
  is safe.
- They are stored as raw-deflate fragments with a CRC and a length up front,
  `flush()`ed without `BFINAL`, so that fragments concatenate into one stream
  ([Search](@/contributor/search-rules.md)).
- Thumbnails are not blobs. They are keyed by their source's md5, so they die
  with it. They are `fsync`ed before the rename even though they are a cache:
  ext4 can persist a zero-length file.
- The server serves only the images a file already carries: an `.spd`'s
  thumbnail, a `.note`'s user cover. A cover's position is found at index time
  and the bytes are streamed, never buffered.

## What each format yields

- **`.note`:** text comes from the tablet's own recognition (`RECOGNTEXT`;
  there is no OCR), derived at upload. `has_ink` has three states, and NULL
  means a layer not yet read. The background layer never counts as ink; a
  hidden layer does.
- **PDF:** every MuPDF call is made from C, because `fz_try` is
  setjmp/longjmp and a Zig frame between them is undefined behaviour. One
  tenant does the probe and then the text, because each blob is offered once
  per drain. The probe caps MuPDF's store at 8 MB; the text pass caps it at
  4 MB and reopens the document every 32 pages, which keeps it inside the
  server's 50 MB. Either way the cache stays well under the ceiling below, so
  HarfBuzz, which cannot make MuPDF empty it, always has room. A page's shape is
  `fz_bound_page`, never the raw `/MediaBox`. Private Use Area glyphs become
  spaces, because the tokenizer treats them as word characters. Extraction
  stops at 5,000 pages and records that it was truncated.
- **XPS and CBZ:** the PDF tenant's, through MuPDF's XPS and CBZ handlers
  (`pdf_index.extensions`). Only these three handlers are registered, so a
  book that reflows (EPUB, FB2) is never laid out on the server: one named
  `.epub` is refused by its extension, and one renamed `.pdf` is a zip, which
  MuPDF's CBZ handler opens as the images it holds, or not at all. Whether a file gets a text pass goes by its name too: a CBZ's
  pages are images, so it gets only a header-only pair and the "no text"
  verdict, without being read.
- **Every MuPDF context runs in a memory pool of its own, under a ceiling**
  (`backend/pdf/pool.zig`, 32 MiB of the whole server's 50 MB): every
  allocation MuPDF and its libraries make comes from the pool, which counts
  the pages it maps from the system, and one past the ceiling is refused, so
  MuPDF evicts its cache and retries, then fails. When the context is dropped,
  the pool unmaps all of it. Whatever a file holds (a zip entry read whole, a
  decompression bomb, a huge image or font, a page of a hundred thousand small
  objects), it costs at most the ceiling while it is read, and nothing after.
  HarfBuzz, which MuPDF calls to shape text, is the one exception to the pool:
  it keeps a few hundred bytes in statics for the life of the process, so its
  blocks come from `malloc`, still counted against the ceiling
  (`backend/pdf/budget.c`). Opening that fails at the ceiling, or that MuPDF
  got through only by going without memory it was refused (a page count read
  that way is not the file's), is the `too_large` verdict for the probe or the text pass; so is the text pass when
  a page's text needed more than the ceiling and MuPDF went on without it (a
  refusal its retry got past costs nothing), and those pages are left out of
  search (the rest are kept). A failure the ceiling did not cause stays the file's (`unopenable`,
  `encrypted`), and one where the C library had no memory is ours, retried.
  Before any of it, `pdf_index.gate` sends MuPDF a file named `.pdf` (which
  MuPDF repairs, with or without a header), or a file whose bytes are a PDF
  (`%PDF-` in the first 4 KB, as MuPDF looks) or a zip, and refuses the rest
  (a tar, an OLE file) as `unopenable`. Whatever passes, only a zip is opened
  by its content; anything else is read as a PDF (`backend/pdf/open.h`), so a
  tar or an OLE file named `.pdf` never reaches MuPDF's archive readers. Only
  a file the probe passed is ever opened again.
- **`.txt`:** paragraphs, split at blank lines and capped near 8 KB, each
  addressed by its byte range into the raw blob. Search's requirement that
  every word match applies per paragraph.
- **`.spd`:** parsed once per blob. A parse failure is remembered as
  `indexable = 0`.
