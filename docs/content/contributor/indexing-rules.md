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
  per drain. The text pass caps MuPDF's store at 4 MB and reopens the document
  every 32 pages, which is what keeps the 50 MB budget. A page's shape is
  `fz_bound_page`, never the raw `/MediaBox`. Private Use Area glyphs become
  spaces, because the tokenizer treats them as word characters. Extraction
  stops at 5,000 pages and records that it was truncated.
- **`.txt`:** paragraphs, split at blank lines and capped near 8 KB, each
  addressed by its byte range into the raw blob. Search's requirement that
  every word match applies per paragraph.
- **`.spd`:** parsed once per blob. A parse failure is remembered as
  `indexable = 0`.
