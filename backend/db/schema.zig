//! Database schema and migrations: accounts, devices, sessions, the per-user
//! file tree over content-addressed blobs, upload sessions, and the per-blob
//! `.note`/`.spd` indexes.

const std = @import("std");
const sqlite = @import("sqlite.zig");

const schema_ddl = @import("schema_ddl.zig");
const ddl_v1 = schema_ddl.ddl_v1;
const ddl_v2 = schema_ddl.ddl_v2;
const ddl_v3 = schema_ddl.ddl_v3;
const ddl_v4 = schema_ddl.ddl_v4;
const ddl_v5 = schema_ddl.ddl_v5;
const ddl_v6 = schema_ddl.ddl_v6;
const ddl_v7 = schema_ddl.ddl_v7;
const ddl_v8 = schema_ddl.ddl_v8;
const ddl_v9 = schema_ddl.ddl_v9;
const ddl_v10 = schema_ddl.ddl_v10;
const ddl_v11 = schema_ddl.ddl_v11;
const ddl_v12 = schema_ddl.ddl_v12;
const ddl_v13 = schema_ddl.ddl_v13;
const ddl_v15 = schema_ddl.ddl_v15;
const ddl_v16 = schema_ddl.ddl_v16;
const ddl_v14 = schema_ddl.ddl_v14;

/// Current schema version. Bump + add a migration step when the schema changes.
/// Never fold a change into an earlier step: an install that already applied
/// that version would never run it.
pub const version: i64 = 16;

/// Default per-user quota (10 GiB); `Files.default_total_bytes` and
/// `Files.default_total_bytes` alias it.
pub const default_capacity_bytes: i64 = 10 * 1024 * 1024 * 1024;

/// The migration steps in order: `steps[i]` takes a database from version `i` to
/// version `i + 1`.
const steps = [_][:0]const u8{ ddl_v1, ddl_v2, ddl_v3, ddl_v4, ddl_v5, ddl_v6, ddl_v7, ddl_v8, ddl_v9, ddl_v10, ddl_v11, ddl_v12, ddl_v13, ddl_v14, ddl_v15, ddl_v16 };

comptime {
    if (steps.len != version) @compileError(
        "schema.version must equal the number of migration steps — bump one and you must add the other",
    );
}

/// Applies the schema to `db`. On a fresh database (`user_version` 0) it lays
/// down the whole `v1` baseline in one shot; an already-migrated database (any
/// `user_version` >= `version`) is left untouched. Idempotent.
pub fn migrate(db: sqlite.Db) !void {
    const current = try userVersion(db);
    if (current >= version) return;
    inline for (steps, 1..) |ddl, n| {
        if (current < n) try applyStep(db, n, ddl);
    }
}

/// Runs one migration step and its `user_version` stamp in one transaction.
/// `sqlite3_exec` auto-commits each statement, so a step interrupted partway
/// would otherwise re-run on boot and fail on "already exists" forever. The
/// stamp must stay inside: `user_version` is transactional header state.
fn applyStep(db: sqlite.Db, comptime n: comptime_int, ddl: [:0]const u8) !void {
    try db.exec("BEGIN IMMEDIATE;");
    // A failing ROLLBACK means SQLite already rolled back itself (e.g. SQLITE_FULL).
    errdefer db.exec("ROLLBACK;") catch {};
    try db.exec(ddl);
    try db.exec(std.fmt.comptimePrint("PRAGMA user_version = {d};", .{n}));
    try db.exec("COMMIT;");
}

/// The database's `user_version`: the schema step it has reached.
pub fn userVersion(db: sqlite.Db) !i64 {
    var r = (try db.row("PRAGMA user_version;", &.{})) orelse return 0;
    defer r.finalize();
    return r.int(0);
}

/// The FTS5 tokenizer the browser's index (`webapp/wasm/sqlite_core.zig`) and
/// `search/fuzzy.zig` must share; a mismatch makes search silently miss.
/// `remove_diacritics 2` makes `reuniao` find `reunião`.
pub const fts_tokenizer = "unicode61 remove_diacritics 2";

// ---- tests of private helpers ----

