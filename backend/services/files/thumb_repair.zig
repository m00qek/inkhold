//! On-demand repair of derived thumbnails.

const filesmod = @import("../files.zig");
const Files = filesmod.Files;
const internal = @import("internal.zig");
const noteindex = @import("../note_index.zig");
const thumbnail = @import("../thumbnail.zig");
const spdindex = @import("../spd_index.zig");

/// Extractor by the blob's own magic (the URL has no name); missing is `.none`.
fn thumbSourceKind(self: Files, md5: []const u8) thumbnail.SourceKind {
    var head: [thumbnail.source_probe_len]u8 = undefined;
    const size = self.blobs.sizeOf(md5) catch return .none;
    const n: usize = @intCast(@min(size, head.len));
    const bytes = self.blobs.readRange(md5, 0, n, head[0..n]) catch return .none;
    return thumbnail.sourceKind(bytes);
}

/// Does `/thumbnail/{hash}` need a re-derive first? Asks the format's memo; a
/// blob neither format claims is false and 404s without deriving. O(1) probes.
pub fn thumbNeedsRepair(self: Files, md5: []const u8) bool {
    return switch (thumbSourceKind(self, md5)) {
        .spd => spdindex.needsRepair(self.db, self.thumbs, md5) catch false,
        .note => noteindex.needsRepair(self.db, self.thumbs, md5) catch false,
        .none => false,
    };
}

/// Chooses streaming a `.note` cover from the blob vs a `.spd` thumbnail.
pub fn thumbnailSourceKind(self: Files, md5: []const u8) thumbnail.SourceKind {
    return thumbSourceKind(self, md5);
}

/// A `.note` cover's recorded location, or null; streamed from the blob.
pub fn noteCover(self: Files, md5: []const u8) !?noteindex.CoverLocation {
    return noteindex.coverLocation(self.db, md5);
}

/// Lazily re-derives a missing/stale index row and `thumbs/` file on first
/// request (old schemas, version bumps, restores without `thumbs/`).
/// Best-effort; a corrupt blob's `indexable = 0` row makes it a one-time cost.
/// `lk` exposes `lockDb()`/`unlockDb()`. The caller must not hold the db lock:
/// the derive runs off it, and the order is repair mutex → db lock.
pub fn repairDerivedThumb(self: *Files, lk: anytype, md5: []const u8) void {
    // A reader view's gate is unshared, so repairing here would lose the
    // single-flight bound. Unreachable: `/thumbnail` is `manual_db_lock`.
    if (self.read_only) return;
    self.thumb_repair.lockUncancelable(self.io);
    defer self.thumb_repair.unlock(self.io);

    const kind = thumbSourceKind(self.*, md5);
    if (kind == .none) return;

    // Double-check under the mutex: a waiter may find the work done.
    {
        lk.lockDb();
        defer lk.unlockDb();
        const needed = switch (kind) {
            .spd => spdindex.needsRepair(self.db, self.thumbs, md5) catch return,
            .note => noteindex.needsRepair(self.db, self.thumbs, md5) catch return,
            .none => unreachable,
        };
        if (!needed) return;
    }

    // Derive off the db lock, disk before commit, then a brief locked write.
    switch (kind) {
        .spd => {
            var derived = (spdindex.deriveStored(self.gpa, self.blobs, md5) catch return) orelse return;
            defer derived.deinit();
            if (derived.thumb) |t| self.thumbs.put(md5, t.bytes) catch {};

            lk.lockDb();
            defer lk.unlockDb();
            self.db.exec("BEGIN IMMEDIATE;") catch return;
            spdindex.store(self.db, md5, derived, internal.now(self.*)) catch {
                self.db.exec("ROLLBACK;") catch {};
                return;
            };
            self.db.exec("COMMIT;") catch {
                self.db.exec("ROLLBACK;") catch {};
            };
        },
        .note => {
            // A cover writes no thumbs file, only the index row the serve path reads.
            var parsed = (noteindex.parseStoredBlob(self.gpa, self.io, self.blobs, md5) catch return) orelse return;
            defer parsed.deinit();

            lk.lockDb();
            defer lk.unlockDb();
            self.db.exec("BEGIN IMMEDIATE;") catch return;
            noteindex.store(self.db, md5, parsed, internal.now(self.*)) catch {
                self.db.exec("ROLLBACK;") catch {};
                return;
            };
            self.db.exec("COMMIT;") catch {
                self.db.exec("ROLLBACK;") catch {};
            };
        },
        .none => unreachable,
    }
}
