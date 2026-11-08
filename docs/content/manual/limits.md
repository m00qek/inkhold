---
title: "What doesn't work yet"
description: "The gaps, plainly: what Inkhold can't do today, and why."
weight: 3050
extra:
  reader: operator, household
  type: reference
---

# What doesn't work yet

The gaps, plainly, so you know before you try.

| What | Where it stands |
|---|---|
| **Digest sync** | Not implemented. Inkhold refuses the tablet's Digest requests on purpose, so with that switch on the tablet shows a sync error for Digest. Answering wrongly would be destructive: the Digest app imports whatever it is shown. |
| **To-Do sync** | Implemented, but new: it is off until you [turn it on](@/manual/todo-sync.md). Until then the tablet shows a sync error for To-Do, on purpose: told "no lists", the To-Do app would delete the ones it synced before. |
| **EPUB and Office files** | They upload, sync and download, but the browser has no viewer for them and their text is not searchable. Notebooks, PDFs, sketches, images and text files all open; notebooks, PDFs and text files are searchable. |
| **Handwriting on PDFs** (kept by the tablet in a `.mark` file beside the PDF) | Not searchable, by design. The tablet only recognises handwriting in notebooks. Recognising it ourselves is too heavy for a Raspberry Pi, and sending your handwriting to someone else's server is out of the question. |
| **The Supernote phone app** | Out of scope: it expects the server to draw the pages, which is the one thing Inkhold leaves to the browser. The tablet syncs directly; the app does not. |
| **Models other than the Nomad** | Very likely work, but [not confirmed yet](@/manual/devices.md). |

Something else surprising? [Open an issue](https://github.com/m00qek/inkhold/issues):
that feedback is the point of the beta.
