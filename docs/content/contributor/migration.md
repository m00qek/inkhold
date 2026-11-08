---
title: "Add a database migration"
description: "Change the schema with a migration that upgrades every existing library."
weight: 2040
extra:
  reader: contributor
  type: how-to
---

# Add a database migration

Change the schema with a step that upgrades every existing library on its next
start. The rules behind each step are in [Database schema](@/contributor/database-schema.md).

1. In `backend/db/schema_ddl.zig`, add the next step after the last one, as
   `ddl_vN`: the SQL that takes a version-(N−1) database to version N.
   Additive where possible: a new table, a nullable column, an index.
   **Never edit an applied step**, `ddl_v1` above all: a database that already
   ran it never runs it again, so the change would reach only new installs.
2. In `backend/db/schema.zig`, name it (`const ddl_vN = schema_ddl.ddl_vN;`)
   and append it to `steps`. The list's length is the schema version, checked
   at compile time.
3. A column that stores a verdict ("not looked at yet" versus an answer) is
   nullable, `NULL` meaning not looked at: the background worker's jobs select
   exactly those rows ([Indexing and derived data](@/contributor/indexing.md)).
4. Test it in `backend/db/schema_test.zig`: a fresh database and one migrated
   from the previous version must end up identical, and a step that moves data
   needs a test with data in it.
5. Run `make test`. On the next start, every library runs the new step in one
   transaction with its version stamp, so a failed step leaves the database as
   it was.

A step that changes what an already-shipped step produced gets a new version
of its own: folded into an applied one, it would never run.