test "v16: `has_ink` arrives NULL on every existing page, and nothing else moves" {
    // Existing pages must come out NULL, not `DEFAULT 0` ("empty").
    var db = try sqlite.Db.openMemory();
    defer db.close();
    inline for (steps[0..15], 1..) |ddl, n| try applyStep(db, n, ddl);
    try std.testing.expectEqual(@as(i64, 15), try userVersion(db));

    try db.exec(
        \\INSERT INTO blobs(md5, size, refcount, created_at) VALUES('n', 10, 1, 0);
        \\INSERT INTO note_index(blob_md5, index_version, indexable, page_count, indexed_at)
        \\  VALUES('n', 16, 1, 2, 0);
        \\INSERT INTO note_page_index(blob_md5, kind, page_index, content_hash, width, height, layers, recogn_status)
        \\  VALUES('n', 0, 0, 'h0', 1404, 1872, x'', 0);
        \\INSERT INTO note_page_index(blob_md5, kind, page_index, content_hash, width, height, layers, recogn_status)
        \\  VALUES('n', 0, 1, 'h1', 1404, 1872, x'', 0);
    );

    try applyStep(db, 16, ddl_v16);
    try std.testing.expectEqual(@as(i64, 16), try userVersion(db));

    try std.testing.expectEqual(
        @as(i64, 2),
        try countOf(db, "SELECT COUNT(*) FROM note_page_index WHERE has_ink IS NULL;"),
    );
    try std.testing.expectEqual(
        @as(i64, 0),
        try countOf(db, "SELECT COUNT(*) FROM note_page_index WHERE has_ink IS NOT NULL;"),
    );
    try db.exec("UPDATE note_page_index SET has_ink = 1 WHERE page_index = 0;");
    try db.exec("UPDATE note_page_index SET has_ink = 0 WHERE page_index = 1;");
    try std.testing.expectEqual(@as(i64, 1), try countOf(db, "SELECT COUNT(*) FROM note_page_index WHERE has_ink = 1;"));
    try std.testing.expectEqual(@as(i64, 1), try countOf(db, "SELECT COUNT(*) FROM note_page_index WHERE has_ink = 0;"));

    try std.testing.expectEqual(@as(i64, 2), try countOf(db, "SELECT COUNT(*) FROM note_page_index;"));
    try std.testing.expectEqual(
        @as(i64, 2),
        try countOf(db, "SELECT COUNT(*) FROM note_page_index WHERE width = 1404 AND height = 1872;"),
    );
}

test "v15: only the DERIVED PDFs are re-asked, and a failure verdict is left alone" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    inline for (steps[0..14], 1..) |ddl, n| try applyStep(db, n, ddl);
    try std.testing.expectEqual(@as(i64, 14), try userVersion(db));

    try db.exec(
        \\INSERT INTO blobs(md5, size, refcount, created_at) VALUES('ok', 10, 1, 0);
        \\INSERT INTO blobs(md5, size, refcount, created_at) VALUES('none', 10, 1, 0);
        \\INSERT INTO blobs(md5, size, refcount, created_at) VALUES('trunc', 10, 1, 0);
        \\INSERT INTO blobs(md5, size, refcount, created_at) VALUES('shut', 10, 1, 0);
        \\INSERT INTO blobs(md5, size, refcount, created_at) VALUES('txt', 10, 1, 0);
        \\-- pdf_text: 0 ok, 1 no_text, 2 truncated, 3 unopenable (pdf_text.Verdict).
        \\INSERT INTO note_index(blob_md5, index_version, indexable, page_count, indexed_at, pdf_probe, pdf_text)
        \\  VALUES('ok', 15, 0, 0, 0, 0, 0);
        \\INSERT INTO note_index(blob_md5, index_version, indexable, page_count, indexed_at, pdf_probe, pdf_text)
        \\  VALUES('none', 15, 0, 0, 0, 0, 1);
        \\INSERT INTO note_index(blob_md5, index_version, indexable, page_count, indexed_at, pdf_probe, pdf_text)
        \\  VALUES('trunc', 15, 0, 0, 0, 0, 2);
        \\INSERT INTO note_index(blob_md5, index_version, indexable, page_count, indexed_at, pdf_probe, pdf_text)
        \\  VALUES('shut', 15, 0, 0, 0, 0, 3);
        \\INSERT INTO note_index(blob_md5, index_version, indexable, page_count, indexed_at, txt_index)
        \\  VALUES('txt', 15, 0, 0, 0, 1);
    );

    try applyStep(db, 15, ddl_v15);
    try std.testing.expectEqual(@as(i64, 15), try userVersion(db));

    try std.testing.expectEqual(
        @as(i64, 1),
        try countOf(db, "SELECT COUNT(*) FROM note_index WHERE pdf_probe = 0 AND pdf_text IS NULL;"),
    );
    try std.testing.expectEqual(
        @as(i64, 1),
        try countOf(db, "SELECT COUNT(*) FROM note_index WHERE blob_md5 = 'ok' AND pdf_text IS NULL;"),
    );
    try std.testing.expectEqual(
        @as(i64, 3),
        try countOf(db, "SELECT COUNT(*) FROM note_index WHERE pdf_text IN (1, 2, 3);"),
    );
    try std.testing.expectEqual(
        @as(i64, 1),
        try countOf(db, "SELECT COUNT(*) FROM note_index WHERE blob_md5 = 'txt' AND txt_index = 1;"),
    );
    try std.testing.expectEqual(@as(i64, 5), try countOf(db, "SELECT COUNT(*) FROM note_index;"));
}

