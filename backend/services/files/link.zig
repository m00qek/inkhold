//! Linking a stored blob into the tree, with ingest-time derivation.

const std = @import("std");
const derivesearch = @import("../derive_search.zig");
const noteindex = @import("../note_index.zig");
const thumbnail = @import("../thumbnail.zig");
const spdindex = @import("../spd_index.zig");
const internal = @import("internal.zig");
const bin = @import("bin.zig");
const history = @import("history.zig");
const log = std.log.scoped(.files);
const filesmod = @import("../files.zig");
const Files = filesmod.Files;
const md5_len = filesmod.md5_len;
const Entry = filesmod.Entry;

/// Streams `reader` into the blob store and links it, replacing a live file of
/// that name. Enforces quota.
pub fn putFile(self: Files, user_id: u64, parent_id: ?u64, name: []const u8, reader: *std.Io.Reader, expected_md5: ?[]const u8) !Entry {
    try internal.assertFolder(self, user_id, parent_id);

    const res = try self.blobs.put(reader, expected_md5);
    // Not a dedup: drop the blob and the thumbnail its indexing wrote.
    errdefer if (!res.deduped) internal.removeBlobFiles(self, &res.md5);

    return linkBlob(self, user_id, parent_id, name, &res.md5, res.size);
}

/// Links an already-stored blob (device `upload/finish`), replacing a live
/// file of that name, in one transaction. On failure the on-disk blob is left
/// untouched for the sweep; this never removes blobs.
pub fn linkBlob(self: Files, user_id: u64, parent_id: ?u64, name: []const u8, md5: []const u8, size: u64) !Entry {
    return linkBlobIndexed(self, user_id, parent_id, name, md5, size, null);
}

