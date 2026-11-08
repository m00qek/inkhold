---
title: "Concurrency decisions"
description: "Why the server uses these threads and locks, and what it gave up."
weight: 4030
extra:
  reader: contributor
  type: explanation
---

# Concurrency decisions

Why the server's threads and locks are the way [Threads and locks](@/contributor/threads-and-locks.md) describes.

## Decisions

### Threads follow requests, not sockets

**Problem.** A browser keeps about six sockets per tab open; a thread per socket would spend the Pi's memory on idle connections.

**Decision.** Idle sockets are parked with one poller thread; a small fixed pool of workers serves whatever is readable. Only a held stream (the live channel) gets a thread, capped.

**Cost.** A poller and a handover add a little latency, and the pool size is a tuning number.

**Revisit when** a household's connections stop fitting in the pool's latency, which the footprint check would show.

### One writer, serialised by one lock

**Problem.** SQLite has one writer; several write connections would only contend.

**Decision.** One shared writer connection, held by `db_lock` around a whole handler. Streaming routes lock only around their own database touches.

**Cost.** The lock is not reentrant, and a long handler blocks every other write.

**Revisit when** write latency, measured by the lock histograms, grows past what a household notices.

### A pool of readers

**Problem.** With one shared connection, a 3.4 s search on the Pi blocked everything.

**Decision.** WAL readers from a pool of three, borrowed per operation, for routes flagged `read_only`; when the pool is empty, the writer serves.

**Cost.** The `read_only` flag is a claim about a whole call path and must stay true; an integration audit checks it.

**Revisit when** never on a household's scale.

### Indexing waits for a worker

**Problem.** Indexing on the upload path held the connection for up to a minute on the Pi.

**Decision.** One background worker at the lowest priority works through a job store that is a query, not a queue: each kind of job is a WHERE naming blobs that still owe work. Restart-safe and idempotent, with no claims or status column.

**Cost.** Search and thumbnails lag an upload by however long the worker takes.

**Revisit when** a household waits visibly for indexing.
