---
title: "Indexing decisions"
description: "Why derived data is keyed by content and re-derived rather than migrated, and why text comes from the tablet."
weight: 4050
extra:
  reader: contributor
  type: explanation
---

# Indexing decisions

What Inkhold derives from each file (page positions, text, thumbnails), when, and why it can always be rebuilt. The rules themselves: [Indexing and derived data](@/contributor/indexing-rules.md).

## Decisions

### Derived data is keyed by content

**Problem.** A file can be uploaded twice, restored or renamed; derived data must never go stale or need a migration to catch up.

**Decision.** Index rows and derived files are keyed by blob md5 and an `index_version`; a missing row or an old version is re-derived on read or by the worker.

**Cost.** Changing what a derived file holds means bumping `index_version`, which re-derives every document.

**Revisit when** never: it is what lets the server stay migration-free for derived data.

### Text comes from the device

**Problem.** Running handwriting recognition costs far more than a Pi can spare.

**Decision.** A notebook's text is the tablet's own recognition (`RECOGNTEXT`); PDFs and text files give their own text. There is no OCR.

**Cost.** Handwriting the tablet never recognised, and ink on PDFs, can't be searched.

**Revisit when** the server runs on hardware that can afford recognition and people ask for it. The rules themselves: [Indexing and derived data](@/contributor/indexing-rules.md).
