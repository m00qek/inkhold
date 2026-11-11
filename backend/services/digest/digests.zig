//! A digest's own rows: adding, replacing and soft-deleting one, its handwritten note, and its id by uid.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const digest = @import("../digest.zig");
const Digest = digest.Digest;
const Error = digest.Error;
const Handwriting = digest.Handwriting;
const internal = @import("internal.zig");
const liveId = internal.liveId;

/// The `unique_identifier` inside a digest's metadata JSON, or null. Owned by
/// `a`. Metadata the app sends is JSON text; anything else simply has none.
pub fn uidOfMetadata(a: std.mem.Allocator, metadata: ?[]const u8) ?[]const u8 {
    const text = metadata orelse return null;
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, a, text, .{}) catch return null;
    if (parsed != .object) return null;
    const v = parsed.object.get("unique_identifier") orelse return null;
    if (v != .string or v.string.len == 0) return null;
    return v.string;
}

/// Stores a new digest and returns its id. A resend of a digest still live
/// (same metadata `unique_identifier`, e.g. after a lost reply) updates that
/// row and returns its id, rather than making a second copy.
pub fn addDigest(db: sqlite.Db, user_id: u64, d: Digest, now_ms: i64) sqlite.Error!u64 {
    if (d.uid) |uid| {
        if (try liveId(db, user_id, false, uid)) |id| {
            _ = try putDigest(db, user_id, id, d, now_ms);
            return id;
        }
    }
    try db.runCached(
        \\INSERT INTO digests (user_id, is_group, uid, parent_uid, content, source_path, source_type,
        \\  data_source, author, tags, metadata, comment_str, comment_handwrite_name,
        \\  handwrite_inner_name, handwrite_md5, md5_hash, creation_time, last_modified_time,
        \\  created_at, updated_at)
        \\VALUES (?1, 0, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18);
    , &.{
        .{ .int = @intCast(user_id) },           .{ .text_opt = d.uid },           .{ .text = d.parent_uid },
        .{ .text_opt = d.content },              .{ .text_opt = d.source_path },   .{ .int_opt = d.source_type },
        .{ .text_opt = d.data_source },          .{ .text_opt = d.author },        .{ .text_opt = d.tags },
        .{ .text_opt = d.metadata },             .{ .text_opt = d.comment_str },   .{ .text_opt = d.comment_handwrite_name },
        .{ .text_opt = d.handwrite_inner_name }, .{ .text_opt = d.handwrite_md5 }, .{ .text = d.md5_hash },
        .{ .int = d.creation_time },             .{ .int = d.last_modified_time }, .{ .int = now_ms },
    });
    return @intCast(db.lastInsertRowId());
}

/// Replaces a live digest's fields, keeping its id and creation times.
/// False when there is no such live digest.
pub fn putDigest(db: sqlite.Db, user_id: u64, id: u64, d: Digest, now_ms: i64) sqlite.Error!bool {
    try db.runCached(
        \\UPDATE digests SET uid = COALESCE(?3, uid), parent_uid = ?4, content = ?5, source_path = ?6,
        \\  source_type = ?7, data_source = ?8, author = ?9, tags = ?10, metadata = ?11,
        \\  comment_str = ?12, comment_handwrite_name = ?13, handwrite_inner_name = ?14,
        \\  handwrite_md5 = ?15, md5_hash = ?16, last_modified_time = ?17, updated_at = ?18,
        \\  web_changed_at = NULL
        \\WHERE user_id = ?1 AND id = ?2 AND is_group = 0 AND deleted = 0;
    , &.{
        .{ .int = @intCast(user_id) },             .{ .int = @intCast(id) },                .{ .text_opt = d.uid },
        .{ .text = d.parent_uid },                 .{ .text_opt = d.content },              .{ .text_opt = d.source_path },
        .{ .int_opt = d.source_type },             .{ .text_opt = d.data_source },          .{ .text_opt = d.author },
        .{ .text_opt = d.tags },                   .{ .text_opt = d.metadata },             .{ .text_opt = d.comment_str },
        .{ .text_opt = d.comment_handwrite_name }, .{ .text_opt = d.handwrite_inner_name }, .{ .text_opt = d.handwrite_md5 },
        .{ .text = d.md5_hash },                   .{ .int = d.last_modified_time },        .{ .int = now_ms },
    });
    return db.changes() > 0;
}

/// Soft-deletes a digest: it leaves every listing at once. Nothing to delete
/// is not an error.
pub fn deleteDigest(db: sqlite.Db, user_id: u64, id: u64, now_ms: i64) sqlite.Error!void {
    try db.runCached(
        \\UPDATE digests SET deleted = 1, deleted_at = ?3, updated_at = ?3
        \\WHERE user_id = ?1 AND id = ?2 AND is_group = 0 AND deleted = 0;
    , &.{ .{ .int = @intCast(user_id) }, .{ .int = @intCast(id) }, .{ .int = now_ms } });
}

/// The live digest's note, or null when there is no such live digest.
pub fn handwriting(db: sqlite.Db, arena: std.mem.Allocator, user_id: u64, id: u64) Error!?Handwriting {
    var r = (try db.rowCached(
        \\SELECT handwrite_md5, handwrite_inner_name FROM digests
        \\WHERE user_id = ?1 AND id = ?2 AND is_group = 0 AND deleted = 0;
    , &.{ .{ .int = @intCast(user_id) }, .{ .int = @intCast(id) } })) orelse return null;
    defer r.finalize();
    return .{
        .md5 = if (r.isNull(0)) null else try arena.dupe(u8, r.text(0)),
        .inner_name = if (r.isNull(1)) null else try arena.dupe(u8, r.text(1)),
    };
}

/// The id of the live digest with this uid (metadata `unique_identifier`).
pub fn liveDigestId(db: sqlite.Db, user_id: u64, uid: []const u8) sqlite.Error!?u64 {
    return liveId(db, user_id, false, uid);
}
