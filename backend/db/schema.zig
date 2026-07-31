//! Database schema. Greenfield SQLite tables that preserve the *semantics* of
//! Ratta's relevant MariaDB tables (u_user, e_equipment, e_user_equipment,
//! f_capacity, f_user_file) plus our own sessions and index/search tables — not
//! a 1:1 port.
//!
//! v1 is the whole schema, a single baseline (the app is pre-release, so the 21
//! incremental steps this once carried were squashed away — their column adds,
//! table drops and one-time backfills all folded into the definitions below). A
//! fresh database is created BYTE-IDENTICAL to what the old stepwise migration
//! produced, so an already-migrated install and a fresh one share one schema.
//!
//! The v1 objects:
//!   users / devices / user_devices / capacity — accounts, bound devices, quota.
//!   sessions          — opaque session store; the key is sha256(token) at rest,
//!                        with admin-elevation and idle-expiry timestamps.
//!   blobs / files     — content-addressed physical store + the per-user tree
//!                        (adjacency list, soft-delete tombstones + a frozen bin
//!                        path, the recycle-bin retention clock).
//!   sync_state        — per-user monotonic change counter (control-plane SWR).
//!   upload_sessions   — the device upload/apply→/oss/put→upload/finish handshake.
//!   note_index / note_page_index — the per-blob `.note` index (pages/segments,
//!                        recognized text, cover memo).
//!   spd_index         — the per-blob `.spd` index.
//!   search_partitions / segment_search / segment_text / segment_fts / doc_terms
//!                     — partitioned per-owner full-text search (see
//!                        docs/scratch/search-architecture.md).
//!   settings          — server-wide config (today: the bin retention window).
//! Still to come with the sync-core slice: a change log.

const std = @import("std");
const sqlite = @import("sqlite.zig");

/// Current schema version. Bump + add a migration step when the schema changes.
///
/// v2 adds `file_history` — the append-only version log behind hot-cache
/// versioning (docs/scratch/hot-cache-versioning.md). It is a pure additive
/// step: a fresh database lays the v1 baseline then applies `ddl_v2`, and an
/// already-migrated v1 install applies only `ddl_v2`, so the two end
/// byte-identical (the same authored `file_history` object either way).
///
/// v3 adds the two `users` columns the account screen needs
/// (docs/scratch/user-options.md §8). Same additive shape as v2: the new columns
/// live ONLY in `ddl_v3`, never folded back into `ddl_v1`, so a fresh database
/// reaches them by running v1 → v2 → v3 exactly as an existing install does —
/// which is what makes the two byte-identical, rather than a second authored
/// copy that has to be kept in step by hand.
///
/// v4 RECOMPUTES `capacity.used_bytes` so retained versions are charged (§6). It
/// is a data step with no DDL, and it is its own version rather than folded into
/// v3 for a specific reason: v3 may already have been applied by an install that
/// took the account-screen commit, and a step folded backwards into an
/// already-applied version never runs.
pub const version: i64 = 4;

/// Default per-user quota for a household (10 GiB) — the ONE definition.
///
/// It lives in the db layer as the canonical source: `authsvc.default_capacity`
/// and `Files.default_total_bytes` are aliases of this, so the value a row is
/// created with and the value a missing row reads as cannot drift apart.
pub const default_capacity_bytes: i64 = 10 * 1024 * 1024 * 1024;

/// Applies the schema to `db`. On a fresh database (`user_version` 0) it lays
/// down the whole `v1` baseline in one shot; an already-migrated database (any
/// `user_version` >= `version`) is left untouched. Idempotent.
pub fn migrate(db: sqlite.Db) !void {
    const current = try userVersion(db);
    if (current >= version) return;
    if (current < 1) try db.exec(ddl_v1);
    if (current < 2) try db.exec(ddl_v2);
    if (current < 3) try db.exec(ddl_v3);
    if (current < 4) try db.exec(ddl_v4);
    // Derived from `version` so bumping the constant above cannot leave this
    // literal behind (it was hardcoded once, and nearly missed on a bump).
    try db.exec(std.fmt.comptimePrint("PRAGMA user_version = {d};", .{version}));
}

