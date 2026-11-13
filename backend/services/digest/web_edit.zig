//! The browser's edit of a digest (its comment, its category), its delete, and what a tablet has fetched since.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const digest = @import("../digest.zig");
const Error = digest.Error;
const WebEdit = digest.WebEdit;
const internal = @import("internal.zig");
const liveId = internal.liveId;

/// The browser's edit of a live digest. `md5_hash` must be new: the app takes
/// the server's copy when its md5 differs from the one it last synced and its
/// own is unchanged, with no clock in it, the comment and the category with it
/// (a category it lacks becomes Uncategorized); when both changed, the newer
/// `last_modified_time` wins, so it moves past the row's own time and a tablet
/// clock ahead cannot win over the edit (decompiled
/// `KnowledgeSyncRepository.processKnowledgeDetail` and
/// `updateLocalKnowledgeFromServer`). The handwritten note is never touched.
/// False when there is no such live digest.
pub fn applyWebEdit(db: sqlite.Db, user_id: u64, id: u64, e: WebEdit, md5_hash: []const u8, now_ms: i64) sqlite.Error!bool {
    try db.runCached(
        \\UPDATE digests SET comment_str = COALESCE(?3, comment_str), parent_uid = COALESCE(?4, parent_uid),
        \\  md5_hash = ?5, last_modified_time = MAX(?6, last_modified_time + 1), updated_at = ?6, web_changed_at = ?6
        \\WHERE user_id = ?1 AND id = ?2 AND is_group = 0 AND deleted = 0;
    , &.{
        .{ .int = @intCast(user_id) }, .{ .int = @intCast(id) }, .{ .text_opt = e.comment },
        .{ .text_opt = e.parent_uid }, .{ .text = md5_hash },    .{ .int = now_ms },
    });
    return db.changes() > 0;
}

/// The browser's delete of a live digest: to the bin, where it can be
/// restored (`bin.zig`). The tablet deletes its copy at its next sync, unless
/// it edited it since, and then sends it back as a new digest. False when
/// there is no such live digest.
pub fn deleteFromWeb(db: sqlite.Db, user_id: u64, id: u64, now_ms: i64) sqlite.Error!bool {
    try db.runCached(
        \\UPDATE digests SET deleted = 1, deleted_at = ?3, updated_at = ?3, web_changed_at = ?3
        \\WHERE user_id = ?1 AND id = ?2 AND is_group = 0 AND deleted = 0;
    , &.{ .{ .int = @intCast(user_id) }, .{ .int = @intCast(id) }, .{ .int = now_ms } });
    return db.changes() > 0;
}

/// A tablet asked for this account's manifest at `now_ms`: its sync takes
/// everything the browser changed before that ("Waiting for the tablet" clears).
pub fn markTabletListed(db: sqlite.Db, user_id: u64, now_ms: i64) sqlite.Error!void {
    try db.runCached(
        \\INSERT INTO digest_sync_state (user_id, tablet_listed_at) VALUES (?1, ?2)
        \\ON CONFLICT (user_id) DO UPDATE SET tablet_listed_at = excluded.tablet_listed_at;
    , &.{ .{ .int = @intCast(user_id) }, .{ .int = now_ms } });
}

/// When a tablet last asked for this account's manifest; null: never.
pub fn tabletListedAt(db: sqlite.Db, user_id: u64) sqlite.Error!?i64 {
    var r = (try db.rowCached("SELECT tablet_listed_at FROM digest_sync_state WHERE user_id = ?1;", &.{.{ .int = @intCast(user_id) }})) orelse return null;
    defer r.finalize();
    return r.intOpt(0);
}

/// Whether the browser changed anything at or after `after` (null: ever) that
/// a tablet has not fetched: a digest or a category, made, edited, deleted or
/// restored; or a digest deleted here and then removed for good, whose row is
/// gone but which the tablet still has to drop (`markPurgedUnseen`).
pub fn webChangedSince(db: sqlite.Db, user_id: u64, after: ?i64) sqlite.Error!bool {
    var r = (try db.rowCached(
        \\SELECT 1 FROM digests WHERE user_id = ?1 AND web_changed_at IS NOT NULL AND web_changed_at >= ?2
        \\UNION ALL
        \\SELECT 1 FROM digest_sync_state WHERE user_id = ?1 AND web_purged_at IS NOT NULL AND web_purged_at >= ?2
        \\LIMIT 1;
    , &.{ .{ .int = @intCast(user_id) }, .{ .int = after orelse std.math.minInt(i64) } })) orelse return false;
    r.finalize();
    return true;
}

/// Before binned digests are removed for good (`id`, or the whole bin when
/// null, deleted categories with it): if one carries a browser change no
/// tablet has fetched yet, the account keeps when, so it still waits for the
/// tablet once the row is gone.
pub fn markPurgedUnseen(db: sqlite.Db, user_id: u64, id: ?u64, now_ms: i64) sqlite.Error!void {
    try db.runCached(
        \\INSERT INTO digest_sync_state (user_id, web_purged_at)
        \\SELECT ?1, ?3 WHERE EXISTS (
        \\  SELECT 1 FROM digests d WHERE d.user_id = ?1 AND (d.is_group = 0 OR ?2 IS NULL) AND d.deleted = 1
        \\    AND (?2 IS NULL OR d.id = ?2) AND d.web_changed_at IS NOT NULL
        \\    AND d.web_changed_at >= COALESCE((SELECT tablet_listed_at FROM digest_sync_state WHERE user_id = ?1), d.web_changed_at))
        \\ON CONFLICT (user_id) DO UPDATE SET web_purged_at = excluded.web_purged_at;
    , &.{ .{ .int = @intCast(user_id) }, .{ .int_opt = if (id) |i| @as(i64, @intCast(i)) else null }, .{ .int = now_ms } });
}

/// The live digests the browser changed at or after `after` (null: ever), in
/// id order: what no tablet has fetched yet. At counts as after: an edit in the
/// same millisecond as a tablet's listing waits for the next one.
pub fn changedSince(db: sqlite.Db, arena: std.mem.Allocator, user_id: u64, after: ?i64) Error![]u64 {
    var st = try db.prepareCached(
        \\SELECT id FROM digests WHERE user_id = ?1 AND is_group = 0 AND deleted = 0
        \\  AND web_changed_at IS NOT NULL AND web_changed_at >= ?2 ORDER BY id;
    );
    defer st.finalize();
    st.bindInt(1, @intCast(user_id));
    st.bindInt(2, after orelse std.math.minInt(i64));
    var out: std.ArrayList(u64) = .empty;
    while (try st.step()) try out.append(arena, @intCast(st.columnInt(0)));
    return out.items;
}
