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
  account, and a tablet's next task listing clears it. **The library id does NOT protect to-dos**: its reset at sign-in
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
gets one typed context object (`LibraryCtx`, `ReaderCtx`, `PdfViewerCtx`)
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
