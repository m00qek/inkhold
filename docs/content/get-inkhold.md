---
title: "Get Inkhold"
description: "Choose how to run Inkhold: its container image, a release binary, or built from source."
weight: 10
extra:
  reader: operator
  type: how-to
---

# Get Inkhold

Inkhold runs on a computer in your home that stays on: a Raspberry Pi, a NAS,
an old laptop, a small server. It needs Linux; ARM and every Raspberry Pi work.
Pick one way to run it:

| Way | Choose it when |
|---|---|
| [The container](@/manual/install-container.md) | You already run Docker or Podman. One command, nightly backups built in. |
| [The binary](@/manual/install-binary.md) | You want one file and nothing else, for example on a Raspberry Pi. |
| [From source](@/contributor/build-and-run.md) | You want to change Inkhold, or build it yourself. |

Each way ends the same: Inkhold prints a password for its first account, and
you [point your Supernote at it](@/manual/point-supernote.md). If this is your
first time, [Your first sync](@/manual/first-sync.md) walks through all of it.

Before you start:

- **Back up your tablet.** Inkhold is in beta and syncs your real notebooks.
  Copy the tablet's folders to another computer first.
- **Check your tablet's model.** Inkhold is tested on the Nomad; other models
  are [not confirmed yet](@/manual/devices.md).
