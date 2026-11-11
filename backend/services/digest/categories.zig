//! Categories: rows with `is_group`, named by uid; deleting one deletes its digests.

const sqlite = @import("../../db/sqlite.zig");
const digest = @import("../digest.zig");
const Digest = digest.Digest;
const Error = digest.Error;
const internal = @import("internal.zig");
const liveId = internal.liveId;

/// Stores a new category and returns its id. A resend of a category still
/// live (same `uniqueIdentifier`) updates it and returns its id.
pub fn addGroup(db: sqlite.Db, user_id: u64, g: Digest, now_ms: i64) sqlite.Error!u64 {
    if (g.uid) |uid| {
        if (try liveId(db, user_id, true, uid)) |id| {
            _ = try putGroup(db, user_id, id, g, now_ms);
            return id;
        }
    }
    try db.runCached(
        \\INSERT INTO digests (user_id, is_group, uid, name, description, md5_hash, creation_time,
        \\  last_modified_time, created_at, updated_at)
        \\VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8);
    , &.{
        .{ .int = @intCast(user_id) },    .{ .text_opt = g.uid },  .{ .text_opt = g.name },
        .{ .text_opt = g.description },   .{ .text = g.md5_hash }, .{ .int = g.creation_time },
        .{ .int = g.last_modified_time }, .{ .int = now_ms },
    });
    return @intCast(db.lastInsertRowId());
}

/// Replaces a live category's name, description and md5. A stored id is kept;
/// an empty one takes `g.uid`. False when there is no such live category.
pub fn putGroup(db: sqlite.Db, user_id: u64, id: u64, g: Digest, now_ms: i64) sqlite.Error!bool {
    try db.runCached(
        \\UPDATE digests SET uid = COALESCE(NULLIF(uid, ''), ?3), name = ?4, description = ?5, md5_hash = ?6,
        \\  last_modified_time = ?7, updated_at = ?8
        \\WHERE user_id = ?1 AND id = ?2 AND is_group = 1 AND deleted = 0;
    , &.{
        .{ .int = @intCast(user_id) },    .{ .int = @intCast(id) },       .{ .text_opt = g.uid },
        .{ .text_opt = g.name },          .{ .text_opt = g.description }, .{ .text = g.md5_hash },
        .{ .int = g.last_modified_time }, .{ .int = now_ms },
    });
    return db.changes() > 0;
}

/// Soft-deletes a category and every digest in it, together. Nothing to
/// delete is not an error.
pub fn deleteGroup(db: sqlite.Db, user_id: u64, id: u64, now_ms: i64) sqlite.Error!void {
    try db.exec("BEGIN IMMEDIATE;");
    errdefer db.exec("ROLLBACK;") catch {};
    const binds: []const sqlite.Bind = &.{ .{ .int = @intCast(user_id) }, .{ .int = @intCast(id) }, .{ .int = now_ms } };
    try db.runCached(
        \\UPDATE digests SET deleted = 1, deleted_at = ?3, updated_at = ?3
        \\WHERE user_id = ?1 AND is_group = 0 AND deleted = 0 AND parent_uid <> ''
        \\  AND parent_uid = (SELECT uid FROM digests WHERE user_id = ?1 AND id = ?2 AND is_group = 1 AND deleted = 0);
    , binds);
    try db.runCached(
        \\UPDATE digests SET deleted = 1, deleted_at = ?3, updated_at = ?3
        \\WHERE user_id = ?1 AND id = ?2 AND is_group = 1 AND deleted = 0;
    , binds);
    try db.exec("COMMIT;");
}

/// Whether `uid` names one of the account's live categories ('' is
/// Uncategorized, always there).
pub fn categoryExists(db: sqlite.Db, user_id: u64, uid: []const u8) sqlite.Error!bool {
    if (uid.len == 0) return true;
    return (try liveId(db, user_id, true, uid)) != null;
}
