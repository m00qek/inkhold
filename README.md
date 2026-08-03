# Inkhold

**A private cloud for your Supernote — self-hosted on hardware you own, so your
notes never leave home.**

Inkhold is a drop-in replacement for Ratta's official Supernote *Private Cloud*.
Point your Supernote at it instead of the official service and your notebooks
sync exactly as before — except the server is a single small program running on
*your* machine (a home server, a spare laptop, even a Raspberry Pi), and your
handwriting is stored on *your* disk. There's also a browser app for reading,
searching, and exporting everything from any device on your network.

> **Unofficial.** Inkhold is an independent project, reverse-engineered for
> interoperability. It is **not affiliated with, endorsed by, or connected to
> Ratta or Supernote**. "Supernote" and "Nomad" are used only to describe the
> hardware Inkhold works with.

![Inkhold — a handwritten note reading "Hey there! Welcome to Inkhold. I hope it keeps your notes safe and always at hand :)"](docs/screenshots/welcome-hero.png)

## Why run your own

- **Your notes stay home.** Nothing is uploaded to anyone else's servers. The
  sync path and the web app both live on your LAN; the internet is optional.
- **Tiny.** One binary in the low tens of MB, holding a ~50 MB memory ceiling —
  where the official stack wants ~2 GB of RAM across five processes. It runs
  comfortably on a **single-core, 32-bit Raspberry Pi from 2014**.
- **A real reading app, not just storage.** Browse your library, open notebooks
  page by page with their layers, search your *handwriting*, recover deleted
  notes, and export to PDF, PNG, or layered `.ora` — all in the browser.
- **One process, one port.** Device sync, the browser app, and (optional) TLS all
  come from the same program. No reverse proxy, no containers, no database server
  to run.

## What you can do

- **Sync your Supernote** — upload, download, capacity, folder moves/renames, and
  conflict resolution, all speaking the device's own protocol.
- **Read notebooks in the browser** — notebooks, sketches, and text files, with
  per-layer viewing and in-note find. Pages render *in your browser* (a small
  WebAssembly decoder), so the server only moves bytes.
- **Search your handwriting** — full-text search across every note, powered by the
  on-device OCR text your Supernote already produces.
- **Recover mistakes** — a recycle bin with a retention window, and per-file
  **version history** so you can look back at earlier states of a note.
- **Export** — any note to PDF (with a searchable text layer), a flat PNG, or a
  layered `.ora`.
- **Manage the household** — a small admin console for users, devices, quota, and
  retention.

|  |  |
|---|---|
| ![The library](docs/screenshots/library.png) | ![A notebook open with its layers](docs/screenshots/layers.png) |
| **Your library** — folders and notebooks, at a glance. | **Rich reader** — pages with their layers, in the browser. |
| ![Searching handwriting](docs/screenshots/search.png) |  |
| **Search your handwriting** — full-text, across every note. |  |

## Beta status — please read

Inkhold is **beta software built by reverse-engineering** the Supernote protocol.
It is designed for a **single household** (a handful of devices plus browsers),
not a multi-tenant service.

- ✅ **Verified end-to-end against a real Supernote Nomad** — full upload/download
  round-trips, capacity, conflict resolution.
- ⚠️ **Keep your notes backed up.** Your Supernote keeps its own local copy, and
  Inkhold never deletes device-side data — but this is early software syncing your
  real notebooks, so don't make it the *only* place your notes live yet.
- 🔑 **Back up `cred.key`** (created on first run). It encrypts stored credentials
  and lives outside the database, so a stolen database alone yields nothing —
  and losing the key means everyone has to reset their password.

Found a bug or something surprising? **Open a GitHub issue** — that feedback is the
whole point of the beta.

## Requirements

