---
title: "Serving and caching"
description: "How a page is planned and streamed, the cache rule, and the live channel."
weight: 3054
extra:
  reader: contributor
  type: reference
---

# Serving and caching

How a page is planned and streamed, when a response may be cached as
immutable, and the live channel. Why: [How a request is served](@/contributor/concurrency-decisions.md).

## Pages

- A page response is planned from the index alone: `pagePlan` gives the exact
  `Content-Length` and the ETag, which is the stored content hash. The bytes
  are then streamed from the blob with the lock released, so the peak heap
  stays under one 64 KB chunk.
- A page's `?v=` hash covers its layer bitmaps only. Recognised text and
  template links have hashes of their own, because they change without the
  strokes changing.
- SNPG, the page envelope Inkhold serves, carries its version in band. Bumping
  it must also move the `?v=` domain, or browsers would keep old envelopes.

## The cache rule

A response is `immutable` only when its cache key covers everything that can
change. A content hash covers opaque bytes; it never covers a JSON structure
serialised around them. Page text was once immutable, and pinned responses
without their `words` for a year. So a body that serialises a structure is
`no-cache`. `index.html` is `no-cache`; `/assets/*` is immutable.

## The live channel

Server-sent events on `/api/controlplane/events` carry two events:
`event: sync`, the person's sync version, which the server polls every 500 ms,
and `event: index`, the count of files still being indexed. Held streams are
admission-controlled, 16 in all and 4 per person; past that, a request gets a
one-shot frame and a `retry:` hint, never a 503.
