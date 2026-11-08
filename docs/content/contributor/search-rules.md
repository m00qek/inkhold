---
title: "Search"
description: "The index and its manifest, matching, ranking, coverage, find in a document, phrases and excerpts."
weight: 3056
extra:
  reader: contributor
  type: reference
---

# Search

The index and its manifest, matching, ranking, coverage, find in a document, phrases and excerpts. Why they are this way: [Search decisions](@/contributor/search.md).

## Index and manifest

- **There is no server search.** The browser downloads per-document derived
  text and answers every query from a local FTS5 index in `sqlite-core.wasm`.
  The server-side FTS index was removed: it held `db_lock` for 98 s per
  whole-library ingest on the Pi.
- **One tokenizer.** Server and browser share `schema.fts_tokenizer`
  (`unicode61 remove_diacritics 2`); query text goes to the wasm raw. Any
  folding or escaping in JS would be a second tokenizer.
- **The manifest has no tombstones.** It is the caller's complete live document
  set (binary `SMAN`: md5, tier, derivation state, id, time, version) and
  replaces the client's set wholesale; absence is the only deletion. So any
  LIMIT or extra filter is a correctness bug, and truncation is detectable
  (fixed-width row count up front). ETag is the body's md5.
- **Derivation state** separates "derived and empty" from "not derived yet";
  caching the latter's emptiness would make a document unsearchable for ever.
- **Fetch:** the client sends a `want=` bitmap over manifest positions (LSB
  first, canonical base64url) and receives one stitched gzip stream. It must be
  one gzip member: Chromium and curl decode only the first member of a
  concatenated stream and report success (Node decodes all, so Node tests lie).
  Missing fragments are skipped, so the stream is chunked and `no-store`.
- Golden vectors (`manifest_golden.bin`, `want_golden.txt`) are checked by both
  the Zig encoder and the TS decoder; never regenerate one to make a side pass.
## Matching

- **Typo ladder** (in-wasm, Damerau-Levenshtein): only when the exact query has
  zero hits — the corpus is misspelt handwriting recognition. English-oriented
  stemmers/spellfix were rejected (the corpus is Portuguese).
- **To-dos in search** (`todoModel.findTodos`, `todo/todoSearch.ts`): a task
  is found by its title, the notebook and the words it was lassoed from
  (`link_text`, so a renamed task is still found by what was written) and its
  list's name, all together by the name rule; lists named like the query are
  results too. Matched words are marked. When nothing matches as typed, the
  typo ladder's rules (`search/typo.ts`, a browser copy of the wasm one) pick
  the nearest spelling, said as for notes. To-dos are read at start and, while
  the To-Do page is closed, again by a search when over a minute old; an
  answer repaints the open search.
- **One rule for names.** Note and folder names and to-dos are not in the
  index; `webapp/src/search/match.ts` matches them by the index's rule: the
  query's words folded the same way, all present in any order, only the last
  matched as the start of a word. Only when that matches no name at all does
  the typed text match anywhere inside one ("style" in "MyStyle"): a fallback,
  never a widening, like the typo ladder.
## Ranking and excerpts

