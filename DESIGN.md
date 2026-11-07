# Inkhold design

What the code cannot say for itself: the invariants, the device's behaviour we
reverse-engineered, and why the system is shaped the way it is. Comments in the
code stay short and point here (`DESIGN.md §n`) when a rule spans files.

File formats have their own specs: [`parsers/note/note-format.md`](parsers/note/note-format.md)
and [`parsers/spd/spd-format.md`](parsers/spd/spd-format.md).

## 1. Shape

- **One binary, one port, three faces.** Device sync API, browser control-plane
  API and the static web app, kept apart by caller scope (`.device`,
  `.controlplane`, `.pending`, `.public`); crossing a scope is a 403.
- **The server moves bytes; the browser does the work.** Page rendering, PDF
  rendering, search indexing and querying, and export all run in the browser
  (WASM decoders). The server never rasterises.
- **The budget is a Raspberry Pi 1 B+:** one ARMv6 core, ~50 MB RSS (measured as
  `RssAnon`; `VmRSS` also counts the mmapped DB and binary). Every design choice
  below that looks unusual is usually this budget. No 64-bit atomics on ARMv6:
  counters are `u32`/`usize`.
- **A household, not a tenant fleet:** a handful of devices and browsers.
  Single SQLite file, single writer.

## 2. Storage

### 2.1 Invariants

- Every file operation is scoped by `user_id`. This is the core security
  guarantee; `Files.get` is the ownership boundary for every live read and is
  never relaxed. Narrow separate reads exist for the bin (`getTrashed`) and for
  device retries (`getAnyState`).
- Blobs are content-addressed by md5. Write order: stream to a temp file while
  hashing → fsync → verify the expected md5 → atomic rename to `<ab>/<md5>`. A
  name is its hash, so an existing blob is known-good and never overwritten.
- **Blob before commit, GC after commit.** Multi-table mutations run in one
  transaction; the blob (and any derived file) is on disk before the commit that
  references it and is removed only after the commit that drops the last
  reference. A crash can orphan a blob (harmless, swept), never leave a row
  pointing at missing bytes.
- `reapIfUnreferenced` is the single GC gate: `blobs.refcount = 0` (live
  `files` rows) and no `file_history` row.
- `parent_id` cascades, but cascades cannot decrement refcounts: anything a
  delete reaches must be in the decref set first (`releaseIds`, `purgeUser`).
- md5 lengths are checked where a key becomes a path (`finalRel`); offsets read
  from device-written metadata are hostile (`readRange` bounds every read).
- The server never holds a whole file: `blobstore.chunk_len` (64 KB) windows,
  compile-time because buffers live on the 1 MiB connection stacks (§3.1).

### 2.2 Recycle bin

- Two stages. `trash` sets `deleted = 1` and **holds every blob reference** —
  nothing is released or refunded. `purge`/`emptyBin`/`sweepBin` hard-delete and
  are the only decref callers besides account deletion.
- So `restore` is a flag flip, not a re-index. Restore also revives the trashed
  ancestor chain and a folder's trashed descendants, and auto-renames on
  collision (`freeName`: lowest free ` (n)`, deterministic so replays converge).
- `trash` is idempotent: the device deletes one entity per request, children
  first, with retries. A retry keeps the first `deleted_at` and does not bump the
  sync version.
- `deleted_path` freezes the path at trash time, so the bin listing survives
  later ancestor renames.
- Retention is not retroactive: an entry expires at
  `max(trashed_at, window_changed_at) + window`, so shortening the window never
  purges a month of notes at once.

### 2.3 Quota

- `used_bytes` sums the **distinct blobs** a user's rows keep alive, not file
  sizes: two identical files are one blob. Charge on a user's first reference,
  refund on their last. Dedup across users is not a discount.
- A reference is anything keeping bytes on disk: `files` rows, live or trashed,
  and `file_history` rows. Trashed files keep charging (refunding at trash time
  would let cycling the bin exceed real usage).
- Under quota pressure an edit evicts the user's oldest history-only versions
  rather than being refused; refusal mid-sync is worse than losing history.
- Refunds are computed from the rows after all writes (`settleRefund`), never
  predicted.

### 2.4 Version history

- On supersede, the `file_history` row is written before the decref, in the
  same transaction, so the GC gate keeps the old blob.
