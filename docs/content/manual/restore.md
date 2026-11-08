---
title: "Restore from a backup"
description: "Bring the whole library back to a snapshot."
weight: 2070
extra:
  reader: operator
  type: how-to
---

# Restore from a backup

Bring the whole library back to a snapshot: every notebook, account and
setting, as they were when the snapshot was taken.

**First, back up each tablet.** A tablet that syncs with a server older than
itself deletes the files the server does not have. Inkhold guards against
that (below), but a copy of the tablet is still the safe way.

## With the binary

Onto a fresh install, with the server stopped:

```sh
inkhold restore /mnt/nas/inkhold                     # the newest snapshot
inkhold restore /mnt/nas/inkhold 2026-11-04T030000Z  # a given one
```

`inkhold backup list /mnt/nas/inkhold` lists the snapshots.

## In Docker

With the server's container stopped, onto a new volume:

```sh
docker run --rm -v inkhold-new:/var/lib/inkhold \
  -v /mnt/nas/inkhold-backup:/backup \
  ghcr.io/m00qek/inkhold:latest restore /backup
```

Then start the server with `inkhold-new` as its volume.

## After the restore

- **A restored library has a new identity.** Each tablet notices at its next
  sign-in and syncs from scratch, uploading what the server lacks rather than
  deleting it. If the tablet asks how to treat its digest and to-do data,
  choose **Retain locally**.
- On each tablet, open **Settings → Drive → Private Cloud**: **Auto Sync** is
  off after the reset, and the folders to sync may need ticking again.
- If the snapshot was taken without `cred.key`, each account gets a temporary
  password, printed once by `restore`. Putting the old `cred.key` back before
  restoring avoids that.
