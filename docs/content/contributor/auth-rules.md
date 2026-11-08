---
title: "Authentication and untrusted content"
description: "The rules for passwords, sessions, admin elevation, and the files tablets send."
weight: 3058
extra:
  reader: contributor
  type: reference
---

# Authentication and untrusted content

The rules for passwords, sessions, admin elevation, and the files tablets send. Why they are this way: [Security decisions](@/contributor/security.md).

## Authentication

- The protocol needs `md5(pw)` recoverable, so no bcrypt/argon2: `md5(pw)` is
  stored encrypted (XChaCha20-Poly1305, per-row nonce) under `cred.key`, a
  32-byte 0600 file outside the DB. A stolen backup yields nothing; losing the
  key forces every password reset. Only `serve` may create the key.
- The browser bundles MD5/SHA-256: `crypto.subtle` exists only in secure
  contexts and the LAN deployment is plain HTTP. Plaintext never leaves the
  browser.
- Session tokens are stored as SHA-256 only. Lifetimes: device ~2 years, no
  idle (revoked by unlink); control plane 14 days idle / 90 absolute; pending
  (forced first-login change) 15 minutes.
- Control-plane cookie is `HttpOnly; SameSite=Strict` (`Secure` under TLS);
  that is the CSRF defence, deliberately the only one.
- Admin elevation re-runs the login challenge (nothing replayable over HTTP).
  15 min sliding, 60 min ceiling, stored on the session row. A lapse is 428
  `ELEVATION_REQUIRED`, not 401/403, which the SPA reads as a dead session.
  Every refusal is `INVALID_CREDENTIALS` so admins cannot be enumerated.
- Password-oracle rate limits are keyed by account, not IP: a household shares
  one address.
- Temporary passwords: one generator (4 diceware words), server-chosen so no
  admin knows a housemate's password, shown once, always must-change.
- Account routes take no target id (the session is the subject); admin routes
  always name `:id`. Both faces call the same service functions with
  `actor`/`target`, so one ownership decision covers both.

## Untrusted content

- **No existence oracles.** Blobs are deduplicated across the household, so
  only a `files` row says whose bytes are whose. Foreign ids and md5s answer
  exactly like missing ones (404, byte-identical body).
- `/file/{id}` serves inline only an allowlist (png, jpg, webp, gif, pdf), with
  `nosniff`; everything else is an attachment. SVG/HTML from a device would be
  stored XSS.
- Link schemes are allowlisted (http, https, mailto) in the server, the PDF
  shim and the browser, because the exporter reads the same endpoints.
- `Content-Disposition` names are device-authored: allowlisted quoted form plus
  RFC 5987 `filename*`.
- A `.spd` is an attacker-supplied SQLite database: it is copied and
  deserialised read-only into `:memory:`, never opened as a file.
- Decoders bound every size with checked arithmetic (wasm32 `usize` is 32-bit
  and `ReleaseSmall` has no overflow traps).
