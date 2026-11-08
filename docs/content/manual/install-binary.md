---
title: "Install the binary"
description: "Install the release binary and run it as a service."
weight: 2020
extra:
  reader: operator
  type: how-to
---

# Install the binary

Install a release build and run it as a service, started with the computer and
restarted if it stops. These steps were tested on Debian with systemd.

## 1. Download

| Build | For |
|---|---|
| [x86_64](https://nightly.link/m00qek/inkhold/workflows/ci.yaml/main/inkhold-x86_64-linux-musl.zip) | PCs, servers, cloud machines, Intel and AMD Synology NAS |
| [aarch64](https://nightly.link/m00qek/inkhold/workflows/ci.yaml/main/inkhold-aarch64-linux-musl.zip) | Raspberry Pi 3, 4, 400 and 5 on a 64-bit system, ARM NAS and servers |
| [armhf](https://nightly.link/m00qek/inkhold/workflows/ci.yaml/main/inkhold-arm-linux-musleabihf.zip) | Raspberry Pi 1, 2 and the original Zero, and newer Pis on a 32-bit system |
| [x86](https://nightly.link/m00qek/inkhold/workflows/ci.yaml/main/inkhold-x86-linux-musl.zip) | Old 32-bit PCs and thin clients |

The zip holds one archive. Unpack both:

```sh
unzip inkhold-*.zip
mkdir inkhold && tar -xzf inkhold-*.tar.gz -C inkhold
```

You get the server (`inkhold`, one static file that runs on any Linux), the
browser app (`webapp/dist`), and `config.example.zon`.

## 2. Put the files in place

```sh
sudo install -m 755 inkhold/inkhold /usr/local/bin/inkhold
sudo mkdir -p /usr/local/share/inkhold /etc/inkhold
sudo cp -r inkhold/webapp/dist /usr/local/share/inkhold/web
sudo useradd --system --home-dir /var/lib/inkhold --shell /usr/sbin/nologin inkhold
```

## 3. Write the config

Create `/etc/inkhold/config.zon`:

```zig
.{
    .host = "0.0.0.0",
    .port = 8089,
    .db_path = "/var/lib/inkhold/inkhold.db",
    .cred_key_path = "/var/lib/inkhold/cred.key",
    .data_dir = "/var/lib/inkhold/data",
    .web_dir = "/usr/local/share/inkhold/web",
}
```

- **`.host`**: `0.0.0.0` listens on every network the computer is on. The
  default, `127.0.0.1`, only accepts the computer itself: the tablet and every
  other browser would fail to connect, and it looks exactly like a firewall
  problem.
- **The paths are absolute** so the server and its
  [backups](@/manual/back-up.md) find the same files whatever folder they
  start in.

Every other setting is in [config.zon settings](@/manual/configuration.md).

## 4. Start it as a service

Copy [`contrib/systemd/inkhold.service`](https://github.com/m00qek/inkhold/blob/main/contrib/systemd/inkhold.service)
to `/etc/systemd/system/`, then:

```sh
sudo systemctl enable --now inkhold
journalctl -u inkhold
```

The journal shows the first account's password, once. Open
`http://<the computer's address>:8089` and sign in as `admin@home.lan`.

The service runs as the `inkhold` account and can write only to
`/var/lib/inkhold`, which systemd creates for it: the database, `cred.key`,
your notebooks and the search index all live there.

**Back up `cred.key`** somewhere apart from the server. It encrypts stored
credentials; without it, everyone has to reset their password after a restore.

## Without systemd

Run it by hand with `/usr/local/bin/inkhold --config=/etc/inkhold/config.zon`,
as the `inkhold` account.