test "v14: the search index is gone, `kind = 0` stays, and a mid-derive database survives it" {
    // Driven against a half-written chunked `.txt` derivation.
    var db = try sqlite.Db.openMemory();
    defer db.close();

    inline for (steps[0..13], 1..) |ddl, n| try applyStep(db, n, ddl);
    try std.testing.expectEqual(@as(i64, 13), try userVersion(db));

    try db.exec(
        \\INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);
        \\INSERT INTO blobs(md5, size, refcount, created_at) VALUES('n', 10, 1, 0);
        \\INSERT INTO blobs(md5, size, refcount, created_at) VALUES('t', 10, 1, 0);
        \\INSERT INTO note_index(blob_md5, index_version, indexable, page_count, indexed_at) VALUES('n', 1, 1, 2, 0);
        \\INSERT INTO note_index(blob_md5, index_version, indexable, page_count, indexed_at) VALUES('t', 1, 0, 0, 0);
        \\-- kind 0: a note's two pages, which STAY (geometry, layers, transcript).
        \\INSERT INTO note_page_index(blob_md5, kind, page_index, content_hash, width, height, layers, recogn_status, text)
        \\  VALUES('n', 0, 0, 'h0', 100, 200, x'', 1, 'ink one');
        \\INSERT INTO note_page_index(blob_md5, kind, page_index, content_hash, width, height, layers, recogn_status, text)
        \\  VALUES('n', 0, 1, 'h1', 100, 200, x'', 1, 'ink two');
        \\-- kind 1: a `.txt` HALF written — two paragraph rows of a longer document,
        \\-- with a band reserved for more than were filled. `txt_index` is still
        \\-- NULL, which is what says the write never finished.
        \\INSERT INTO note_page_index(blob_md5, kind, page_index, content_hash, width, height, layers, recogn_status, text)
        \\  VALUES('t', 1, 0, 'p0', 0, 0, x'', 1, 'para one');
        \\INSERT INTO note_page_index(blob_md5, kind, page_index, content_hash, width, height, layers, recogn_status, text)
        \\  VALUES('t', 1, 1, 'p1', 0, 0, x'', 1, 'para two');
        \\INSERT INTO search_partitions(user_id, active, next_seq, created_at) VALUES(1, 1, 8, 0);
    );
    try db.exec(
        \\INSERT INTO segment_search(id, segment_id)
        \\  SELECT (1 << 48) + p.id, p.id FROM note_page_index p;
        \\INSERT INTO segment_fts(rowid, txt)
        \\  SELECT s.id, p.text FROM segment_search s JOIN note_page_index p ON p.id = s.segment_id;
    );
    try std.testing.expectEqual(@as(i64, 4), try countOf(db, "SELECT COUNT(*) FROM segment_search;"));

    try applyStep(db, 14, ddl_v14);
    try std.testing.expectEqual(@as(i64, 14), try userVersion(db));

    for ([_][]const u8{
        "segment_fts",            "segment_text",           "segment_search",  "search_partitions",
        "segment_fts_data",       "segment_fts_docsize",    "segment_fts_idx", "segment_fts_config",
        "segment_search_segment", "search_partitions_user",
    }) |name| {
        var r = (try db.row("SELECT COUNT(*) FROM sqlite_master WHERE name = ?1;", &.{.{ .text = name }})).?;
        defer r.finalize();
        try std.testing.expectEqual(@as(i64, 0), r.int(0));
    }

    try std.testing.expectEqual(@as(i64, 2), try countOf(db, "SELECT COUNT(*) FROM note_page_index;"));
    try std.testing.expectEqual(@as(i64, 2), try countOf(db, "SELECT COUNT(*) FROM note_page_index WHERE kind = 0;"));
    try std.testing.expectEqual(@as(i64, 2), try countOf(db, "SELECT COUNT(*) FROM note_index;")); // both memos survive

    {
        var r = (try db.row("PRAGMA integrity_check;", &.{})).?;
        defer r.finalize();
        try std.testing.expectEqualStrings("ok", r.text(0));
    }
    try migrate(db);
    try std.testing.expectEqual(version, try userVersion(db));
}

