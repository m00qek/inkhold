//! The migration steps as DDL text, one constant per schema version. Never edit a shipped step; add one.

const std = @import("std");
const schema = @import("schema.zig");
const fts_tokenizer = schema.fts_tokenizer;
const version = schema.version;

// The v1 baseline, kept verbatim as the text `sqlite_master` held for installs
// migrated the long way (hence the odd trailing `, col TYPE)` columns), so fresh
// and migrated databases are byte-identical. Never edit it; add a step.
pub const ddl_v1 =
    \\CREATE TABLE users (
    \\  id           INTEGER PRIMARY KEY,
    \\  email        TEXT    NOT NULL UNIQUE,
    \\  password_md5 TEXT    NOT NULL,             -- md5_hex(plaintext), 32 chars
    \\  name         TEXT    NOT NULL DEFAULT '',
    \\  is_admin     INTEGER NOT NULL DEFAULT 0,
    \\  must_change_password INTEGER NOT NULL DEFAULT 1, -- new accounts must change on first login
    \\  created_at   INTEGER NOT NULL
    \\, cred_enc TEXT);
    \\
    \\CREATE TABLE devices (
    \\  equipment_no TEXT PRIMARY KEY,             -- device serial
    \\  model        TEXT,
    \\  firmware     TEXT,
    \\  created_at   INTEGER NOT NULL
    \\);
    \\
    \\CREATE TABLE user_devices (   -- a device bound to a user
    \\  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    \\  equipment_no TEXT    NOT NULL REFERENCES devices(equipment_no) ON DELETE CASCADE,
    \\  name         TEXT    NOT NULL DEFAULT '',
    \\  status       TEXT    NOT NULL DEFAULT 'Y', -- 'Y' active / 'N' revoked
    \\  created_at   INTEGER NOT NULL,
    \\  PRIMARY KEY (user_id, equipment_no)
    \\);
    \\
    \\CREATE TABLE capacity (
    \\  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    \\  used_bytes  INTEGER NOT NULL DEFAULT 0,
    \\  total_bytes INTEGER NOT NULL DEFAULT 0
    \\);
    \\
    \\CREATE TABLE sessions (
    \\  token_hash     TEXT PRIMARY KEY,             -- sha256_hex(opaque token)
    \\  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    \\  audience       TEXT NOT NULL,                -- 'device' | 'controlplane' | 'pending'
    \\  equipment_no   TEXT,                         -- set for device sessions
    \\  created_at     INTEGER NOT NULL,
    \\  expires_at     INTEGER NOT NULL,
    \\  elevated_at    INTEGER,                      -- admin re-auth (v8), NULL = not elevated
    \\  elevated_until INTEGER
    \\, last_used_at INTEGER);
    \\
    \\CREATE TABLE blobs (
    \\  md5        TEXT PRIMARY KEY,             -- content hash, 32 lowercase hex
    \\  size       INTEGER NOT NULL,
    \\  refcount   INTEGER NOT NULL DEFAULT 0,
    \\  created_at INTEGER NOT NULL
    \\);
    \\
    \\CREATE TABLE files (
    \\  id         INTEGER PRIMARY KEY,
    \\  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    \\  parent_id  INTEGER REFERENCES files(id) ON DELETE CASCADE, -- NULL = root
    \\  name       TEXT    NOT NULL,
    \\  is_folder  INTEGER NOT NULL DEFAULT 0,
    \\  md5        TEXT,                          -- content hash (files only)
    \\  size       INTEGER NOT NULL DEFAULT 0,
    \\  created_at INTEGER NOT NULL,
    \\  updated_at INTEGER NOT NULL,
    \\  deleted    INTEGER NOT NULL DEFAULT 0
    \\, deleted_at INTEGER, deleted_path TEXT);
    \\
    \\CREATE TABLE sync_state (
    \\  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    \\  version INTEGER NOT NULL DEFAULT 0
    \\);
    \\
    \\CREATE TABLE upload_sessions (
    \\  inner_name    TEXT PRIMARY KEY,          -- 16 hex, our opaque upload key
    \\  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    \\  path          TEXT NOT NULL,             -- destination FOLDER (Dropbox form, no trailing slash)
    \\  file_name     TEXT NOT NULL,
    \\  declared_size INTEGER NOT NULL,          -- size the device announced at apply
    \\  blob_md5      TEXT,                       -- set once /oss/put has stored the bytes
    \\  created_at    INTEGER NOT NULL
    \\);
    \\
    \\CREATE TABLE note_index (
    \\  blob_md5              TEXT PRIMARY KEY REFERENCES blobs(md5) ON DELETE CASCADE,
    \\  index_version         INTEGER NOT NULL,
    \\  indexable             INTEGER NOT NULL DEFAULT 1,  -- 0 = not a parseable .note
    \\  page_count            INTEGER NOT NULL DEFAULT 0,
    \\  signature             TEXT,                        -- e.g. 'SN_FILE_VER_20260016'
    \\  signature_version     INTEGER NOT NULL DEFAULT 0,  -- the 8-digit key
    \\  equipment             TEXT,                        -- APPLY_EQUIPMENT, e.g. 'N6'
    \\  width                 INTEGER NOT NULL DEFAULT 0,  -- base dims (note.dimensions())
    \\  height                INTEGER NOT NULL DEFAULT 0,
    \\  rle_variant           INTEGER NOT NULL DEFAULT 0,  -- 0 RATTA_RLE, 1 RATTA_RLE X2
    \\  recogn_type           TEXT,                        -- FILE_RECOGN_TYPE (device-reported)
    \\  recogn_language       TEXT,                        -- FILE_RECOGN_LANGUAGE, e.g. 'pt_BR'
    \\  recognized_page_count INTEGER NOT NULL DEFAULT 0,  -- pages with RECOGNSTATUS = 1
    \\  indexed_at            INTEGER NOT NULL
    \\, cover_w INTEGER, cover_h INTEGER, cover_offset INTEGER, cover_length INTEGER, cover_mime TEXT);
    \\
    \\CREATE TABLE note_page_index (
    \\  id            INTEGER PRIMARY KEY,
    \\  blob_md5      TEXT    NOT NULL REFERENCES note_index(blob_md5) ON DELETE CASCADE,
    \\  page_index    INTEGER NOT NULL,
    \\  content_hash  TEXT    NOT NULL,             -- 32 hex; the browser's ?v= cache key
    \\  width         INTEGER NOT NULL,
    \\  height        INTEGER NOT NULL,
    \\  layers        BLOB    NOT NULL,             -- packed (offset,length,flags) records
    \\  recogn_status INTEGER NOT NULL DEFAULT 0,   -- 0 none, 1 done, 2 running
    \\  text_hash     TEXT,                         -- md5 of RECOGNTEXT; NULL unless status = 1
    \\  recogn_offset INTEGER,                      -- RECOGNTEXT content range, for the rich
    \\  recogn_length INTEGER,                      --   (elements + bounding boxes) form
    \\  text          TEXT, kind INTEGER NOT NULL DEFAULT 0, bg_hash TEXT,                         -- recognition.plainText(); NULL when none
    \\  UNIQUE(blob_md5, page_index)
    \\);
    \\
    \\CREATE TABLE search_partitions (
    \\  id         INTEGER PRIMARY KEY AUTOINCREMENT,  -- never reused, by SQLite
    \\  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    \\  active     INTEGER NOT NULL DEFAULT 1,          -- one active per user
    \\  next_seq   INTEGER NOT NULL DEFAULT 0,          -- monotonic, under write lock
    \\  created_at INTEGER NOT NULL
    \\);
    \\
    \\CREATE TABLE segment_search (
    \\  id         INTEGER PRIMARY KEY,   -- (partition << 48) | seq
    \\  segment_id INTEGER NOT NULL REFERENCES note_page_index(id)
    \\);
    \\
    \\CREATE TABLE settings (
    \\  key        TEXT    PRIMARY KEY,
    \\  value      INTEGER NOT NULL,
    \\  updated_at INTEGER NOT NULL
    \\);
    \\
    \\CREATE TABLE spd_index (
    \\  blob_md5      TEXT PRIMARY KEY REFERENCES blobs(md5) ON DELETE CASCADE,
    \\  index_version INTEGER NOT NULL,
    \\  indexable     INTEGER NOT NULL DEFAULT 1,  -- 0 = not a parseable .spd
    \\  indexed_at    INTEGER NOT NULL,
    \\  surface_w     REAL,                        -- surface geometry (config)
    \\  surface_h     REAL,
    \\  ppi           INTEGER,
    \\  vp_x          REAL,
    \\  vp_y          REAL,
    \\  app_version   TEXT,                        -- provenance
    \\  fmt_ver       TEXT,
    \\  layer_count   INTEGER NOT NULL DEFAULT 0,
    \\  thumb_w       INTEGER,                     -- the THUMBNAIL's dims (see above)
    \\  thumb_h       INTEGER
    \\);
    \\
    \\CREATE TABLE doc_terms (
    \\  partition_id INTEGER NOT NULL,
    \\  blob_md5     TEXT    NOT NULL,
    \\  term         TEXT    NOT NULL,
    \\  PRIMARY KEY (partition_id, blob_md5, term)
    \\) WITHOUT ROWID;
    \\
    \\CREATE VIEW segment_text AS
    \\  SELECT s.id AS rowid, p.text AS txt
    \\    FROM segment_search s JOIN note_page_index p ON p.id = s.segment_id;
    \\
    \\CREATE VIRTUAL TABLE segment_fts USING fts5(
    \\  txt, content='segment_text', content_rowid='rowid',
    \\  tokenize='
++ fts_tokenizer ++
    \\');
    \\
    \\CREATE INDEX files_deleted_at ON files(deleted_at) WHERE deleted = 1;
    \\
    \\-- Uniqueness for a folder's live children, and the key the `.mark` pairing
    \\-- rule looks a sibling up by (`mark_pairing.hidePairedMark` / `Files.pairOf` — a plan pin
    \\-- names it). `files_bin_name` in v12 is the same key over TRASHED rows,
    \\-- non-unique because the bin can legitimately hold two rows under one name.
    \\--
    \\-- LOAD-BEARING BY NAME — the only index here that still is: the search-index
    \\-- manifest states `INDEXED BY files_live_name` (`search/index_export.zig`),
    \\-- so dropping or renaming this does not make that read slow, it makes the
    \\-- statement fail to prepare. It is named for the PARTIAL clause rather than
    \\-- the columns — `WHERE deleted = 0` is why walking one user's live library
    \\-- does not also walk their bin (MEASURED: 400 trashed files cost 2,000 VM
    \\-- steps through the total `files_user_parent` index and zero through this
    \\-- one, on a response fetched on every visit).
    \\CREATE UNIQUE INDEX files_live_name
    \\  ON files(user_id, COALESCE(parent_id, 0), name) WHERE deleted = 0;
    \\
    \\-- LOAD-BEARING BY PLAN, and it USED to be load-bearing by name: search's
    \\-- `files` join stated `INDEXED BY files_md5`, so losing this index failed
    \\-- loudly at prepare time rather than quietly at runtime. That statement went
    \\-- with the read face in §6 step 7, and no statement names
    \\-- the index any more — but the derivation still reaches `files` by md5 with
    \\-- no owner to seek on, and losing this turns each arm into a scan
    \\-- (MEASURED: 8,647 VM steps per document). What catches that now is the
    \\-- plan pin in `search/index_export.zig`, which asserts `SEARCH f USING
    \\-- INDEX files_md5 (md5=?)` — a failing test rather than a failing prepare,
    \\-- and the reason this comment is not simply deleted.
    \\CREATE INDEX files_md5 ON files(md5);
    \\
    \\CREATE INDEX files_user_parent ON files(user_id, parent_id, deleted);
    \\
    \\CREATE INDEX note_page_index_blob ON note_page_index(blob_md5, page_index);
    \\
    \\CREATE INDEX search_partitions_user ON search_partitions(user_id, active);
    \\
    \\CREATE INDEX segment_search_segment ON segment_search(segment_id);
    \\
    \\CREATE INDEX sessions_user ON sessions(user_id);
    \\
    \\CREATE INDEX upload_sessions_user ON upload_sessions(user_id);
;

// v2: the append-only version log. A row keeps its blob alive for GC alongside
// `blobs.refcount`, and cascades with its file.
pub const ddl_v2 =
    \\CREATE TABLE file_history (
    \\  file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    \\  md5        TEXT    NOT NULL,
    \\  size       INTEGER NOT NULL,
    \\  created_at INTEGER NOT NULL
    \\);
    \\
    \\CREATE INDEX file_history_file ON file_history(file_id, created_at);
    \\
    \\CREATE INDEX file_history_md5 ON file_history(md5);
;

// v3: account-screen columns, NULL by meaning. `password_changed_at` NULL is
// "never changed" (unknowable before v3); `history_keep` NULL follows the admin
// default, which the config value also caps.
pub const ddl_v3 =
    \\ALTER TABLE users ADD COLUMN password_changed_at INTEGER;
    \\ALTER TABLE users ADD COLUMN history_keep INTEGER;
;

// v4: retained versions count against quota. Recomputes from `files`,
// `file_history` and `blobs` rather than adjusting, so it is safe to re-run; the
// `IN (... UNION ...)` charges a blob reachable both ways once.
pub const ddl_v4 =
    \\UPDATE capacity SET used_bytes = (
    \\  SELECT COALESCE(SUM(b.size), 0) FROM blobs b WHERE b.md5 IN (
    \\    SELECT md5 FROM files
    \\     WHERE user_id = capacity.user_id AND is_folder = 0
    \\       AND md5 IS NOT NULL AND md5 <> ''
    \\    UNION
    \\    SELECT fh.md5 FROM file_history fh JOIN files f ON f.id = fh.file_id
    \\     WHERE f.user_id = capacity.user_id
    \\  )
    \\);
;

// v5: running staged total per upload session, so a chunked `/oss/put` is held
// to the session's remaining budget (`totalChunks` is caller-chosen). Stored on
// the row because summing staged parts from disk would be O(N²) stats.
pub const ddl_v5 =
    \\ALTER TABLE upload_sessions ADD COLUMN received_bytes INTEGER NOT NULL DEFAULT 0;
;

/// The 4-byte file-type marker ("note", "mark", ...) preceding the X-series
/// signature, which `signature` excludes. NULL = unknown (pre-v6 row or the
/// original/ASA family, whose signature is at offset 0), never "not a note".
pub const ddl_v6 =
    \\ALTER TABLE note_index ADD COLUMN filetype TEXT;
;

/// The page's own 1-based number from its `PAGE<n>` footer key, as opposed to
/// `page_index` (its position). A `.mark` holds only annotated pages, named by
/// their PDF page (`note-format.md` §13.2). 0 = not recorded.
pub const ddl_v7 =
    \\ALTER TABLE note_page_index ADD COLUMN source_page INTEGER NOT NULL DEFAULT 0;
;

/// Byte range of a page's `EXTERNALLINKINFO` block (PDF-template links), re-read
/// on demand since one notebook can hold 51k records. `links_hash` is the `?v=`
/// of the links route; NULL means the page has no links.
pub const ddl_v8 =
    \\ALTER TABLE note_page_index ADD COLUMN links_offset INTEGER;
    \\ALTER TABLE note_page_index ADD COLUMN links_length INTEGER;
    \\ALTER TABLE note_page_index ADD COLUMN links_hash TEXT;
;

/// `pdf_probe` verdict (`backend/pdf/probe.zig`), recorded so a file is never
/// probed twice: NULL never probed, 0 shape recorded, 1 unopenable, 2 encrypted,
/// 3 no pages or degenerate page 1.
pub const ddl_v9 =
    \\ALTER TABLE note_index ADD COLUMN pdf_probe INTEGER;
;

/// `pdf_text` verdict for deriving `terms/<md5>` and `text/<md5>`: NULL never
/// extracted, 0 every page, 1 no text (a scan), 2 truncated at
/// `pdf_text.max_pages`, 3 could not open what the probe could.
pub const ddl_v10 =
    \\ALTER TABLE note_index ADD COLUMN pdf_text INTEGER;
;

/// `txt_index` memo, written last in the transaction that finishes a chunked
/// `.txt` derivation: NULL never derived, 0 derived, 1 skipped over
/// `txt_index.max_file_bytes`. The UPDATE backfills already-derived blobs.
pub const ddl_v11 =
    \\ALTER TABLE note_index ADD COLUMN txt_index INTEGER;
    \\UPDATE note_index SET txt_index = 0
    \\ WHERE EXISTS (SELECT 1 FROM note_page_index np
    \\                WHERE np.blob_md5 = note_index.blob_md5 AND np.kind = 1);
;

/// v12: `files_bin_name`, `files_live_name`'s key over trashed rows, so `.mark`
/// pairing in the bin is a seek rather than a library walk per row. Not unique:
/// the bin can hold two rows under one name.
pub const ddl_v12 =
    \\CREATE INDEX files_bin_name
    \\  ON files(user_id, COALESCE(parent_id, 0), name) WHERE deleted = 1;
;

/// v13: drops `doc_terms`, unread since fuzzy search moved to the browser.
pub const ddl_v13 =
    \\DROP TABLE doc_terms;
;

/// v15: re-derive PDF text after Private Use Area glyphs became spaces. Only
/// successful verdicts are cleared; `index_version` is bumped separately because
/// the `note_index` upsert preserves `pdf_probe`/`pdf_text`.
pub const ddl_v15 =
    \\UPDATE note_index SET pdf_text = NULL WHERE pdf_text = 0;
;

/// v16: `has_ink` tri-state (1 inked, 0 empty, NULL not yet scanned). NULL must
/// stay distinct from empty; the deferred `ink` tenant fills it.
pub const ddl_v16 =
    \\ALTER TABLE note_page_index ADD COLUMN has_ink INTEGER;
;

/// v17: what `inkhold backup` last did, one row per backup directory, read by
/// the admin console's backup notice (docs/content/contributor/storage.md (Backups)). Written by the backup
/// process beside the server; `restore` empties it, or a restored server would
/// report the snapshot day's backups as its own.
pub const ddl_v17 =
    \\CREATE TABLE backup_runs (
    \\  dir          TEXT    PRIMARY KEY,     -- the directory as given to `backup create`
    \\  last_run_at  INTEGER,                 -- the last `create`, good or not; NULL: verify only
    \\  last_ok_at   INTEGER,                 -- NULL: never succeeded here
    \\  last_error   TEXT,                    -- NULL when the last `create` succeeded
    \\  snapshot     TEXT,                    -- the last good snapshot's name
    \\  blobs        INTEGER,
    \\  bytes        INTEGER,
    \\  verified_at  INTEGER,                 -- the last `verify`, NULL: never
    \\  verify_error TEXT                     -- NULL when the last `verify` passed
    \\);
;

/// v18: the library's identity, a random id made once per library. Tablets
/// get it as `uniqueMachineId` from `check/exists/server` at sign-in and drop
/// their file-sync records when it differs from the one they stored
/// (docs/content/contributor/device-protocol.md). `restore` gives the restored library a new one, so a tablet that held
/// newer files starts fresh instead of deleting what the server lacks.
pub const ddl_v18 =
    \\CREATE TABLE library (
    \\  id         INTEGER PRIMARY KEY CHECK (id = 1),  -- exactly one row
    \\  machine_id TEXT    NOT NULL                     -- 32 lowercase hex, random
    \\);
    \\INSERT INTO library (id, machine_id) VALUES (1, lower(hex(randomblob(16))));
;

/// v19: file ids are never reused. Tablets key their sync records by the
/// server's id; a plain `INTEGER PRIMARY KEY` hands the top id out again once
/// that row is purged, so a tablet that missed the purge would take a new file
/// for the old one. AUTOINCREMENT keeps the high-water mark in
/// `sqlite_sequence`. SQLite cannot add it in place, so the table is rebuilt
/// with the same columns and indexes; `schema.zig` runs this step with foreign
/// keys off, or the DROP's implicit DELETE would cascade into `file_history`.
/// Ids already purged off the top before v19 cannot be known; none is reused
/// from here on.
pub const ddl_v19 =
    \\CREATE TABLE files_v19 (
    \\  id         INTEGER PRIMARY KEY AUTOINCREMENT,  -- never reused, by SQLite
    \\  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    \\  parent_id  INTEGER REFERENCES files(id) ON DELETE CASCADE, -- NULL = root
    \\  name       TEXT    NOT NULL,
    \\  is_folder  INTEGER NOT NULL DEFAULT 0,
    \\  md5        TEXT,                          -- content hash (files only)
    \\  size       INTEGER NOT NULL DEFAULT 0,
    \\  created_at INTEGER NOT NULL,
    \\  updated_at INTEGER NOT NULL,
    \\  deleted    INTEGER NOT NULL DEFAULT 0,
    \\  deleted_at INTEGER,
    \\  deleted_path TEXT
    \\);
    \\INSERT INTO files_v19 (id, user_id, parent_id, name, is_folder, md5, size, created_at, updated_at, deleted, deleted_at, deleted_path)
    \\  SELECT id, user_id, parent_id, name, is_folder, md5, size, created_at, updated_at, deleted, deleted_at, deleted_path FROM files;
    \\DROP TABLE files;
    \\ALTER TABLE files_v19 RENAME TO files;
    \\CREATE INDEX files_deleted_at ON files(deleted_at) WHERE deleted = 1;
    \\CREATE UNIQUE INDEX files_live_name
    \\  ON files(user_id, COALESCE(parent_id, 0), name) WHERE deleted = 0;
    \\CREATE INDEX files_md5 ON files(md5);
    \\CREATE INDEX files_user_parent ON files(user_id, parent_id, deleted);
    \\CREATE INDEX files_bin_name
    \\  ON files(user_id, COALESCE(parent_id, 0), name) WHERE deleted = 1;
;

// v20: the tablet's To-Do data, stored as the To-Do app sends it (decompiled
// `TaskSync`, July capture). Ids are the tablet's own (32 hex), unique per
// account. A task with no `list_id` is in the Inbox. The app deletes from the
// tablet any synced list or task the server does not list, so rows leave only
// by an explicit delete from a tablet, or with their account.
pub const ddl_v20 =
    \\CREATE TABLE todo_lists (
    \\  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    \\  list_id       TEXT    NOT NULL,
    \\  title         TEXT    NOT NULL DEFAULT '',
    \\  create_time   INTEGER NOT NULL DEFAULT 0,
    \\  last_modified INTEGER NOT NULL DEFAULT 0,
    \\  deleted       INTEGER NOT NULL DEFAULT 0,
    \\  PRIMARY KEY (user_id, list_id)
    \\) WITHOUT ROWID;
    \\CREATE TABLE todo_tasks (
    \\  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    \\  task_id           TEXT    NOT NULL,
    \\  list_id           TEXT,
    \\  title             TEXT    NOT NULL DEFAULT '',
    \\  detail            TEXT,
    \\  status            TEXT    NOT NULL DEFAULT 'needsAction',
    \\  importance        TEXT,
    \\  recurrence        TEXT,
    \\  links             TEXT,
    \\  reminder_on       INTEGER NOT NULL DEFAULT 0,
    \\  due_time          INTEGER NOT NULL DEFAULT 0,
    \\  completed_time    INTEGER NOT NULL DEFAULT 0,
    \\  last_modified     INTEGER NOT NULL DEFAULT 0,
    \\  sort              INTEGER NOT NULL DEFAULT 0,
    \\  sort_completed    INTEGER NOT NULL DEFAULT 0,
    \\  sort_time         INTEGER NOT NULL DEFAULT 0,
    \\  planner_sort      INTEGER NOT NULL DEFAULT 0,
    \\  planner_sort_time INTEGER NOT NULL DEFAULT 0,
    \\  deleted           INTEGER NOT NULL DEFAULT 0,
    \\  PRIMARY KEY (user_id, task_id)
    \\) WITHOUT ROWID;
    \\CREATE INDEX todo_tasks_list ON todo_tasks(user_id, list_id);
;

// v21: what the browser changed that a tablet has not fetched yet. A row's
// `web_changed_at` is set by a browser edit and cleared when a tablet sends
// the row; `todo_sync_state` keeps, per account, when a tablet last listed its
// tasks and when the browser last changed anything (deletes included).
pub const ddl_v21 =
    \\ALTER TABLE todo_lists ADD COLUMN web_changed_at INTEGER;
    \\ALTER TABLE todo_tasks ADD COLUMN web_changed_at INTEGER;
    \\CREATE TABLE todo_sync_state (
    \\  user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    \\  tablet_listed_at INTEGER,
    \\  web_changed_at   INTEGER
    \\);
;

// v22: the words a lassoed task was made from. `link_text` is the task's title
// when its notebook link arrived from a tablet, kept through every rename (on
// the tablet or in the browser) so the browser can still find those words on
// the page; a new link resets it, a removed one clears it. Existing linked
// tasks start from their current title.
pub const ddl_v22 =
    \\ALTER TABLE todo_tasks ADD COLUMN link_text TEXT;
    \\UPDATE todo_tasks SET link_text = title WHERE links IS NOT NULL;
;

// v14: drops the server-side search index. Order matters: the FTS5 table before
// its content view, `segment_search` (FK to pages) before the page rows.
pub const ddl_v14 =
    \\DROP TABLE segment_fts;
    \\DROP VIEW segment_text;
    \\DROP TABLE segment_search;
    \\DROP TABLE search_partitions;
    \\DELETE FROM note_page_index WHERE kind <> 0;
;

test {
    _ = @import("schema_test.zig");
}
