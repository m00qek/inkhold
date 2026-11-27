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
| **Digest sync** | New, and tested on one Nomad only: it is off until you [turn it on](@/manual/digest-sync.md). Digests, their categories and their handwritten notes are kept and synced. The browser [shows them](@/manual/digest.md), changes their typed comments, moves them between categories and to the recycle bin, and makes, renames and deletes categories; making digests and their handwritten notes stays the tablet's. A category deleted in the browser while the tablet holds an unsynced change to one of its digests should come back on the tablet with that digest; not yet seen on one. One from an EPUB opens the file, not its page; the tablet's tags on a digest are kept but not shown. |
| **To-Do sync** | Implemented, but new: it is off until you [turn it on](@/manual/todo-sync.md). Until then the tablet shows a sync error for To-Do, on purpose: told "no lists", the To-Do app would delete the ones it synced before. |
| **Comic books** | A comic book whose pages are WebP images doesn't open, on the tablet or in the browser: neither can decode them. A comic book stored as a tar still opens in the browser, but the server doesn't open it: its library card keeps a standard page shape. |
| **Very large documents** | The server gives reading a document at most 32 MB of memory, to spare a small server. A PDF, XPS document or comic book that needs more still opens in the browser, but the server leaves it out: its library card keeps a standard page shape and its text isn't searchable. For a comic book, what counts is its first page (a page scan that large); for a PDF or an XPS document, opening it, or one page's text, in which case only that page isn't searchable. |
| **Very large libraries in search** | Each browser keeps up to 32 MB of your documents' words for searching, less if it is short of storage: about a dozen long novels as text files, and far more notebooks. When your library has more, it keeps every notebook first, then the documents you changed most recently, and search says how many it left out; **Show them** under that line lists up to 50 of them by name, each opening the document, and counts the rest. Those are still found by name, and by Find once you open them. |
| **EPUB, FB2, Word and Kindle files** | They upload, sync and download, but the browser has no viewer for them and their text is not searchable. Notebooks, PDFs, XPS documents, comic books, sketches, images and text files all open; notebooks, PDFs, XPS documents and text files are searchable. |
| **Handwriting on PDFs** (kept by the tablet in a `.mark` file beside the PDF) | Not searchable, by design. The tablet only recognises handwriting in notebooks. Recognising it ourselves is too heavy for a Raspberry Pi, and sending your handwriting to someone else's server is out of the question. |
| **The Supernote phone app** | Out of scope: it expects the server to draw the pages, which is the one thing Inkhold leaves to the browser. The tablet syncs directly; the app does not. |
| **Models other than the Nomad** | Very likely work, but [not confirmed yet](@/manual/devices.md). |

Something else surprising? [Open an issue](https://github.com/m00qek/inkhold/issues):
that feedback is the point of the beta.
