//! The recycle bin: trash, restore, purge and the retention sweep.

const std = @import("std");
const filesmod = @import("../files.zig");
const Files = filesmod.Files;
const internal = @import("internal.zig");
const BinEntry = filesmod.BinEntry;
const md5_len = filesmod.md5_len;
const markpair = @import("../mark_pairing.zig");
const history = @import("history.zig");

/// The default bin retention (30 days); the effective window is in
/// `services/settings.zig`.
pub const bin_retention_s: i64 = 30 * 24 * 60 * 60;

/// One user's bin, newest deletion first, allocated in `alloc`. Paths are the
/// ones frozen at trash time (`deleted_path`), O(bin) and immune to later
/// ancestor renames. `is_root` is computed live. A flat list; the client
/// groups and nests from `parent_id`/`deleted_at`/`is_root`.
pub fn listBin(self: Files, alloc: std.mem.Allocator, user_id: u64) ![]BinEntry {
    var out: std.ArrayList(BinEntry) = .empty;

    // Empty-bin early exit on `files_deleted_at`.
    {
        var probe = try self.db.prepare(
            "SELECT EXISTS(SELECT 1 FROM files WHERE user_id = ?1 AND deleted = 1);",
        );
        defer probe.finalize();
        probe.bindInt(1, @intCast(user_id));
        if (!try probe.step() or probe.columnInt(0) == 0) return out.toOwnedSlice(alloc);
    }

    var s = try self.db.prepare(bin_listing_sql);
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    while (try s.step()) {
        const pid = s.columnInt(1);
        const is_folder = s.columnInt(3) != 0;
        const m = s.columnText(4);
        try out.append(alloc, .{
            .id = @intCast(s.columnInt(0)),
            .parent_id = if (pid == 0) null else @intCast(pid),
            .name = try alloc.dupe(u8, s.columnText(2)),
            .is_folder = is_folder,
            .md5 = if (is_folder or m.len == 0) null else try alloc.dupe(u8, m),
            .size = @intCast(s.columnInt(5)),
            .deleted_at = s.columnInt(6),
            .path = try alloc.dupe(u8, s.columnText(7)),
            .is_root = s.columnInt(8) != 0,
        });
    }
    return out.toOwnedSlice(alloc);
}

/// Live rows a web delete of `id` would tombstone, counted before `trash`.
/// Paired `.mark`s are not counted: the user never saw them.
pub fn liveSubtreeCount(self: Files, user_id: u64, id: u64) !usize {
    var r = (try self.db.row(live_subtree_count_sql, &.{ .{ .int = @intCast(id) }, .{ .int = @intCast(user_id) } })) orelse return 0;
    defer r.finalize();
    return @intCast(r.int(0));
}

/// Tombstones an entry and its subtree, holding every blob reference (no
/// refund; `purge` does that). Idempotent: one UPDATE gated on `deleted = 0`
/// serves the device's children-first, retried deletes and the web's single
/// request, keeping earlier `deleted_at`s. A pair goes together in one
/// transaction, or the mark would surface as a conjured file.
pub fn trash(self: Files, user_id: u64, id: u64) !void {
    if (!try internal.exists(self, user_id, id)) return error.NotFound;

    try self.db.exec("BEGIN IMMEDIATE;");
    errdefer self.db.exec("ROLLBACK;") catch {};

    // The rule, spent once, before any write.
    const partner = try internal.pairOf(self, user_id, id);

    const ts = internal.now(
        self,
    );
    var changed = try trashSubtree(self, user_id, id, ts);
    if (partner) |p| changed += try trashSubtree(self, user_id, p.id, ts);

    // A no-op retry must not invalidate every cached listing.
    if (changed > 0) try internal.bumpSync(self, user_id);
    try self.db.exec("COMMIT;");
}

/// Inside an open transaction. A pair's roots share `ts`, so their retention
/// clocks match and the bin groups them.
pub fn trashSubtree(self: Files, user_id: u64, id: u64, ts: i64) !i64 {
    var s = try self.db.prepare(subtree_trash_sql);
    defer s.finalize();
    s.bindInt(1, @intCast(id));
    s.bindInt(2, @intCast(user_id));
    s.bindInt(3, ts);
    _ = try s.step();
    return self.db.changes();
}

