//! Tests for the schema and its migrations.

const std = @import("std");
const sqlite = @import("sqlite.zig");
const schema = @import("schema.zig");
const migrate = schema.migrate;

test "foreign keys are enforced" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try migrate(db);
    var s = try db.prepare("INSERT INTO capacity(user_id, total_bytes) VALUES(999, 1);");
    defer s.finalize();
    try std.testing.expectError(error.Step, s.step());
}

test "files tree: folder + file insert, and unique live names per folder" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try migrate(db);
    try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);");

    try db.exec("INSERT INTO blobs(md5, size, refcount, created_at) VALUES('aa', 10, 1, 0);");
    try db.exec("INSERT INTO files(user_id, parent_id, name, is_folder, created_at, updated_at) VALUES(1, NULL, 'Notes', 1, 0, 0);");
    try db.exec("INSERT INTO files(user_id, parent_id, name, md5, size, created_at, updated_at) VALUES(1, 1, 'a.note', 'aa', 10, 0, 0);");

    {
        var s = try db.prepare("INSERT INTO files(user_id, parent_id, name, created_at, updated_at) VALUES(1, 1, 'a.note', 0, 0);");
        defer s.finalize();
        try std.testing.expectError(error.Step, s.step());
    }
    try db.exec("UPDATE files SET deleted = 1 WHERE name = 'a.note';");
    try db.exec("INSERT INTO files(user_id, parent_id, name, md5, size, created_at, updated_at) VALUES(1, 1, 'a.note', 'aa', 10, 0, 0);");

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

test "v17: backup_runs holds one row per directory, empty on a migrated install" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try migrate(db);
    var r = (try db.row("SELECT COUNT(*) FROM backup_runs;", &.{})).?;
    try std.testing.expectEqual(@as(i64, 0), r.int(0));
    r.finalize();
    try db.exec("INSERT INTO backup_runs(dir, last_run_at) VALUES('/mnt/nas', 1);");
    var dup = try db.prepare("INSERT INTO backup_runs(dir, last_run_at) VALUES('/mnt/nas', 2);");
    defer dup.finalize();
    try std.testing.expectError(error.Step, dup.step());
}

/// Every index on `files`, as SQLite stores its definition.
fn fileIndexes(gpa: std.mem.Allocator, db: sqlite.Db) ![]const u8 {
    var s = try db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'files' AND sql IS NOT NULL ORDER BY name;");
    defer s.finalize();
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    while (try s.step()) try out.print(gpa, "{s}: {s}\n", .{ s.columnText(0), s.columnText(1) });
    return out.toOwnedSlice(gpa);
}

fn count(db: sqlite.Db, sql: []const u8) !i64 {
    var r = (try db.row(sql, &.{})).?;
    defer r.finalize();
    return r.int(0);
}

test "v19: files keep their ids, rows, history and indexes, and a purged top id is never handed out again" {
    const gpa = std.testing.allocator;
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrateTo(db, 18);
    try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@home', '', 0);");
    try db.exec("INSERT INTO files(id, user_id, name, is_folder, created_at, updated_at) VALUES(1, 1, 'Note', 1, 0, 0);");
    try db.exec("INSERT INTO files(id, user_id, parent_id, name, md5, size, created_at, updated_at) VALUES(2, 1, 1, 'a.note', 'aa', 1, 0, 0);");
    try db.exec("INSERT INTO files(id, user_id, parent_id, name, md5, size, created_at, updated_at, deleted, deleted_at, deleted_path) VALUES(7, 1, 1, 'b.note', 'bb', 2, 0, 0, 1, 5, '/Note/b.note');");
    try db.exec("INSERT INTO file_history(file_id, md5, size, created_at) VALUES(2, 'old', 1, 0);");
    const before = try fileIndexes(gpa, db);
    defer gpa.free(before);

    try schema.migrateTo(db, 19);
    try std.testing.expectEqual(@as(i64, 19), try schema.userVersion(db));

    // Same rows, same ids, and the history that hangs off them survived the DROP.
    try std.testing.expectEqual(@as(i64, 3), try count(db, "SELECT COUNT(*) FROM files;"));
    try std.testing.expectEqual(@as(i64, 1), try count(db, "SELECT COUNT(*) FROM file_history WHERE file_id = 2;"));
    try std.testing.expectEqual(@as(i64, 5), try count(db, "SELECT deleted_at FROM files WHERE id = 7 AND deleted = 1 AND deleted_path = '/Note/b.note';"));
    const after = try fileIndexes(gpa, db);
    defer gpa.free(after);
    try std.testing.expectEqualStrings(before, after);

    // Foreign keys are back on, still pointing at the rebuilt table.
    try std.testing.expectEqual(@as(i64, 1), try count(db, "PRAGMA foreign_keys;"));
    sqlite.log_exec_errors = false;
    defer sqlite.log_exec_errors = true;
    try std.testing.expectError(error.Exec, db.exec("INSERT INTO file_history(file_id, md5, size, created_at) VALUES(99, 'x', 1, 0);"));
    try db.exec("DELETE FROM files WHERE id = 2;");
    try std.testing.expectEqual(@as(i64, 0), try count(db, "SELECT COUNT(*) FROM file_history;"));

    // The top id is purged; the next file still gets a new one.
    try db.exec("DELETE FROM files WHERE id = 7;");
    try db.exec("INSERT INTO files(user_id, parent_id, name, md5, size, created_at, updated_at) VALUES(1, 1, 'c.note', 'cc', 3, 0, 0);");
    try std.testing.expectEqual(@as(i64, 8), try count(db, "SELECT MAX(id) FROM files;"));
}