fn countOf(db: sqlite.Db, sql: []const u8) !i64 {
    var r = (try db.row(sql, &.{})) orelse return error.NoRow;
    defer r.finalize();
    return r.int(0);
}

test "migrate creates the v1 schema and is idempotent" {
    var db = try sqlite.Db.openMemory();
    defer db.close();

    try migrate(db);
    try std.testing.expectEqual(version, try userVersion(db));
    try migrate(db); // second run is a no-op

    try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);");
    try db.exec("INSERT INTO capacity(user_id, total_bytes) VALUES(1, 1000);");

    var r = (try db.row("SELECT email FROM users WHERE id = 1;", &.{})) orelse return error.TestUnexpectedResult;
    defer r.finalize();
    try std.testing.expectEqualStrings("a@b.c", r.text(0));
}

test "v2: fresh and v1-upgraded databases carry an identical file_history table" {
    const read_ddl = struct {
        fn get(db: sqlite.Db, buf: []u8) ![]const u8 {
            var r = (try db.row("SELECT sql FROM sqlite_master WHERE name = 'file_history';", &.{})) orelse return error.Missing;
            defer r.finalize();
            const sql = r.text(0);
            @memcpy(buf[0..sql.len], sql);
            return buf[0..sql.len];
        }
    }.get;

    var fresh = try sqlite.Db.openMemory();
    defer fresh.close();
    try migrate(fresh);
    try std.testing.expectEqual(version, try userVersion(fresh));

    var upg = try sqlite.Db.openMemory();
    defer upg.close();
    try upg.exec(ddl_v1);
    try upg.exec("PRAGMA user_version = 1;");
    try migrate(upg);
    try std.testing.expectEqual(version, try userVersion(upg));

    var fbuf: [512]u8 = undefined;
    var ubuf: [512]u8 = undefined;
    try std.testing.expectEqualStrings(try read_ddl(fresh, &fbuf), try read_ddl(upg, &ubuf));

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

    var from_v1 = try sqlite.Db.openMemory();
    defer from_v1.close();
    try from_v1.exec(ddl_v1);
    try from_v1.exec("PRAGMA user_version = 1;");
    try migrate(from_v1);

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

    try fresh.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);");
    var r = (try fresh.row("SELECT password_changed_at, history_keep FROM users WHERE id = 1;", &.{})) orelse return error.TestUnexpectedResult;
    defer r.finalize();
    try std.testing.expect(r.intOpt(0) == null);
    try std.testing.expect(r.intOpt(1) == null);
}

