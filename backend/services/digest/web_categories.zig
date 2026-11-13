//! The browser's categories: made, renamed and deleted here, taken by the
//! tablet at its next sync (decompiled `KnowledgeBaseSyncWorker`). A category
//! the tablet lacks is added with the server's uid and md5; one it has not
//! changed since its last sync takes the server's name when the md5 differs,
//! and when both changed the newer `last_modified_time` wins; one missing from
//! the list is deleted with its digests, unless the tablet changed them since
//! (the delete itself is `categories.deleteGroup`, shared with the tablet's).

const sqlite = @import("../../db/sqlite.zig");
const internal = @import("internal.zig");

/// What making a category came to. `name_taken`, here and in `Renamed`: a
/// live category has that name already; the app refuses a second ("%s
/// already exists"), so the server does too.
pub const Created = enum { done, name_taken };

/// What renaming a category came to; `not_found`: no such live category.
pub const Renamed = enum { done, name_taken, not_found };

/// Stores a category made in the browser, with a new `uid` and `md5_hash`.
pub fn createCategory(db: sqlite.Db, user_id: u64, uid: []const u8, name: []const u8, md5_hash: []const u8, now_ms: i64) sqlite.Error!Created {
    try db.exec("BEGIN IMMEDIATE;");
    errdefer db.exec("ROLLBACK;") catch {};
    if (try nameTaken(db, user_id, name, null)) {
        try db.exec("ROLLBACK;");
        return .name_taken;
    }
    try db.runCached(
        \\INSERT INTO digests (user_id, is_group, uid, name, md5_hash, creation_time, last_modified_time,
        \\  created_at, updated_at, web_changed_at)
        \\VALUES (?1, 1, ?2, ?3, ?4, ?5, ?5, ?5, ?5, ?5);
    , &.{
        .{ .int = @intCast(user_id) }, .{ .text = uid }, .{ .text = name }, .{ .text = md5_hash }, .{ .int = now_ms },
    });
    try db.exec("COMMIT;");
    return .done;
}

/// Renames a live category; its own name is no clash. The new md5 makes the
/// tablet take it; the time moves past the row's own, so a tablet clock
/// ahead cannot win over it.
pub fn renameCategory(db: sqlite.Db, user_id: u64, uid: []const u8, name: []const u8, md5_hash: []const u8, now_ms: i64) sqlite.Error!Renamed {
    try db.exec("BEGIN IMMEDIATE;");
    errdefer db.exec("ROLLBACK;") catch {};
    const result: Renamed = if (try internal.categoryId(db, user_id, uid) == null)
        .not_found
    else if (try nameTaken(db, user_id, name, uid))
        .name_taken
    else
        .done;
    if (result != .done) {
        try db.exec("ROLLBACK;");
        return result;
    }
    try db.runCached(
        \\UPDATE digests SET name = ?3, md5_hash = ?4, last_modified_time = MAX(?5, last_modified_time + 1),
        \\  updated_at = ?5, web_changed_at = ?5
        \\WHERE user_id = ?1 AND uid = ?2 AND is_group = 1 AND deleted = 0;
    , &.{
        .{ .int = @intCast(user_id) }, .{ .text = uid }, .{ .text = name }, .{ .text = md5_hash }, .{ .int = now_ms },
    });
    try db.exec("COMMIT;");
    return .done;
}

/// Whether a live category other than `except_uid` is named exactly `name`.
fn nameTaken(db: sqlite.Db, user_id: u64, name: []const u8, except_uid: ?[]const u8) sqlite.Error!bool {
    var r = (try db.rowCached(
        \\SELECT 1 FROM digests WHERE user_id = ?1 AND is_group = 1 AND deleted = 0 AND name = ?2
        \\  AND (?3 IS NULL OR uid IS NOT ?3) LIMIT 1;
    , &.{ .{ .int = @intCast(user_id) }, .{ .text = name }, .{ .text_opt = except_uid } })) orelse return false;
    r.finalize();
    return true;
}