fn userVersion(db: sqlite.Db) !i64 {
    var r = (try db.row("PRAGMA user_version;", &.{})) orelse return 0;
    defer r.finalize();
    return r.int(0);
}

// The full schema as authored objects only. The FTS5 virtual table
// `segment_fts` brings its own shadow tables (`segment_fts_config/data/docsize/
// idx`), the view `segment_text` and any implicit objects are created by SQLite
// — we author the CREATE VIRTUAL TABLE / VIEW and let it do the rest. A handful
// of columns read oddly (`files` trails `, deleted_at INTEGER, deleted_path
// TEXT)`, and similar on `users`/`sessions`/`note_index`/`note_page_index`):
// that is the exact text the old `ALTER TABLE ... ADD COLUMN` steps left in
// `sqlite_master`, reproduced verbatim so a fresh v1 database is byte-identical
// to an install migrated the long way.
const ddl_v1 =
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
    \\  tokenize='unicode61 remove_diacritics 2');
    \\
    \\CREATE INDEX files_deleted_at ON files(deleted_at) WHERE deleted = 1;
    \\
    \\CREATE UNIQUE INDEX files_live_name
    \\  ON files(user_id, COALESCE(parent_id, 0), name) WHERE deleted = 0;
    \\
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

// v2 — the append-only version log for hot-cache versioning (H3). One row per
// superseded version: enough to list a file's history and resolve `md5 → blob`,
// nothing more (offsets/MIME come from the retained `note_index`). A history row
// is a blob KEEP-ALIVE the GC gate checks alongside `blobs.refcount`
// (`files.zig` `reapIfUnreferenced`), so a retained version's blob is not
// deleted while its row lives. `ON DELETE CASCADE` makes history follow its file
// to the recycle bin and vanish when the file is purged (H10). Indexes:
// `(file_id, created_at)` lists/evicts a file's versions; `md5` is the GC gate's
// "does any history row still reference this blob?" probe.
const ddl_v2 =
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

// v3 — the two columns the account screen (docs/scratch/user-options.md §8)
// found missing. Both are ADDITIVE and both are deliberately NULLable, because
// NULL is a meaning here rather than a placeholder:
//
//   `password_changed_at` — epoch seconds of the last self-service password
//     change. NULL = never changed THROUGH THIS COLUMN, which is what every
//     existing account is: the fact was unknowable before this migration, so
//     backfilling `created_at` would invent a change that may never have
//     happened. The screen has to say "never changed" for those rather than
//     imply the account is stale (§8).
//
//   `history_keep` — the per-user K (how many versions of each file to retain).
//     NULL = "follow the admin's configured default", which is exactly what
//     every existing row has effectively been doing, so the backfill is a no-op
//     on behaviour: nobody's history depth moves when this lands. A number here
//     is the user's own choice, still bounded above by the config value (§7:
//     "bounded above by whatever ceiling the admin's config sets").
const ddl_v3 =
    \\ALTER TABLE users ADD COLUMN password_changed_at INTEGER;
    \\ALTER TABLE users ADD COLUMN history_keep INTEGER;
;

// v4 — retained versions count against quota (docs/scratch/user-options.md §6).
//
// A version kept in `file_history` occupies disk: its blob survives the GC gate
// on the strength of that row alone (`reapIfUnreferenced`'s keep-alive). Until
// now it was not charged, so a user could churn edits to one note and accumulate
// unbilled disk for ever — while a TRASHED file, whose bytes occupy disk for
// exactly the same reason, has always been charged. History was the
// inconsistency, not the proposal.
//
// **It RECOMPUTES rather than adjusts.** The total is rebuilt from `files`,
// `file_history` and `blobs` — the same reconstruction the quota audit performs
// — so this converges from either direction, is safe to re-run, and cannot
// double-apply if it is somehow reached twice. An adjustment (`used_bytes = ... +
// history`) would be correct exactly once and corrupt every time after.
//
// EXISTING INSTALLS WILL SEE `used_bytes` JUMP, by the size of the blobs their
// retained versions were keeping alive for free. That is the point: the meter
// was reading low against what the disk actually held.
//
// `DISTINCT` is carried by the `IN (SELECT ... UNION ...)` — a blob reachable
// both from a live file and from some version is one blob and is charged once.
const ddl_v4 =
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

