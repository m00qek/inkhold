//! Charged bytes, quota and the storage breakdown.

const filesmod = @import("../files.zig");
const Files = filesmod.Files;
const authsvc = @import("../auth/service.zig");

/// Charged bytes and quota, as `get_space_usage` reports them.
pub const Cap = struct { used: i64, total: i64 };

/// Quota for a user with no `capacity` row; one definition shared with the
/// db layer and the v10 repair migration.
pub const default_total_bytes: i64 = authsvc.default_capacity;

/// A missing row reads as 0 used of the default (nothing stored yet).
pub fn capacity(self: Files, user_id: u64) !Cap {
    var r = (try self.db.row("SELECT used_bytes, total_bytes FROM capacity WHERE user_id = ?1;", &.{.{ .int = @intCast(user_id) }})) orelse
        return .{ .used = 0, .total = default_total_bytes };
    defer r.finalize();
    return .{ .used = r.int(0), .total = r.int(1) };
}

/// The account screen's five-way split of charged bytes, over distinct blobs.
/// A partition by precedence, so each blob counts once: live kinds (notebook <
/// sketch < document on ties), then recycle bin (trashed files and their
/// history), then versions (history of live files only). So the bin line is
/// what emptying it returns, and versions is versioning's marginal cost.
pub const StorageBreakdown = struct {
    notebooks: i64 = 0,
    sketches: i64 = 0,
    documents: i64 = 0,
    recycle_bin: i64 = 0,
    versions: i64 = 0,

    /// Equals `capacity.used_bytes`; the partition test asserts it.
    pub fn total(self: StorageBreakdown) i64 {
        return self.notebooks + self.sketches + self.documents + self.recycle_bin + self.versions;
    }
};

pub const storage_breakdown_sql =
    \\WITH live(md5, rank) AS (
    \\  SELECT f.md5,
    \\         MIN(CASE WHEN lower(f.name) LIKE '%.note' THEN 0
    \\                  WHEN lower(f.name) LIKE '%.spd'  THEN 1
    \\                  ELSE 2 END)
    \\    FROM files f
    \\   WHERE f.user_id = ?1 AND f.deleted = 0 AND f.is_folder = 0
    \\     AND f.md5 IS NOT NULL AND f.md5 <> ''
    \\   GROUP BY f.md5
    \\),
    \\binned(md5) AS (
    \\  SELECT DISTINCT m.md5 FROM (
    \\    SELECT f.md5 AS md5 FROM files f
    \\     WHERE f.user_id = ?1 AND f.deleted = 1 AND f.is_folder = 0
    \\       AND f.md5 IS NOT NULL AND f.md5 <> ''
    \\    UNION ALL
    \\    SELECT fh.md5 FROM file_history fh JOIN files f ON f.id = fh.file_id
    \\     WHERE f.user_id = ?1 AND f.deleted = 1
    \\  ) m
    \\  WHERE m.md5 NOT IN (SELECT md5 FROM live)
    \\),
    \\versions(md5) AS (
    \\  SELECT DISTINCT fh.md5 FROM file_history fh JOIN files f ON f.id = fh.file_id
    \\   WHERE f.user_id = ?1 AND f.deleted = 0
    \\     AND fh.md5 NOT IN (SELECT md5 FROM live)
    \\     AND fh.md5 NOT IN (SELECT md5 FROM binned)
    \\)
    \\SELECT
    \\  (SELECT COALESCE(SUM(b.size), 0) FROM live l JOIN blobs b ON b.md5 = l.md5 WHERE l.rank = 0),
    \\  (SELECT COALESCE(SUM(b.size), 0) FROM live l JOIN blobs b ON b.md5 = l.md5 WHERE l.rank = 1),
    \\  (SELECT COALESCE(SUM(b.size), 0) FROM live l JOIN blobs b ON b.md5 = l.md5 WHERE l.rank = 2),
    \\  (SELECT COALESCE(SUM(b.size), 0) FROM binned x JOIN blobs b ON b.md5 = x.md5),
    \\  (SELECT COALESCE(SUM(b.size), 0) FROM versions v JOIN blobs b ON b.md5 = v.md5);
;

pub fn storageBreakdown(self: Files, user_id: u64) !StorageBreakdown {
    var r = (try self.db.row(storage_breakdown_sql, &.{.{ .int = @intCast(user_id) }})) orelse return .{};
    defer r.finalize();
    return .{
        .notebooks = r.int(0),
        .sketches = r.int(1),
        .documents = r.int(2),
        .recycle_bin = r.int(3),
        .versions = r.int(4),
    };
}
