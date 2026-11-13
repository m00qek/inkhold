//! What the digest parts share and nothing else calls: the column list and the row reader.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const digest = @import("../digest.zig");
const Digest = digest.Digest;
const Error = digest.Error;

pub const columns =
    \\id, is_group, uid, parent_uid, name, description, content, source_path, source_type,
    \\  data_source, author, tags, metadata, comment_str, comment_handwrite_name,
    \\  handwrite_inner_name, handwrite_md5, md5_hash, creation_time, last_modified_time,
    \\  created_at, updated_at
;

/// How many `columns` there are: what a query selects after them starts here.
pub const column_count = std.mem.count(u8, columns, ",") + 1;

pub fn readAll(arena: std.mem.Allocator, st: sqlite.Stmt) Error![]Digest {
    var out: std.ArrayList(Digest) = .empty;
    while (try st.step()) try out.append(arena, try readRow(arena, st));
    return out.items;
}

pub fn readRow(arena: std.mem.Allocator, st: sqlite.Stmt) Error!Digest {
    return .{
        .id = @intCast(st.columnInt(0)),
        .is_group = st.columnInt(1) != 0,
        .uid = try optText(arena, st, 2),
        .parent_uid = try arena.dupe(u8, st.columnText(3)),
        .name = try optText(arena, st, 4),
        .description = try optText(arena, st, 5),
        .content = try optText(arena, st, 6),
        .source_path = try optText(arena, st, 7),
        .source_type = st.columnIntOpt(8),
        .data_source = try optText(arena, st, 9),
        .author = try optText(arena, st, 10),
        .tags = try optText(arena, st, 11),
        .metadata = try optText(arena, st, 12),
        .comment_str = try optText(arena, st, 13),
        .comment_handwrite_name = try optText(arena, st, 14),
        .handwrite_inner_name = try optText(arena, st, 15),
        .handwrite_md5 = try optText(arena, st, 16),
        .md5_hash = try arena.dupe(u8, st.columnText(17)),
        .creation_time = st.columnInt(18),
        .last_modified_time = st.columnInt(19),
        .created_at = st.columnInt(20),
        .updated_at = st.columnInt(21),
    };
}

pub fn liveId(db: sqlite.Db, user_id: u64, is_group: bool, uid: []const u8) sqlite.Error!?u64 {
    var r = (try db.rowCached(
        \\SELECT id FROM digests WHERE user_id = ?1 AND is_group = ?2 AND uid = ?3 AND deleted = 0
        \\ORDER BY id LIMIT 1;
    , &.{ .{ .int = @intCast(user_id) }, .{ .int = @intFromBool(is_group) }, .{ .text = uid } })) orelse return null;
    defer r.finalize();
    return @intCast(r.int(0));
}

pub fn optText(arena: std.mem.Allocator, st: sqlite.Stmt, col: c_int) Error!?[]const u8 {
    if (st.columnIsNull(col)) return null;
    return try arena.dupe(u8, st.columnText(col));
}

/// The id of the live category `uid`; '' (Uncategorized) is never a row.
pub fn categoryId(db: sqlite.Db, user_id: u64, uid: []const u8) sqlite.Error!?u64 {
    if (uid.len == 0) return null;
    return liveId(db, user_id, true, uid);
}