test "migrate creates the v1 schema and is idempotent" {
    var db = try sqlite.Db.openMemory();
    defer db.close();

    try migrate(db);
    try std.testing.expectEqual(version, try userVersion(db));
    try migrate(db); // second run is a no-op

    // Tables are present and usable.
    try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);");
    try db.exec("INSERT INTO capacity(user_id, total_bytes) VALUES(1, 1000);");

    var r = (try db.row("SELECT email FROM users WHERE id = 1;", &.{})) orelse return error.TestUnexpectedResult;
    defer r.finalize();
    try std.testing.expectEqualStrings("a@b.c", r.text(0));
}

test "v2: fresh and v1-upgraded databases carry an identical file_history table" {
    // The authored `file_history` DDL from `sqlite_master`, whichever path built it.
    const read_ddl = struct {
        fn get(db: sqlite.Db, buf: []u8) ![]const u8 {
            var r = (try db.row("SELECT sql FROM sqlite_master WHERE name = 'file_history';", &.{})) orelse return error.Missing;
            defer r.finalize();
            const sql = r.text(0);
            @memcpy(buf[0..sql.len], sql);
            return buf[0..sql.len];
        }
    }.get;

    // Fresh: baseline + v2 in one migrate().
    var fresh = try sqlite.Db.openMemory();
    defer fresh.close();
    try migrate(fresh);
    try std.testing.expectEqual(version, try userVersion(fresh));

    // Upgraded: an install stamped at v1 (baseline only), then migrated to v2.
    var upg = try sqlite.Db.openMemory();
    defer upg.close();
    try upg.exec(ddl_v1);
    try upg.exec("PRAGMA user_version = 1;");
    try migrate(upg);
    try std.testing.expectEqual(version, try userVersion(upg));

    var fbuf: [512]u8 = undefined;
    var ubuf: [512]u8 = undefined;
    try std.testing.expectEqualStrings(try read_ddl(fresh, &fbuf), try read_ddl(upg, &ubuf));

    // And the table is usable / cascades with its file.
    try fresh.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);");
    try fresh.exec("INSERT INTO files(id, user_id, name, md5, size, created_at, updated_at) VALUES(1, 1, 'a.note', 'aa', 1, 0, 0);");
    try fresh.exec("INSERT INTO file_history(file_id, md5, size, created_at) VALUES(1, 'bb', 2, 0);");
    try fresh.exec("DELETE FROM files WHERE id = 1;");
    var s = try fresh.prepare("SELECT COUNT(*) FROM file_history;");
    defer s.finalize();
    _ = try s.step();
    try std.testing.expectEqual(@as(i64, 0), s.columnInt(0)); // cascaded away with its file
}

