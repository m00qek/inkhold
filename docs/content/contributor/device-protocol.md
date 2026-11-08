---
title: "Device protocol"
description: "Every request the Supernote makes, and what Inkhold answers."
weight: 3020
extra:
  reader: contributor
  type: reference
---

# Device protocol

What the Supernote does and what Inkhold must answer, reverse-engineered against a Nomad: facts here were observed on hardware unless marked otherwise.

## What the tablet can and cannot be told

- **Failures are HTTP 200 with a coded envelope** (`QUOTA_EXCEEDED`, …). A
  4xx/5xx reads to the tablet as a network failure mid-sync.
- **Never 401 on byte endpoints**: a 401 logs the device out. A bad download
  capability is 403.
- **Never 404 from delete/move/copy/create**: a 404 aborts the sync (or makes it
  re-download deleted notes). Unknown, foreign, already-trashed ids answer
  success with the payload omitted — which also hides other users' id spaces.
## File sync

- `delete_folder_v3` is the only delete, for files too, one entity per request,
  children first, with retries. `move_v3`/`copy_v3` carry a full destination
  path including the filename; copy is used for conflict resolution
  (`…_CONFLICT_<ts>.note`). Without `create_folder_v2` empty folders never sync.
- File sync walks the tree (`list_folder`, recursive) and diffs md5s; paths
  are computed in SQL from a folder-only recursive CTE (whole-library
  materialisation was a 3–5× regression). `query/summary/*` is NOT file sync:
  it is the Digest app's protocol (decompiled `KnowledgeApiService`).
- **Sync records survive sign-out.** The tablet keeps one record per synced
  file (path, md5, the server's id). A record whose file is missing from the
  server reads as "deleted in the cloud", and the tablet deletes its copy. It
  drops the records only at sign-in, when `check/exists/server`'s `userId` or
  `uniqueMachineId`, or the email, differs from what it stored; an empty
  stored value counts as a match. Inkhold reports the account id and the
  library id (`library` table, v18). A new library id makes tablets resync
  from scratch: they merge and upload, never delete. (Decompiled from the
  Settings app, firmware Chauvet.E103.2606141001; the deletion was seen on a
  Nomad switched to an empty server under the same email.)
## Sign-in and devices

- **Login:** `password = sha256_hex(md5_hex(pw) + randomCode)`. The kind of
  client comes from `equipment` (1 web, 2 app, 3 terminal), not `equipmentNo`:
  the Android app logs in with no serial. Device logins get the token in the
  body.
- **`bindEquipment` arrives without a token**: the Nomad sends it a few ms after
  login, before it has stored the token. It is accepted only when a live device
  session for that serial belongs to the named account. File calls usually
  arrive first and auto-bind the serial with a placeholder name; bind replaces
  the placeholder. Its `totalCapacity` is the device's own storage (KB) and is
  ignored — a device cannot raise its own quota.
- Pre-login `equipment/unlink` with no caller is a no-op success: a real unbind
  would let any LAN client log out a device by its printed serial.
## Bytes in and out

- **Downloads:** `download_v3` mints a `?t=` token (128-bit, ~5 min,
  multi-use for retries and Range) because the GET carries no access token.
  `/oss/get` is raw bytes with a `Content-Disposition` filename — without it the
  device cannot materialise the note.
- **Uploads:** `upload/apply` binds path and name (authoritative) → `/oss/put`
  (multipart, optionally chunked; the device uploads parts sequentially) →
  `upload/finish` (md5 must equal `content_hash`; the on-disk size is charged,
  not the declared one). The cap is per session, not per part, and retried parts
  are credited back.
- `get_space_usage` is bytes (confirmed on screen); `user/query.totalCapacity`
  is bytes by assumption.
## Auto Sync

- **Auto Sync** is a Socket.IO 2 / Engine.IO 3 websocket at `/socket.io/`
  (device token in the query; the `sign=` HMAC uses a firmware key and is not
  checked). While it is up the tablet uploads each local change at once and
  full-syncs on connect. It sends no Engine.IO pings: the server's
  `ratta_ping` every 20 s, which it answers, is the heartbeat. Changes made
  elsewhere go out as `ServerMessage` `{"code":"200","data":[MessageBean]}`;
  the tablet re-reads each by `id` and reconciles, so only the id, a type it
  acts on (`MODIFYFILE`, `DELETEFILE`, …) and a path inside a synced folder
  matter. Its own uploads come back too, as a no-op. `STARTSYNC` is honoured
  only before the first full sync succeeds, so it cannot carry later changes.
## To-Do and Digest

- To-Do and Digest ride their own protocol (`schedule/*`, `query/summary/*`;
  their `to-do`/`digest` events share the socket). Neither may ever get an
  empty or made-up answer: the To-Do app deletes every list and task it once
  synced that the server does not list, and the Digest app imports whatever
  the server lists as collections (it imported every folder when
  `query/summary/group` presented folders as groups, seen on hardware
  2026-11-05). Refused with `success: false` at 200 (401/403/404 take other
  paths in the apps), the sync stops before comparing anything.
- **To-Do sync** (schema v20, `services/todo.zig`, `handlers/device/todo.zig`)
  stores lists and tasks exactly as the app sends them, keyed by the tablet's
  own ids per account; the app decides every merge itself. A full sync starts
  at token 0 and reads absence as deletion, so listings return everything
  stored and the incoming `nextSyncToken` never narrows them; rows leave only
  by an explicit delete (which always succeeds: one failed delete aborts the
  app's whole sync) or with their account. Deleting a list takes its tasks.
  Behind `config.todo_sync`, off until proven on a tablet; off, every call is
  refused. The browser edits the same rows (`services/todo_web.zig`,
  `/api/controlplane/todo`, the To-Do page in `webapp/src/pages/todo/`) the way
  the tablet's app does: server-stamped times, new and moved tasks on top
  (sort 0, newest sort time), a reorder as positions plus one sort time.
  "Waiting for the tablet" is schema v21: a browser edit marks the row and the
  account, and a tablet's next task listing clears it. A lassoed task's
  handwriting is cut in the browser (`webapp/src/pages/todo/todoInk.ts`): the
  task's page is fetched and rendered once, the words it was lassoed from are
  found in the page's recognized text, and only the strokes of that crop are
  kept (paper and template lines turned transparent, trimmed to the ink), in
  the persistent thumbnail store under the page's version. It is shown as a
  mask painted in the theme's ink, in a chip at the row's edge that also opens
  the note. Those words are schema
  v22's `link_text`: the title the task had when its link arrived, kept through
  renames so the match survives them. **The library id does NOT protect to-dos**: its reset at sign-in
  (`doLogin: clear table of private cloud`, `clearSyncTable`) clears file
  records only (seen on hardware 2026-11-05). What protects them is a prompt
  the same sign-in shows whenever the tablet remembers a previous account,
  same account included: "Retain locally" marks every to-do unsynced, so it
  uploads; "Delete locally" (`todo/delete_synced_data`) removes the synced
  ones, losing any newer than a restored snapshot. A restore or reinstall
  always forces that sign-in (sessions revoked, tokens invalid), so the
  README, the restore command and the config tell users to choose Retain.
  Tested on a Nomad 2026-11-05: create, complete, rename, move and delete of
  tasks and lists all synced; after a restore to a snapshot older than one
  synced task, Retain kept it on the tablet and uploaded it again.
  Unverified: whether a tablet that was unregistered first (`hasUnregister`)
  skips the prompt and keeps its marks. Digest stays refused.
