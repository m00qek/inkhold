---
title: "Upgrade Inkhold"
description: "Upgrade to a new release safely, with a backup first."
weight: 2090
extra:
  reader: operator
  type: how-to
---

# Upgrade Inkhold

Move to a newer build safely, with a backup first. Inkhold updates its database
on the first start of the new version; nothing else needs doing.

## 1. Back up

```sh
inkhold --config=/etc/inkhold/config.zon backup create /mnt/nas/inkhold --keep=7
```

In Docker: `docker exec inkhold /inkhold --config=/etc/inkhold/config.zon backup create /backup --keep=7`.

If the new version misbehaves, [restoring](@/manual/restore.md) this backup is
the way back.

## 2a. In Docker

```sh
docker pull ghcr.io/m00qek/inkhold-beta:latest
docker stop inkhold && docker rm inkhold
docker run -d --name inkhold -p 8089:8089 \
  -v inkhold:/var/lib/inkhold \
  -v /mnt/nas/inkhold-backup:/backup \
  ghcr.io/m00qek/inkhold-beta:latest
```

Use the same volumes as before: everything that matters lives in them, not in
the container.

## 2b. With the binary

[Download](@/manual/install-binary.md) the new build and unpack it, then
replace the program and the browser app, and restart:

```sh
sudo install -m 755 inkhold/inkhold /usr/local/bin/inkhold
sudo rm -rf /usr/local/share/inkhold/web
sudo cp -r inkhold/webapp/dist /usr/local/share/inkhold/web
sudo systemctl restart inkhold
```

## 3. Check

`journalctl -u inkhold` (or `docker logs inkhold`) shows the start. Open the
library in a browser: it loads the new app on its next visit. A phone with
Inkhold on its home screen may need the app closed and opened again.
