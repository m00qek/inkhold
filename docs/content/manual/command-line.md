---
title: "Command line"
description: "Every command and option of the inkhold binary. Generated from --help."
weight: 3020
extra:
  reader: operator
  type: reference
---

# Command line

Every command and option of the `inkhold` program, as `inkhold --help`
prints it. The server is `inkhold` with no command; the others manage
accounts and backups, and work beside a running server (all but `restore`).

<!-- Generated from backend/cli.zig by docs/tools/generate.mjs. Edit the source, not this page. -->

```text
Inkhold — a private cloud for Supernote devices.

Usage:
  inkhold [--config=<config>] [serve]
  inkhold [--config=<config>] users list
  inkhold [--config=<config>] users reset-password <user>
  inkhold [--config=<config>] users make-admin <user>
  inkhold [--config=<config>] backup create <dir> [--keep=<n>] [--include-cred-key]
                              [--no-compress] [--max-rate=<rate>]
  inkhold [--config=<config>] backup list <dir>
  inkhold [--config=<config>] backup verify <dir> [<snapshot>] [--deep]
  inkhold [--config=<config>] backup prune <dir> --keep=<n>
  inkhold [--config=<config>] restore <dir> [<snapshot>]
  inkhold (-h | --help)
  inkhold --version

Arguments:
  <user>            Account to act on, exactly as `inkhold users list`
                    prints it.
  <dir>             A backup directory. It must already exist: on a Pi a
                    missing one is usually an unmounted NAS.
  <snapshot>        One snapshot in it, as `backup list` names it; the
                    newest when omitted.

Options:
  -c --config=<config>   Config file to read [default: config.zon].
  -h --help              Show this message and exit.
  --version              Print the version and exit.
  --keep=<n>             Keep the newest <n> snapshots; remove the rest and
                         every file only they needed.
  --include-cred-key     Put cred.key in the snapshot too [default: no].
  --no-compress          Store every file as it is, not gzipped.
  --max-rate=<rate>      Read at most this fast, e.g. 4M or 512K; 0 is
                         unlimited [default: 4M for backup, 0 for restore].
  --deep                 Also re-read every file and check the database
                         page by page.

Commands:
  serve                       Run the server. Assumed when no command
                              is given.
  users list                  List accounts: address, whether they are
                              an admin, and whether a password change is
                              already pending.
  users reset-password        Issue a temporary password and print it
                              ONCE. Signs that account out everywhere; a
                              change is required at next sign-in.
  users make-admin            Grant admin to an account that already
                              exists.
  backup create               Snapshot this install into <dir>, beside a
                              running server. Only what is new is copied.
  backup list                 The snapshots in <dir>, oldest first.
  backup verify               Check that each snapshot can be restored.
  backup prune                Keep the newest snapshots; free the rest.
  restore                     Put a snapshot back onto a fresh install,
                              with the server stopped.

Recovery:
  These exist for the one case the web app cannot cover: nobody can sign
  in, so nobody can be helped from the admin console. They are authorised by
  read/write access to the data directory — proof of ownership on a self-hosted
  server, and access you already have to the database and the credential key.

  A household with ONE admin is one forgotten password from unreachable.
  `users list` is the diagnosis, `users make-admin` is the cure, and both are
  worth running before anything goes wrong rather than after.

Backups:
  A backup directory holds plain files, safe to keep on a NAS share, a USB
  disk or in a Dropbox folder: copying tools carry it intact, and each run
  adds only what changed. Nothing in it is encrypted, so keep it as private
  as your notes. cred.key is left out unless asked for: without it a restore
  still returns every note, and every account gets a temporary password.
  To run one nightly: https://m00qek.github.io/inkhold/manual/back-up/

  Before restoring, back up each tablet. A restore signs every tablet
  out and gives the library a new identity, so each one syncs from scratch
  at its next sign-in and uploads what the snapshot lacks.

Notes:
  The database must already exist. Every command except `serve` and `restore`
  refuses to create one and prints the path it tried — a mistyped --config
  would otherwise open an empty database and report that your own account
  does not exist, at the worst possible moment. `restore` is the opposite: it
  refuses to run where a database already exists.

  Safe to run while the server is up, all but `restore`: a reset takes
  effect on the next request, and a backup runs beside it at low priority.

  Temporary passwords are printed to stdout and never written to a log.
```

In Docker, run a command inside the container:

```sh
docker exec inkhold /inkhold --config=/etc/inkhold/config.zon users list
```
