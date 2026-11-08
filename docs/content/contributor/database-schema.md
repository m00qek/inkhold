---
title: "Database schema"
description: "Every table and column, and the migrations that made them."
weight: 3040
extra:
  reader: contributor
  type: reference
---

# Database schema

The rules of the schema and its migrations. The tables themselves are in
`backend/db/schema_ddl.zig`, one step per version, and each table's owner is
listed in [Where things live](@/contributor/where-things-live.md).
[Add a database migration](@/contributor/migration.md) is the how-to.

- Version 1 is the verbatim schema of an install that had been migrated the
  long way, so a fresh database and a migrated one are byte-identical; a test
  compares their `sqlite_master`. Never edit `ddl_v1`. An additive change lives
  in a step of its own.
- A data step that changes what an already-shipped version produced gets a new
  version. A step folded into an applied version never runs. That
  `steps.len == version` is checked at compile time.
- Each step and its `user_version` stamp are one `BEGIN IMMEDIATE`
  transaction. A partial step once left an install unable to boot.
- A verdict column (`pdf_probe`, `pdf_text`, `txt_index`, `has_ink`) is
  nullable, and NULL means "not looked at yet", which is exactly what the
  background worker's tenants select ([Threads and locks](@/contributor/threads-and-locks.md)).
- Some indexes are load-bearing by query plan: `files_live_name` is named in an
  `INDEXED BY`, and others are pinned by tests that check the VM's steps.
