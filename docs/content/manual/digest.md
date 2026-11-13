---
title: "Read your digests in the browser"
description: "Browse the tablet's digests by category or by source, open each where it came from, change its comment and category, and make, rename and delete categories."
weight: 2185
extra:
  reader: household
  type: how-to
---

# Read your digests in the browser

See the passages and handwriting you collected in the tablet's Digest app, go
from each back to the page it came from, change what you typed about it, move
it to another category or to the recycle bin, and make, rename and delete
categories. Digest sync must be [turned on](@/manual/digest-sync.md) first.
The tablet takes every change at its next sync. Making digests and writing
their handwritten notes stay the tablet's.

Choose **Digest** in the library's left rail. It opens on your categories, the
way To-Do opens on its lists: a card for each, with its newest passage whole,
where it came from, and how many of its digests carry a handwritten note.
Under **Digest** in the rail, as under **To-Do**:

- **All**: every digest, newest first.
- **Uncategorized**: the digests in no category.
- **Sources**: each document or notebook your digests come from, shown as the
  library shows a file, by the first page you took a passage from, with how
  many digests and over which pages; and what you typed on the tablet. A
  document's digests are in page order, so they read like notes on it from
  top to bottom.

Choose a digest to open it beside the list: the whole passage, the page it is
on, your comment, the note you wrote on it, its category and when you made it.
Choosing it again in the list, or **Escape**, closes it.
On a large screen a list opens with its first digest already beside it. **‹**,
at the top, goes back to the categories or the sources.

![The Digest page: All's digests in a column, each with its passage, its comment and where it came from, and one open beside it with a small picture of its page, its comment and its handwritten note.](screenshots/digest.png)

- **Open at page**, beside a small picture of that page, opens the document or
  notebook there. The reader's back button returns to the digest.
- **Edit**, beside **Comment**, changes the typed comment (**Add a comment**
  when there is none), up to 2000 characters, as on the tablet. **Save
  comment** keeps it; **Escape** or **Cancel** leaves it as it was. Until the
  tablet syncs, the digest says it is waiting for the tablet. If the tablet
  changed the same comment meanwhile, the later change wins.
- The digest's **⋯**, at its top, holds the rest:
  - **Move to…** puts it in another of your categories, in Uncategorized, or
    in a **New category…** you name there.
    It waits for the tablet the same way.
  - **Copy text** copies the passage.
  - **Move to bin** puts it in the [recycle bin](@/manual/deleted-file.md),
    with **Undo** for a moment after. The tablet deletes it too at its next
    sync, and restoring it brings it back on both.
- On a smaller screen the digest takes the list's place; **‹**, at the top,
  goes back to the list.

## Make, rename and delete categories

- **New category**, the **+** at the top of the categories, asks for a name.
  The name follows the tablet's rules, and the box says which one a name
  breaks: up to 150 characters, not starting with a dot, none of
  `/ < > * ? | \ : "`, and not the name of another category.
- **Rename category** and **Delete category** are in a category's **⋯**, on its
  card or at the top when you are inside it. **Uncategorized** can't be
  renamed or deleted.
- Deleting a category deletes its digests with it, as on the tablet. They wait
  in the recycle bin, and restoring one brings its category back too. If you
  had changed one of its digests on the tablet before it synced, the tablet
  should keep that digest and make the category again, so nothing you wrote
  there is lost. That is what its app's code says it does; it has not been
  seen on a tablet yet.

A digest whose file is no longer in the library (it was never synced, or it
moved) can't be opened, and says so. One from an EPUB offers **Open the file**
instead: the browser can't open an EPUB at a page yet. If a document's file
has changed since you took the digest, the digest says so, here and in the
document's **Digests**: the page it names may no longer hold the passage.

The other way round, a PDF or a notebook lists its own digests: **Digests**, in
its bar, shows them in page order beside the page, the ones on the page you
are on marked. Choose one to go to its page; **Open in Digest** brings you
back here.
