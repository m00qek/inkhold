---
title: "Cross-build for every architecture"
description: "Build for x86_64, aarch64, armhf (Raspberry Pi 1) and x86."
weight: 2030
extra:
  reader: contributor
  type: how-to
---

# Cross-build for every architecture

Build the release for all four targets on one machine. Do it before any push
that changes the server: a push to `main` publishes `:latest`, and a
build that breaks only on 32-bit ARM is a broken Raspberry Pi.

| Target | For |
|---|---|
| `x86_64-linux-musl` | PCs and servers |
| `aarch64-linux-musl` | 64-bit ARM: Pi 3 and later on a 64-bit system |
| `arm-linux-musleabihf` | 32-bit ARM, built for the Pi 1's CPU (`arm1176jzf_s`) so it runs on every Pi |
| `x86-linux-musl` | 32-bit x86 |

One target, as the release builds it (server, browser app and example config,
in `inkhold-<target>.tar.gz`):

```sh
make release-artifact TARGET=arm-linux-musleabihf
```

Every target, the server alone, the quickest check that it builds:

```sh
for t in x86_64-linux-musl aarch64-linux-musl arm-linux-musleabihf x86-linux-musl; do
  zig build -Doptimize=ReleaseSafe -Dtarget=$t $(make -s print-zig-cpu TARGET=$t) \
    --prefix /tmp/inkhold-$t || break
done
```

`make print-zig-cpu TARGET=…` prints the CPU flag a target needs (only 32-bit
ARM has one); CI reads the same flag, so the Makefile is the one place it
lives. The binaries are static: `file` should say "statically linked" for each.

Two things that break only on 32-bit targets, and so only here: 64-bit atomics
(ARMv6 has none; use `u32`/`usize` counters) and `u64` lengths used to index a
slice (`usize` is 32 bits).