test "v24: categories stored without an id get one and a fresh md5; others are untouched" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrateTo(db, 23);
    try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@home', '', 0);");
    try db.exec(
        \\INSERT INTO digests(id, user_id, is_group, uid, name, md5_hash, created_at, updated_at) VALUES
        \\ (1, 1, 1, NULL, 'Français', 'g1', 0, 0),
        \\ (2, 1, 1, '', 'Note', 'g2', 0, 0),
        \\ (3, 1, 1, 'kb-work', 'Work', 'g3', 0, 0),
        \\ (4, 1, 0, NULL, 'a digest, not a category', 'd1', 0, 0);
    );
    try schema.migrateTo(db, 24);
    try std.testing.expectEqual(@as(i64, 24), try schema.userVersion(db));
    try std.testing.expectEqual(@as(i64, 2), try count(db, "SELECT COUNT(*) FROM digests WHERE id IN (1, 2) AND length(uid) = 32 AND md5_hash NOT IN ('g1', 'g2');"));
    try std.testing.expectEqual(@as(i64, 1), try count(db, "SELECT COUNT(*) FROM digests WHERE id = 3 AND uid = 'kb-work' AND md5_hash = 'g3';"));
    try std.testing.expectEqual(@as(i64, 1), try count(db, "SELECT COUNT(*) FROM digests WHERE id = 4 AND uid IS NULL AND md5_hash = 'd1';"));
}

test "v25: digests keep what the browser changed, unset until it changes something; accounts their tablet's last listing" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrateTo(db, 24);
    try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@home', '', 0);");
    try db.exec("INSERT INTO digests(id, user_id, md5_hash, created_at, updated_at) VALUES (1, 1, 'd1', 0, 0);");
    try schema.migrateTo(db, 25);
    try std.testing.expectEqual(@as(i64, 1), try count(db, "SELECT COUNT(*) FROM digests WHERE id = 1 AND web_changed_at IS NULL AND md5_hash = 'd1';"));
    try db.exec("INSERT INTO digest_sync_state(user_id, tablet_listed_at) VALUES (1, 5);");
    try db.exec("DELETE FROM users WHERE id = 1;");
    try std.testing.expectEqual(@as(i64, 0), try count(db, "SELECT COUNT(*) FROM digest_sync_state;"));
}

test "v26: an account's tablet has a time the browser last purged a digest it had not seen go, unset until then" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrateTo(db, 25);
    try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@home', '', 0);");
    try db.exec("INSERT INTO digest_sync_state(user_id, tablet_listed_at) VALUES (1, 5);");
    try schema.migrateTo(db, 26);
    try std.testing.expectEqual(@as(i64, 1), try count(db, "SELECT COUNT(*) FROM digest_sync_state WHERE user_id = 1 AND tablet_listed_at = 5 AND web_purged_at IS NULL;"));
}