test "v5: fresh and stepwise-migrated databases carry an identical upload_sessions table" {
    const read_ddl = struct {
        fn get(db: sqlite.Db, buf: []u8) ![]const u8 {
            var r = (try db.row("SELECT sql FROM sqlite_master WHERE name = 'upload_sessions';", &.{})) orelse return error.Missing;
            defer r.finalize();
            const sql = r.text(0);
            @memcpy(buf[0..sql.len], sql);
            return buf[0..sql.len];
        }
    }.get;

    var fresh = try sqlite.Db.openMemory();
    defer fresh.close();
    try migrate(fresh);

    var from_v4 = try sqlite.Db.openMemory();
    defer from_v4.close();
    try from_v4.exec(ddl_v1);
    try from_v4.exec(ddl_v2);
    try from_v4.exec(ddl_v3);
    try from_v4.exec("PRAGMA user_version = 4;");
    try migrate(from_v4);

    var a: [1024]u8 = undefined;
    var b: [1024]u8 = undefined;
    try std.testing.expectEqualStrings(try read_ddl(fresh, &a), try read_ddl(from_v4, &b));
    try std.testing.expectEqual(version, try userVersion(fresh));
    try std.testing.expectEqual(version, try userVersion(from_v4));

    // DEFAULT 0, not NULL, so an in-flight upload's budget arithmetic still works.
    try from_v4.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);");
    try from_v4.exec(
        "INSERT INTO upload_sessions(inner_name, user_id, path, file_name, declared_size, created_at) " ++
            "VALUES('x', 1, '/Note', 'a.note', 10, 0);",
    );
    var r = (try from_v4.row("SELECT received_bytes FROM upload_sessions WHERE inner_name = 'x';", &.{})) orelse
        return error.TestUnexpectedResult;
    defer r.finalize();
    try std.testing.expect(!r.isNull(0));
    try std.testing.expectEqual(@as(i64, 0), r.int(0));
}

test "v6: fresh and stepwise-migrated databases carry an identical note_index table" {
    const read_ddl = struct {
        fn get(db: sqlite.Db, buf: []u8) ![]const u8 {
            var r = (try db.row("SELECT sql FROM sqlite_master WHERE name = 'note_index';", &.{})) orelse return error.Missing;
            defer r.finalize();
            const sql = r.text(0);
            @memcpy(buf[0..sql.len], sql);
            return buf[0..sql.len];
        }
    }.get;

    var fresh = try sqlite.Db.openMemory();
    defer fresh.close();
    try migrate(fresh);

    var from_v5 = try sqlite.Db.openMemory();
    defer from_v5.close();
    try from_v5.exec(ddl_v1);
    try from_v5.exec(ddl_v2);
    try from_v5.exec(ddl_v3);
    try from_v5.exec(ddl_v5);
    try from_v5.exec("PRAGMA user_version = 5;");
    try migrate(from_v5);

    var a: [2048]u8 = undefined;
    var b: [2048]u8 = undefined;
    try std.testing.expectEqualStrings(try read_ddl(fresh, &a), try read_ddl(from_v5, &b));
    try std.testing.expectEqual(version, try userVersion(fresh));
    try std.testing.expectEqual(version, try userVersion(from_v5));

    try from_v5.exec(
        "INSERT INTO blobs(md5, size, refcount, created_at) VALUES('0123456789abcdef0123456789abcdef', 1, 1, 0);",
    );
    try from_v5.exec(
        "INSERT INTO note_index(blob_md5, index_version, indexable, page_count, indexed_at) " ++
            "VALUES('0123456789abcdef0123456789abcdef', 1, 1, 3, 0);",
    );
    var r = (try from_v5.row(
        "SELECT filetype, page_count FROM note_index WHERE blob_md5 = '0123456789abcdef0123456789abcdef';",
        &.{},
    )) orelse return error.TestUnexpectedResult;
    defer r.finalize();
    try std.testing.expect(r.isNull(0));
    try std.testing.expectEqual(@as(i64, 3), r.int(1));
}

