---
title: "Serving decisions"
description: "Why a response is planned then streamed, and when a response may be immutable."
weight: 4060
extra:
  reader: contributor
  type: explanation
---

# Serving decisions

How pages and files are served and cached, and why. The rules themselves: [Serving and caching](@/contributor/serving-rules.md).

## Decisions

### Plan, then stream

**Problem.** A page or a file must never be held whole in the server's memory on a Pi.

**Decision.** A response is planned from the index alone (exact length, ETag), then streamed from the blob in 64 KB windows with the database lock released.

**Cost.** Every byte route needs a plan, and its own lock discipline.

**Revisit when** never.

### Immutable only when the key covers everything

**Problem.** A cached response that can change under its key pins wrong data for a year.

**Decision.** `immutable` only when the cache key covers every byte that can change; JSON around opaque bytes is `no-cache`.

**Cost.** Some responses revalidate that rarely change.

**Revisit when** never. The rules themselves: [Serving and caching](@/contributor/serving-rules.md).