- A machine on your home network to run it on (Linux; ARM and Raspberry Pi work).
- A Supernote **Nomad** — other models are untested, see [Devices](#devices).
- To build from source: the [Zig](https://ziglang.org) toolchain. To run a
  prebuilt binary: nothing.

## Get Inkhold

Two ways in. Both end at [First run](#first-run), which is the same either way.

### Download a binary

Rolling builds from `main`, statically linked against musl — they drop into any
Linux system without glibc version trouble.

- **[x86_64](https://nightly.link/m00qek/inkhold-beta/workflows/ci.yaml/main/inkhold-x86_64-linux-musl.zip)**
  — modern PCs and servers, cloud VMs, Intel/AMD Synology NAS (the Plus series).
- **[aarch64](https://nightly.link/m00qek/inkhold-beta/workflows/ci.yaml/main/inkhold-aarch64-linux-musl.zip)**
  — Raspberry Pi 3, 4, 400 and 5 **on a 64-bit OS**, ARM Synology NAS, ARM cloud servers.
- **[armhf](https://nightly.link/m00qek/inkhold-beta/workflows/ci.yaml/main/inkhold-arm-linux-musleabihf.zip)**
  — older Pis (1, 2, the original Zero), and newer ones still running a 32-bit OS.
- **[x86](https://nightly.link/m00qek/inkhold-beta/workflows/ci.yaml/main/inkhold-x86-linux-musl.zip)**
  — legacy 32-bit Intel/AMD machines and old thin clients.

Extract the `.zip`. You will also want `config.example.zon` from this repository
beside the binary.

### Build from source

```sh
git clone <this-repo> inkhold && cd inkhold
make serve
```

`make serve` builds the WebAssembly page decoder, the browser app and the server,
then runs it. On first use it writes a config for you — already set to listen on
every interface — so you can skip straight past the `.host` note below.

## First run

**If you wrote your own config, set `.host` first.** It defaults to `127.0.0.1`,
which accepts connections only from the machine itself: your tablet and your
browser will both fail to reach it, and it looks exactly like a firewall problem.
Use `0.0.0.0` to listen on every interface, or your server's LAN address to pin it
to one. (`make serve` already does this for you.)

```sh
cp config.example.zon config.zon    # then edit — see Configuration below
./inkhold                            # picks up ./config.zon from the current directory
```

To keep the config elsewhere, name it: `./inkhold --config=/etc/inkhold/config.zon`

Inkhold serves **everything on one port** — device sync, the browser app and
optional TLS — **8089 by default**. Change it with `.port` in your config, or
`make serve PORT=9000`.

On the **first run** it creates an `admin` account and prints a **temporary
password to the terminal**. Note it down: it is shown once, and you will change it
when you first sign in.

Then open `http://<LAN-IP>:<port>` in a browser and sign in. `make serve` prints
the address; `make lan-ip` prints it on its own, and without the repository
`hostname -I` will do.

## Point your Supernote at it

On the device: **Settings → Supernote Cloud / Private Cloud → server address**,
and enter the same `http://<LAN-IP>:<port>`. Sign in with an Inkhold account, and
your notebooks sync into the library.

> Running over plain HTTP is fine on a trusted home network. For sync across the
> internet, Inkhold can terminate **TLS itself** (no reverse proxy) — see
> [TLS](#tls).

## What doesn't work yet

Honest gaps, so you know before you try:

| | |
|---|---|
| **Data Sync — To-Do and Digest** | The tablet's To-Do and Digest data does not sync. Inkhold implements the file-sync protocol; these ride a separate one that has not been reverse-engineered. Notes, folders, and the other synced types are unaffected. |
| **PDF previews** | A `.pdf` in the library shows a document glyph rather than a rendered first page. It still uploads, syncs and downloads — you just cannot see inside it from the browser. `.note`, `.spd`, images and text all render. |
| **The Supernote mobile app** | Deliberately out of scope: it expects the server to render pages, which is the one thing Inkhold pushes to the browser instead. The device syncs directly; the app does not. |

### Devices

| Device            | Status                                             |
|-------------------|----------------------------------------------------|
| Supernote **Nomad** (A6 X2) | ✅ Verified end-to-end against a real device |
| Other Supernote models (A5 X, A6 X, **Manta** (A5 X2), …) | ❓ Untested — likely similar, help wanted |

Own a non-Nomad Supernote? Trying it and reporting back is one of the most useful
things a beta tester can do.

## Configuration

Copy [`config.example.zon`](config.example.zon) to `config.zon` and edit. Fields
are optional; omitted ones use defaults:

`host`, `port`, `db_path`, `data_dir`, `web_dir`, `cred_key_path`, `admin_email`,
`max_connections`, and `tls` (`enabled`, `cert_path`, `key_path`, `cipher_suites`).

## TLS

TLS 1.3 is terminated in-process (no reverse proxy needed). Set `tls.enabled =
true` with a cert and key; `bash scripts/dev-cert.sh` makes a self-signed dev
certificate to get started.

## For developers

The internals — how the single binary serves three faces on one port, the
content-addressed blob store, the client-side WASM rendering pipeline, and the
`.note`/`.spd` parsers — are documented in comments beside the code they explain.
The layout:

```
backend/    the Zig server — one binary, device sync + browser API + static host
webapp/     the browser app (TypeScript, zero runtime deps); wasm/ = page decoders
parsers/    the .note and .spd format parsers (own build + tests + specs)
```

Build & test:

```sh
make test-all                     # backend + frontend (unit + e2e) + parser suites
zig build test                    # backend + note unit tests
zig build -Doptimize=ReleaseSafe  # the release server binary
```

## License

Inkhold is free and open-source software, released under the **GNU General Public
License, version 3 (GPLv3)** — see [`LICENSE`](LICENSE). You can run it, study it,
change it, and share it.

## Credits

Supernote file-format understanding derives from
[supernote-tool](https://github.com/jya-dev/supernote-tool) (Apache-2.0). Inkhold
is an independent, unofficial project and is not affiliated with Ratta/Supernote.