test "v4: used_bytes is RECOMPUTED to charge retained versions, and converges from either direction" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try migrate(db);

    try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);");
    try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(2, 'x@y.z', '0123456789abcdef0123456789abcdef', 0);");
    try db.exec("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(1, 0, 100000);");
    try db.exec("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(2, 0, 100000);");
    // 'both' is held live and in history and must be charged once.
    try db.exec("INSERT INTO blobs(md5, size, refcount, created_at) VALUES('cur', 100, 1, 0);");
    try db.exec("INSERT INTO blobs(md5, size, refcount, created_at) VALUES('old', 30, 0, 0);");
    try db.exec("INSERT INTO blobs(md5, size, refcount, created_at) VALUES('both', 7, 1, 0);");
    try db.exec("INSERT INTO blobs(md5, size, refcount, created_at) VALUES('theirs', 500, 1, 0);");
    try db.exec("INSERT INTO files(id, user_id, name, md5, size, created_at, updated_at) VALUES(1, 1, 'a.note', 'cur', 100, 0, 0);");
    try db.exec("INSERT INTO files(id, user_id, name, md5, size, created_at, updated_at) VALUES(2, 1, 'b.note', 'both', 7, 0, 0);");
    try db.exec("INSERT INTO files(id, user_id, name, md5, size, created_at, updated_at) VALUES(3, 2, 'c.note', 'theirs', 500, 0, 0);");
    try db.exec("INSERT INTO file_history(file_id, md5, size, created_at) VALUES(1, 'old', 30, 0);");
    try db.exec("INSERT INTO file_history(file_id, md5, size, created_at) VALUES(2, 'both', 7, 0);");
    try db.exec("INSERT INTO files(id, user_id, name, is_folder, created_at, updated_at) VALUES(4, 1, 'Dir', 1, 0, 0);");
    try db.exec("INSERT INTO file_history(file_id, md5, size, created_at) VALUES(2, 'old', 30, 0);");

    const readUsed = struct {
        fn get(d: sqlite.Db, uid: i64) !i64 {
            var r = (try d.row("SELECT used_bytes FROM capacity WHERE user_id = ?1;", &.{.{ .int = uid }})) orelse return error.Missing;
            defer r.finalize();
            return r.int(0);
        }
    }.get;

    try db.exec("UPDATE capacity SET used_bytes = 107 WHERE user_id = 1;");
    try db.exec(ddl_v4);
    try std.testing.expectEqual(@as(i64, 137), try readUsed(db, 1)); // 100 + 30 + 7, each once
    try std.testing.expectEqual(@as(i64, 500), try readUsed(db, 2));

    try db.exec("UPDATE capacity SET used_bytes = 999999 WHERE user_id = 1;");
    try db.exec(ddl_v4);
    try std.testing.expectEqual(@as(i64, 137), try readUsed(db, 1));
    try db.exec(ddl_v4);
    try std.testing.expectEqual(@as(i64, 137), try readUsed(db, 1));
    try std.testing.expectEqual(@as(i64, 500), try readUsed(db, 2)); // never disturbed
}

test "a step that fails partway leaves the database untouched, and still migratable" {
    var db = try sqlite.Db.openMemory();
    defer db.close();

    const half_failing =
        \\CREATE TABLE users (id INTEGER PRIMARY KEY);
        \\CREATE TABLE users (id INTEGER PRIMARY KEY);
    ;
    sqlite.log_exec_errors = false; // the failure below is the point, not a symptom
    defer sqlite.log_exec_errors = true;
    try std.testing.expectError(error.Exec, applyStep(db, 1, half_failing));
    sqlite.log_exec_errors = true;

    // Scoped probe: an open `sqlite_master` cursor would make v13's DROP fail SQLITE_LOCKED.
    try std.testing.expectEqual(@as(i64, 0), try userVersion(db));
    {
        var r = (try db.row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'users';",
            &.{},
        )) orelse return error.TestUnexpectedResult;
        defer r.finalize();
        try std.testing.expectEqual(@as(i64, 0), r.int(0));
    }

    try migrate(db);
    try std.testing.expectEqual(version, try userVersion(db));
    try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);");
}

test "the user_version stamp rolls back with its step" {
    var db = try sqlite.Db.openMemory();
    defer db.close();

    try db.exec("BEGIN IMMEDIATE;");
    try db.exec("PRAGMA user_version = 7;");
    try std.testing.expectEqual(@as(i64, 7), try userVersion(db)); // visible inside
    try db.exec("ROLLBACK;");
    try std.testing.expectEqual(@as(i64, 0), try userVersion(db)); // and gone again
}

test {
    _ = schema_ddl;
}
