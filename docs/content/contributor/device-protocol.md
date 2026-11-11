---
title: "Device protocol"
description: "Every request the Supernote makes, and what Inkhold answers."
weight: 3020
extra:
  reader: contributor
  type: reference
---

# Device protocol

What the Supernote does when it syncs, and what Inkhold must answer. Everything
here was learnt from a real tablet, a Nomad, by watching it and by reading the
decompiled apps; where a fact is an assumption rather than an observation, it
says so. The routes themselves are in the [HTTP API](@/contributor/http-api.md).

Every rule by which the tablet deletes, overwrites or resets its own data was
last checked against firmware Chauvet.E103.2610191001 (2026-11-09): the
launcher's file sync 1.01.086, Settings 1.01.385 and To-Do 1.00.466. A
firmware update can change any of it, so read the new apps again before
trusting it.

## What the tablet can and cannot be told

- **A failure is an HTTP 200 with a coded body**, for example
  `QUOTA_EXCEEDED`. Any 4xx or 5xx status reads to the tablet as the network
  failing in the middle of a sync.
- **Never answer 401 on a byte route.** A 401 signs the tablet out. A download
  with a bad capability token gets a 403 instead.
- **Never answer 404 from delete, move, copy or create.** A 404 aborts the
  sync, or makes the tablet download notes it had deleted. An id that is
  unknown, belongs to someone else, or is already in the bin gets a success
  answer with the payload left out. That also hides other people's id spaces.

## File sync

- The tablet has one way to delete, `delete_folder_v3`, which it uses for files
  too: one entity per request, children before parents, with retries.
- `move_v3` and `copy_v3` carry the full destination path including the file
  name. Copy is how the tablet resolves a conflict: it makes
  `<name>_CONFLICT_<timestamp>.note` beside the original.
- Without `create_folder_v2`, empty folders never sync.
- **A full sync is one call:** `list_folder` on `/` with `recursive: true`,
  with no paging. The tablet compares each file's md5 against that one answer.
  Inkhold computes paths in SQL with a recursive query over folders only;
  materialising the whole library was three to five times slower.
- **That answer must be the whole tree, every time.** A synced file missing
  from it is deleted on the tablet, so there is no cap, no paging and no
  partial answer: the tree is read in one snapshot under the database lock,
  and any failure is a 500, which aborts the tablet's sync before it compares
  anything. Never answer it with error code `E0304` or `E0318`: the launcher
  treats those two as success, reads no entries, and would delete every synced
  file.
- Only entries under `/NOTE/Note`, `/NOTE/MyStyle`, `/DOCUMENT/Document`,
  `/EXPORT`, `/SCREENSHOT` and `/INBOX` count, compared case-sensitively;
  anything else in the answer is ignored.
- `query/summary/*` is not file sync. It is the Digest app's protocol, found in
  the decompiled `KnowledgeApiService`.
- **The tablet's sync records survive signing out.** It keeps one record per
  synced file: its path, its md5 and the server's id for it. A record whose
  file is missing from the server reads as "deleted in the cloud", and the
  tablet deletes its own copy. It drops those records only at sign-in, and only
  when the `userId` or `uniqueMachineId` that `check/exists/server` reports, or
  the email, differs from what it stored; an empty stored value counts as a
  match. Inkhold reports the account's id and the library's id (the `library`
  table, schema v18). So a new library id makes every tablet sync from scratch:
  it merges and uploads, and never deletes. This was decompiled from the
  Settings app (firmware Chauvet.E103.2606141001), and the deletion was seen on
  a Nomad switched to an empty server under the same email.

## Sign-in and devices

- Sign-in sends `password = sha256_hex(md5_hex(password) + randomCode)`.
- The kind of client comes from the `equipment` field (1 is the web, 2 the
  phone app, 3 a tablet), not from `equipmentNo`: the phone app signs in with no
  serial number. A tablet's sign-in gets its token in the response body.
- **`bindEquipment` arrives without a token.** The Nomad sends it a few
  milliseconds after signing in, before it has stored the token. Inkhold
  accepts it only when a live tablet session for that serial number belongs to
  the named account. File calls usually arrive first and bind the serial number
  with a placeholder name; the bind call then replaces the placeholder. The
  `totalCapacity` it carries is the tablet's own storage, in KB, and is ignored:
  a tablet cannot raise its own allotment.
- `equipment/unlink` before sign-in, with no caller, is a no-op that answers
  success. A real unbind there would let anyone on the network sign a tablet
  out by the serial number printed on it.

## Bytes in and out

