---
title: "Search decisions"
description: "Why search runs in the browser, why one tokenizer, and why weights instead of bm25."
weight: 4070
extra:
  reader: contributor
  type: explanation
---

# Search decisions

Why search runs in the browser, how results are ranked, and what was left out. The rules themselves: [Search](@/contributor/search-rules.md).

## Decisions

### There is no server search

**Problem.** A server-side full-text index held the database lock for 98 s per whole-library ingest on the Pi.

**Decision.** The browser downloads each document's derived text once and answers every query from a local FTS5 index in `sqlite-core.wasm`.

**Cost.** The first search after a sync fetches text; each browser holds its own copy.

**Revisit when** libraries grow past a few thousand documents, where the browser's rebuild starts to show.

### One tokenizer

**Problem.** Two tokenizers, one on each side, would disagree on what a word is.

**Decision.** Server and browser share `unicode61 remove_diacritics 2`; query text reaches the wasm raw.

**Cost.** No language-aware stemming.

**Revisit when** a language's search needs stemming.

### Weights, not bm25

**Problem.** The index holds one set of terms per page, so bm25 can't tell a page about a word from one that mentions it.

**Decision.** Matching pages over the document's pages, weighted by what the person wrote: notes over marked PDFs over other files; recency breaks ties.

**Cost.** A hand-tuned rank.

**Revisit when** the index stores positions. The rules themselves: [Search](@/contributor/search-rules.md).
