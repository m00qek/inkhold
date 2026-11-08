---
title: "Install the binary"
description: "Install the release binary and run it as a service."
weight: 2020
extra:
  reader: operator
  type: how-to
---

# Install the binary

Install the release binary and run it as a service.

1. Download the build for your machine and unzip it:

   | Build | For |
   |---|---|
   | [x86_64](https://nightly.link/m00qek/inkhold-beta/workflows/ci.yaml/pre-release/inkhold-x86_64-linux-musl.zip) | PCs, servers, cloud machines, Intel and AMD Synology NAS |
   | [aarch64](https://nightly.link/m00qek/inkhold-beta/workflows/ci.yaml/pre-release/inkhold-aarch64-linux-musl.zip) | Raspberry Pi 3, 4, 400 and 5 on a 64-bit system, ARM NAS and servers |
   | [armhf](https://nightly.link/m00qek/inkhold-beta/workflows/ci.yaml/pre-release/inkhold-arm-linux-musleabihf.zip) | Raspberry Pi 1, 2 and the original Zero, and newer Pis on a 32-bit system |
   | [x86](https://nightly.link/m00qek/inkhold-beta/workflows/ci.yaml/pre-release/inkhold-x86-linux-musl.zip) | Old 32-bit PCs and thin clients |

   Each is a single file with nothing to install beside it.

2. Put a config beside it, copied from
   [`config.example.zon`](https://github.com/m00qek/inkhold/blob/main/config.example.zon),
   and set **`.host`** in it:

   ```zig
   .host = "0.0.0.0",
   ```

   The default, `127.0.0.1`, only accepts the computer itself: the tablet and
   every other browser would fail to connect, and it looks exactly like a
   firewall problem. `0.0.0.0` listens on every network the computer is on.

3. Start it:

   ```sh
   ./inkhold                                   # reads ./config.zon
   ./inkhold --config=/etc/inkhold/config.zon  # or name the config
   ```

   It prints the first account's password once. Note it down.

4. Open `http://<the computer's address>:8089` and sign in as `admin@home.lan`.

## Run it as a service

Inkhold doesn't ship a unit for the server yet (only for its
[backups](@/manual/back-up.md)). A minimal one, for `systemd`, with the binary
in `/usr/local/bin` and its config and data under `/var/lib/inkhold`:

```ini
# /etc/systemd/system/inkhold.service
[Unit]
Description=Inkhold
After=network-online.target
Wants=network-online.target

[Service]
User=inkhold
WorkingDirectory=/var/lib/inkhold
ExecStart=/usr/local/bin/inkhold --config=/var/lib/inkhold/config.zon
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then `systemctl enable --now inkhold`, and `journalctl -u inkhold` shows the
first account's password.

Back up `cred.key` (written beside the database on the first start) somewhere
apart from the server: it encrypts stored credentials, and without it everyone
has to reset their password after a restore.
