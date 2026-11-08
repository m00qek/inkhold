---
title: "The shape of the system"
description: "Why the server stays small enough for a 2014 Raspberry Pi, and what that cost."
weight: 4010
extra:
  reader: contributor
  type: explanation
---

# The shape of the system

Why Inkhold is one small program that leaves the hard work to the browser, and what that cost.

## Decisions

### One program, one port

**Problem.** A household should not run a stack: the official private cloud wants several services, a database server and gigabytes of memory.

**Decision.** One binary serves the tablet's sync, the browser's API and the app's files on one port, kept apart by caller scope (`.device`, `.controlplane`, `.pending`, `.public`); crossing a scope is a 403. One SQLite file, one writer.

**Cost.** Everything shares one process and one database lock; a slow route can be felt by the others (see [Concurrency decisions](@/contributor/concurrency-decisions.md)).

**Revisit when** a household needs more than one machine to serve it, which nobody has asked for.

### The server moves bytes; the browser does the work

**Problem.** Drawing a page, rendering a PDF, indexing and exporting each cost more than a Raspberry Pi 1 can spare for a household.

**Decision.** All of it runs in the browser, on WebAssembly decoders. The server never rasterises: it plans byte ranges from its index and streams them.

**Cost.** The browser downloads decoders (MuPDF alone is about 5 MB), a first visit is heavier, and an old phone draws more slowly than a server would.

**Revisit when** the target hardware is no longer a single ARMv6 core, or most readers are on devices too weak for the decoders.

### A Raspberry Pi 1 B+ is the budget

**Problem.** If it runs on the weakest hardware a household might have, it runs on anything.

**Decision.** One ARMv6 core and about 50 MB of anonymous memory (`RssAnon`; `VmRSS` also counts the mapped database and binary). No 64-bit atomics on ARMv6, so counters are `u32`/`usize`. Most choices that look unusual elsewhere in this manual come from this budget.

**Cost.** Simple designs are sometimes passed over for cheaper ones, and every change is measured on the Pi (see [Measure memory and speed on a Pi](@/contributor/measure-on-a-pi.md)).

**Revisit when** the Pi 1 stops being a machine anyone runs, and the measurements show the budget no longer shapes the code.

### A household, not a fleet

**Problem.** Multi-tenant designs (sharding, queues, many writers) cost memory and complexity a home server never repays.

**Decision.** A handful of devices and browsers, one SQLite file, one writer.

**Cost.** It doesn't scale past a household, by design.

**Revisit when** someone needs to serve many households from one install.
