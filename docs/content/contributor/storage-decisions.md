---
title: "Storage decisions"
description: "Why Inkhold never deletes outright, and how the bin and versions follow."
weight: 4020
extra:
  reader: contributor
  type: explanation
---

# Storage decisions

Why the library is stored the way [Storage layout](@/contributor/storage.md) describes.

## Decisions

### Files are named by their content

**Problem.** Files arrive from tablets that retry, from the browser and from restores; the same notebook often exists twice.

**Decision.** Every file is a blob named by its md5, written to a temp file, fsynced, checked, then renamed. A name is its hash, so an existing blob is known-good and never overwritten, and two identical files share one blob.

**Cost.** A blob's name says nothing about its file; only a `files` row does, so every read goes through ownership (`Files.get`), and quota must count distinct blobs, not files.

**Revisit when** never: it is what makes crashes, retries and backups simple.

### Blob before commit, garbage collection after

**Problem.** A crash between writing bytes and recording them must not leave a row pointing at nothing.

**Decision.** Bytes reach the disk before the transaction that references them commits, and leave only after the transaction that drops the last reference. `reapIfUnreferenced` is the one gate.

**Cost.** A crash can orphan a blob, swept later: some wasted disk for a while.

**Revisit when** never.

### Deleting is two stages

**Problem.** A tablet deletes what it believes was deleted in the cloud; a mistaken delete must be recoverable.

**Decision.** `trash` only marks a row and keeps every reference; `purge`, `emptyBin` and the retention sweep are the only real deletions. Restore is a flag flip, and the window is never retroactive: shortening it never purges a month at once.

**Cost.** Trashed files keep counting against their owner's quota until they go.

**Revisit when** never: it is the product's promise ([Why nothing is deleted outright](@/manual/never-deletes.md)).

### History gives way before an edit does

**Problem.** Refusing a tablet's upload mid-sync is worse than losing an old version.

**Decision.** Under quota pressure an edit evicts the writer's own oldest history-only versions instead of being refused; the install-wide ceiling evicts only the writing user's versions too.

**Cost.** Someone near their allotment keeps fewer versions than the setting promises.

**Revisit when** quota pressure becomes common, and people want to choose what goes.

### Backups are plain files

**Problem.** A household backs up to whatever it has (a NAS share, a USB disk, a Dropbox folder) and never reads cron mail.

**Decision.** A shared store of blobs plus one folder per snapshot, each complete on its own; no packing, no links, nothing a sync client can't carry. Every run is recorded so the library can warn admins when backups stop.

**Cost.** No encryption and no deduplication beyond whole files: a backup is as private as the folder it sits in.

**Revisit when** households ask for encrypted or off-site backups.
