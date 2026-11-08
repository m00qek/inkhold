---
title: "Turn on To-Do sync"
description: "Let the tablet's To-Do lists sync, and choose Retain locally when the tablet asks."
weight: 2100
extra:
  reader: operator
  type: how-to
---

# Turn on To-Do sync

Let the tablet's To-Do lists and tasks sync with Inkhold, so you can
[use them in a browser](@/manual/todo.md). To-Do sync is new, so it is off
until you turn it on. While it is off, the tablet's To-Do app shows a sync
error, on purpose, and nothing is touched.

1. **Copy the tablet first.** Told "no lists" by a server that doesn't keep
   them, the To-Do app deletes the ones it synced before. Inkhold is careful
   about this, but a copy is the safe way.
2. Set `todo_sync` in [config.zon](@/manual/configuration.md):

   ```zig
   .todo_sync = true,
   ```

3. Restart Inkhold.
4. Sync the tablet. If it asks how to treat its digest and to-do data, choose
   **Retain locally**: **Delete locally** removes them from the tablet.

**To-Do** appears in the library's left rail, with the tablet's lists and
tasks in it.

Digest sync is not implemented: see [What doesn't work yet](@/manual/limits.md).