- Bounds: per-file `keep` (the owner's policy, ceiling `@max(keep, max_keep)`),
  then install-wide `max_bytes`, enforced by evicting **the writing user's**
  oldest versions only. `keep = 0` disables versioning.
- Restoring a version goes through the upload supersede path, so the displaced
  current is retained: restore is undoable.

### 2.5 `.mark` pairs

- The device writes a document's annotations to `<document full name>.mark`
  (extension appended). A pair lists as one row, the document's, which carries
  `annotationsId`.
- The rule is relational, not an extension list: same folder, exact stem, no
  chains (`a.mark.mark`), neither half a folder, same `deleted` state. One SQL
  rule (`mark_pairing.zig`) is shared by every listing; `pairOf` is the one
  entry point for mutations, so what a listing folds is exactly what a
  trash/restore/move/purge carries.
- A pair moves and renames as one. Ink is never composited onto a trashed
  document (trashed reads select `NULL` for the mark).

### 2.6 Backups

`inkhold backup` (`services/backup.zig`) is for a household: a folder of plain
files that a NAS share, a USB disk or a Dropbox folder carries intact. It is a
separate process beside a running server; scheduling is cron's or systemd's
(`contrib/systemd/` has a timer, shipped disabled; the Docker image runs
busybox crond beside the server when a volume is mounted at `/backup`).

- **Layout.** One shared store, `blobs/ab/<md5>[.gz]`, and one directory per
  snapshot (`YYYY-MM-DDTHHMMSSZ/`: `inkhold.db.gz`, `manifest.txt`, optionally
  `cred.key`). Blobs never change, so every snapshot is complete on its own:
  restoring needs one snapshot and the store, never a chain. No packing, no
  links: each run adds only new files, which is what sync clients upload.
- **Consistency.** Copy every blob the live `blobs` table names; `VACUUM INTO`
  a private copy; copy what that copy names and the store still lacks. A blob
  gone from the live store then was uploaded and purged inside the window, so
  the snapshot is retaken. Snapshot-first alone is wrong: blob-before-commit
  (§2.1) covers additions, not purges. References come from `blobs` only, the
  GC gate's record, which already counts the bin and history.
- **Atomic.** A snapshot is built as `<name>.partial/`, the manifest written
  last, then renamed. A manifest is refused when cut short, out of order or
  disagreeing with its header; `prune` reads every kept one to its end before
  deleting anything. One writer per directory: an O_EXCL lock file, not
  `flock` (which SMB and synced folders do not honour), stale after six hours.
- **Place.** The directory must already exist (a missing one is usually an
  unmounted NAS; creating it would fill the SD card) and must not be inside
  the live data. Sharing a filesystem with it is warned about. The private
  snapshot lives in `<data_dir>/backup-tmp`, never in the watched folder.
- **Compression.** gzip level 1 per blob, kept only when it saves 10%: on real
  notebooks and PDFs higher levels buy nothing. md5 names the decompressed
  bytes; gzip's trailer is checked by `gzfile.inflate`, since
  `flate.Decompress` does not.
- **Footprint.** 4 MB of anonymous memory whatever the library's size: md5s
  are streamed 256 per statement (short read transactions, so the server's WAL
  checkpoints), buffers sit in one ~420 KB scratch, each SQLite connection
  gets a 256 KB page cache (it reads each page once; 1 MB pushed a Pi 1 past
  the budget at 16,000 blobs). The process drops to nice 19 and the idle I/O class and reads at
  4 MiB/s by default. `scripts/footprint.py` pins all of it, at two sizes.
- **`cred.key`** stays out unless asked for, and the snapshot's legacy
  `password_md5` column is blanked, so a backup alone holds no usable
  credential. `restore` uses the snapshot's key, else the install's own if it
  decrypts the accounts, else a new key and a temporary password per account.
- **Restore** never writes over a database, refuses while the port answers,
  verifies first, and renames the database in last. A tablet that resumes
  syncing against an older server deletes what it holds that the server lacks
  (#21's mechanism; seen on a Nomad), and signing it out is not enough: it
  keeps its sync records across sign-out. So restore signs every device out
  AND gives the library a new id (§4), which makes each tablet start from
  scratch at its next sign-in. Thumbnails and search text are rebuilt by the
  server (§8.3).
- **The notice.** Households never read cron mail. `create` and `verify`
  record every run, good or failed, in `backup_runs` (one row per directory,
  schema v17), whenever the database is reachable; `restore` empties it.
  `backup/status.zig` judges it: a directory whose last run failed is
  `failed`, always; no success anywhere is `never`, unless an admin said they
  back up another way; the newest success anywhere older than
  `backup_warn_after_hours` (48) is `late`, so a weekly USB disk beside a
  nightly NAS is fine. Admins see it as one line in the library (no elevation,
  or it would hide behind a prompt); the Server panel lists each directory.

## 3. Concurrency

### 3.1 Threads and locks

- **Threads follow requests, not sockets.** The acceptor parks every socket
  with the poller (`http/poller.zig`, one `poll` thread); a readable one goes
  to a worker from a fixed pool (`workers`, 4) which serves it and parks it
  again. A parked plaintext socket is one `Conn` (`http/conn.zig`, ~34 KB) and
  no thread; `max_connections` (192) is therefore an fd budget. Only a `held`
  route (the SSE channel) gets a thread of its own, capped by `max_held`;
  sockets idle past `idle_timeout_s` are closed. Worker and held-stream stacks
  are 1 MiB, bisected empirically against a live 32 MB upload; re-bisect if
  the upload path's frames change. `scripts/footprint.py` pins these numbers in CI.
- One shared SQLite writer connection, serialised by `db_lock` around the whole
  handler. `std.Io.Mutex` is not reentrant: anything that takes `db_lock`
  itself (`indexSnapshot`, `pending.Pulse`) must not be called inside a
  `lockDb` bracket.
- **Lock order:** `Files.thumb_repair` first, `db_lock` second. `Pulse.mutex`
  is held across its recount including `db_lock`; nothing takes them reversed.
- Once a response head is sent, a failure returns without `body.end()` (it
  asserts the full `Content-Length` and panics in safe builds); the closed
  connection is the truncation signal.

### 3.2 Route flags

- `manual_db_lock`: streaming routes (`/oss/get`, `/oss/put`, page bytes, raw
  file, thumbnails, uploads, SSE) lock only around their own DB touches so a
  multi-MB transfer never holds the global lock. Their plans own inline copies
  so nothing borrows SQLite statement memory past the unlock.
- `read_only`: runs on a pooled `SQLITE_OPEN_READONLY` connection without
  `db_lock`. The flag is a claim about the whole call path, not the HTTP method
  (device POSTs pure reads; self-healing listings write, so they stay on the
  writer). Defaults to false. An integration audit probes every flagged route on
  a real reader and on the writer with an update hook armed.
- Banned pairs, asserted at comptime: `read_only` + `manual_db_lock`, and
  either one + `require_admin` (elevation renewal is an UPDATE on the automatic
  path).

### 3.3 Reader pool

- WAL allows many readers and one writer; one shared connection threw that away
  (a 3.4 s search on the Pi blocked everything). Readers win even on one core,
  through preemption.
- Borrow per operation, never per request: SSE streams live for minutes.
  Exhaustion returns null and the caller falls back to the writer under
  `db_lock` — the pool is an optimisation, its size (3) is tuning.
- Readers open after the writer has created and migrated the DB. The
  per-connection `temp` schema stays writable on a reader (used for the term
  fold scratch).

### 3.4 Deferred work

- Indexing on the upload path held the connection for the whole derive (48–60 s
  for a 16 MB `.txt` on the Pi), so post-upload work runs on one background
  worker at nice 19.
- **The job store is a query, not a queue.** Each tenant is a FROM/WHERE naming
  blobs that still owe work. That buys restart safety, idempotence (all writes
  are upserts) and live priority, with no claims or status column.
- Tenant shape: re-check under the lock → derive off the lock → verdict under
  the lock. **The derived file is the fact**: files are written before the
  verdict, never the reverse, or a crash marks an underived blob done for ever.
- A tenant that can never succeed records a verdict (over-cap, broken PDF, no
  text), or it is retried for ever. Each blob is offered at most once per
  drain; a 30 s idle tick paces retries.
- The tenant FROM/WHERE fragments are shared by the worker and the "indexing
  pending" count (`pending.zig`), which may only add bounds, so the two cannot
  disagree. Signal the worker after COMMIT, never inside the transaction.

## 4. Device protocol

Reverse-engineered against a Supernote Nomad; facts here were observed on
hardware unless marked otherwise.

- **Failures are HTTP 200 with a coded envelope** (`QUOTA_EXCEEDED`, …). A
  4xx/5xx reads to the tablet as a network failure mid-sync.
- **Never 401 on byte endpoints**: a 401 logs the device out. A bad download
  capability is 403.
- **Never 404 from delete/move/copy/create**: a 404 aborts the sync (or makes it
  re-download deleted notes). Unknown, foreign, already-trashed ids answer
  success with the payload omitted — which also hides other users' id spaces.
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

## 5. Auth and credentials

- The protocol needs `md5(pw)` recoverable, so no bcrypt/argon2: `md5(pw)` is
  stored encrypted (XChaCha20-Poly1305, per-row nonce) under `cred.key`, a
  32-byte 0600 file outside the DB. A stolen backup yields nothing; losing the
  key forces every password reset. Only `serve` may create the key.
- The browser bundles MD5/SHA-256: `crypto.subtle` exists only in secure
  contexts and the LAN deployment is plain HTTP. Plaintext never leaves the
  browser.
- Session tokens are stored as SHA-256 only. Lifetimes: device ~2 years, no
  idle (revoked by unlink); control plane 14 days idle / 90 absolute; pending
  (forced first-login change) 15 minutes.
- Control-plane cookie is `HttpOnly; SameSite=Strict` (`Secure` under TLS);
  that is the CSRF defence, deliberately the only one.
- Admin elevation re-runs the login challenge (nothing replayable over HTTP).
  15 min sliding, 60 min ceiling, stored on the session row. A lapse is 428
  `ELEVATION_REQUIRED`, not 401/403, which the SPA reads as a dead session.
  Every refusal is `INVALID_CREDENTIALS` so admins cannot be enumerated.
- Password-oracle rate limits are keyed by account, not IP: a household shares
  one address.
- Temporary passwords: one generator (4 diceware words), server-chosen so no
  admin knows a housemate's password, shown once, always must-change.
- Account routes take no target id (the session is the subject); admin routes
  always name `:id`. Both faces call the same service functions with
  `actor`/`target`, so one ownership decision covers both.

## 6. Security rules for untrusted content

- **No existence oracles.** Blobs are deduplicated across the household, so
  only a `files` row says whose bytes are whose. Foreign ids and md5s answer
  exactly like missing ones (404, byte-identical body).
- `/file/{id}` serves inline only an allowlist (png, jpg, webp, gif, pdf), with
  `nosniff`; everything else is an attachment. SVG/HTML from a device would be
  stored XSS.
- Link schemes are allowlisted (http, https, mailto) in the server, the PDF
  shim and the browser, because the exporter reads the same endpoints.
- `Content-Disposition` names are device-authored: allowlisted quoted form plus
  RFC 5987 `filename*`.
- A `.spd` is an attacker-supplied SQLite database: it is copied and
  deserialised read-only into `:memory:`, never opened as a file.
- Decoders bound every size with checked arithmetic (wasm32 `usize` is 32-bit
  and `ReleaseSmall` has no overflow traps).

## 7. Schema and migrations

- v1 is the verbatim schema of a long-way-migrated install, so fresh and
  migrated databases are byte-identical (a test compares `sqlite_master`).
  Never edit `ddl_v1`; additive changes live in their own step.
- A data step that changes a shipped version's outcome gets a new version — a
  step folded into an applied version never runs. `steps.len == version` is
  checked at comptime.
- Each step and its `user_version` stamp is one `BEGIN IMMEDIATE` transaction;
  a partial step once bricked boot.
- Verdict columns (`pdf_probe`, `pdf_text`, `txt_index`, `has_ink`) are
  nullable, NULL meaning "not looked at yet" — exactly what the worker's tenants
  select (§3.4).
- Some indexes are load-bearing by plan (`files_live_name` is named in an
  `INDEXED BY`; others are pinned by VM-step tests).

## 8. Indexing and derived data

### 8.1 `.note` index

- Parse unlocked, write locked: parsing is pure CPU over addressed ranges
  (kilobytes allocated for a 40 MB note); rows are written in the caller's
  transaction.
- Rows are keyed by blob md5, so they are never stale and are shared by every
  deduped file; any read joins through `files` for ownership.
- Self-healing, no backfill migrations: a missing row or one at an old
  `index_version` is re-parsed on read. Concurrent heals are harmless (upserts).
- Landscape pages (`ORIENTATION = 1090`) store their raster natively landscape;
  effective dimensions are stored per page. Wrong width shears silently.

### 8.2 `index_version`

The browser caches derived text under `(md5, index_version)`. Bump it **only**
when what that key names changes (the derived `terms/` and `text/` files). A
bump re-derives every document. A new column with unchanged derived bytes does
not bump (it heals through a tenant instead).

### 8.3 Derived stores

- `terms/` and `text/` files carry `index_version` in their name; a DB column
  may cache existence but is never the authority. A crash between writing the
  new version and retiring the old leaves both, which is safe.
- Stored as raw-deflate fragments with CRC and length up front, `flush()`ed
  (no BFINAL) so they concatenate (§10).
- Thumbnails are not blobs: keyed by source md5 so they die with it. fsync
  before rename even for a cache (ext4 can persist a zero-length file).
- The server only serves images files already carry (`.spd` thumbnail, a
  `.note` user cover); covers are located at index time and streamed, never
  buffered.

### 8.4 Per format

- **`.note`:** text comes from the device's own recognition (`RECOGNTEXT`, no
  OCR), derived at upload. `has_ink` is tri-state (NULL = unread layer); the
  background never counts, a hidden layer does.
- **PDF:** all MuPDF calls are in C (`fz_try` is setjmp/longjmp; a Zig frame in
  between is UB). One tenant does probe then text, because each blob is offered
  once per drain. The text pass caps MuPDF's store at 4 MB and reopens every 32
  pages — what makes the 50 MB budget close. Page shape is `fz_bound_page`,
  never raw `/MediaBox`. Private Use Area glyphs become spaces (the tokenizer
  treats them as word characters). Capped at 5,000 pages, recorded as truncated.
- **`.txt`:** paragraph segments (blank-line split, ~8 KB cap), addressed by
  byte range into the raw blob; search AND-semantics are per paragraph.
- **`.spd`:** parsed once per blob; a parse failure is a memoised
  `indexable = 0`.

## 9. Serving and caching

### 9.1 Pages

- A page response is planned from the index alone (`pagePlan`: exact
  `Content-Length`, ETag = stored content hash) and then streamed from the blob
  with the lock released. Peak heap stays under one chunk.
- The page `?v=` hash covers layer bitmaps only; recognition text and template
  links have their own hashes because they change without the strokes changing.
- SNPG (our page envelope) is versioned in band; bumping it must also move the
  `?v=` domain.

### 9.2 Cache rule

`immutable` only when the cache key covers everything that can change. A
content hash covers opaque bytes; it never covers a JSON struct serialised
around them (page text was once immutable and pinned responses without `words`
for a year). Struct-serialised bodies are `no-cache`. `index.html` is
`no-cache`; `/assets/*` is immutable.

### 9.3 Live channel

SSE on `/api/controlplane/events` carries `event: sync` (the per-user sync
version, polled server-side every 500 ms) and `event: index` (pending count).
Held streams are admission-controlled (16 total, 4 per user) and degrade to a
one-shot frame plus `retry:`, never a 503.

## 10. Search

- **There is no server search.** The browser downloads per-document derived
  text and answers every query from a local FTS5 index in `sqlite-core.wasm`.
  The server-side FTS index was removed: it held `db_lock` for 98 s per
  whole-library ingest on the Pi.
- **One tokenizer.** Server and browser share `schema.fts_tokenizer`
  (`unicode61 remove_diacritics 2`); query text goes to the wasm raw. Any
  folding or escaping in JS would be a second tokenizer.
- **The manifest has no tombstones.** It is the caller's complete live document
  set (binary `SMAN`: md5, tier, derivation state, id, time, version) and
  replaces the client's set wholesale; absence is the only deletion. So any
  LIMIT or extra filter is a correctness bug, and truncation is detectable
  (fixed-width row count up front). ETag is the body's md5.
- **Derivation state** separates "derived and empty" from "not derived yet";
  caching the latter's emptiness would make a document unsearchable for ever.
- **Fetch:** the client sends a `want=` bitmap over manifest positions (LSB
  first, canonical base64url) and receives one stitched gzip stream. It must be
  one gzip member: Chromium and curl decode only the first member of a
  concatenated stream and report success (Node decodes all, so Node tests lie).
  Missing fragments are skipped, so the stream is chunked and `no-store`.
- Golden vectors (`manifest_golden.bin`, `want_golden.txt`) are checked by both
  the Zig encoder and the TS decoder; never regenerate one to make a side pass.
- **Typo ladder** (in-wasm, Damerau-Levenshtein): only when the exact query has
  zero hits — the corpus is misspelt handwriting recognition. English-oriented
  stemmers/spellfix were rejected (the corpus is Portuguese).
- **To-dos in search** (`todoModel.findTodos`, `todo/todoSearch.ts`): a task
  is found by its title, the notebook and the words it was lassoed from
  (`link_text`, so a renamed task is still found by what was written) and its
  list's name, all together by the name rule; lists named like the query are
  results too. Matched words are marked. When nothing matches as typed, the
  typo ladder's rules (`search/typo.ts`, a browser copy of the wasm one) pick
  the nearest spelling, said as for notes. To-dos are read at start and, while
  the To-Do page is closed, again by a search when over a minute old; an
  answer repaints the open search.
- **One rule for names.** Note and folder names and to-dos are not in the
  index; `webapp/src/search/match.ts` matches them by the index's rule: the
  query's words folded the same way, all present in any order, only the last
  matched as the start of a word. Only when that matches no name at all does
  the typed text match anywhere inside one ("style" in "MyStyle"): a fallback,
  never a widening, like the typo ladder.
- **Measured** (`npm run bench:search`, laptop, 2026-11-05; real wasm, libraries
  shaped like the hub's: 45 docs, 231 text pages, 54 distinct words a page).
  A whole rebuild, which every sync that brings anything new costs the next
  search: 4 ms at 1x, 24 ms at 10x (450 docs), 674 ms at 100x (4,500 docs,
  58 MB). Queries stay under 10 ms; a typo-ladder scan is 90 ms at 100x. So the
  rebuild only matters past a few thousand documents; IndexedDB reads are not
  in these numbers.
- **Ranking** (`search/localSearch.ts`): names matched by words first (then,
  only when none did, names matched inside), then documents by relevance:
  matching pages over the document's pages plus two, weighted 1 for what the
  person wrote (notes), 0.8 for a document they wrote on (a `.mark`: its ink
  is not indexed, only the printed words, but it was worked with) and 0.6 for
  a PDF or `.txt` as it came; recency breaks ties. A weight, not an order: a
  document about the words still beats a note that mentions them once. The
  to-dos, also the person's writing, sit before the first document that is
  neither named like the query nor a note. bm25 is not used: the terms are one per page,
  so it can't tell a page about a word from one that mentions it. How close the
  words sit picks a document's excerpt, not its place: ranking by it would read
  every result's text before showing any.
- **Coverage** (`services/search/coverage.zig`, `GET
  /api/controlplane/search-index/coverage`, `pages/searchCoverage.ts`): only
  what the tablet recognized is searchable, so search says how much that is.
  Per live `.note` with writing: pages with writing (`has_ink` not 0, or
  recognized to non-empty text; the tablet also "recognizes" blank pages, to
  nothing), how many were recognized, how many it was still recognizing at
  sync (`RECOGNSTATUS` 2), and whether recognition is on (`FILE_RECOGN_TYPE`).
  One query, asked for by search (at most once a minute), never by listings.
  Shown as a line under results, under "No matches" and while the query is
  too short, opening to the notes search can't fully read and why. The
  tablet's titles and keywords are not indexed; none of the hub's notes had
  any (2026-11-05).
- **Find in a document** (`pages/viewer/findSession.ts`): one session for
  every viewer; a note, a PDF and a `.txt` bring only a surface (how a
  segment's marks are drawn and a segment brought into view: a page, or a
  paragraph). On the first find the viewer fetches the document's text
  (`text/<md5>`, unless `textPrefetch` already holds it) and builds a one-
  document FTS5 index in the browser; the count is the index's, never the
  marks', and stepping goes match by match ("3 of 12"). It never says "No
  matches" for a search that didn't happen: a note the device never
  recognised, text the server has not extracted yet (a 404 the manifest
  marks `pending`, a job still owing it: "still being indexed", asked again
  every 15 s while the bar is open; a document the manifest doesn't list, a
  bin or version preview, is never promised that), a record with no text (a scanned PDF, an empty file), or
  a failure. A PDF past the server's 5,000-page extraction cap is searched
  in its first 5,000 pages, and the count says so. A typo-tolerant answer
  is held behind "Try similar spellings". Only a move (a landing, a step)
  scrolls the current match into view; a repaint never does. The field is a
  query: no autocorrect, capitals or spellcheck.
- **Quoted phrases** (`search/phrase.ts`): `"passé composé"` wants the words
  together, in order. The terms are one set per page, so the index finds the
  candidate pages and the page text decides: library search checks against
  the text the browser holds (`searchService.checkPhrases`), keeping and
  counting, never dropping, a document whose text it doesn't hold ("N results
  couldn't be checked"); in-document find checks the segments it already
  loaded; names and to-dos check their own words. A quote still being typed is
  a phrase whose last word may be a start; a single quoted word is a word.
- **Excerpts** (`search/excerpt.ts`, `pages/searchExcerpts.ts`): a result's
  line is cut in the browser from text it already holds; a search never
  fetches text. After each sync the browser keeps text ahead of time
  (`search/textPrefetch.ts`): every note, then marked documents, then every
  other PDF and `.txt`, newest first, within a 2 MB allowance (a quarter of it
  at most per document). A document too big for it is remembered in
  `localStorage` by text version, so it isn't fetched again only to be refused. Among the first 50 matching
  pages, the shortest stretch holding every query word wins, then words matched
  whole over a typed prefix, then the earliest page; where the typo ladder
  answered, its words are looked for. The result opens on the excerpt's page.
  Lines fill as results scroll into view, after the row is painted, and work
  for a result a newer query replaced is skipped. Measured: 0.2 ms for a
  5-page note, 5.5 ms for a dense PDF at the 50-page cap.

## 11. Browser app

### 11.1 Seams

`main.ts` wires four seams; each has a real and a fake implementation (dev and
e2e run on the fakes, `?real`/`?fake` override):

| Seam | Real | What it owns |
|---|---|---|
| `Api` (`api/types.ts`) | `createHttpApi()` | the wire contract; `api/fake.ts` is the reference behaviour |
| `NoteRenderer` (`render/types.ts`) | `createWasmRenderer()` | SNPG → RGBA in `note-decode.wasm` |
| `RenderCache` (`cache/types.ts`) | `renderCache.ts` | rendered pixels (§11.4) |
| `LiveChannel` (`sync/types.ts`) | `live.ts` (SSE) | freshness (§9.3) |

Golden wire fixtures in `webapp/tests/fixtures/wire/` pin the server's JSON
through the client normalisers (`INK_UPDATE_WIRE_FIXTURES=1 zig build test`
regenerates them).

### 11.2 Routing

Hash routing (the server has no SPA fallback). Every place has a URL;
navigation pushes, adjustments (page turns, find queries) replace, so Back
leaves a note in one step. URL pages are one-based. Trashed files live under
`#/bin/note/:id` because live routes 404 them; past versions are addressed by an
md5 prefix.

### 11.3 Viewers

Four viewers share one four-method `Viewer` interface (`el`/`open`/`hide`/
`destroy`) and compose shared services (viewer chrome, toolbar, side panel,
page index, layers panel, thumbnails, virtual list) instead of inheriting.
Reach for those before writing a private copy.

A PDF is its own viewer: its pages share resources through the xref, so the
document is opened once in a worker (MuPDF, ~5 MB of wasm, one session for the
viewer's life), streamed by Range requests through a 32 KB block cache. A PDF
has no version history of its own; its `.mark` does.

### 11.4 Caches

- L0 app shell: fingerprinted, immutable. L1 listing/metadata: the only layer
  that revalidates, stale-while-revalidate gated on the sync version. L2 page
  bytes: immutable under `?v=`, browser HTTP cache. L3 rendered pixels:
  `RenderCache`, keyed by (content hash, size tier, theme), never a source of
  truth.
- **One persistent pixel store**, `sn-thumbs`, shared by the render cache and
  thumbnails under one byte budget. Thumbnails persist as WebP (raw RGBA was
  20–40× larger); reader pages stay in memory.
- Other IndexedDB caches each have their own database, so adding a store never
  needs a version bump another module's open connection would block. All
  degrade to no-ops when storage is unavailable.
- Never paint an off-screen page: every canvas renders lazily through
  `IntersectionObserver`; a theme toggle repaints only what is visible.

### 11.5 Adding a file type

A file type is a row in nine decisions. Miss one and the feature degrades
silently.

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

### 11.6 Export

- Client-side, always: native resolution, light theme, bypassing the render
  cache. Download-only — exports never enter the device's `EXPORT/` folder.
- The PDF writer is dependency-free and streaming: it pulls one page at a time
  and returns a Blob of chunks, so a whole notebook peaks at about one page.
- An invisible text layer only at a **verified** mm scale (`pxPerMm`, an
  allowlist of measured hardware; only `N6`, the Nomad, today). A missing text layer is
  obvious; a mis-scaled one is silently wrong.
- Annotated PDFs export as an incremental update over the original bytes
  (keeping forms, bookmarks, annotations); ink is drawn into page content, not
  as an annotation.

### 11.7 WASM rules

- Any call can grow linear memory and detach `memory.buffer`: create views after
  the producing call, never keep them, copy out before the next call.
- `sqlite-core.wasm` serves both the `.spd` viewer and the search index (SQLite
  is most of its size). It runs on a null VFS, so `SQLITE_TEMP_STORE=3` is
  mandatory and checked at open.
- MuPDF needs the wasm exception-handling proposal: the browser floor is about
  Chrome 95 / Firefox 131 / Safari 18.4. Every export that can suspend on
  `ink.host_read` must be wrapped for JSPI.
- MuPDF is a pinned, unpatched dependency; upstream bugs are worked around by
  excluding sources and supplying stubs (`load-jpx.c`), not by patching.

### 11.8 Markup and styles

Held by `tests/e2e/semantics.spec.ts` (every main screen, at desktop in both
themes and at phone width): axe-core's WCAG 2.2 AA and best-practice rules,
plus the structure axe doesn't judge (`helpers/semantics.ts`). Both must find
nothing. `tests/e2e/focus.spec.ts` holds that every Tab stop shows focus.

- **Landmarks:** one `<main>` (the content area; pre-auth screens have their
  own), the top bar a `<header>`, the search box a search landmark, the rail
  the navigation landmark ("Library"), breadcrumbs a "Breadcrumb" navigation.
  Panels inside `<main>` are named regions, not asides. A "Skip to content"
  link comes first.
- **Where you are:** one `<h1>` per screen, and the tab's title with it
  (`ui/place.ts`): library screens are named by the breadcrumbs' current
  place, a viewer or To-Do by itself. Focus moves to the heading on a change of
  screen, only after the person has acted and never while typing. Sections
  are `<h2>`s.
- **Links and buttons:** anything that goes somewhere is an `<a href>` (it
  opens in a new tab, says where it leads); a plain click still runs the app's
  own action (`ui/link.ts`). Buttons are actions. A place with no address (a
  category the tablet hasn't created) is a button marked `data-no-address`.
- **Collections are lists.** Gallery cards are `<li>`s in `ul.cards`, which is
  `display: contents` so each card stays a grid cell (`masonry.ts` looks
  inside).
- **Announcements** are small status regions holding the message only, never
  the buttons beside it. Icons are hidden from screen readers (`svg()` emits
  `aria-hidden`).
- **Targets:** at least 24px with a mouse and 44px on a touch screen
  (`pointer: coarse` grows the control tokens; a zero-specificity rule gives
  anything pressable a minimum).
- **Toggles** say their state with `aria-pressed`, and show it: ON is filled
  in ink with the icon in the paper colour, OFF has no fill, so the two never
  differ by a shade of grey. Never the accent: that is the focus ring, and a
  focused button must not look switched on. A menu trigger's open state
  (`aria-expanded`) stays the quieter outline.
- **Contrast:** 4.5:1 for all text in both themes; the soft and faint greys
  are tuned to it on every surface they sit on.
- **Styles** (`scripts/lint-styles.mjs` enforces): sizes from tokens; type,
  spacing and control heights in rem (they follow the reader's text size;
  touch minimums keep a px floor); start/end, never left/right; z-index only
  from the `--z-…` scale; colours and shadows only from tokens; no class the
  app never sets (the few built at runtime are listed). Breakpoints are the set
  written in `00-tokens.css`: phone below 700px, tablet to 1099px, desktop
  from 1100px.
- **Pixel proof:** `VISUAL_DIR=<dir> npx playwright test visual` and
  `scripts/visual-diff.sh <before> <after>` show a change that must move
  nothing moved nothing.
- **Engines:** Chromium runs everything; `E2E_BROWSER=webkit` runs Safari's
  engine (every iPhone browser) on devlab's inkhold-ci, since WebKit needs
  Debian/Ubuntu libraries.

### 11.9 Phones and tablets

Intrinsic first: content sizes itself (grids that fill, rows that wrap,
rem sizes), a component asks its container how much room it has, and media
queries only switch the page's shape. That shape follows the room there is
(`00-tokens.css`): phone below 700px, tablet to 1099px, desktop from 1100px.
Touch is its own question, `(pointer: coarse)`, never inferred from width.

- **Viewer bars** (`styles/10-toolbar.css`) are containers (`bar`). Under
  60rem of bar, Back and the file's actions drop their words (still named)
  and controls in a zone close up; under what that fits, the zones wrap. A
  title gives way first (`flex: 1 1 8rem`). The export menu hangs from the
  trigger's start when the bar has wrapped. On a phone the bar is no
  container, so its bottom row can be `fixed` to the screen.

- **Phone** (`pages/library/libraryPhone.ts`, `styles/23-phone.css`): the
  rail is a drawer from the bar's ☰ (modal: the rest is inert, focus goes in
  and back to ☰; Escape, the scrim or a link closes it). The bar keeps ☰, the
  place's name and ⋯ (its tools as one menu; shown only when it has some).
  A tab bar holds Library, To-Do, Search and You; its Search opens the box
  across the bar, which stays while it holds a query. The tab bar gives way
  to a viewer's own bar. Cards run two columns. Viewers keep ‹, the title and ⋯ on top and
  one row at the bottom: paging, then the panel switches (Recognized text,
  Layers, Pages; a PDF's Pages, Outline, Annotations), kept in view because
  a switch's state is worth seeing (text size for text). Zoom is a pinch,
  and a double tap back to Fit (`ui/pinchZoom.ts`): the page scales by a
  transform while the fingers move, then the viewer re-renders sharp at
  that factor of Fit and the point under the fingers stays put. A quick
  sideways swipe turns the page, left for the next (`ui/swipePages.ts`);
  a page zoomed past the stage pans first and turns only from the edge it
  started at, and the pager stays the one-pointer way. A `.txt` drops its
  paper card: the text fills the screen's width and the column-width zoom
  is hidden, leaving text size. The page opts into `viewport-fit=cover`:
  the shell pads itself below the status bar (the band behind it in the top
  bar's colour) and every bottom bar pads above the home indicator, all by
  `env(safe-area-inset-*)`. The zoom
  stepper is the one-finger way (WCAG 2.5.1), in ⋯ with the other
  occasional tools (`fold` in the toolbar spec: Find, zoom) and the file's
  actions, the tools under "View", ticked while on. A viewer's panels start
  closed on a phone and open as ONE sheet sitting on the bottom row, never
  beside the page: one open at a time, a fixed height (Pages a short strip
  whose thumbnails run sideways), a × in its head. The stage pads itself
  clear of the bar (`--phone-bar-h`, measured) and of an open sheet, and
  Fit measures that padded box, so the page always lands above both. Every place below another has
  ‹ in ☰'s place, one level up (a folder's parent, Lists, the folder a
  search started from): iPhones have no back button. A viewer's Find sits
  beside ⋯ in the top row (`top` in the toolbar spec: moved there, not
  copied, so focus order follows what you see). Menus are sheets
  along the bottom (`placePop` sets `data-sheet`). On a touch screen controls are 44px.
- **A bar with no room folds into ⋯** (`ui/barMenu.ts`): its controls become
  ONE menu, in the bar's order, a divider wherever the bar has one (and
  around each choice). A select becomes its options and a pressed-button
  group its buttons, the current one ticked (`menuitemradio`); a button
  with a menu of its own brings that menu's rows in (`setMenuRows`, else its
  in-page `.menu__pop`) when short; a long one (more than `SUBMENU_AT`, 4,
  items: a viewer's Download) is one row with ›, that opens its rows in the
  same sheet under a ‹ row back, rather than burying the rest of ⋯. An
  action is listed once (`onceEach`): a row repeats one of the same name in
  the same section, or one in no section (the file's own action), never
  merely a namesake (two views' "PDF document" are two files); any other
  button is a row with its icon and name. Rows only forward to the bar's
  control. On a phone: the library bar's tools, To-Do's (New list, the
  list's actions, Download), and each viewer's file zone. ⋯ shows only when
  there is something behind it. Sheets along the bottom stay open through
  scrolls and resizes (no trigger holds them), and a gallery repaint closes
  only menus whose trigger it replaces.
- **Tablet:** the rail is a strip of icons; names stay in the accessibility
  tree and in a tooltip.
- **Text size:** the rail's width, the account page's label gutter and the
  viewers' toolbar (which wraps) follow the text size, so 200% clips
  nothing. On touch screens the root takes Apple's body style
  (`-apple-system-body`), so iPhones follow the system's Larger Text; on a Mac
  it would shrink the app, hence touch only.
- **Tests:** the guard adds a tablet in portrait (820px) and in landscape
  (1180px, desktop layout under a finger), both with touch; `tests/e2e/phone.spec.ts` holds the
  drawer, the tab bar, search, sheets and the viewer's bottom bar.

### 11.10 Installing and offline

The app installs as a PWA: `public/manifest.webmanifest` (name, `standalone`,
the desk colour, icons from `icons/build.sh`) and a service worker,
`sw/sw.js`, which `vite.config.ts` writes into each build with that build's
file list and a version hashed from the files and the worker's own code.
Production builds only; dev never registers one.

- **What the device keeps.** The app's own files (cache-first), and the
  listings a person browses with: `/api/user/me`, the folder tree, the bin,
  storage use (network-first, the stored copy only when the network fails).
  That is names and counts, never a file: pages, PDFs, images, transcripts
  and to-dos always come from the server. The wasm decoders are not kept
  either; only reading needs them.
- **Forgetting.** Signing out, or the server refusing the session (401/403
  on any listing), deletes the stored listings. `server-info` is not kept,
  since the sign-in page reads it.
- **Offline.** The app opens and browses what this device has seen. Opening a
  file, a version or To-Do says it needs a connection and stays put
  (`libraryRoutes.ts`, `offline()`), instead of a viewer that never fills.
- **Updates.** A new build installs beside the old one and waits; the page
  offers "A new version of Inkhold is ready" with Reload, and only then does
  the new one take over (`src/pwa/register.ts`). It reloads once the new
  worker is `activated`, not on `controllerchange`: a reload while it is
  still activating can stall. An installed app looks for updates when it
  comes back to the foreground.
- **Server.** `sw.js` and the manifest are `no-cache` like every unhashed
  file (`backend/http/static.zig`); the manifest is served as
  `application/manifest+json`.
- **Tests.** `tests/e2e/pwa.spec.ts`, run with
  `npx playwright test -c playwright.pwa.config.ts` against a production
  build: the manifest, offline browsing, what is and is not kept, sign-out
  and a refused session, offline opening, and the update offer.

## 12. Where things live

The directories are layers. An import points down the list, never up: a file
in `services/` may import `store/` and `db/`, and nothing in `store/` knows
`http/` exists. The one deliberate exception is `http/context.zig`, the
per-request bag of service pointers every handler receives.

| layer | directory | holds |
|---|---|---|
| entry | `backend/main.zig`, `cli.zig`, `cli/`, `app.zig`, `routes.zig`, `config.zig` | process start, the CLI grammar, the composition root, the route table |
| transport | `http/` | the accept loop and TLS, the router, request context, replies, multipart, static files, rate limits, SSE admission, lock histograms |
| handlers | `handlers/` | one function per route, in `auth`, `device/`, `controlplane/`, `admin`; thin HTTP shells that parse, call a service, reply |
| services | `services/` | the domain: `files` (tree, bin, quota, history), `auth/`, `controlplane` (the browser's JSON shapes), `sync`, `settings`, `backup` (§2.6), the indexers (`note_index`, `spd_index`, `txt_index`, `pdf_index`, `pdf_text`, `ink_scan`, `derive_search`), `deferred` (the worker), `pending`, `search/` |
| stores | `store/` | content-addressed bytes on disk: blobs, thumbnails, derived files |
| db | `db/` | the SQLite wrapper, the schema and migrations, the reader pool |
| leaf | `compress/`, `pdf/`, `util/` | code with no dependency on the rest: the gzip stitcher, the MuPDF shims, small helpers |
| tests | `test/http/` | integration tests over the in-memory transport; unit tests sit beside the code (below) |
| benches | `bench/` | measurement programs, built on demand, never shipped |

Within `services/`, the indexers sit below `files` (which calls them inside
its transactions), and `controlplane`, `sync` and `auth` sit above it. Each
SQL table has one owner, and only the owner writes it: `files` owns `files`,
`blobs`, `capacity`, `file_history`, `sync_state` and `upload_sessions`; `auth`
owns `users`, `sessions`, `devices` and `user_devices`; `settings` owns
`settings`; `note_index` owns `note_index` and `note_page_index`, where the
other indexers record their per-blob verdict through it (§8); `spd_index` owns
`spd_index`. Any module may read a table it does not own, joining through
`files` for ownership (§2.1).

### 12.1 A module in parts

A module is one file, `x.zig`, until it outgrows 500 lines. Then `x.zig`
stays as the façade (the types, the struct, `pub const f = part.f;` for each
exported function, grouped under one header per part) and the parts move to
`x/`: `x/part.zig` holds the code, `x/part_test.zig` its tests, `x/fixture.zig`
what the tests share, `x/internal.zig` what the parts share and nothing else
calls. Nothing becomes `pub` for a test's sake: a test that needs a private
helper stays inline, under `// ---- tests of private helpers ----` at the end
of the file. `files.zig` + `files/` is the model.

### 12.2 Naming

- Handlers are named after the resource, not the face: `controlplane.tree`,
  `admin.listUsers`, `device.listFolder`. The face is the module.
- One import alias per module, everywhere: `filesmod`, `authsvc`, `context`,
  `noteindex`, `blobstore`, `thumbstore`, `derivedstore`, `sqlite`, `schema`.
- A section header `// ---- name ----` sits above code; a header with nothing
  under it is deleted, not kept.
- Every file starts with a `//!` line saying what it is for; every `pub fn`
  that is not a one-line wrapper carries a `///` saying what the caller may
  assume.

### 12.3 The browser app

`webapp/src/` is laid out by role: `api/` (the server client and its fake),
`core/` (shared types), `render/`, `search/`, `export/`, `cache/`, `sync/`,
`ui/` (DOM helpers) and `pages/` (the screens). A screen with more than one
module gets its own folder, `pages/<feature>/`, with the entry module named
after the feature (`pages/library/library.ts`); a single-file screen stays at
`pages/`. Unit tests live under `tests/unit/`, end-to-end specs under
`tests/e2e/`, mirroring the source names.

A screen that outgrows one file is not cut into closures fed by thunks. It
gets one typed context object (`LibraryCtx`, `ReaderCtx`, `PdfViewerCtx`,
`TodoCtx`)
that names everything its parts share, built once in dependency order by the
screen's entry module; each part is `createX(ctx)` returning a named
interface, and reads a member only when one of its functions runs. The
context file states the order rule; the entry module is the only place that
has to get it right.

Stylesheets are a list of rules, so the 500-line target is for code, not for
them. `styles.css` is an ordered manifest and the order is load-bearing; a
sheet that grows is split by component (`09-admin.css`, `09b-admin-panels.css`),
the continuation imported right after its base so the cascade is unchanged.

### 12.4 The test gate

`make test` is the gate (`zig build test`, the parsers, `zig fmt --check`),
and a commit lands only when its summary line reads `N/N tests passed`.
The sample notebooks the tests embed (`sample.note`, `sample-2.note`,
`layers_edited.note`) are named modules supplied by `build.zig` from
`parsers/note/tests/fixtures/`, so `@embedFile("sample.note")` is the same
spelling from any directory.