/// `linkBlob` with the `.note` index pre-parsed, so the multi-MB parse can run
/// outside the transaction (and the global lock). Rows are still written
/// inside it, so an index never outlives a rolled-back link.
pub fn linkBlobIndexed(
    self: Files,
    user_id: u64,
    parent_id: ?u64,
    name: []const u8,
    md5: []const u8,
    size: u64,
    pre_parsed: ?*const noteindex.Parsed,
) !Entry {
    try internal.assertFolder(self, user_id, parent_id);

    // ---- parse outside the transaction ----
    var owned: ?noteindex.Parsed = null;
    defer if (owned) |*p| p.deinit();
    var parsed: ?*const noteindex.Parsed = pre_parsed;
    if (parsed == null and !try noteindex.isCurrent(self.db, md5)) {
        owned = noteindex.parseStoredBlob(self.gpa, self.io, self.blobs, md5) catch null;
        if (owned) |*p| parsed = p;
    }

    // ---- `.spd` index + thumbnail, outside the transaction ----
    // An untrusted SQLite DB, opened read-only in memory once. Gated on the name
    // and `isCurrent`; any failure means no row, never a failed upload.
    var spd_derived: ?spdindex.Derived = null;
    defer if (spd_derived) |*d| d.deinit();
    if (thumbnail.wantsSpd(name) and !(spdindex.isCurrent(self.db, md5) catch false)) {
        spd_derived = spdindex.deriveStored(self.gpa, self.blobs, md5) catch null;
    }

    // `.txt` (and other) derives belong to `services/deferred.zig`; the worker is
    // signalled after COMMIT below.

    // Thumbnail before the commit (a crash can only orphan a regenerable file).
    // A `.note` cover is not copied: the serve path streams it from the blob.
    if (spd_derived) |d| {
        if (d.thumb) |t| self.thumbs.put(md5, t.bytes) catch {};
    }

    // `.note` derived files, eagerly and outside the transaction: the text is
    // already in the container and the parse was needed anyway. Best-effort.
    if (parsed) |p| writeNoteDerived(self, md5, p) catch |e| {
        log.warn("terms/text write failed for {s}: {t}", .{ md5, e });
    };

    try self.db.exec("BEGIN IMMEDIATE;");
    errdefer self.db.exec("ROLLBACK;") catch {};

    try internal.ensureBlobRow(self, md5, size);

    const existing = try internal.liveChild(self, user_id, parent_id, name);
    if (existing) |e| if (e.is_folder) return error.NameConflict;

    const old_md5: ?[md5_len]u8 = if (existing) |e| e.md5 else null;
    const same_content = if (old_md5) |om| std.mem.eql(u8, &om, md5) else false;

    // ---- reference counts, read before any row write ----
    // Quota follows anything keeping bytes on disk, incl. `file_history`.
    var new_charge = false;
    if (!same_content) new_charge = try internal.userChargedRefs(self, user_id, md5) == 0;

    var file_id: u64 = undefined;
    const ts = internal.now(self);

    // Rolls back with the link.
    if (parsed) |p| try noteindex.store(self.db, md5, p.*, ts);

    // Best-effort: a missing row is re-derived on demand.
    if (spd_derived) |d| spdindex.store(self.db, md5, d, ts) catch |e| log.warn("blob {s}: spd index not stored, will re-derive: {t}", .{ md5, e });

    if (existing) |e| {
        file_id = e.id;
        var s = try self.db.prepare("UPDATE files SET md5 = ?1, size = ?2, updated_at = ?3 WHERE id = ?4;");
        defer s.finalize();
        s.bindText(1, md5);
        s.bindInt(2, @intCast(size));
        s.bindInt(3, ts);
        s.bindInt(4, @intCast(file_id));
        _ = try s.step();
    } else {
        var s = try self.db.prepare(
            "INSERT INTO files(user_id, parent_id, name, is_folder, md5, size, created_at, updated_at) VALUES(?1,?2,?3,0,?4,?5,?6,?6);",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        internal.bindOpt(s, 2, parent_id);
        s.bindText(3, name);
        s.bindText(4, md5);
        s.bindInt(5, @intCast(size));
        s.bindInt(6, ts);
        _ = try s.step();
        file_id = @intCast(self.db.lastInsertRowId());
    }

    if (!same_content) try internal.incref(self, md5);

    try internal.bumpSync(self, user_id); // an upload/replace changed the tree

    // Retain on supersede: write the history row before the decref, so the GC gate
    // keeps the blob. Refcount drops but the charge stays. `keep == 0` prunes and
    // refunds. `evicted` lets settlement give back exactly what left.
    const keep = (try self.versionPolicy(user_id)).keep;
    var gc_old = false;
    var gc_hist: std.ArrayList([md5_len]u8) = .empty;
    defer gc_hist.deinit(self.gpa);
    var evicted: std.ArrayList(history.Evicted) = .empty;
    defer evicted.deinit(self.gpa);
    if (old_md5) |om| {
        if (!same_content) {
            if (keep > 0) try history.recordHistory(self, file_id, &om, existing.?.size, ts);
            gc_old = try internal.decref(self, &om);
            // K per file, then the global max_bytes ceiling.
            if (keep > 0) try history.evictHistory(self, user_id, file_id, keep, &gc_hist, &evicted);
        }
    }

    // ---- quota settlement, from the rows as they are now ----
    // Eviction may drop the version just recorded, so nothing is predicted.
    var settled: std.ArrayList([md5_len]u8) = .empty;
    defer settled.deinit(self.gpa);
    var delta: i64 = if (new_charge) @as(i64, @intCast(size)) else 0;
    if (old_md5) |om| {
        if (!same_content) try internal.settleRefund(self, user_id, &om, @intCast(existing.?.size), &settled, &delta);
    }
    for (evicted.items) |*e| try internal.settleRefund(self, user_id, &e.md5, e.size, &settled, &delta);

    // Never refuse an edit for the version it displaced: evict the user's oldest
    // versions until it fits, and refuse only when live files alone do not.
    // Bounded: each pass deletes one row whose blob no live file holds.
    const cap = try self.capacity(user_id);
    while (cap.used + delta > cap.total) {
        const dropped = (try history.evictOldestVersion(self, user_id, &gc_hist)) orelse break;
        try internal.settleRefund(self, user_id, &dropped.md5, dropped.size, &settled, &delta);
    }
    if (cap.used + delta > cap.total) return error.QuotaExceeded; // errdefer rolls back
    try internal.addUsed(self, user_id, delta);

    try self.db.exec("COMMIT;");
    // After commit, or the worker may find nothing and sleep.
    if (self.deferred) |w| w.signal();
    if (gc_old) internal.removeBlobFiles(self, &old_md5.?);
    for (gc_hist.items) |*m| internal.removeBlobFiles(self, m);

    return .{
        .id = file_id,
        .parent_id = parent_id,
        .name = try self.gpa.dupe(u8, name),
        .is_folder = false,
        .md5 = try self.gpa.dupe(u8, md5),
        .size = size,
        .updated_at = ts,
        // The upload response is a listing row; the `.mark` often arrives first.
        .mark_id = try self.liveMarkIdFor(user_id, parent_id, name),
    };
}

/// Derived files for one `.note`. Gated on `indexable`: non-notes parse to an
/// empty `Parsed`, and an empty file would mark them derived for ever.
fn writeNoteDerived(self: Files, md5: []const u8, p: *const noteindex.Parsed) !void {
    if (!p.indexable) return;
    // Null store: nothing to write.
    const terms_store = self.terms orelse return;
    const text_store = self.text orelse return;
    var src = noteindex.Pages.init(p);
    try derivesearch.writeDerived(
        self.gpa,
        terms_store,
        text_store,
        md5,
        // The address space: every page, not only recognised ones.
        p.note.page_count,
        &src,
    );
}

/// Links an already-stored blob as a new file, never over an existing one (web
/// upload). Unlike the device, a browser drop of a same-named file is a
/// different file, so a collision takes `bin.freeName`'s ` (n)`. Caller frees
/// `.name` / `.md5`.
pub fn placeUpload(self: Files, user_id: u64, parent_id: ?u64, name: []const u8, md5: []const u8, size: u64) !Entry {
    // Fail a bad destination before the `bin.freeName` scan.
    try internal.assertFolder(self, user_id, parent_id);

    const final = try bin.freeName(self, user_id, parent_id, name, null);
    defer self.gpa.free(final);
    return linkBlob(self, user_id, parent_id, final, md5, size);
}
