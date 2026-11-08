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
     ghcr.io/m00qek/inkhold-beta:latest
   ```

   The `/backup` line is optional: it turns on [nightly backups](@/manual/back-up.md)
   into that folder. Leave it out and there are none.

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
  ghcr.io/m00qek/inkhold-beta:latest
```

Every setting is listed in [config.zon settings](@/manual/configuration.md).

## Which image

One tag covers x86_64, aarch64, 32-bit ARM and 32-bit x86: Docker pulls the one
for your machine. The ARM image runs on every Raspberry Pi from the original B+
up. The image is about 25 MB: the server and a small busybox that schedules
backups, so `docker exec -it inkhold sh` gives you a shell.

`:latest` follows the main branch. To stay on one build, use its commit as the
tag.
