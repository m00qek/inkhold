//! `inkhold backup verify`: can each snapshot be restored? By default, cheap:
//! the manifest reads to its end, every blob it names is in the store, and the
//! database inflates whole and matches its gzip trailer. `deep` also re-hashes
//! every blob in the store, once however many snapshots share it, and runs
//! SQLite's integrity check on the database. Memory stays flat either way;
//! only the list of damaged blobs found grows, and a healthy store has none.

const std = @import("std");
const layout = @import("layout.zig");
const manifest = @import("manifest.zig");
const list_mod = @import("list.zig");
const blob_copy = @import("blob_copy.zig");
const gzfile = @import("gzfile.zig");
const pace_mod = @import("pace.zig");
const create_mod = @import("create.zig");
const sqlite = @import("../../db/sqlite.zig");
const Io = std.Io;
const Dir = Io.Dir;

pub const Options = struct {
    deep: bool = false,
    rate: u64 = pace_mod.default_rate,
    /// Where `deep` inflates a database to run the integrity check; must not be
    /// inside the backup directory a sync client watches. Required for `deep`.
    tmp_dir: ?[]const u8 = null,
};

pub const Result = struct {
    name: layout.SnapshotName,
    manifest_ok: bool = true,
    db_ok: bool = true,
    blobs: u64 = 0,
    missing: u64 = 0,
    corrupt: u64 = 0,
    /// The first missing or corrupt blob, for the message.
    first_bad: ?[layout.md5_len]u8 = null,

    pub fn ok(self: Result) bool {
        return self.manifest_ok and self.db_ok and self.missing == 0 and self.corrupt == 0;
    }
};

pub const Verified = struct {
    results: std.ArrayList(Result) = .empty,
    /// Blobs `deep` re-hashed.
    hashed: u64 = 0,

    pub fn deinit(self: *Verified, gpa: std.mem.Allocator) void {
        self.results.deinit(gpa);
    }

    pub fn allOk(self: *const Verified) bool {
        for (self.results.items) |r| if (!r.ok()) return false;
        return true;
    }
};

pub const VerifyError = error{
    NoSuchSnapshot,
    NoSnapshots,
};

/// Verifies snapshot `only`, or every complete snapshot when null.
pub fn verify(gpa: std.mem.Allocator, io: Io, dir: Dir, only: ?[]const u8, opts: Options) !Verified {
    var out: Verified = .{};
    errdefer out.deinit(gpa);

    var names: std.ArrayList(layout.SnapshotName) = .empty;
    defer names.deinit(gpa);
    if (only) |name| {
        if (!layout.isSnapshotName(name)) return error.NoSuchSnapshot;
        dir.access(io, name, .{}) catch return error.NoSuchSnapshot;
        try names.append(gpa, name[0..layout.snapshot_name_len].*);
    } else {
        var l = try list_mod.list(gpa, io, dir);
        defer l.deinit(gpa);
        for (l.entries.items) |e| try names.append(gpa, e.name);
        if (names.items.len == 0) return error.NoSnapshots;
    }

    const s = try gpa.create(blob_copy.Scratch);
    defer gpa.destroy(s);
    var pace = pace_mod.Pace.init(io, opts.rate);

    var corrupt: std.ArrayList([layout.md5_len]u8) = .empty;
    defer corrupt.deinit(gpa);
    if (opts.deep) out.hashed = try hashStore(gpa, io, dir, &corrupt, &pace, s);

    for (names.items) |name| {
        var r: Result = .{ .name = name };
        checkBlobs(io, dir, &name, corrupt.items, &r) catch {
            r.manifest_ok = false;
        };
        r.db_ok = checkDb(gpa, io, dir, &name, opts, &pace, s) catch false;
        try out.results.append(gpa, r);
    }
    return out;
}

