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