- **Downloads:** `download_v3` mints a `?t=` token (128 bits, about five
  minutes, usable more than once so retries and Range requests work) because
  the GET that follows carries no access token. `/oss/get` answers raw bytes
  with a `Content-Disposition` file name; without that name the tablet cannot
  write the note.
- **Uploads** are three calls. `upload/apply` binds the path and name, which
  are authoritative. `/oss/put` carries the bytes as multipart, in parts when
  the file is large; the tablet sends parts one after another. `upload/finish`
  checks that the md5 equals the `content_hash` the tablet declared. The size
  charged to the allotment is what landed on disk, not what was declared; the
  cap applies to the whole session, not to each part, and a retried part is
  credited back.
- `get_space_usage` is in bytes, confirmed on the tablet's screen.
  `user/query.totalCapacity` is in bytes by assumption.

## Auto Sync

- Auto Sync is a Socket.IO 2 / Engine.IO 3 websocket at `/socket.io/`. The
  tablet's token travels in the query string; the `sign=` HMAC uses a key from
  the firmware and is not checked.
- While the socket is up, the tablet uploads each local change at once, and
  runs a full sync when it connects.
- The tablet sends no Engine.IO pings. The heartbeat is the server's
  `ratta_ping` every 20 seconds, which the tablet answers.
- A change made elsewhere goes out as a `ServerMessage`,
  `{"code":"200","data":[MessageBean]}`. The tablet re-reads each message's
  file by `id` and reconciles, so only three things in the message matter: the
  id, a type it acts on (`MODIFYFILE`, `DELETEFILE`, and so on), and a path
  inside a synced folder. Its own uploads come back to it too, as a no-op.
- `STARTSYNC` is honoured only before the first full sync succeeds, so it
  cannot carry later changes.

## To-Do and Digest

- The To-Do and Digest apps have their own protocol (`schedule/*` and
  `query/summary/*`), and their `to-do` and `digest` events share the Auto
  Sync socket.
- **Neither may ever get an empty or made-up answer.** The To-Do app deletes
  every list and task it once synced that the server does not list. The Digest
  app imports whatever the server lists as collections: when
  `query/summary/group` presented folders as groups, it imported every folder
  (seen on hardware, 2026-11-05). A refusal is `success: false` at HTTP 200
  (401, 403 and 404 take other paths in the apps), and the app stops its sync
  before comparing anything.
