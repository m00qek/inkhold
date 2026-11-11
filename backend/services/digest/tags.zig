//! Tags, per account.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const digest = @import("../digest.zig");
const Error = digest.Error;
const Tag = digest.Tag;

pub fn addTag(db: sqlite.Db, user_id: u64, name: []const u8, now_ms: i64) sqlite.Error!u64 {
    try db.runCached("INSERT INTO digest_tags (user_id, name, created_at) VALUES (?1, ?2, ?3);", &.{
        .{ .int = @intCast(user_id) }, .{ .text = name }, .{ .int = now_ms },
    });
    return @intCast(db.lastInsertRowId());
}

/// False when there is no such tag.
pub fn renameTag(db: sqlite.Db, user_id: u64, id: u64, name: []const u8) sqlite.Error!bool {
    try db.runCached("UPDATE digest_tags SET name = ?3 WHERE user_id = ?1 AND id = ?2;", &.{
        .{ .int = @intCast(user_id) }, .{ .int = @intCast(id) }, .{ .text = name },
    });
    return db.changes() > 0;
}

/// Nothing to delete is not an error.
pub fn deleteTag(db: sqlite.Db, user_id: u64, id: u64) sqlite.Error!void {
    try db.runCached("DELETE FROM digest_tags WHERE user_id = ?1 AND id = ?2;", &.{
        .{ .int = @intCast(user_id) }, .{ .int = @intCast(id) },
    });
}

pub fn tags(db: sqlite.Db, arena: std.mem.Allocator, user_id: u64) Error![]Tag {
    var st = try db.prepareCached("SELECT id, name, created_at FROM digest_tags WHERE user_id = ?1 ORDER BY id;");
    defer st.finalize();
    st.bindInt(1, @intCast(user_id));
    var out: std.ArrayList(Tag) = .empty;
    while (try st.step()) try out.append(arena, .{
        .id = @intCast(st.columnInt(0)),
        .name = try arena.dupe(u8, st.columnText(1)),
        .created_at = st.columnInt(2),
    });
    return out.items;
}