- **Measured** (`npm run bench:search`, laptop, 2026-11-05; real wasm, libraries
  shaped like the hub's: 45 docs, 231 text pages, 54 distinct words a page).
  A whole rebuild, which every sync that brings anything new costs the next
  search: 4 ms at 1x, 24 ms at 10x (450 docs), 674 ms at 100x (4,500 docs,
  58 MB). Queries stay under 10 ms; a typo-ladder scan is 90 ms at 100x. So the
  rebuild only matters past a few thousand documents; IndexedDB reads are not
  in these numbers.
- **Ranking** (`search/localSearch.ts`): names matched by words first (then,
  only when none did, names matched inside), then documents by relevance:
  matching pages over the document's pages plus two, weighted 1 for what the
  person wrote (notes), 0.8 for a document they wrote on (a `.mark`: its ink
  is not indexed, only the printed words, but it was worked with) and 0.6 for
  a PDF or `.txt` as it came; recency breaks ties. A weight, not an order: a
  document about the words still beats a note that mentions them once. The
  to-dos, also the person's writing, sit before the first document that is
  neither named like the query nor a note. bm25 is not used: the terms are one per page,
  so it can't tell a page about a word from one that mentions it. How close the
  words sit picks a document's excerpt, not its place: ranking by it would read
  every result's text before showing any.
## Coverage

- **Coverage** (`services/search/coverage.zig`, `GET
  /api/controlplane/search-index/coverage`, `pages/searchCoverage.ts`): only
  what the tablet recognized is searchable, so search says how much that is.
  Per live `.note` with writing: pages with writing (`has_ink` not 0, or
  recognized to non-empty text; the tablet also "recognizes" blank pages, to
  nothing), how many were recognized, how many it was still recognizing at
  sync (`RECOGNSTATUS` 2), and whether recognition is on (`FILE_RECOGN_TYPE`).
  One query, asked for by search (at most once a minute), never by listings.
  Shown as a line under results, under "No matches" and while the query is
  too short, opening to the notes search can't fully read and why. The
  tablet's titles and keywords are not indexed; none of the hub's notes had
  any (2026-11-05).
## Find in a document

- **Find in a document** (`pages/viewer/findSession.ts`): one session for
  every viewer; a note, a PDF and a `.txt` bring only a surface (how a
  segment's marks are drawn and a segment brought into view: a page, or a
  paragraph). On the first find the viewer fetches the document's text
  (`text/<md5>`, unless `textPrefetch` already holds it) and builds a one-
  document FTS5 index in the browser; the count is the index's, never the
  marks', and stepping goes match by match ("3 of 12"). It never says "No
  matches" for a search that didn't happen: a note the device never
  recognised, text the server has not extracted yet (a 404 the manifest
  marks `pending`, a job still owing it: "still being indexed", asked again
  every 15 s while the bar is open; a document the manifest doesn't list, a
  bin or version preview, is never promised that), a record with no text (a scanned PDF, an empty file), or
  a failure. A PDF past the server's 5,000-page extraction cap is searched
  in its first 5,000 pages, and the count says so. A typo-tolerant answer
  is held behind "Try similar spellings". Only a move (a landing, a step)
  scrolls the current match into view; a repaint never does. The field is a
  query: no autocorrect, capitals or spellcheck.
## Phrases and excerpts

- **Quoted phrases** (`search/phrase.ts`): `"passé composé"` wants the words
  together, in order. The terms are one set per page, so the index finds the
  candidate pages and the page text decides: library search checks against
  the text the browser holds (`searchService.checkPhrases`), keeping and
  counting, never dropping, a document whose text it doesn't hold ("N results
  couldn't be checked"); in-document find checks the segments it already
  loaded; names and to-dos check their own words. A quote still being typed is
  a phrase whose last word may be a start; a single quoted word is a word.
- **Excerpts** (`search/excerpt.ts`, `pages/searchExcerpts.ts`): a result's
  line is cut in the browser from text it already holds; a search never
  fetches text. After each sync the browser keeps text ahead of time
  (`search/textPrefetch.ts`): every note, then marked documents, then every
  other PDF and `.txt`, newest first, within a 2 MB allowance (a quarter of it
  at most per document). A document too big for it is remembered in
  `localStorage` by text version, so it isn't fetched again only to be refused. Among the first 50 matching
  pages, the shortest stretch holding every query word wins, then words matched
  whole over a typed prefix, then the earliest page; where the typo ladder
  answered, its words are looked for. The result opens on the excerpt's page.
  Lines fill as results scroll into view, after the row is painted, and work
  for a result a newer query replaced is skipped. Measured: 0.2 ms for a
  5-page note, 5.5 ms for a dense PDF at the 50-page cap.