/// Re-hashes every blob file in the store; the damaged ones go in `corrupt`.
fn hashStore(gpa: std.mem.Allocator, io: Io, dir: Dir, corrupt: *std.ArrayList([layout.md5_len]u8), pace: *pace_mod.Pace, s: *blob_copy.Scratch) !u64 {
    var blobs = dir.openDir(io, layout.blobs_dir, .{ .iterate = true }) catch |e| switch (e) {
        error.FileNotFound => return 0,
        else => return e,
    };
    defer blobs.close(io);
    var hashed: u64 = 0;
    var fans = blobs.iterate();
    while (try fans.next(io)) |fan| {
        if (fan.kind != .directory) continue;
        var sub = try blobs.openDir(io, fan.name, .{ .iterate = true });
        defer sub.close(io);
        var files = sub.iterate();
        while (try files.next(io)) |f| {
            const stem = if (std.mem.endsWith(u8, f.name, layout.gz_suffix)) f.name[0 .. f.name.len - layout.gz_suffix.len] else f.name;
            if (!layout.isMd5(stem)) continue; // a .tmp or a stranger's file
            hashed += 1;
            _ = blob_copy.check(io, dir, stem, pace, s) catch |e| switch (e) {
                error.BlobCorrupt => {
                    try corrupt.append(gpa, stem[0..layout.md5_len].*);
                    continue;
                },
                else => return e,
            };
        }
    }
    return hashed;
}

fn checkBlobs(io: Io, dir: Dir, name: []const u8, corrupt: []const [layout.md5_len]u8, r: *Result) !void {
    var pbuf: [layout.snapshot_name_len + 1 + layout.manifest_name.len]u8 = undefined;
    const path = std.fmt.bufPrint(&pbuf, "{s}/{s}", .{ name, layout.manifest_name }) catch unreachable;
    const f = try dir.openFile(io, path, .{});
    defer f.close(io);
    var buf: [4096]u8 = undefined;
    var fr = f.reader(io, &buf);
    var m = try manifest.Reader.init(&fr.interface);
    while (try m.next()) |md5| {
        r.blobs += 1;
        const bad = if (!blob_copy.has(io, dir, &md5)) blk: {
            r.missing += 1;
            break :blk true;
        } else if (contains(corrupt, &md5)) blk: {
            r.corrupt += 1;
            break :blk true;
        } else false;
        if (bad and r.first_bad == null) r.first_bad = md5;
    }
}

fn contains(list: []const [layout.md5_len]u8, md5: *const [layout.md5_len]u8) bool {
    for (list) |*m| if (std.mem.eql(u8, m, md5)) return true;
    return false;
}

const sqlite_magic = "SQLite format 3\x00";

/// The database inflates whole, matches its trailer and looks like SQLite;
/// with `deep`, SQLite's own integrity check passes too.
fn checkDb(gpa: std.mem.Allocator, io: Io, dir: Dir, name: []const u8, opts: Options, pace: *pace_mod.Pace, s: *blob_copy.Scratch) !bool {
    var pbuf: [layout.snapshot_name_len + 1 + layout.db_name.len]u8 = undefined;
    const path = std.fmt.bufPrint(&pbuf, "{s}/{s}", .{ name, layout.db_name }) catch unreachable;
    var head: [sqlite_magic.len]u8 = undefined;

    if (!opts.deep) {
        _ = try gzfile.inflate(io, dir, path, null, &head, s, pace);
        return std.mem.eql(u8, &head, sqlite_magic);
    }

    const tmp_dir = opts.tmp_dir orelse return error.NoTmpDir;
    Dir.cwd().deleteTree(io, tmp_dir) catch {};
    try Dir.cwd().createDirPath(io, tmp_dir);
    defer Dir.cwd().deleteTree(io, tmp_dir) catch {};
    const db_path = try std.fmt.allocPrintSentinel(gpa, "{s}/check.db", .{tmp_dir}, 0);
    defer gpa.free(db_path);
    {
        const out = try Dir.cwd().createFile(io, db_path, .{});
        defer out.close(io);
        var fw = out.writerStreaming(io, &s.write_buf);
        _ = try gzfile.inflate(io, dir, path, &fw.interface, &head, s, pace);
        try fw.interface.flush();
    }
    if (!std.mem.eql(u8, &head, sqlite_magic)) return false;
    const db = try sqlite.Db.openNoCreate(db_path, create_mod.cache_kib);
    defer db.close();
    var r = (try db.row("PRAGMA integrity_check;", &.{})) orelse return false;
    defer r.finalize();
    return std.mem.eql(u8, r.text(0), "ok");
}
