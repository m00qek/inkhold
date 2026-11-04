//! `inkhold backup create`: one consistent snapshot of a live install, taken
//! beside a running server.
//!
//! The order is what makes it consistent (DESIGN.md §2.6):
//!   1. copy every blob the live database names that the backup lacks;
//!   2. `VACUUM INTO` a private copy of the database;
//!   3. copy any blob that copy names and the backup still lacks (an upload
//!      that landed between 1 and 2). If one is gone from the live store too,
//!      it was uploaded and purged inside the window: take the snapshot again.
//! Blobs are written before the rows that name them, so (1) alone would miss
//! nothing added; (3) covers what was purged, which snapshot-first would not.
//! Blob references come from the `blobs` table only, the GC gate's own record,
//! which already counts the recycle bin and version history.

const std = @import("std");
const layout = @import("layout.zig");
const manifest = @import("manifest.zig");
const lock = @import("lock.zig");
const pace_mod = @import("pace.zig");
const blob_copy = @import("blob_copy.zig");
const place = @import("place.zig");
const gzfile = @import("gzfile.zig");
const prune_mod = @import("prune.zig");
const sqlite = @import("../../db/sqlite.zig");
const schema = @import("../../db/schema.zig");
const blobstore = @import("../../store/blobs.zig");
const atomic = @import("../../store/atomic.zig");
const Io = std.Io;
const Dir = Io.Dir;

/// The live install, as the config names it.
pub const Paths = struct {
    db_path: []const u8,
    data_dir: []const u8,
    cred_key_path: []const u8,
};

pub const Options = struct {
    /// After a good snapshot, prune to this many (`prune.pruneLocked`).
    keep: ?u32 = null,
    compress: bool = true,
    include_cred_key: bool = false,
    /// Source bytes per second; 0 is unlimited.
    rate: u64 = pace_mod.default_rate,
    /// Who is running, for the lock file.
    host: []const u8 = "",
    pid: i64 = 0,
    /// The `inkhold` version, recorded in the manifest.
    version: []const u8 = "",
};

/// What a run did, and the details a failure message needs.
pub const Report = struct {
    name: layout.SnapshotName = @splat('0'),
    blobs: u64 = 0,
    bytes: u64 = 0,
    /// Blobs this run added to the shared store.
    copied: u64 = 0,
    same_filesystem: bool = false,
    /// On `error.Locked`: who holds the directory.
    holder: lock.Holder = .{},
    /// On `SourceCorrupt` / `BlobLost`: which blob.
    md5: [layout.md5_len]u8 = @splat('0'),
    /// What `keep` removed.
    pruned: prune_mod.Report = .{},
};

pub const CreateError = error{
    NoDatabase,
    NoBlobStore,
    NoCredKey,
    /// A snapshot (or its `.partial`) of this exact second already exists.
    SnapshotExists,
    /// A blob the snapshot names vanished from the live store on every try.
    BlobLost,
};

/// Page cache for each of the backup's connections: it reads every page about
/// once, so a big cache only costs memory (the 4 MB budget, DESIGN.md §2.6).
pub const cache_kib = 1000;

/// md5s read per statement in the copy passes: short read transactions, so the
/// server's WAL can checkpoint while blobs are being copied.
const batch_len = 256;

const max_attempts = 3;

/// The private snapshot lives next to the live data, never in the backup
/// directory (a sync client would upload it) and never in /tmp (RAM on a Pi).
pub const tmp_dir_name = "backup-tmp";
const tmp_snapshot_name = "snapshot.db";