/// What `restore` did, often more than asked. `name` is owned by `gpa`.
pub const Restored = struct {
    /// The resulting name, possibly suffixed (see `freeName`).
    name: []u8,
    renamed: bool,
    /// Trashed ancestor folders brought back to make it reachable.
    ancestors: usize,
    descendants: usize,

    pub fn deinit(self: Restored, gpa: std.mem.Allocator) void {
        gpa.free(self.name);
    }
};

/// Restores a trashed entry, its trashed ancestor chain (else orphaned), and
/// for a folder every trashed descendant. Names a live entry has taken are
/// auto-renamed (`files_live_name` is unique). The blob was never released,
/// so there is nothing to re-index. A pair returns together: the document is
/// restored first and its free-name search skips suffixes whose `.mark` is
/// taken, so the mark follows it. Restoring a live entry is a no-op.
pub fn restore(self: Files, user_id: u64, id: u64) !Restored {
    if (!try internal.exists(self, user_id, id)) return error.NotFound;

    try self.db.exec("BEGIN IMMEDIATE;");
    errdefer self.db.exec("ROLLBACK;") catch {};

    // Spent once, while both members are still trashed.
    const partner = try internal.pairOf(self, user_id, id);

    var ancestors: usize = 0;
    var descendants: usize = 0;

    // 1. Ancestors, root-first, so collisions resolve top-down.
    {
        var chain: std.ArrayList(u64) = .empty; // leaf-first
        defer chain.deinit(self.gpa);
        var cur = try internal.parentOf(self, user_id, id);
        var guard: usize = 0;
        while (cur) |pid| {
            guard += 1;
            if (guard > 256) break; // cycle guard (should never trigger)
            try chain.append(self.gpa, pid);
            cur = try internal.parentOf(self, user_id, pid);
        }
        var i = chain.items.len;
        while (i > 0) {
            i -= 1;
            const r = try restoreRow(self, user_id, chain.items[i], .{});
            self.gpa.free(r.name);
            if (r.was_trashed) ancestors += 1;
        }
    }

    // 2. The entry and its pair, document first; report the requested row's name.
    const self_row = blk: {
        const p = partner orelse break :blk try restoreRow(self, user_id, id, .{});

        const pdf_id = if (p.entry_is_mark) p.id else id;
        const mark_id = if (p.entry_is_mark) id else p.id;

        const pdf_row = try restoreRow(self, user_id, pdf_id, .{ .pair = markpair.mark_ext });
        errdefer self.gpa.free(pdf_row.name);

        const want = try std.fmt.allocPrint(self.gpa, "{s}" ++ markpair.mark_ext, .{pdf_row.name});
        defer self.gpa.free(want);
        const mark_row = try restoreRow(self, user_id, mark_id, .{ .name = want });

        if (p.entry_is_mark) {
            self.gpa.free(pdf_row.name);
            break :blk mark_row;
        }
        self.gpa.free(mark_row.name);
        break :blk pdf_row;
    };
    errdefer self.gpa.free(self_row.name);

    // 3. Descendants, shallowest first. Ids are collected before writing, so the
    //    recursive CTE is not mutated underneath.
    {
        var kids: std.ArrayList(u64) = .empty;
        defer kids.deinit(self.gpa);
        {
            var s = try self.db.prepare(subtree_depth_sql);
            defer s.finalize();
            s.bindInt(1, @intCast(id));
            s.bindInt(2, @intCast(user_id));
            while (try s.step()) try kids.append(self.gpa, @intCast(s.columnInt(0)));
        }
        for (kids.items) |kid| {
            const r = try restoreRow(self, user_id, kid, .{});
            self.gpa.free(r.name);
            if (r.was_trashed) descendants += 1;
        }
    }

    try internal.bumpSync(self, user_id); // the tree changed; the device re-downloads
    try self.db.exec("COMMIT;");
    return .{
        .name = self_row.name,
        .renamed = self_row.renamed,
        .ancestors = ancestors,
        .descendants = descendants,
    };
}

