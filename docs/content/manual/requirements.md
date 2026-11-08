---
title: "Requirements"
description: "The hardware, operating systems and browsers Inkhold runs on."
weight: 3070
extra:
  reader: operator
  type: reference
---

# Requirements

## The server

- **Linux**, on x86_64, aarch64, 32-bit ARM or 32-bit x86. Every Raspberry Pi
  works, down to a Pi 1 from 2014. The program is one static file: nothing to
  install beside it.
- **Or Docker or Podman**, on any of the same.
- **Memory and processor**: little. A Pi 1 serves a household of four with two
  tablets at about 15% of its single core through a busy evening.
- **Disk**: room for your notebooks and their versions, plus the search index.
  A backup belongs on another disk.
- **An address the tablet can reach**: the same home network, or HTTPS for
  [anywhere](@/manual/https.md).

## The tablet

A Supernote with Private Cloud in its settings. The Nomad is tested end to end;
other models are [very likely to work](@/manual/devices.md).

## The browser

A current Chrome, Edge, Safari or Firefox, on a computer or a phone. The app
is tested in Chrome and in Safari's engine, which every iPhone browser uses.
It draws pages and searches with WebAssembly, which every current browser has.