pub fn create(gpa: std.mem.Allocator, io: Io, paths: Paths, backup_dir: []const u8, now: i64, opts: Options, report: *Report) !void {
    report.* = .{};
    const where = try place.check(io, backup_dir, paths.data_dir, paths.db_path);
    report.same_filesystem = where.same_filesystem;

    var dst = try Dir.cwd().openDir(io, backup_dir, .{ .iterate = true });
    defer dst.close(io);
    const held = try lock.acquire(io, dst, now, opts.host, opts.pid, &report.holder);
    defer held.release(io);

    report.name = layout.snapshotName(now);
    var pbuf: [layout.snapshot_name_len + layout.partial_suffix.len]u8 = undefined;
    const partial = std.fmt.bufPrint(&pbuf, "{s}{s}", .{ &report.name, layout.partial_suffix }) catch unreachable;
    if (exists(io, dst, &report.name) or exists(io, dst, partial)) return error.SnapshotExists;

    const blobs_path = try std.fmt.allocPrint(gpa, "{s}/blobs", .{paths.data_dir});
    defer gpa.free(blobs_path);
    var blobs_dir = Dir.cwd().openDir(io, blobs_path, .{}) catch |e| switch (e) {
        error.FileNotFound => return error.NoBlobStore,
        else => return e,
    };
    defer blobs_dir.close(io);
    const live: blobstore.BlobStore = .{ .io = io, .root = blobs_dir };

    const live_db = try openDb(gpa, paths.db_path);
    defer live_db.close();

    const s = try gpa.create(blob_copy.Scratch);
    defer gpa.destroy(s);
    var pace = pace_mod.Pace.init(io, opts.rate);
    const copy: Copy = .{ .io = io, .live = live, .dst = dst, .compress = opts.compress, .pace = &pace, .s = s, .report = report };

    // 1. Everything the live database names.
    try copy.all(live_db, .tolerate_missing);

    const tmp_dir = try std.fmt.allocPrint(gpa, "{s}/{s}", .{ paths.data_dir, tmp_dir_name });
    defer gpa.free(tmp_dir);
    const snap_path = try std.fmt.allocPrintSentinel(gpa, "{s}/{s}", .{ tmp_dir, tmp_snapshot_name }, 0);
    defer gpa.free(snap_path);
    Dir.cwd().deleteTree(io, tmp_dir) catch {};
    try Dir.cwd().createDirPath(io, tmp_dir);
    defer Dir.cwd().deleteTree(io, tmp_dir) catch {};

    var attempt: u8 = 1;
    while (true) : (attempt += 1) {
        // 2. The database, consistent as of one moment.
        Dir.cwd().deleteFile(io, snap_path) catch {};
        try live_db.run("VACUUM INTO ?1;", &.{.{ .text = snap_path }});
        const snap = try sqlite.Db.openNoCreate(snap_path, cache_kib);
        defer snap.close();
        // A standalone file: no -wal beside it to forget.
        try snap.exec("PRAGMA journal_mode = DELETE;");
        // The legacy plaintext-md5 column is never read (login decrypts
        // `cred_enc`) and new rows leave it blank; an old install may still
        // carry values. Blank them in the copy, so a backup without cred.key
        // holds no usable credential. The live table is not touched.
        try snap.exec("UPDATE users SET password_md5 = '' WHERE password_md5 <> '';");

        // 3. Whatever landed between 1 and 2.
        copy.all(snap, .strict) catch |e| switch (e) {
            error.SourceMissing => {
                if (attempt < max_attempts) continue;
                return error.BlobLost;
            },
            else => return e,
        };

        try writeSnapshot(io, snap, snap_path, dst, partial, now, paths, opts, s, &pace, report);
        break;
    }
    // Under the same lock, so no other run sees the store mid-sweep.
    if (opts.keep) |keep| try prune_mod.pruneLocked(gpa, io, dst, keep, &report.pruned);
}

const Copy = struct {
    io: Io,
    live: blobstore.BlobStore,
    dst: Dir,
    compress: bool,
    pace: *pace_mod.Pace,
    s: *blob_copy.Scratch,
    report: *Report,

    const Missing = enum { tolerate_missing, strict };

    /// Copies every blob `db` names into the backup, in md5 order, a batch per
    /// statement. `tolerate_missing`: a row whose file is gone was purged after
    /// the read; the snapshot pass decides whether that matters.
    fn all(self: Copy, db: sqlite.Db, missing: Missing) !void {
        var after: [layout.md5_len]u8 = undefined;
        var after_len: usize = 0;
        var batch: [batch_len][layout.md5_len]u8 = undefined;
        while (true) {
            const n = try readBatch(db, after[0..after_len], &batch);
            if (n == 0) return;
            for (batch[0..n]) |*md5| {
                const outcome = blob_copy.put(self.io, self.live, self.dst, md5, self.compress, self.pace, self.s) catch |e| switch (e) {
                    error.SourceMissing => {
                        if (missing == .tolerate_missing) continue;
                        self.report.md5 = md5.*;
                        return e;
                    },
                    error.SourceCorrupt => {
                        self.report.md5 = md5.*;
                        return e;
                    },
                    else => return e,
                };
                if (outcome != .present) self.report.copied += 1;
            }
            after = batch[n - 1];
            after_len = layout.md5_len;
        }
    }
};

