//! The browser's edit of a digest (its comment, its category) and what a tablet has fetched since.

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
