//! Categories: rows with `is_group`, named by uid; deleting one deletes its digests, to the bin.

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
        \\  last_modified_time = ?7, updated_at = ?8, web_changed_at = NULL
        \\WHERE user_id = ?1 AND id = ?2 AND is_group = 1 AND deleted = 0;
    , &.{
        .{ .int = @intCast(user_id) },    .{ .int = @intCast(id) },       .{ .text_opt = g.uid },
        .{ .text_opt = g.name },          .{ .text_opt = g.description }, .{ .text = g.md5_hash },
        .{ .int = g.last_modified_time }, .{ .int = now_ms },
    });
    return db.changes() > 0;
}

/// Who deletes a category: the browser's delete waits for a tablet to fetch
/// it (`web_changed_at`); a tablet's is its own.
pub const Origin = enum { tablet, web };

/// A category by its server id (the tablet's) or its uid (the browser's).
pub const GroupRef = union(enum) { id: u64, uid: []const u8 };

/// Soft-deletes a live category and every digest in it, together; the
/// digests go to the bin. Returns how many digests it held; null when there
/// is no such live category (a delete of one already gone succeeds for a
/// tablet).
pub fn deleteGroup(db: sqlite.Db, user_id: u64, ref: GroupRef, origin: Origin, now_ms: i64) sqlite.Error!?u64 {
    try db.exec("BEGIN IMMEDIATE;");
    errdefer db.exec("ROLLBACK;") catch {};
    const id = (try liveGroupId(db, user_id, ref)) orelse {
        try db.exec("ROLLBACK;");
        return null;
    };
    const binds: []const sqlite.Bind = &.{ .{ .int = @intCast(user_id) }, .{ .int = @intCast(id) }, .{ .int = now_ms }, .{ .int = @intFromBool(origin == .web) } };
    try db.runCached(
        \\UPDATE digests SET deleted = 1, deleted_at = ?3, updated_at = ?3,
        \\  web_changed_at = CASE WHEN ?4 THEN ?3 ELSE web_changed_at END
        \\WHERE user_id = ?1 AND is_group = 0 AND deleted = 0 AND parent_uid <> ''
        \\  AND parent_uid = (SELECT uid FROM digests WHERE user_id = ?1 AND id = ?2 AND is_group = 1 AND deleted = 0);
    , binds);
    const digests: u64 = @intCast(db.changes());
    try db.runCached(
        \\UPDATE digests SET deleted = 1, deleted_at = ?3, updated_at = ?3,
        \\  web_changed_at = CASE WHEN ?4 THEN ?3 ELSE web_changed_at END
        \\WHERE user_id = ?1 AND id = ?2 AND is_group = 1 AND deleted = 0;
    , binds);
    try db.exec("COMMIT;");
    return digests;
}

/// The id of the live category `ref` names.
fn liveGroupId(db: sqlite.Db, user_id: u64, ref: GroupRef) sqlite.Error!?u64 {
    switch (ref) {
        .uid => |uid| return internal.categoryId(db, user_id, uid),
        .id => |id| {
            var r = (try db.rowCached(
                \\SELECT id FROM digests WHERE user_id = ?1 AND id = ?2 AND is_group = 1 AND deleted = 0;
            , &.{ .{ .int = @intCast(user_id) }, .{ .int = @intCast(id) } })) orelse return null;
            r.finalize();
            return id;
        },
    }
}

/// Whether `uid` names one of the account's live categories ('' is
/// Uncategorized, always there).
pub fn categoryExists(db: sqlite.Db, user_id: u64, uid: []const u8) sqlite.Error!bool {
    if (uid.len == 0) return true;
    return (try liveId(db, user_id, true, uid)) != null;
}