/// Hard-deletes a trashed entry and its subtree: blob refcounts drop, blobs at
/// 0 lose their index rows and leave disk, quota is refunded. NotFound if live,
/// so a live file is never one mistyped id away. A pair is destroyed together,
/// or the mark's bytes would stay charged with no row to purge.
pub fn purge(self: Files, user_id: u64, id: u64) !void {
    if (!try internal.existsTrashed(self, user_id, id)) return error.NotFound;

    var gc: std.ArrayList([md5_len]u8) = .empty;
    defer gc.deinit(self.gpa);

    try self.db.exec("BEGIN IMMEDIATE;");
    errdefer self.db.exec("ROLLBACK;") catch {};

    var ids: std.ArrayList(u64) = .empty;
    defer ids.deinit(self.gpa);
    {
        var s = try self.db.prepare(subtree_ids_sql);
        defer s.finalize();
        s.bindInt(1, @intCast(id));
        s.bindInt(2, @intCast(user_id));
        while (try s.step()) try ids.append(self.gpa, @intCast(s.columnInt(0)));
    }
    try addPairs(self, user_id, &ids);

    try releaseIds(self, user_id, ids.items, &gc);
    try internal.bumpSync(self, user_id);
    try self.db.exec("COMMIT;");

    for (gc.items) |*m| internal.removeBlobFiles(self, m); // GC on disk after the commit
}

/// Purges the whole bin. Returns the count the bin listing showed (hidden
/// `.mark`s excluded), taken before the release.
pub fn emptyBin(self: Files, user_id: u64) !usize {
    var gc: std.ArrayList([md5_len]u8) = .empty;
    defer gc.deinit(self.gpa);

    try self.db.exec("BEGIN IMMEDIATE;");
    errdefer self.db.exec("ROLLBACK;") catch {};

    const shown: usize = blk: {
        var r = (try self.db.row(
            "SELECT COUNT(*) FROM files f WHERE f.user_id = ?1 AND f.deleted = 1" ++
                internal.hide_paired_bin_mark ++ ";",
            &.{.{ .int = @intCast(user_id) }},
        )) orelse break :blk 0;
        defer r.finalize();
        break :blk @intCast(r.int(0));
    };

    var ids: std.ArrayList(u64) = .empty;
    defer ids.deinit(self.gpa);
    {
        var s = try self.db.prepare(bin_ids_sql);
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        while (try s.step()) try ids.append(self.gpa, @intCast(s.columnInt(0)));
    }

    try releaseIds(self, user_id, ids.items, &gc);
    if (ids.items.len > 0) try internal.bumpSync(self, user_id);
    try self.db.exec("COMMIT;");

    for (gc.items) |*m| internal.removeBlobFiles(self, m);
    return shown;
}

/// Purges entries trashed more than `max_age_s` ago, for every user, one user
/// at a time (quota is per user), each expanded to its subtree closure.
pub fn sweepBin(self: Files, max_age_s: i64) !usize {
    return self.sweepBinBefore(internal.now(
        self,
    ) - max_age_s);
}

/// `sweepBin` against a cutoff computed by `settings.sweepCutoff` (which
/// keeps a shortened window non-retroactive).
pub fn sweepBinBefore(self: Files, cutoff: i64) !usize {
    var users: std.ArrayList(u64) = .empty;
    defer users.deinit(self.gpa);
    {
        var s = try self.db.prepare(
            "SELECT DISTINCT user_id FROM files WHERE deleted = 1 AND COALESCE(deleted_at, 0) < ?1;",
        );
        defer s.finalize();
        s.bindInt(1, cutoff);
        while (try s.step()) try users.append(self.gpa, @intCast(s.columnInt(0)));
    }

    var total: usize = 0;
    for (users.items) |uid| total += try sweepBinForUser(self, uid, cutoff);
    return total;
}

