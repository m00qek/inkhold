//! The digests' bin: deleted digests, kept until the bin's retention purges
//! them (`retention.zig`), wherever they were deleted, on the tablet or here.
//!
//! Restoring puts a row back in the manifest under its own id. A tablet that
//! deleted it since has no such id, so it fetches the digest whole (decompiled
//! `KnowledgeSyncRepository.processKnowledgeHash`: a manifest id it lacks goes
//! to `query/summary/id`); one that never synced the delete finds the same md5
//! and does nothing. So a restore keeps the md5, and the tablet's own copy of
//! an unsynced edit cannot lose to it. Seen on a Nomad (Digest 1.00.153,
//! 2026-11-12): a restored digest came back, its handwritten note with it.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const digest = @import("../digest.zig");
const Digest = digest.Digest;
const Error = digest.Error;
const internal = @import("internal.zig");
const liveId = internal.liveId;

/// A deleted digest, as the bin lists it.
pub const BinRow = struct {
    digest: Digest,
    deleted_at: i64,
    /// The name of the category it was in, live or deleted; null when
    /// Uncategorized, or when that category is gone for good.
    category_name: ?[]const u8,
    /// The tablet brought it back already: it re-sent its own copy, edited
    /// before it synced the delete, which is live under a new id.
    back: bool,
};

/// The account's deleted digests, the latest deleted first.
pub fn binned(db: sqlite.Db, arena: std.mem.Allocator, user_id: u64) Error![]BinRow {
    var st = try db.prepareCached("SELECT " ++ internal.columns ++
        \\, deleted_at,
        \\  (SELECT g.name FROM digests g WHERE g.user_id = d.user_id AND g.is_group = 1 AND g.uid = d.parent_uid
        \\     AND d.parent_uid <> '' ORDER BY g.deleted, g.id DESC LIMIT 1),
        \\  EXISTS (SELECT 1 FROM digests l WHERE l.user_id = d.user_id AND l.is_group = 0 AND l.deleted = 0
        \\     AND l.uid = d.uid)
        \\FROM digests d WHERE d.user_id = ?1 AND d.is_group = 0 AND d.deleted = 1
        \\ORDER BY d.deleted_at DESC, d.id DESC;
    );
    defer st.finalize();
    st.bindInt(1, @intCast(user_id));
    const n = internal.column_count;
    var out: std.ArrayList(BinRow) = .empty;
    while (try st.step()) try out.append(arena, .{
        .digest = try internal.readRow(arena, st),
        .deleted_at = st.columnIntOpt(n) orelse 0,
        .category_name = try internal.optText(arena, st, n + 1),
        .back = st.columnInt(n + 2) != 0,
    });
    return out.items;
}

/// What `restoreDigest` did.
pub const Restored = union(enum) {
    /// Back in the listings, in the category `parent_uid` ('' Uncategorized).
    restored: struct { parent_uid: []const u8 },
    /// No such digest in this account's bin.
    not_in_bin,
    /// The tablet brought it back already (`BinRow.back`).
    back_already,
};

/// Takes a digest out of the bin. A category deleted since comes back with
/// it, under its own uid, so the tablet adds it again (`reviveCategory`).
/// When the digest lands elsewhere, it takes `md5_if_moved`, a new md5, since
/// what the tablet may still hold differs.
pub fn restoreDigest(db: sqlite.Db, arena: std.mem.Allocator, user_id: u64, id: u64, md5_if_moved: []const u8, now_ms: i64) Error!Restored {
    try db.exec("BEGIN IMMEDIATE;");
    errdefer db.exec("ROLLBACK;") catch {};
    const result = try restoreIn(db, arena, user_id, id, md5_if_moved, now_ms);
    try db.exec(if (result == .restored) "COMMIT;" else "ROLLBACK;");
    return result;
}

fn restoreIn(db: sqlite.Db, arena: std.mem.Allocator, user_id: u64, id: u64, md5_if_moved: []const u8, now_ms: i64) Error!Restored {
    const uid: ?[]const u8, const parent: []const u8 = blk: {
        var r = (try db.rowCached(
            \\SELECT uid, parent_uid FROM digests WHERE user_id = ?1 AND id = ?2 AND is_group = 0 AND deleted = 1;
        , &.{ .{ .int = @intCast(user_id) }, .{ .int = @intCast(id) } })) orelse return .not_in_bin;
        defer r.finalize();
        break :blk .{ if (r.isNull(0)) null else try arena.dupe(u8, r.text(0)), try arena.dupe(u8, r.text(1)) };
    };
    if (uid) |u| if (try liveId(db, user_id, false, u) != null) return .back_already;

    const target: []const u8 = if (parent.len == 0 or try liveId(db, user_id, true, parent) != null)
        parent
    else
        try reviveCategory(db, arena, user_id, parent, now_ms);
    if (std.mem.eql(u8, target, parent)) {
        try db.runCached(
            \\UPDATE digests SET deleted = 0, deleted_at = NULL, updated_at = ?3, web_changed_at = ?3
            \\WHERE user_id = ?1 AND id = ?2 AND is_group = 0 AND deleted = 1;
        , &.{ .{ .int = @intCast(user_id) }, .{ .int = @intCast(id) }, .{ .int = now_ms } });
    } else {
        try db.runCached(
            \\UPDATE digests SET deleted = 0, deleted_at = NULL, parent_uid = ?3, md5_hash = ?4,
            \\  last_modified_time = MAX(?5, last_modified_time + 1), updated_at = ?5, web_changed_at = ?5
            \\WHERE user_id = ?1 AND id = ?2 AND is_group = 0 AND deleted = 1;
        , &.{ .{ .int = @intCast(user_id) }, .{ .int = @intCast(id) }, .{ .text = target }, .{ .text = md5_if_moved }, .{ .int = now_ms } });
    }
    return .{ .restored = .{ .parent_uid = target } };
}

