---
title: "Run Inkhold on a Raspberry Pi"
description: "Put Inkhold on a Raspberry Pi with the binary and its systemd service, start to finish."
weight: 1020
extra:
  reader: operator
  type: tutorial
---

# Run Inkhold on a Raspberry Pi

In this tutorial you put Inkhold on a Raspberry Pi, running as a service that
starts with the Pi, and sign in to it from a browser. Any Pi works, down to a
Pi 1 from 2014. It takes about twenty minutes.

You need a Pi running Raspberry Pi OS with network access, and a terminal on
it (over SSH is fine).

## 1. Which build

```sh
uname -m
```

- `armv6l` or `armv7l`: you want **armhf**.
- `aarch64`: you want **aarch64**.

## 2. Download and unpack it

On the Pi, with the build you chose (here, armhf):

```sh
curl -LO https://nightly.link/m00qek/inkhold-beta/workflows/ci.yaml/pre-release/inkhold-arm-linux-musleabihf.zip
unzip inkhold-*.zip
mkdir inkhold && tar -xzf inkhold-*.tar.gz -C inkhold
```

## 3. Install it

These are the same commands as [Install the binary](@/manual/install-binary.md),
which is the page to keep when they change.

```sh
sudo install -m 755 inkhold/inkhold /usr/local/bin/inkhold
sudo mkdir -p /usr/local/share/inkhold /etc/inkhold
sudo cp -r inkhold/webapp/dist /usr/local/share/inkhold/web
sudo useradd --system --home-dir /var/lib/inkhold --shell /usr/sbin/nologin inkhold
```

Create `/etc/inkhold/config.zon` with `sudo nano /etc/inkhold/config.zon`:

```zig
.{
    .host = "0.0.0.0",
    .db_path = "/var/lib/inkhold/inkhold.db",
    .cred_key_path = "/var/lib/inkhold/cred.key",
    .data_dir = "/var/lib/inkhold/data",
    .web_dir = "/usr/local/share/inkhold/web",
}
```

## 4. Start it

Fetch the service file and start it:

```sh
sudo curl -Lo /etc/systemd/system/inkhold.service \
  https://raw.githubusercontent.com/m00qek/inkhold/main/contrib/systemd/inkhold.service
sudo systemctl enable --now inkhold
journalctl -u inkhold
```

The last command shows a line like
`Created admin 'admin@home.lan' with a temporary password: …`. Keep that
password: it is shown once.

## 5. Sign in

`hostname -I` prints the Pi's address. On any computer in the house, open
`http://<that address>:8089` and sign in as `admin@home.lan` with the temporary
password, then choose your own.

## What you have now

Inkhold, running on the Pi, restarting with it. Next:

- [Point your Supernote at Inkhold](@/manual/point-supernote.md).
- [Back up automatically](@/manual/back-up.md): a USB disk on the Pi or a NAS
  share both work.