pub fn sweepBinForUser(self: Files, user_id: u64, cutoff: i64) !usize {
    var gc: std.ArrayList([md5_len]u8) = .empty;
    defer gc.deinit(self.gpa);

    try self.db.exec("BEGIN IMMEDIATE;");
    errdefer self.db.exec("ROLLBACK;") catch {};

    var ids: std.ArrayList(u64) = .empty;
    defer ids.deinit(self.gpa);
    {
        var s = try self.db.prepare(expired_bin_ids_sql);
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindInt(2, cutoff);
        while (try s.step()) try ids.append(self.gpa, @intCast(s.columnInt(0)));
    }
    // A pair expires together even if its stamps differ, or the mark would appear.
    try addPairs(self, user_id, &ids);

    try releaseIds(self, user_id, ids.items, &gc);
    if (ids.items.len > 0) try internal.bumpSync(self, user_id);
    try self.db.exec("COMMIT;");

    for (gc.items) |*m| internal.removeBlobFiles(self, m);
    return ids.items.len;
}

/// Releases every blob reference a user's rows hold, then hard-deletes them:
/// the storage half of account deletion (the FK cascade does not decref).
/// Shared blobs are only decremented. Call before deleting the `users` row.
pub fn purgeUser(self: Files, user_id: u64) !void {
    var doomed: std.ArrayList([md5_len]u8) = .empty;
    defer doomed.deinit(self.gpa);

    try self.db.exec("BEGIN IMMEDIATE;");
    errdefer self.db.exec("ROLLBACK;") catch {};

    // Every row, trashed included: a tombstone still holds its blob reference.
    {
        var s = try self.db.prepare(
            "SELECT md5 FROM files WHERE user_id = ?1 AND is_folder = 0;",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        while (try s.step()) {
            const m = s.columnText(0);
            if (m.len != md5_len) continue; // defensive: a folder-shaped row
            var buf: [md5_len]u8 = undefined;
            @memcpy(&buf, m);
            try doomed.append(self.gpa, buf);
        }
    }

    // Retained versions' md5s, collected before their rows cascade away.
    var hist_doomed: std.ArrayList([md5_len]u8) = .empty;
    defer hist_doomed.deinit(self.gpa);
    {
        var s = try self.db.prepare(
            "SELECT fh.md5 FROM file_history fh JOIN files f ON f.id = fh.file_id WHERE f.user_id = ?1;",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        while (try s.step()) {
            const m = s.columnText(0);
            if (m.len != md5_len) continue;
            var buf: [md5_len]u8 = undefined;
            @memcpy(&buf, m);
            try hist_doomed.append(self.gpa, buf);
        }
    }

    // In the same transaction as the decrefs, so refcount never disagrees.
    {
        var s = try self.db.prepare("DELETE FROM files WHERE user_id = ?1;");
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        _ = try s.step();
    }

    var gc: std.ArrayList([md5_len]u8) = .empty;
    defer gc.deinit(self.gpa);
    for (doomed.items) |*m| {
        if (try internal.decref(self, m)) try gc.append(self.gpa, m.*);
    }
    try history.reapDistinct(self, hist_doomed.items, &gc);

    try self.db.exec("COMMIT;");

    for (gc.items) |*m| internal.removeBlobFiles(self, m); // GC on disk after the commit
}

/// Tombstones the subtree at ?1, freezing each row's current path into
/// `deleted_path`. Gated on `deleted = 0` in the UPDATE, so trashed rows keep
/// their `deleted_at` and path while live rows below them are caught. The walk
/// ignores `deleted` so it can pass through trashed ancestors.
pub const subtree_trash_sql =
    \\WITH RECURSIVE
    \\  sub(id) AS (
    \\    SELECT id FROM files WHERE id = ?1 AND user_id = ?2
    \\    UNION
    \\    SELECT f.id FROM files f JOIN sub ON f.parent_id = sub.id
    \\  ),
    \\  tree(id, path) AS (
    \\    SELECT id, '/'||name FROM files WHERE user_id = ?2 AND parent_id IS NULL
    \\    UNION ALL
    \\    SELECT f.id, t.path||'/'||f.name FROM files f JOIN tree t ON f.parent_id = t.id
    \\    WHERE f.user_id = ?2
    \\  )
    \\UPDATE files SET deleted = 1, deleted_at = ?3, updated_at = ?3,
    \\  deleted_path = (SELECT path FROM tree WHERE tree.id = files.id)
    \\WHERE id IN (SELECT id FROM sub) AND deleted = 0;
;

/// Parents before children; `id` breaks ties so the older of two same-named
/// siblings keeps the name, identically on every replay.
pub const subtree_depth_sql =
    \\WITH RECURSIVE sub(id, depth) AS (
    \\  SELECT id, 0 FROM files WHERE id = ?1 AND user_id = ?2
    \\  UNION ALL
    \\  SELECT f.id, sub.depth + 1 FROM files f JOIN sub ON f.parent_id = sub.id
    \\)
    \\SELECT id FROM sub WHERE depth > 0 ORDER BY depth, id;
;

pub const subtree_ids_sql =
    \\WITH RECURSIVE sub(id) AS (
    \\  SELECT id FROM files WHERE id = ?1 AND user_id = ?2
    \\  UNION
    \\  SELECT f.id FROM files f JOIN sub ON f.parent_id = sub.id
    \\)
    \\SELECT id FROM sub;
;

/// User ?1's bin plus everything reachable below it.
pub const bin_ids_sql =
    \\WITH RECURSIVE sub(id) AS (
    \\  SELECT id FROM files WHERE user_id = ?1 AND deleted = 1
    \\  UNION
    \\  SELECT f.id FROM files f JOIN sub ON f.parent_id = sub.id
    \\)
    \\SELECT id FROM sub;
;

/// The same, trashed before ?2.
pub const expired_bin_ids_sql =
    \\WITH RECURSIVE sub(id) AS (
    \\  SELECT id FROM files
    \\  WHERE user_id = ?1 AND deleted = 1 AND COALESCE(deleted_at, 0) < ?2
    \\  UNION
    \\  SELECT f.id FROM files f JOIN sub ON f.parent_id = sub.id
    \\)
    \\SELECT id FROM sub;
;

/// The bin listing: a direct read of tombstones via `files_deleted_at`, O(bin).
/// `is_root` is computed live. A trashed pair is one row (the document's), and
/// its size is the pair's, because purging frees both.
pub const bin_listing_sql =
    \\SELECT f.id, f.parent_id, f.name, f.is_folder, f.md5,
    \\       f.size + COALESCE((SELECT m.size FROM files m
    \\                           WHERE m.user_id = f.user_id
    \\                             AND COALESCE(m.parent_id, 0) = COALESCE(f.parent_id, 0)
    \\                             AND m.name = f.name || '.mark'
    \\                             AND m.is_folder = 0 AND m.deleted = 1
    \\                             AND f.is_folder = 0
    \\                             AND substr(f.name, -5) <> '.mark'), 0),
    \\       COALESCE(f.deleted_at, 0), COALESCE(f.deleted_path, ''),
    \\       (f.parent_id IS NULL OR NOT EXISTS (
    \\          SELECT 1 FROM files p WHERE p.id = f.parent_id AND p.deleted = 1))
    \\FROM files f WHERE f.user_id = ?1 AND f.deleted = 1
++ internal.hide_paired_bin_mark ++
    \\
    \\ORDER BY COALESCE(f.deleted_at, 0) DESC, f.id DESC;
;

/// The live subtree at ?1, counted as `trash` would tombstone it, minus paired
/// `.mark`s below the anchor (the user never saw them).
pub const live_subtree_count_sql =
    \\WITH RECURSIVE sub(id) AS (
    \\  SELECT id FROM files WHERE id = ?1 AND user_id = ?2 AND deleted = 0
    \\  UNION
    \\  SELECT f.id FROM files f JOIN sub ON f.parent_id = sub.id WHERE f.deleted = 0
++ internal.hide_paired_mark ++
    \\
    \\)
    \\SELECT COUNT(*) FROM sub;
;

/// Closes `ids` under the pairing rule, adding each member's partner once.
/// The set is already cascade-closed, so only file siblings are added.
pub fn addPairs(self: Files, user_id: u64, ids: *std.ArrayList(u64)) !void {
    const n = ids.items.len; // snapshot: added rows are pairs already
    var i: usize = 0;
    while (i < n) : (i += 1) {
        const p = (try internal.pairOf(self, user_id, ids.items[i])) orelse continue;
        if (std.mem.indexOfScalar(u64, ids.items, p.id) != null) continue;
        try ids.append(self.gpa, p.id);
    }
}

pub fn releaseIds(self: Files, user_id: u64, ids: []const u64, gc: *std.ArrayList([md5_len]u8)) !void {
    // Must run inside a transaction. Everything is read before any delete (the
    // cascade removes rows we have not looked at); zero-ref blobs go to `gc` for
    // removal after commit. One entry per row: refcount counts rows, the refund
    // counts distinct md5s.
    const Doomed = struct { md5: [md5_len]u8, size: i64 };
    var doomed: std.ArrayList(Doomed) = .empty;
    defer doomed.deinit(self.gpa);

    for (ids) |fid| {
        var r = (try self.db.row(
            "SELECT md5, size FROM files WHERE id = ?1 AND user_id = ?2 AND is_folder = 0;",
            &.{ .{ .int = @intCast(fid) }, .{ .int = @intCast(user_id) } },
        )) orelse continue; // a folder, or already gone
        defer r.finalize();
        const m = r.text(0);
        if (m.len != md5_len) continue; // defensive: a file row with no blob
        var d: Doomed = .{ .md5 = undefined, .size = r.int(1) };
        @memcpy(&d.md5, m);
        try doomed.append(self.gpa, d);
    }

    // Retained-version md5s, collected before their rows cascade away, reaped after.
    var hist_doomed: std.ArrayList(history.Evicted) = .empty;
    defer hist_doomed.deinit(self.gpa);
    for (ids) |fid| {
        var s = try self.db.prepare("SELECT md5, size FROM file_history WHERE file_id = ?1;");
        defer s.finalize();
        s.bindInt(1, @intCast(fid));
        while (try s.step()) {
            const m = s.columnText(0);
            if (m.len != md5_len) continue;
            var e: history.Evicted = .{ .md5 = undefined, .size = s.columnInt(1) };
            @memcpy(&e.md5, m);
            try hist_doomed.append(self.gpa, e);
        }
    }

    for (ids) |fid| {
        var s = try self.db.prepare("DELETE FROM files WHERE id = ?1 AND user_id = ?2;");
        defer s.finalize();
        s.bindInt(1, @intCast(fid));
        s.bindInt(2, @intCast(user_id));
        _ = try s.step();
    }

    // Refund per distinct blob the user no longer holds in any charged sense,
    // including purged files' retained versions (their rows are gone).
    var settled: std.ArrayList([md5_len]u8) = .empty;
    defer settled.deinit(self.gpa);
    var delta: i64 = 0;
    for (doomed.items) |*d| try internal.settleRefund(self, user_id, &d.md5, d.size, &settled, &delta);
    for (hist_doomed.items) |*h| try internal.settleRefund(self, user_id, &h.md5, h.size, &settled, &delta);
    if (delta != 0) try internal.addUsed(self, user_id, delta);

    for (doomed.items) |*d| {
        if (try internal.decref(self, &d.md5)) try gc.append(self.gpa, d.md5);
    }

    // Reap blobs whose last keeper was a cascaded history row, after the decrefs.
    {
        var hist_md5s: std.ArrayList([md5_len]u8) = .empty;
        defer hist_md5s.deinit(self.gpa);
        for (hist_doomed.items) |*h| try hist_md5s.append(self.gpa, h.md5);
        try history.reapDistinct(self, hist_md5s.items, gc);
    }
}

/// `was_trashed` is false for an already-live row, so counts include only
/// rows actually changed.
pub const RestoredRow = struct { name: []u8, was_trashed: bool, renamed: bool };

/// Name choice for `restoreRow`; both fields serve `.mark` pairing only.
pub const RestoreName = struct {
    /// Restore under this name: a mark follows its document's possibly new name.
    name: ?[]const u8 = null,
    /// Accept a candidate only if `candidate ++ pair` is also free, so the pair
    /// shares one ` (n)` and never adopts an orphan mark.
    pair: ?[]const u8 = null,
};

/// Makes one row live, renaming on collision; leaves a live row alone. The
/// returned `name` is owned by `gpa`.
pub fn restoreRow(self: Files, user_id: u64, id: u64, opts: RestoreName) !RestoredRow {
    var parent_id: ?u64 = null;
    var deleted = false;
    var name: []u8 = undefined;
    {
        var r = (try self.db.row(
            "SELECT parent_id, name, deleted FROM files WHERE id = ?1 AND user_id = ?2;",
            &.{ .{ .int = @intCast(id) }, .{ .int = @intCast(user_id) } },
        )) orelse return error.NotFound;
        defer r.finalize();
        const pid = r.int(0);
        parent_id = if (pid == 0) null else @intCast(pid);
        name = try self.gpa.dupe(u8, r.text(1));
        deleted = r.int(2) != 0;
    }
    defer self.gpa.free(name);
    if (!deleted) return .{ .name = try self.gpa.dupe(u8, name), .was_trashed = false, .renamed = false };

    const final = try freeName(self, user_id, parent_id, opts.name orelse name, opts.pair);
    errdefer self.gpa.free(final);

    // `deleted_path` is NULL for live rows.
    var s = try self.db.prepare(
        "UPDATE files SET deleted = 0, deleted_at = NULL, deleted_path = NULL, name = ?1, updated_at = ?2 WHERE id = ?3;",
    );
    defer s.finalize();
    s.bindText(1, final);
    s.bindInt(2, internal.now(
        self,
    ));
    s.bindInt(3, @intCast(id));
    _ = try s.step();
    return .{ .name = final, .was_trashed = true, .renamed = !std.mem.eql(u8, final, name) };
}

/// A name free in `parent_id`: `wanted`, or ` (n)` inserted before the
/// extension with the lowest free n ≥ 2. Deterministic, so a replayed restore
/// lands on the same name. An existing suffix is replaced, not stacked. With
/// `pair`, `cand ++ pair` must be free too. Always a fresh allocation.
pub fn freeName(self: Files, user_id: u64, parent_id: ?u64, wanted: []const u8, pair: ?[]const u8) ![]u8 {
    if (try nameFree(self, user_id, parent_id, wanted, pair)) return self.gpa.dupe(u8, wanted);

    const dot = std.mem.lastIndexOfScalar(u8, wanted, '.');
    const full_stem = if (dot) |d| (if (d == 0) wanted else wanted[0..d]) else wanted;
    const ext = wanted[full_stem.len..];
    const stem = stripSuffix(full_stem);

    var n: u32 = 2;
    while (n < 10_000) : (n += 1) {
        const cand = try std.fmt.allocPrint(self.gpa, "{s} ({d}){s}", .{ stem, n, ext });
        errdefer self.gpa.free(cand);
        if (try nameFree(self, user_id, parent_id, cand, pair)) return cand;
        self.gpa.free(cand);
    }
    return error.NameConflict;
}

/// Whether `cand` is free and, with `pair`, not half of somebody else's pair:
/// for a document name `cand ++ pair` must be free; for a mark name its stem
/// must be.
pub fn nameFree(self: Files, user_id: u64, parent_id: ?u64, cand: []const u8, pair: ?[]const u8) !bool {
    if (try internal.liveChild(self, user_id, parent_id, cand) != null) return false;
    const suffix = pair orelse return true;
    if (markpair.markStemOf(cand)) |stem| return (try internal.liveChild(self, user_id, parent_id, stem)) == null;
    const twin = try std.fmt.allocPrint(self.gpa, "{s}{s}", .{ cand, suffix });
    defer self.gpa.free(twin);
    return (try internal.liveChild(self, user_id, parent_id, twin)) == null;
}

/// Strips one trailing ` (n)` (all digits), so `Budget (draft)` survives.
pub fn stripSuffix(stem: []const u8) []const u8 {
    if (stem.len == 0 or stem[stem.len - 1] != ')') return stem;
    const open = std.mem.lastIndexOfScalar(u8, stem, '(') orelse return stem;
    if (open < 2 or stem[open - 1] != ' ') return stem; // needs " (" and a non-empty base
    const digits = stem[open + 1 .. stem.len - 1];
    if (digits.len == 0) return stem;
    for (digits) |ch| if (!std.ascii.isDigit(ch)) return stem;
    return stem[0 .. open - 1];
}