test "v3: fresh and stepwise-migrated databases carry an identical users table" {
    // Same property the v2 test pins, for the two columns v3 adds. The columns
    // live only in `ddl_v3` (never folded back into the v1 baseline), so this is
    // byte-identical BY CONSTRUCTION — the test is here to keep it that way, since
    // the tempting "just add them to the baseline too" edit breaks it silently.
    const read_ddl = struct {
        fn get(db: sqlite.Db, buf: []u8) ![]const u8 {
            var r = (try db.row("SELECT sql FROM sqlite_master WHERE name = 'users';", &.{})) orelse return error.Missing;
            defer r.finalize();
            const sql = r.text(0);
            @memcpy(buf[0..sql.len], sql);
            return buf[0..sql.len];
        }
    }.get;

    var fresh = try sqlite.Db.openMemory();
    defer fresh.close();
    try migrate(fresh);

    // An install stamped at v1, then migrated all the way up.
    var from_v1 = try sqlite.Db.openMemory();
    defer from_v1.close();
    try from_v1.exec(ddl_v1);
    try from_v1.exec("PRAGMA user_version = 1;");
    try migrate(from_v1);

    // And one stamped at v2 (the shipped hot-cache-versioning schema).
    var from_v2 = try sqlite.Db.openMemory();
    defer from_v2.close();
    try from_v2.exec(ddl_v1);
    try from_v2.exec(ddl_v2);
    try from_v2.exec("PRAGMA user_version = 2;");
    try migrate(from_v2);

    var a: [1024]u8 = undefined;
    var b: [1024]u8 = undefined;
    var c: [1024]u8 = undefined;
    try std.testing.expectEqualStrings(try read_ddl(fresh, &a), try read_ddl(from_v1, &b));
    try std.testing.expectEqualStrings(try read_ddl(fresh, &a), try read_ddl(from_v2, &c));
    try std.testing.expectEqual(version, try userVersion(fresh));
    try std.testing.expectEqual(version, try userVersion(from_v2));

    // Both columns exist and read NULL for a row created without them — the
    // "never changed" / "follow the config default" backfill.
    try fresh.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);");
    var r = (try fresh.row("SELECT password_changed_at, history_keep FROM users WHERE id = 1;", &.{})) orelse return error.TestUnexpectedResult;
    defer r.finalize();
    try std.testing.expect(r.intOpt(0) == null);
    try std.testing.expect(r.intOpt(1) == null);
}

test "v4: used_bytes is RECOMPUTED to charge retained versions, and converges from either direction" {
    // The migration recomputes rather than adjusts, which is what makes it safe to
    // re-run and correct no matter what the counter said before. This drives it
    // from BOTH sides — a total that was too low (the real case: a v3 install whose
    // versions were never charged) and one that was too high — and demands it land
    // on the same reconstructed figure, twice.
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try migrate(db);

    try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);");
    try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(2, 'x@y.z', '0123456789abcdef0123456789abcdef', 0);");
    try db.exec("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(1, 0, 100000);");
    try db.exec("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(2, 0, 100000);");
    // Three blobs: the live current (100), a retained version (30), and one the
    // user holds BOTH live and in history (7) — which must be charged once.
    try db.exec("INSERT INTO blobs(md5, size, refcount, created_at) VALUES('cur', 100, 1, 0);");
    try db.exec("INSERT INTO blobs(md5, size, refcount, created_at) VALUES('old', 30, 0, 0);");
    try db.exec("INSERT INTO blobs(md5, size, refcount, created_at) VALUES('both', 7, 1, 0);");
    try db.exec("INSERT INTO blobs(md5, size, refcount, created_at) VALUES('theirs', 500, 1, 0);");
    try db.exec("INSERT INTO files(id, user_id, name, md5, size, created_at, updated_at) VALUES(1, 1, 'a.note', 'cur', 100, 0, 0);");
    try db.exec("INSERT INTO files(id, user_id, name, md5, size, created_at, updated_at) VALUES(2, 1, 'b.note', 'both', 7, 0, 0);");
    try db.exec("INSERT INTO files(id, user_id, name, md5, size, created_at, updated_at) VALUES(3, 2, 'c.note', 'theirs', 500, 0, 0);");
    try db.exec("INSERT INTO file_history(file_id, md5, size, created_at) VALUES(1, 'old', 30, 0);");
    try db.exec("INSERT INTO file_history(file_id, md5, size, created_at) VALUES(2, 'both', 7, 0);");
    // A folder row (NULL md5) and a second history row on the same blob, so the
    // DISTINCT-ness of the reconstruction is actually exercised.
    try db.exec("INSERT INTO files(id, user_id, name, is_folder, created_at, updated_at) VALUES(4, 1, 'Dir', 1, 0, 0);");
    try db.exec("INSERT INTO file_history(file_id, md5, size, created_at) VALUES(2, 'old', 30, 0);");

    const readUsed = struct {
        fn get(d: sqlite.Db, uid: i64) !i64 {
            var r = (try d.row("SELECT used_bytes FROM capacity WHERE user_id = ?1;", &.{.{ .int = uid }})) orelse return error.Missing;
            defer r.finalize();
            return r.int(0);
        }
    }.get;

    // From BELOW — the real migration case: a counter that only ever saw live files.
    try db.exec("UPDATE capacity SET used_bytes = 107 WHERE user_id = 1;");
    try db.exec(ddl_v4);
    try std.testing.expectEqual(@as(i64, 137), try readUsed(db, 1)); // 100 + 30 + 7, each once
    try std.testing.expectEqual(@as(i64, 500), try readUsed(db, 2));

    // From ABOVE, and then twice more: it converges to the same figure and is a
    // no-op thereafter, which is what "safe to re-run" has to mean.
    try db.exec("UPDATE capacity SET used_bytes = 999999 WHERE user_id = 1;");
    try db.exec(ddl_v4);
    try std.testing.expectEqual(@as(i64, 137), try readUsed(db, 1));
    try db.exec(ddl_v4);
    try std.testing.expectEqual(@as(i64, 137), try readUsed(db, 1));
    try std.testing.expectEqual(@as(i64, 500), try readUsed(db, 2)); // never disturbed
}

