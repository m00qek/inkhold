---
title: "Database schema"
description: "Every table and column, and the migrations that made them."
weight: 3040
extra:
  reader: contributor
  type: reference
---

# Database schema

The rules of the schema and its migrations. The tables themselves are in `backend/db/schema_ddl.zig`, each version a step; [Add a database migration](@/contributor/migration.md) is the how-to.

- v1 is the verbatim schema of a long-way-migrated install, so fresh and
  migrated databases are byte-identical (a test compares `sqlite_master`).
  Never edit `ddl_v1`; additive changes live in their own step.
- A data step that changes a shipped version's outcome gets a new version — a
  step folded into an applied version never runs. `steps.len == version` is
  checked at comptime.
- Each step and its `user_version` stamp is one `BEGIN IMMEDIATE` transaction;
  a partial step once bricked boot.
- Verdict columns (`pdf_probe`, `pdf_text`, `txt_index`, `has_ink`) are
  nullable, NULL meaning "not looked at yet" — exactly what the worker's tenants
  select ([§3.4](@/contributor/threads-and-locks.md#deferred-work)).
- Some indexes are load-bearing by plan (`files_live_name` is named in an
  `INDEXED BY`; others are pinned by VM-step tests).
