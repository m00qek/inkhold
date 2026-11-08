---
title: "Back up automatically"
description: "Take backups on a schedule and check that they can be restored."
weight: 2060
extra:
  reader: operator
  type: how-to
---

# Back up automatically

Take a backup every night into a folder of plain files (a NAS share, a USB
disk, a Dropbox or Google Drive folder) and check that it can be restored.
Inkhold keeps serving while it backs up.

## In Docker

Mount the backup folder at `/backup`, and that is all:

```sh
docker run -d --name inkhold -p 8089:8089 \
  -v inkhold:/var/lib/inkhold \
  -v /mnt/nas/inkhold-backup:/backup \
  ghcr.io/m00qek/inkhold:latest
```

The container then backs up every night at 03:00 UTC, keeps 7 snapshots, and
checks each new one. If the computer was off at 03:00, it backs up a minute
after it next starts. `docker logs inkhold` shows each run.

Mount the NAS share itself. A bind mount of a folder whose share has dropped
off quietly fills the computer's own disk instead.

To change the time or the options, copy the image's
[`crontab`](https://github.com/m00qek/inkhold/blob/main/docker/rootfs/etc/inkhold/crontab),
edit it, and mount it with `-v ./crontab:/etc/inkhold/crontab:ro`. For local
time instead of UTC, pass a POSIX zone, for example
`-e TZ=CET-1CEST,M3.5.0,M10.5.0/3`.

## With the binary

The folder must exist; then:

```sh
inkhold backup create /mnt/nas/inkhold --keep=7
inkhold backup list   /mnt/nas/inkhold
inkhold backup verify /mnt/nas/inkhold            # --deep re-reads every file
```

To run it every night, either:

- add one line with `crontab -e`:

  ```text
  0 3 * * *  /usr/local/bin/inkhold --config=/etc/inkhold/config.zon backup create /mnt/nas/inkhold --keep=7 >/dev/null
  ```

- or use the systemd service and timer in
  [`contrib/systemd/`](https://github.com/m00qek/inkhold/tree/main/contrib/systemd):
  set the account, config path and folder at the top of
  `inkhold-backup.service`, copy both files to `/etc/systemd/system/`, then
  `systemctl enable --now inkhold-backup.timer`. It backs up at 03:00, makes up
  for a night the computer was off, and checks each new snapshot.

## Worth knowing

- **The folder is not encrypted.** Keep it as private as the notebooks in it.
- **`cred.key` is left out** unless you pass `--include-cred-key`. Without it a
  restore still brings back every notebook; each account gets a temporary
  password instead.
- **Admins are told when backups stop.** A line in the library says when the
  last backup failed, is more than two days old, or never happened, and the
  admin console's server panel lists every backup folder.
- **Backing up is slow on purpose:** low priority, reading 4 MiB/s
  (`--max-rate` changes it), so syncing stays quick meanwhile.
- On FAT32 a file cannot exceed 4 GB. On "online-only" cloud folders,
  `verify --deep` downloads everything to check it.

[How backups work](@/manual/how-backups-work.md) explains snapshots and why
each night's backup is small.
