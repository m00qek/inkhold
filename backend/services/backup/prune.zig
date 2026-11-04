//! `inkhold backup prune`: keep the newest `keep` snapshots, and remove every
//! blob none of them names, along with what interrupted runs left behind
//! (`.partial` snapshots, `<md5>.tmp` blobs). This is what compaction means
//! here: blobs stay one plain file each, never packed, so a sync client keeps
//! uploading only what is new.
//!
//! The sweep walks the store one fan-out directory at a time against a merge
//! of the kept manifests, each streamed in md5 order: memory is one directory
//! listing plus a small buffer per kept snapshot. Every kept manifest is read
//! to its end first: one that turned out short would make the blobs after its
//! cut look unreferenced, and they would be deleted.

const std = @import("std");
const layout = @import("layout.zig");
const manifest = @import("manifest.zig");
const lock = @import("lock.zig");
const list_mod = @import("list.zig");
const Io = std.Io;
const Dir = Io.Dir;
const File = Io.File;

pub const Report = struct {
    removed_snapshots: u32 = 0,
    removed_partials: u32 = 0,
    removed_blobs: u64 = 0,
    removed_temps: u64 = 0,
    freed_bytes: u64 = 0,
    /// Snapshot directories with no readable manifest: neither kept nor removed
    /// (they may hold someone's only database), and they protect no blobs.
    incomplete: u32 = 0,
    /// On `error.Locked`.
    holder: lock.Holder = .{},
    /// On `error.BadManifest`: the snapshot whose manifest stopped the sweep.
    bad: ?layout.SnapshotName = null,
};

pub const PruneError = error{
    /// `keep` must be at least one: prune never deletes the last snapshot.
    KeepZero,
};

/// Takes the directory's lock and prunes to `keep` snapshots.
pub fn prune(gpa: std.mem.Allocator, io: Io, dir: Dir, keep: u32, now: i64, host: []const u8, pid: i64, report: *Report) !void {
    report.* = .{};
    const held = try lock.acquire(io, dir, now, host, pid, &report.holder);
    defer held.release(io);
    try pruneLocked(gpa, io, dir, keep, report);
}

/// `prune` for a caller that already holds the lock (`create --keep`).
pub fn pruneLocked(gpa: std.mem.Allocator, io: Io, dir: Dir, keep: u32, report: *Report) !void {
    if (keep == 0) return error.KeepZero;

    var l = try list_mod.list(gpa, io, dir);
    defer l.deinit(gpa);

    var kept: std.ArrayList(layout.SnapshotName) = .empty;
    defer kept.deinit(gpa);
    var complete: usize = 0;
    for (l.entries.items) |e| {
        if (e.header == null) report.incomplete += 1 else complete += 1;
    }
    // Oldest first: everything before the last `keep` complete ones goes.
    var to_drop = complete -| keep;
    for (l.entries.items) |e| {
        if (e.header == null) continue;
        if (to_drop > 0) {
            to_drop -= 1;
            try dir.deleteTree(io, &e.name);
            report.removed_snapshots += 1;
        } else try kept.append(gpa, e.name);
    }

    // Under the lock, any `.partial` is an interrupted run's.
    report.removed_partials = try removePartials(io, dir);

    for (kept.items) |*name| {
        validate(io, dir, name) catch {
            report.bad = name.*;
            return error.BadManifest;
        };
    }
    try sweep(gpa, io, dir, kept.items, report);
}

fn removePartials(io: Io, dir: Dir) !u32 {
    var n: u32 = 0;
    var doomed: [16][layout.snapshot_name_len + layout.partial_suffix.len]u8 = undefined;
    while (true) {
        var found: usize = 0;
        var it = dir.iterate();
        while (try it.next(io)) |e| {
            if (e.kind != .directory or e.name.len != doomed[0].len) continue;
            if (!std.mem.endsWith(u8, e.name, layout.partial_suffix)) continue;
            if (!layout.isSnapshotName(e.name[0..layout.snapshot_name_len])) continue;
            @memcpy(&doomed[found], e.name);
            found += 1;
            if (found == doomed.len) break;
        }
        // Deleted outside the iteration, which must not see its directory change.
        for (doomed[0..found]) |*name| try dir.deleteTree(io, name);
        n += @intCast(found);
        if (found < doomed.len) return n;
    }
}

/// Reads a manifest to its end; any defect is an error.
fn validate(io: Io, dir: Dir, name: []const u8) !void {
    var m: Stream = undefined;
    try m.open(io, dir, name);
    defer m.close(io);
    while (try m.reader.next()) |_| {}
}

