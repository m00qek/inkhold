//! The bin's retention: soft-deleted rows removed for good.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const digest = @import("../digest.zig");
const Error = digest.Error;

/// Removes rows soft-deleted before `before_ms` for good (the bin's
/// retention). Returns the md5s of the handwritten notes they held a
/// reference to, owned by `arena`: the caller releases them.
pub fn purgeDeleted(db: sqlite.Db, arena: std.mem.Allocator, before_ms: i64) Error![]const []const u8 {
    var held: std.ArrayList([]const u8) = .empty;
    {
        var st = try db.prepareCached(
            \\SELECT handwrite_md5 FROM digests
            \\WHERE deleted = 1 AND deleted_at < ?1 AND handwrite_inner_name IS NOT NULL AND handwrite_md5 IS NOT NULL;
        );
        defer st.finalize();
        st.bindInt(1, before_ms);
        while (try st.step()) try held.append(arena, try arena.dupe(u8, st.columnText(0)));
    }
    try db.runCached("DELETE FROM digests WHERE deleted = 1 AND deleted_at < ?1;", &.{.{ .int = before_ms }});
    return held.items;
}
