---
title: "Security decisions"
description: "Why passwords are stored the way they are, why foreign files answer like missing ones, and why every byte from a tablet is treated as hostile."
weight: 4040
extra:
  reader: contributor
  type: explanation
---

# Security decisions

How Inkhold treats passwords, sessions and the untrusted files tablets send, and why. The rules themselves: [Authentication and untrusted content](@/contributor/auth-rules.md).

## Decisions

### Passwords stored recoverable, encrypted

**Problem.** The tablet's sign-in proves `md5(password)` against a fresh code, so the server must be able to recover that value: a one-way hash such as bcrypt cannot be used.

**Decision.** `md5(password)` is stored encrypted (XChaCha20-Poly1305, a nonce per row) under `cred.key`, a file kept outside the database. A stolen database or backup alone reveals nothing.

**Cost.** The key and the database together reveal every `md5(password)`, which is weak; losing the key forces every account to reset.

**Revisit when** the device protocol allows a challenge that does not need a recoverable secret.

### No existence oracles

**Problem.** Blobs are shared across the household; answering differently for someone else's file would tell an attacker it exists.

**Decision.** Foreign ids and md5s answer exactly as missing ones do: same status, byte-identical body.

**Cost.** Debugging a 404 can't tell "not yours" from "not there".

**Revisit when** never.

### A tablet's files are hostile

**Problem.** Every byte comes from a device that may be compromised or buggy.

**Decision.** Offsets are bounds-checked, decoders use checked arithmetic, a `.spd` is copied into memory and opened read-only, only an allowlist of types is served inline, and link schemes are allowlisted.

**Cost.** Every new format needs its own bounds work.

**Revisit when** never. The rules themselves: [Authentication and untrusted content](@/contributor/auth-rules.md).
