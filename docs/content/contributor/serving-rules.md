---
title: "Serving and caching"
description: "How a page is planned and streamed, the cache rule, and the live channel."
weight: 3054
extra:
  reader: contributor
  type: reference
---

# Serving and caching

How a page is planned and streamed, the cache rule, and the live channel. Why they are this way: [Serving decisions](@/contributor/serving-and-caching.md).

## Pages

- A page response is planned from the index alone (`pagePlan`: exact
  `Content-Length`, ETag = stored content hash) and then streamed from the blob
  with the lock released. Peak heap stays under one chunk.
- The page `?v=` hash covers layer bitmaps only; recognition text and template
  links have their own hashes because they change without the strokes changing.
- SNPG (our page envelope) is versioned in band; bumping it must also move the
  `?v=` domain.

## Cache rule

`immutable` only when the cache key covers everything that can change. A
content hash covers opaque bytes; it never covers a JSON struct serialised
around them (page text was once immutable and pinned responses without `words`
for a year). Struct-serialised bodies are `no-cache`. `index.html` is
`no-cache`; `/assets/*` is immutable.

## Live channel

SSE on `/api/controlplane/events` carries `event: sync` (the per-user sync
version, polled server-side every 500 ms) and `event: index` (pending count).
Held streams are admission-controlled (16 total, 4 per user) and degrade to a
one-shot frame plus `retry:`, never a 503.
