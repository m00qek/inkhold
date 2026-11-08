---
title: "Measure memory and speed on a Pi"
description: "Measure the server's footprint and a household's load on a real Raspberry Pi."
weight: 2060
extra:
  reader: contributor
  type: how-to
---

# Measure memory and speed on a Pi

The server's budget is a Raspberry Pi 1 ([The shape of the system](@/contributor/system-shape.md)).
Two scripts check a change against it.

## The footprint: memory and threads

```sh
make footprint
```

Builds a ReleaseSafe server and runs `scripts/footprint.py`: it starts the
server, holds idle connections, and reads the process's memory; then it seeds a
library at two sizes and runs a backup beside the serving server. It fails when
a number crosses its ceiling. CI runs it on the x86_64 musl binary that ships
(`make footprint SERVER=path` measures a binary already built). Ceilings are
raised only with a note in the script saying what bought the bytes.

The numbers are measured on x86_64 as a stand-in for the Pi: the structure
they pin (threads don't grow with connections) is the same there.

## A household's evening: load

`scripts/household_load.py` plays a household against a server: people
browsing, opening and searching, and tablets syncing.

```sh
scripts/household_load.py zig-out/bin/inkhold --seconds 120 --people 4
```

To measure the Pi itself, run the server on it and the load from another
machine, so the load generator doesn't share the Pi's one core:

```sh
scripts/household_load.py --ssh pi --remote-binary inkhold-arm --seconds 300
```

On the devlab's Pi 1 B+, the server runs as a job (`devlab-target`), which
answers only the NUC, so the load comes from the NUC's `scratch/inkhold-builder`
instance. From the laptop, with a release's armhf archive:

```sh
scripts/pi-load.sh inkhold-arm-linux-musleabihf.tar.gz --seconds 300
```

It submits the archive and a config as the job, signs in with the job's
first-run password, and seeds the libraries from the builder. The evening
starts once indexing is done, read from the job's CPU time (under 5% of the
core for 3 s), and the script ends with the job's own accounting: its peak
memory (the unpacked archive included, since on the Pi's read-only root files
are RAM) and its CPU time.

`--think 0` removes the pause between clicks (a stress test); `--tls CERT KEY`
serves HTTPS, and `--suite` limits the cipher suites, to compare them.

Measured on a Pi 1 B+ in a household evening (four people, two tablets): about
15% of its core and 5 MB of anonymous memory, a folder listing in 68 ms at the
median. A change worth measuring is one that should move these.
