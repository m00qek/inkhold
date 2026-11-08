---
title: "Indexing and derived data"
description: "The .note index, index_version, the derived stores, and what each format yields."
weight: 3052
extra:
  reader: contributor
  type: reference
---

# Indexing and derived data

The .note index, index_version, the derived stores, and what each format yields. Why they are this way: [Indexing decisions](@/contributor/indexing.md).

## `.note` index

- Parse unlocked, write locked: parsing is pure CPU over addressed ranges
  (kilobytes allocated for a 40 MB note); rows are written in the caller's
  transaction.
- Rows are keyed by blob md5, so they are never stale and are shared by every
  deduped file; any read joins through `files` for ownership.
- Self-healing, no backfill migrations: a missing row or one at an old
  `index_version` is re-parsed on read. Concurrent heals are harmless (upserts).
- Landscape pages (`ORIENTATION = 1090`) store their raster natively landscape;
  effective dimensions are stored per page. Wrong width shears silently.

## `index_version`

The browser caches derived text under `(md5, index_version)`. Bump it **only**
when what that key names changes (the derived `terms/` and `text/` files). A
bump re-derives every document. A new column with unchanged derived bytes does
not bump (it heals through a tenant instead).

## Derived stores

- `terms/` and `text/` files carry `index_version` in their name; a DB column
  may cache existence but is never the authority. A crash between writing the
  new version and retiring the old leaves both, which is safe.
- Stored as raw-deflate fragments with CRC and length up front, `flush()`ed
  (no BFINAL) so they concatenate ([§10](@/contributor/search-rules.md)).
- Thumbnails are not blobs: keyed by source md5 so they die with it. fsync
  before rename even for a cache (ext4 can persist a zero-length file).
- The server only serves images files already carry (`.spd` thumbnail, a
  `.note` user cover); covers are located at index time and streamed, never
  buffered.

## Per format

- **`.note`:** text comes from the device's own recognition (`RECOGNTEXT`, no
  OCR), derived at upload. `has_ink` is tri-state (NULL = unread layer); the
  background never counts, a hidden layer does.
- **PDF:** all MuPDF calls are in C (`fz_try` is setjmp/longjmp; a Zig frame in
  between is UB). One tenant does probe then text, because each blob is offered
  once per drain. The text pass caps MuPDF's store at 4 MB and reopens every 32
  pages — what makes the 50 MB budget close. Page shape is `fz_bound_page`,
  never raw `/MediaBox`. Private Use Area glyphs become spaces (the tokenizer
  treats them as word characters). Capped at 5,000 pages, recorded as truncated.
- **`.txt`:** paragraph segments (blank-line split, ~8 KB cap), addressed by
  byte range into the raw blob; search AND-semantics are per paragraph.
- **`.spd`:** parsed once per blob; a parse failure is a memoised
  `indexable = 0`.