/// Where a digest whose category `uid` was deleted goes back to: that
/// category, brought back; the live one of its name, when one was made since
/// (the app allows no second); Uncategorized ('') when it is gone for good.
fn reviveCategory(db: sqlite.Db, arena: std.mem.Allocator, user_id: u64, uid: []const u8, now_ms: i64) Error![]const u8 {
    const id: i64, const name: ?[]const u8 = blk: {
        var r = (try db.rowCached(
            \\SELECT id, name FROM digests WHERE user_id = ?1 AND is_group = 1 AND uid = ?2 AND deleted = 1
            \\ORDER BY deleted_at DESC, id DESC LIMIT 1;
        , &.{ .{ .int = @intCast(user_id) }, .{ .text = uid } })) orelse return "";
        defer r.finalize();
        break :blk .{ r.int(0), if (r.isNull(1)) null else try arena.dupe(u8, r.text(1)) };
    };
    if (name) |n| {
        var r = try db.rowCached(
            \\SELECT uid FROM digests WHERE user_id = ?1 AND is_group = 1 AND deleted = 0 AND name = ?2
            \\  AND uid IS NOT NULL AND uid <> '' ORDER BY id LIMIT 1;
        , &.{ .{ .int = @intCast(user_id) }, .{ .text = n } });
        if (r) |*live| {
            defer live.finalize();
            return try arena.dupe(u8, live.text(0));
        }
    }
    try db.runCached(
        \\UPDATE digests SET deleted = 0, deleted_at = NULL, updated_at = ?3, web_changed_at = ?3
        \\WHERE user_id = ?1 AND id = ?2 AND is_group = 1 AND deleted = 1;
    , &.{ .{ .int = @intCast(user_id) }, .{ .int = id }, .{ .int = now_ms } });
    return uid;
}

/// What deleting a digest for good leaves to release: the md5 of the
/// handwritten note it held a reference to, if any.
pub const Purged = struct { held: ?[]const u8 };

/// Removes a digest from the bin for good; null when it is not in this
/// account's bin. The caller releases `Purged.held` in the same transaction
/// (`digest_purge.zig`).
pub fn purgeDigest(db: sqlite.Db, arena: std.mem.Allocator, user_id: u64, id: u64) Error!?Purged {
    const binds: []const sqlite.Bind = &.{ .{ .int = @intCast(user_id) }, .{ .int = @intCast(id) } };
    const held: ?[]const u8 = blk: {
        var r = (try db.rowCached(
            \\SELECT CASE WHEN handwrite_inner_name IS NOT NULL THEN handwrite_md5 END FROM digests
            \\WHERE user_id = ?1 AND id = ?2 AND is_group = 0 AND deleted = 1;
        , binds)) orelse return null;
        defer r.finalize();
        break :blk if (r.isNull(0)) null else try arena.dupe(u8, r.text(0));
    };
    try db.runCached("DELETE FROM digests WHERE user_id = ?1 AND id = ?2 AND is_group = 0 AND deleted = 1;", binds);
    return .{ .held = held };
}

/// What emptying the bin left to release: how many digests went, and the md5s
/// of the handwritten notes they held a reference to, owned by the arena.
pub const Emptied = struct { digests: u64, held: []const []const u8 };

/// Empties the account's bin of digests, and of the deleted categories only a
/// restore could bring back. The caller releases `held` in the same transaction
/// (`digest_purge.zig`).
pub fn emptyDigestBin(db: sqlite.Db, arena: std.mem.Allocator, user_id: u64) Error!Emptied {
    var held: std.ArrayList([]const u8) = .empty;
    {
        var st = try db.prepareCached(
            \\SELECT handwrite_md5 FROM digests
            \\WHERE user_id = ?1 AND is_group = 0 AND deleted = 1 AND handwrite_inner_name IS NOT NULL AND handwrite_md5 IS NOT NULL;
        );
        defer st.finalize();
        st.bindInt(1, @intCast(user_id));
        while (try st.step()) try held.append(arena, try arena.dupe(u8, st.columnText(0)));
    }
    const user: []const sqlite.Bind = &.{.{ .int = @intCast(user_id) }};
    try db.runCached("DELETE FROM digests WHERE user_id = ?1 AND is_group = 0 AND deleted = 1;", user);
    const digests: u64 = @intCast(db.changes());
    try db.runCached("DELETE FROM digests WHERE user_id = ?1 AND is_group = 1 AND deleted = 1;", user);
    return .{ .digests = digests, .held = held.items };
}
