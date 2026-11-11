---
title: "config.zon settings"
description: "Every setting in config.zon, its default, and what it changes. Generated from config.example.zon."
weight: 3010
extra:
  reader: operator
  type: reference
---

# config.zon settings

Every setting of Inkhold's config file, its default, and what it changes.
Every setting is optional: one left out takes its default. Copy
[`config.example.zon`](https://github.com/m00qek/inkhold/blob/main/config.example.zon),
which lists them all, and change what you need.

<!-- Generated from config.example.zon and backend/config.zig by docs/tools/generate.mjs. Edit the source, not this page. -->

| Setting | Default | What it does |
|---|---|---|
| `host` | `"127.0.0.1"` | The address to listen on. The default accepts this computer only: use "0.0.0.0" for every network it is on, or one of its addresses. |
| `port` | `8089` | The port for everything: the tablet's sync, the browser app and HTTPS. |
| `db_path` | `"inkhold.db"` | The database file, created on the first start. |
| `cred_key_path` | `"cred.key"` | The key that encrypts stored credentials, created on the first start. Kept apart from the database, so a stolen database reveals nothing. Back it up somewhere else: without it, everyone has to reset their password. |
| `data_dir` | `"data"` | Where your notebooks and everything derived from them are stored. |
| `web_dir` | `""` | The browser app's files. Empty serves no browser app, only the tablet's sync. |
| `admin_email` | `"admin@home.lan"` | The email of the first account, created on the first start with a temporary password. It must be an email address, and it applies on the first start only. |
| `max_connections` | `192` | How many connections may be open at once. An idle one costs about 34 KB and no thread, and a browser keeps about 6 per tab. |
| `workers` | `4` | Threads answering requests. Memory grows with this number; a few are plenty for a household. |
| `max_held` | `24` | Threads for the live updates that browsers and tablets listen to, beyond the workers. |
| `idle_timeout_s` | `300` | Seconds an idle connection stays open. Generous, because over HTTPS reopening one costs a handshake. |
| `trusted_proxy` | `""` | The address of a reverse proxy that handles HTTPS in front of Inkhold. Requests from it are rate-limited by each visitor's address (from X-Real-IP, or the last X-Forwarded-For) instead of all as one. Empty trusts no such header. |
| `backup_warn_after_hours` | `48` | Admins see a notice in the library when the newest successful backup is older than this many hours. |
| `todo_sync` | `false` | Sync the tablet's To-Do lists and tasks. New, so off: while off, the tablet's To-Do app shows a sync error and nothing is touched. Copy the tablet first, and when it asks how to treat its digest and to-do data, choose "Retain locally". |
| `digest_sync` | `false` | Sync the tablet's digests: excerpts, their categories and annotations. New, so off: while off, the tablet's Digest app shows a sync error and nothing is touched. Copy the tablet first, and when it asks how to treat its digest and to-do data, choose "Retain locally". |
| `history.keep` | `5` | How many earlier versions of each file are kept. 0 keeps none. |
| `history.max_keep` | `15` | The most versions a person may choose to keep of their own files. |
| `history.max_bytes` | `500000000` | Bytes all the household's versions may take together. Past it, the oldest versions of whoever is saving go first. |
| `tls.enabled` | `false` | Serve HTTPS (TLS 1.3) directly, with no reverse proxy. When false, plain HTTP. |
| `tls.cert_path` | `"certs/cert.pem"` | The certificate, as a PEM file. |
| `tls.key_path` | `"certs/key.pem"` | Its private key, as a PEM file. |
| `tls.cipher_suites` | none | The cipher suites allowed, preferred first. Leave it empty: Inkhold then picks what is cheap on its own processor. Names such as "AES_256_GCM_SHA384", "AES_128_GCM_SHA256", "CHACHA20_POLY1305_SHA256". |

A setting inside `tls` is written in its own block:

```zig
.tls = .{
    .enabled = true,
    .cert_path = "/etc/inkhold/cert.pem",
    .key_path = "/etc/inkhold/key.pem",
},
```

A change takes effect when Inkhold restarts.