- **To-Do sync** (schema v20, `services/todo.zig`, `handlers/device/todo.zig`)
  stores lists and tasks exactly as the app sends them, keyed by the tablet's
  own ids per account. The app decides every merge itself. A full sync starts
  at token 0 and reads absence as deletion, so a listing returns everything
  stored and the incoming `nextSyncToken` never narrows it. A row leaves only
  by an explicit delete, which always succeeds (one failed delete aborts the
  app's whole sync), or with its account. Deleting a list takes its tasks.
- **How the app merges** (decompiled `TaskSync`): a row present on both sides
  goes to whichever `lastModified` is strictly newer, and an equal one changes
  nothing; a task's order and planner order merge the same way by `sortTime`
  and `planerSortTime`. A row the server marks deleted is deleted on the
  tablet, which then deletes it on the server too. Lists page by `pageToken`
  and tasks by `nextPageToken`, 200 a page; any non-200 or `success: false`
  aborts before the merge.
- To-Do sync is behind `config.todo_sync`, off by default; while off, every
  call is refused.
- The browser edits the same rows (`services/todo_web.zig`,
  `/api/controlplane/todo`, `webapp/src/pages/todo/`) the way the tablet's app
  does: the server stamps the times, never below the row's own time plus one,
  so an edit still wins against a tablet whose clock runs ahead (an older or
  equal stamp would be silently overwritten); a new or moved task goes on top
  (sort 0, the newest sort time); and a reorder is a set of positions plus one
  sort time. "Waiting for the tablet" is schema v21: a browser edit marks the row and
  the account, and the tablet's next task listing clears the mark.
- A task lassoed from a notebook page shows its handwriting in the browser
  (`webapp/src/pages/todo/todoInk.ts`). The task's page is fetched and drawn
  once; the words it was lassoed from are found in the page's recognised text;
  only the strokes of that crop are kept, with paper and template lines made
  transparent and the crop trimmed to the ink, in the persistent thumbnail
  store under the page's version. It is shown as a mask painted in the theme's
  ink colour, in a chip at the row's edge that also opens the note. Those words
  are schema v22's `link_text`: the title the task had when its link arrived,
  kept through renames so the match survives them.
- **The library id does not protect to-dos.** The reset at sign-in
  (`doLogin: clear table of private cloud`, `clearSyncTable`) clears file
  records only (seen on hardware, 2026-11-05). What protects them is a prompt
  the same sign-in shows whenever the tablet remembers a previous account, the
  same account included. **Retain locally** marks every to-do unsynced, so it
  uploads. **Delete locally** (`todo/delete_synced_data`) removes the synced
  ones, losing any newer than a restored snapshot. A restore or a reinstall
  always forces that sign-in (sessions revoked, tokens invalid), which is why
  the docs, the restore command and the config all say to choose Retain.
- Tested on a Nomad, 2026-11-05: creating, completing, renaming, moving and
  deleting tasks and lists all synced. After a restore to a snapshot older than
  one synced task, Retain kept that task on the tablet and uploaded it again.
  A tablet whose account was unregistered and registered again (a changed
  `soldOutCount` at sign-in) skips the prompt, and Settings does the Retain
  itself (`SwitchCloudHelper.clearSyncState`); Inkhold never sends a
  `soldOutCount`, so that path does not arise.
- **Digest sync** (schema v23, `services/digest.zig`,
  `handlers/device/digest.zig`; decompiled `com.ratta.supernote.knowledge`
  1.00.133) stores digests and their categories in one table, as the official
  server does: a category is a row with `is_group`, a digest names it by uid in
  `parent_uid`, and `''` is the app's built-in Uncategorized, never a row. The
  app compares `query/summary/hash` against its own digests
  (`processKnowledgeHash`): a synced digest (server id above 0) the manifest
  lacks is **deleted on the tablet** unless edited there since; an empty
  manifest deletes them all. So the manifest and `query/summary/group` come as
  one call (page 0, size 0) and are answered whole; ids are AUTOINCREMENT,
  never reused; deletes always succeed; deleting a category deletes its
  digests. `query/summary` is paged by the app, 1-based, 1000 a page, until a
  short page.
- **A digest's comment or category, changed in the browser** (schema v25,
  `digest.applyWebEdit`; decompiled 1.00.153 `processKnowledgeDetail`). The app
  keeps, per digest, its data md5 now and as last synced. When only the
  server's md5 differs from the one it last synced, it copies the server's
  digest with no clock check; when both sides changed, the newer
  `lastModifiedTime` wins, a tie the server's. So the browser's edit sets a new
  random md5 and stamps `max(now, lastModifiedTime + 1)`, and touches nothing
  else: the handwritten note stays the tablet's. The category is
  `parentUniqueIdentifier`, which the app copies as the digest's
  `knowledgeBaseUniqueAttribute`, Uncategorized when it lacks that category;
  the server only moves a digest to one of the account's live categories. The
  tablet asking for the manifest is what clears "Waiting for the tablet", which
  puts that route on the writer.
- **Retain locally** for digests is the provider URI
  `knowledge/update_all_to_add_state`: every digest and every category but the
  default one goes back to server id 0 and state new, so the next sync uploads
  them all and deletes none. A restore therefore loses no digest when the
  docs' advice is followed.
- A digest from a document records its exact span: `metadata` (a JSON string)
  holds `document_location_data` (itself a JSON string: page from 0, chapter,
  start and end character), `source_size` and `unique_identifier`;
  `sourcePath` is the file's path in the tablet's own tree.
- A handwritten note is a `.mark` file. The app asks `upload/apply/summary`
  for a place, POSTs it multipart to `/api/oss/put` (a session whose path is
  `digest:`, which `upload/finish` refuses), and names the upload in its add
  or update; the server claims the blob then. A digest holds a blob reference
  exactly when `handwrite_inner_name` is set, and releases it when the note is
  replaced or the digest purged. `download/summary` gives a token URL for
  `/api/oss/summary/:id`; its token is minted for `id | 2^62`, so it never
  fetches a file.
- **A category always has an id.** The app's category picker reads every
  category's `uniqueIdentifier` and crashes on a null one, and a tablet can
  hold such categories (imported from folders by a pre-Digest Inkhold). So a
  category added or updated without one, or with `""`, which is the app's own
  Uncategorized, gets a random id and an `md5Hash` the tablet lacks. The app
  then sees the server's copy as changed, and its next sync copies the id onto
  the tablet (`updateLocalKnowledgeBaseFromServer`). Schema v24 did the same
  once for categories already stored.
- Both byte URLs sit under `/api/oss/` because the app moves only such URLs
  onto the address it was given (`replaceHost`). Any other keeps the scheme
  the server wrote, `http` behind a TLS proxy, and the proxy's 301 fails the
  sync.
- Digest sync is behind `config.digest_sync`, off by default. Not yet tested
  on a tablet.
