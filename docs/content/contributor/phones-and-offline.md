---
title: "Phone and offline decisions"
description: "Why layout is intrinsic first, and why offline means navigating, not reading."
weight: 4090
extra:
  reader: contributor
  type: explanation
---

# Phone and offline decisions

How the app adapts to phones and tablets, and what works offline. The rules themselves: [Phones and offline](@/contributor/phones-rules.md).

## Decisions

### Intrinsic first

**Problem.** Width breakpoints alone break inside a narrow panel or a split screen.

**Decision.** Content sizes itself; a component asks its container how much room it has; media queries only switch the page's shape. Touch is its own question, `(pointer: coarse)`.

**Cost.** Layouts are harder to predict than fixed breakpoints, so the e2e guard visits phones and tablets.

**Revisit when** never.

### Offline means navigating, not reading

**Problem.** Keeping files on a device copies people's notes somewhere the household can't see.

**Decision.** The service worker keeps the app and the listings a person browses with, never a file: pages, PDFs, images and to-dos always come from the server.

**Cost.** Without a connection, nothing opens.

**Revisit when** people ask to read offline and accept copies on their devices.

Intrinsic first: content sizes itself (grids that fill, rows that wrap, The rules themselves: [Phones and offline](@/contributor/phones-rules.md).
rem sizes), a component asks its container how much room it has, and media
queries only switch the page's shape. That shape follows the room there is
(`00-tokens.css`): phone below 700px, tablet to 1099px, desktop from 1100px.
Touch is its own question, `(pointer: coarse)`, never inferred from width.
