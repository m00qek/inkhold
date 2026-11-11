---
title: "Turn on Digest sync"
description: "Let the tablet's digests sync, and choose Retain locally when the tablet asks."
weight: 2105
extra:
  reader: operator
  type: how-to
---

# Turn on Digest sync

Let the tablet's digests sync with Inkhold: the excerpts you collect from
documents and notes, their categories, and the notes you write on them. Digest
sync is new and **not yet tested on a tablet**, so it is off until you turn it
on. While it is off, the tablet's Digest app shows a sync error, on purpose,
and nothing is touched.

1. **Export your digests first.** Long-press a digest in the tablet's Digest
   app and choose **Export**, or copy the tablet. A digest the tablet once
   synced, which a server then fails to list, is deleted from the tablet.
   Inkhold always lists every digest it keeps, but a copy is the safe way.
2. Set `digest_sync` in [config.zon](@/manual/configuration.md):

   ```zig
   .digest_sync = true,
   ```

3. Restart Inkhold.
4. Sync the tablet. If it asks how to treat its digest and to-do data, choose
   **Retain locally**: every digest is then sent to Inkhold as new, and none is
   deleted. **Delete locally** removes them from the tablet.

The digests are kept on the server and in your
[backups](@/manual/back-up.md). Reading them in the browser is not there yet:
see [What doesn't work yet](@/manual/limits.md).
