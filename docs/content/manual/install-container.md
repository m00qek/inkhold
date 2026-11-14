---
title: "Install with Docker or Podman"
description: "Run Inkhold's container image, with its data and settings kept outside it."
weight: 2010
extra:
  reader: operator
  type: how-to
---

# Install with Docker or Podman

Run Inkhold's container image, with its data and settings kept outside it.

1. Create a volume for Inkhold's data, then start the container:

   ```sh
   docker volume create inkhold
   docker run -d --name inkhold -p 8089:8089 \
     -v inkhold:/var/lib/inkhold \
     -v /mnt/nas/inkhold-backup:/backup \
     ghcr.io/m00qek/inkhold:latest
   ```

   The `/backup` line is optional: it turns on [nightly backups](@/manual/back-up.md)
   into that folder, and a weekly check that re-reads every file in it. Leave
   it out and there are none.

2. Read the first account's password, printed once:

   ```sh
   docker logs inkhold
   ```

   Note it down. You change it the first time you sign in.

3. Open `http://<the computer's address>:8089` in a browser and sign in as
   `admin@home.lan` with that password.

With Podman, use the same commands with `podman` in place of `docker`.

## What lives where

Everything that must survive an upgrade (the database, `cred.key`, your
notebooks and the search index) is in the `/var/lib/inkhold` volume. Keep the
volume, and you can replace the container at any time.

The image's settings are at `/etc/inkhold/config.zon`. To change the port, turn
on HTTPS or set another first-account email, mount your own over it:

```sh
docker run -d --name inkhold -p 8089:8089 \
  -v inkhold:/var/lib/inkhold \
  -v ./my-config.zon:/etc/inkhold/config.zon:ro \
  ghcr.io/m00qek/inkhold:latest
```

Every setting is listed in [config.zon settings](@/manual/configuration.md).

## Backups

With a folder mounted at `/backup`, the container backs up into it every night
at 03:00 UTC, keeping 7 snapshots and checking each new one, and re-reads every
file in it on Sundays at 04:00. `docker logs inkhold` shows each run, and an
admin sees a failed one in the library. To change the times or options, see
[Back up automatically](@/manual/back-up.md).

Mount a folder on another disk, such as a NAS share: a backup on the same disk
goes down with it. To also keep a copy away from this machine, run rclone on
the host, not in the container, as in
[Keep a copy away from the server](@/manual/offsite-copy.md).

## Which image

One tag covers x86_64, aarch64, 32-bit ARM and 32-bit x86: Docker pulls the one
for your machine. The ARM image runs on every Raspberry Pi from the original B+
up. The image is about 25 MB: the server and a small busybox that schedules
backups, so `docker exec -it inkhold sh` gives you a shell.

`:latest` is the newest [release](https://github.com/m00qek/inkhold/releases).
To stay on one, use its version as the tag, as in `:1.0.0-beta.1`. `:next` is
the release being tried before it becomes `:latest`: newer, less proven.
