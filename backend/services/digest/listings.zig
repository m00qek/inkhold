//! What the app reads back: the manifest and the categories whole, digests by id or by page.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const digest = @import("../digest.zig");
const Digest = digest.Digest;
const Error = digest.Error;
const HashRow = digest.HashRow;
const internal = @import("internal.zig");
const columns = internal.columns;
const readAll = internal.readAll;
const readRow = internal.readRow;
const optText = internal.optText;

/// The manifest: EVERY live digest of the account, in id order. Never paged
/// and never filtered further: the app deletes whatever it lacks.
pub fn manifest(db: sqlite.Db, arena: std.mem.Allocator, user_id: u64) Error![]HashRow {
    var st = try db.prepareCached(
        \\SELECT id, md5_hash, handwrite_md5, comment_handwrite_name, last_modified_time
        \\FROM digests WHERE user_id = ?1 AND is_group = 0 AND deleted = 0 ORDER BY id;
    );
    defer st.finalize();
    st.bindInt(1, @intCast(user_id));
    var out: std.ArrayList(HashRow) = .empty;
    while (try st.step()) {
        try out.append(arena, .{
            .id = @intCast(st.columnInt(0)),
            .md5_hash = try arena.dupe(u8, st.columnText(1)),
            .handwrite_md5 = try optText(arena, st, 2),
            .comment_handwrite_name = try optText(arena, st, 3),
            .last_modified_time = st.columnInt(4),
        });
    }
    return out.items;
}

/// EVERY live category of the account, in id order (the app reads them in one
/// call, and deletes a synced category the list lacks, as it does digests).
pub fn groups(db: sqlite.Db, arena: std.mem.Allocator, user_id: u64) Error![]Digest {
    var st = try db.prepareCached("SELECT " ++ columns ++
        \\ FROM digests WHERE user_id = ?1 AND is_group = 1 AND deleted = 0 ORDER BY id;
    );
    defer st.finalize();
    st.bindInt(1, @intCast(user_id));
    return readAll(arena, st);
}

/// The live digests among `ids`, in id order; unknown or deleted ids are left
/// out, never invented.
pub fn digestsByIds(db: sqlite.Db, arena: std.mem.Allocator, user_id: u64, ids: []const u64) Error![]Digest {
    var out: std.ArrayList(Digest) = .empty;
    var st = try db.prepareCached("SELECT " ++ columns ++
        \\ FROM digests WHERE user_id = ?1 AND id = ?2 AND is_group = 0 AND deleted = 0;
    );
    defer st.finalize();
    const sorted = try arena.dupe(u64, ids);
    std.mem.sort(u64, sorted, {}, std.sort.asc(u64));
    var prev: ?u64 = null;
    for (sorted) |id| {
        if (prev == id) continue;
        prev = id;
        st.reset();
        st.bindInt(1, @intCast(user_id));
        st.bindInt(2, @intCast(id));
        if (try st.step()) try out.append(arena, try readRow(arena, st));
    }
    return out.items;
}

/// One page of live digests, in id order, optionally of one category
/// (`parent_uid`, '' for Uncategorized). `page` is 1-based, as the app sends
/// it; it reads pages until one comes back short.
pub fn digestsPage(db: sqlite.Db, arena: std.mem.Allocator, user_id: u64, parent_uid: ?[]const u8, page: u32, size: u32) Error![]Digest {
    const offset: i64 = @as(i64, @max(page, 1) - 1) * size;
    var st = try db.prepareCached("SELECT " ++ columns ++
        \\ FROM digests WHERE user_id = ?1 AND is_group = 0 AND deleted = 0
        \\  AND (?2 IS NULL OR parent_uid = ?2)
        \\ORDER BY id LIMIT ?3 OFFSET ?4;
    );
    defer st.finalize();
    st.bindInt(1, @intCast(user_id));
    st.bindTextOpt(2, parent_uid);
    st.bindInt(3, size);
    st.bindInt(4, offset);
    return readAll(arena, st);
}

/// How many live digests a `digestsPage` listing has in all.
pub fn digestCount(db: sqlite.Db, user_id: u64, parent_uid: ?[]const u8) sqlite.Error!i64 {
    var r = (try db.rowCached(
        \\SELECT COUNT(*) FROM digests WHERE user_id = ?1 AND is_group = 0 AND deleted = 0
        \\  AND (?2 IS NULL OR parent_uid = ?2);
    , &.{ .{ .int = @intCast(user_id) }, .{ .text_opt = parent_uid } })).?;
    defer r.finalize();
    return r.int(0);
}