test "foreign keys are enforced" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try migrate(db);
    // capacity references a non-existent user -> FK violation at step time.
    var s = try db.prepare("INSERT INTO capacity(user_id, total_bytes) VALUES(999, 1);");
    defer s.finalize();
    try std.testing.expectError(error.Step, s.step());
}

test "files tree: folder + file insert, and unique live names per folder" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try migrate(db);
    try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);");

    // A root folder, then a file inside it referencing a blob.
    try db.exec("INSERT INTO blobs(md5, size, refcount, created_at) VALUES('aa', 10, 1, 0);");
    try db.exec("INSERT INTO files(user_id, parent_id, name, is_folder, created_at, updated_at) VALUES(1, NULL, 'Notes', 1, 0, 0);");
    try db.exec("INSERT INTO files(user_id, parent_id, name, md5, size, created_at, updated_at) VALUES(1, 1, 'a.note', 'aa', 10, 0, 0);");

    // A second live file with the same name in the same folder is rejected.
    {
        var s = try db.prepare("INSERT INTO files(user_id, parent_id, name, created_at, updated_at) VALUES(1, 1, 'a.note', 0, 0);");
        defer s.finalize();
        try std.testing.expectError(error.Step, s.step());
    }
    // But once the first is soft-deleted, the name is free again.
    try db.exec("UPDATE files SET deleted = 1 WHERE name = 'a.note';");
    try db.exec("INSERT INTO files(user_id, parent_id, name, md5, size, created_at, updated_at) VALUES(1, 1, 'a.note', 'aa', 10, 0, 0);");

    // Two different root entries with the same name also collide (COALESCE folds NULL).
    try db.exec("INSERT INTO files(user_id, parent_id, name, is_folder, created_at, updated_at) VALUES(1, NULL, 'Docs', 1, 0, 0);");
    {
        var s = try db.prepare("INSERT INTO files(user_id, parent_id, name, is_folder, created_at, updated_at) VALUES(1, NULL, 'Docs', 1, 0, 0);");
        defer s.finalize();
        try std.testing.expectError(error.Step, s.step());
    }
}

test "deleting a user cascades their files" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try migrate(db);
    try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);");
    try db.exec("INSERT INTO files(user_id, parent_id, name, is_folder, created_at, updated_at) VALUES(1, NULL, 'Notes', 1, 0, 0);");
    try db.exec("INSERT INTO files(user_id, parent_id, name, created_at, updated_at) VALUES(1, 1, 'a.note', 0, 0);");
    try db.exec("DELETE FROM users WHERE id = 1;");

    var s = try db.prepare("SELECT COUNT(*) FROM files;");
    defer s.finalize();
    _ = try s.step();
    try std.testing.expectEqual(@as(i64, 0), s.columnInt(0)); // both file rows cascaded away
}