/// Up to `batch_len` blob md5s after `after`, ascending.
fn readBatch(db: sqlite.Db, after: []const u8, out: *[batch_len][layout.md5_len]u8) !usize {
    var st = try db.prepare("SELECT md5 FROM blobs WHERE md5 > ?1 ORDER BY md5 LIMIT " ++ std.fmt.comptimePrint("{d}", .{batch_len}) ++ ";");
    defer st.finalize();
    st.bindText(1, after);
    var n: usize = 0;
    while (try st.step()) {
        const m = st.columnText(0);
        if (!layout.isMd5(m)) return error.BadBlobRow;
        @memcpy(&out[n], m);
        n += 1;
    }
    return n;
}

/// Fills `<partial>/`, writes the manifest last, and renames it into place.
fn writeSnapshot(
    io: Io,
    snap: sqlite.Db,
    snap_path: []const u8,
    dst: Dir,
    partial: []const u8,
    now: i64,
    paths: Paths,
    opts: Options,
    s: *blob_copy.Scratch,
    pace: *pace_mod.Pace,
    report: *Report,
) !void {
    var h: manifest.Header = .{ .schema = try schema.userVersion(snap), .created = now, .has_cred_key = opts.include_cred_key, .blobs = 0, .bytes = 0 };
    {
        var r = (try snap.row("SELECT COUNT(*), COALESCE(SUM(size), 0) FROM blobs;", &.{})).?;
        defer r.finalize();
        h.blobs = @intCast(r.int(0));
        h.bytes = @intCast(r.int(1));
    }
    h.setInkhold(opts.version);

    try dst.createDir(io, partial, .default_dir);
    errdefer dst.deleteTree(io, partial) catch {};
    var pdir = try dst.openDir(io, partial, .{});
    defer pdir.close(io);

    try gzfile.deflate(io, Dir.cwd(), snap_path, pdir, layout.db_name, s, pace);
    if (opts.include_cred_key) try copyCredKey(io, paths.cred_key_path, pdir);

    {
        const f = try pdir.createFile(io, layout.manifest_name, .{});
        defer f.close(io);
        var fw = f.writerStreaming(io, &s.write_buf);
        try manifest.writeHeader(&fw.interface, &h);
        var st = try snap.prepare("SELECT md5 FROM blobs ORDER BY md5;");
        defer st.finalize();
        while (try st.step()) try manifest.writeMd5(&fw.interface, st.columnText(0));
        try fw.interface.flush();
        try f.sync(io);
    }

    try Dir.rename(dst, partial, dst, &report.name, io);
    if (!exists(io, dst, layout.readme_name)) {
        dst.writeFile(io, .{ .sub_path = layout.readme_name, .data = layout.readme }) catch {};
    }
    report.blobs = h.blobs;
    report.bytes = h.bytes;
}

fn copyCredKey(io: Io, path: []const u8, pdir: Dir) !void {
    var buf: [64]u8 = undefined;
    const f = Dir.cwd().openFile(io, path, .{}) catch |e| switch (e) {
        error.FileNotFound => return error.NoCredKey,
        else => return e,
    };
    defer f.close(io);
    const key = try atomic.readAll(io, f, &buf);
    const out = try pdir.createFile(io, layout.cred_key_name, .{});
    defer out.close(io);
    try out.writePositionalAll(io, key, 0);
    try out.sync(io);
}

fn openDb(gpa: std.mem.Allocator, path: []const u8) !sqlite.Db {
    const z = try gpa.dupeSentinel(u8, path, 0);
    defer gpa.free(z);
    return sqlite.Db.openNoCreate(z, cache_kib) catch return error.NoDatabase;
}

fn exists(io: Io, dir: Dir, name: []const u8) bool {
    dir.access(io, name, .{}) catch return false;
    return true;
}