/// One manifest being read in md5 order, with its current head.
const Stream = struct {
    file: File,
    buf: [2048]u8,
    fr: File.Reader,
    reader: manifest.Reader,
    head: ?[layout.md5_len]u8,

    /// Built in place: `reader` points into `fr`, which points into `buf`.
    fn open(self: *Stream, io: Io, dir: Dir, name: []const u8) !void {
        var pbuf: [layout.snapshot_name_len + 1 + layout.manifest_name.len]u8 = undefined;
        const path = std.fmt.bufPrint(&pbuf, "{s}/{s}", .{ name, layout.manifest_name }) catch unreachable;
        self.file = try dir.openFile(io, path, .{});
        errdefer self.file.close(io);
        self.fr = self.file.reader(io, &self.buf);
        self.reader = try manifest.Reader.init(&self.fr.interface);
        self.head = try self.reader.next();
    }

    fn close(self: *Stream, io: Io) void {
        self.file.close(io);
    }

    /// Advances past every md5 below `md5`; true when the head is `md5`.
    fn names(self: *Stream, md5: *const [layout.md5_len]u8) !bool {
        while (self.head) |h| {
            switch (std.mem.order(u8, &h, md5)) {
                .lt => self.head = try self.reader.next(),
                .eq => return true,
                .gt => return false,
            }
        }
        return false;
    }
};

fn sweep(gpa: std.mem.Allocator, io: Io, dir: Dir, kept: []const layout.SnapshotName, report: *Report) !void {
    var streams = try gpa.alloc(*Stream, kept.len);
    defer gpa.free(streams);
    var opened: usize = 0;
    defer for (streams[0..opened]) |st| {
        st.close(io);
        gpa.destroy(st);
    };
    for (kept) |*name| {
        const st = try gpa.create(Stream);
        st.open(io, dir, name) catch |e| {
            gpa.destroy(st);
            return e;
        };
        streams[opened] = st;
        opened += 1;
    }

    var blobs = dir.openDir(io, layout.blobs_dir, .{ .iterate = true }) catch |e| switch (e) {
        error.FileNotFound => return,
        else => return e,
    };
    defer blobs.close(io);

    // Fan-out directories in ascending order, so they meet the manifests in order.
    var fans: std.ArrayList([2]u8) = .empty;
    defer fans.deinit(gpa);
    {
        var it = blobs.iterate();
        while (try it.next(io)) |e| {
            if (e.kind == .directory and e.name.len == 2 and isHex(e.name)) try fans.append(gpa, e.name[0..2].*);
        }
    }
    std.mem.sort([2]u8, fans.items, {}, lessFan);

    var files: std.ArrayList([layout.md5_len + 4]u8) = .empty;
    defer files.deinit(gpa);
    var lens: std.ArrayList(u8) = .empty;
    defer lens.deinit(gpa);
    for (fans.items) |*fan| {
        var sub = try blobs.openDir(io, fan, .{ .iterate = true });
        defer sub.close(io);

        files.clearRetainingCapacity();
        {
            var it = sub.iterate();
            while (try it.next(io)) |e| {
                if (e.kind != .file or e.name.len > layout.md5_len + 4) continue;
                var name: [layout.md5_len + 4]u8 = @splat(0);
                @memcpy(name[0..e.name.len], e.name);
                try files.append(gpa, name);
            }
        }
        std.mem.sort([layout.md5_len + 4]u8, files.items, {}, lessName);

        for (files.items) |*padded| {
            const name = std.mem.sliceTo(padded, 0);
            if (std.mem.endsWith(u8, name, ".tmp")) {
                try remove(io, sub, name, report);
                report.removed_temps += 1;
                continue;
            }
            const stem = if (std.mem.endsWith(u8, name, layout.gz_suffix)) name[0 .. name.len - layout.gz_suffix.len] else name;
            if (!layout.isMd5(stem)) continue; // not ours: leave it
            var referenced = false;
            for (streams) |st| {
                if (try st.names(stem[0..layout.md5_len])) referenced = true;
            }
            if (referenced) continue;
            try remove(io, sub, name, report);
            report.removed_blobs += 1;
        }
    }
}

fn remove(io: Io, sub: Dir, name: []const u8, report: *Report) !void {
    if (sub.statFile(io, name, .{})) |st| report.freed_bytes += st.size else |_| {}
    try sub.deleteFile(io, name);
}

fn isHex(s: []const u8) bool {
    for (s) |c| switch (c) {
        '0'...'9', 'a'...'f' => {},
        else => return false,
    };
    return true;
}

fn lessFan(_: void, a: [2]u8, b: [2]u8) bool {
    return std.mem.order(u8, &a, &b) == .lt;
}

fn lessName(_: void, a: [layout.md5_len + 4]u8, b: [layout.md5_len + 4]u8) bool {
    return std.mem.order(u8, &a, &b) == .lt;
}
