---
title: "Add a file type"
description: "Teach Inkhold to show, index and export a new kind of file."
weight: 2050
extra:
  reader: contributor
  type: how-to
---

# Add a file type

Teach Inkhold to show, index and export a new kind of file. A file type is a
row in nine decisions, in the browser app and the server; miss one and the
feature degrades silently.

| # | Where | Decides |
|---|---|---|
| 1 | `core/fileKind.ts` — `fileKind()` | which stage renders it |
| 2 | `core/fileKind.ts` — `canPreviewHistory()` | whether version preview is offered |
| 3 | `core/fileKind.ts` — `UPLOAD_ACCEPT` | whether the web may upload it |
| 4 | `render/thumbnails.ts` — `strategyFor()` | which thumbnail strategy draws its tile |
| 5 | `pages/galleryCards.ts` — `FACADE_THUMB_TYPES` | whether the card asks for a tile at all |
| 6 | `pages/library/library.ts` — `viewerFor()` | which viewer opens it |
| 7 | `api/fake.ts` | a fixture, or no e2e can reach it |
| 8 | `backend/services/controlplane.zig` — `fileTypeFor()` | the type the server reports (parser-verified, not the extension) |
| 9 | `backend/handlers/controlplane/bytes.zig` — `inline_types` | inline or attachment |

4 and 5 must agree; `thumbnails.test.ts` asserts it for every type. 8 is why a
`.mark` (a thin `.note`) reports as `"note"`.
Then:

1. Add the type's fixture to the fake API (row 7) and an e2e spec that opens
   it, the way `tests/e2e/txtViewer.spec.ts` does for `.txt`.
2. If it needs a viewer, compose the shared services ([The browser app](@/contributor/browser-app-rules.md))
   rather than copying one.
3. Add it to the user manual's [File types](@/manual/file-types.md) page.
4. [Run the tests](@/contributor/run-the-tests.md).
