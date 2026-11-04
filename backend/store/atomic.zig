//! What the blob, thumbnail and derived stores share: a `tmp/` staging
//! directory beside the published files, random temp names, the crash sweep,
//! and reading a small file whole. Publishing itself is the store's rename;
//! the invariant (DESIGN.md §2.1) is that nothing is renamed into place before
//! it is fsynced, and a crash can only leave a temp file for `sweepTmp`.

const std = @import("std");
const Io = std.Io;
const Dir = Io.Dir;
const File = Io.File;

/// Creates `sub` under `root` if missing; an existing directory is fine.
pub fn ensureDir(io: Io, root: Dir, sub: []const u8) !void {
    var d = root.createDirPathOpen(io, sub, .{}) catch |err| switch (err) {
        error.PathAlreadyExists => return,
        else => return err,
    };
    d.close(io);
}

/// A fresh `tmp/<16 hex>` name from the OS CSPRNG, written into `buf`.
pub fn tempName(io: Io, buf: *[20]u8) []const u8 {
    var raw: [8]u8 = undefined;
    io.random(&raw);
    @memcpy(buf[0..4], "tmp/");
    buf[4..20].* = std.fmt.bytesToHex(raw, .lower);
    return buf[0..20];
}

/// Removes temp files abandoned by a crash and recreates the staging directory.
pub fn sweepTmp(io: Io, root: Dir) void {
    root.deleteTree(io, "tmp") catch {};
    ensureDir(io, root, "tmp") catch {};
}

/// Reads `file` from its current position into `buf`, as much as fits.
pub fn readAll(io: Io, file: File, buf: []u8) ![]u8 {
    var rbuf: [4096]u8 = undefined;
    var fr = file.reader(io, &rbuf);
    var total: usize = 0;
    while (total < buf.len) {
        const n = try fr.interface.readSliceShort(buf[total..]);
        if (n == 0) break;
        total += n;
    }
    return buf[0..total];
}
