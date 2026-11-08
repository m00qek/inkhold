---
title: "Authentication and untrusted content"
description: "The rules for passwords, sessions, admin elevation, and the files tablets send."
weight: 3058
extra:
  reader: contributor
  type: reference
---

# Authentication and untrusted content

The rules for passwords, sessions, admin elevation, and the files a tablet
sends. Why they are this way: [How sign-in and trust work](@/contributor/security.md).

## Authentication

- The tablet's protocol needs `md5(password)` to be recoverable, so there is no
  bcrypt or argon2. `md5(password)` is stored encrypted with
  XChaCha20-Poly1305, a nonce per row, under `cred.key`: a 32-byte file with
  mode 0600, kept outside the database. A stolen backup yields nothing; losing
  the key forces every password to be reset. Only `serve` may create the key.
- The browser bundles its own MD5 and SHA-256, because `crypto.subtle` exists
  only in secure contexts and a home deployment is plain HTTP. The password in
  plain text never leaves the browser.
- Session tokens are stored as their SHA-256 only. Lifetimes: a tablet's
  session about two years with no idle limit (it ends when the tablet is
  unlinked); the browser's 14 days idle and 90 days absolute; a pending session
  (the forced change of password at a first sign-in) 15 minutes.
- The browser's cookie is `HttpOnly; SameSite=Strict`, and `Secure` under TLS.
  That is the CSRF defence, and deliberately the only one.
- Admin elevation re-runs the sign-in challenge, so nothing replayable crosses
  plain HTTP. It lasts 15 minutes sliding, 60 minutes at most, stored on the
  session's row. A lapse answers 428 `ELEVATION_REQUIRED`, never 401 or 403,
  which the app would read as a dead session. Every refusal is
  `INVALID_CREDENTIALS`, so an attacker cannot learn who the admins are.
- Rate limits on anything that checks a password are keyed by account, not by
  address: a household shares one address.
- Temporary passwords come from one generator (four diceware words), are chosen
  by the server so that no admin knows a housemate's password, are shown once,
  and must always be changed at the next sign-in.
- Account routes name no target: the session is the subject. Admin routes
  always name `:id`. Both call the same service functions with an `actor` and a
  `target`, so one ownership check covers both faces.

## Untrusted content

- **No existence oracles.** Blobs are shared across the household, so only a
  `files` row says whose bytes are whose. An id or md5 that belongs to someone
  else answers exactly like one that does not exist: a 404 with a byte-identical
  body.
- `/file/{id}` serves inline only an allowlist of types (png, jpg, webp, gif,
  pdf), with `nosniff`; everything else is an attachment. An SVG or HTML file
  from a tablet, served inline, would be stored cross-site scripting.
- Link schemes are allowlisted (http, https, mailto) in the server, in the PDF
  shim and in the browser, because the exporter reads the same endpoints.
- `Content-Disposition` names are written by the tablet, so they are sent in
  the allowlisted quoted form plus RFC 5987's `filename*`.
- A `.spd` is a SQLite database an attacker could have written. It is copied
  and deserialised read-only into `:memory:`, never opened as a file.
- The decoders bound every size with checked arithmetic: on wasm32 `usize` is
  32 bits, and a `ReleaseSmall` build has no overflow traps.
