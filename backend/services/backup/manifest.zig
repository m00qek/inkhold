//! A snapshot's manifest: who made it, from which schema, and the sorted list
//! of every blob it needs. It is the last file written into a snapshot, so a
//! snapshot without one is incomplete and ignored. Read as a stream: a
//! library of any size costs one small buffer.
//!
//!     inkhold-backup 1
//!     inkhold 0.0.0
//!     schema 16
//!     created 1793761200
//!     cred-key no
//!     blobs 37
//!     bytes 117543914
//!     --
//!     0123456789abcdef0123456789abcdef
//!     …

const std = @import("std");
const layout = @import("layout.zig");
const Io = std.Io;

/// Bumped only if a reader of the old format would misread the new one.
pub const format_version: u32 = 1;

pub const Header = struct {
    format: u32 = format_version,
    /// The `inkhold` version that wrote it, for `list`; informational.
    inkhold_buf: [32]u8 = undefined,
    inkhold_len: u8 = 0,
    /// The database's `user_version`: a binary older than this cannot restore it.
    schema: i64,
    created: i64,
    has_cred_key: bool,
    /// Blob count and their total uncompressed bytes.
    blobs: u64,
    bytes: u64,

    pub fn inkhold(self: *const Header) []const u8 {
        return self.inkhold_buf[0..self.inkhold_len];
    }

    pub fn setInkhold(self: *Header, v: []const u8) void {
        const n = @min(v.len, self.inkhold_buf.len);
        @memcpy(self.inkhold_buf[0..n], v[0..n]);
        self.inkhold_len = @intCast(n);
    }
};

pub const Error = error{BadManifest};

/// Writes the header; `writeMd5` follows for each blob, in ascending order.
pub fn writeHeader(w: *Io.Writer, h: *const Header) Io.Writer.Error!void {
    try w.print(
        "inkhold-backup {d}\ninkhold {s}\nschema {d}\ncreated {d}\ncred-key {s}\nblobs {d}\nbytes {d}\n--\n",
        .{ h.format, h.inkhold(), h.schema, h.created, if (h.has_cred_key) "yes" else "no", h.blobs, h.bytes },
    );
}

pub fn writeMd5(w: *Io.Writer, md5: []const u8) Io.Writer.Error!void {
    std.debug.assert(layout.isMd5(md5));
    try w.writeAll(md5);
    try w.writeByte('\n');
}

/// A manifest open for reading: the header, then `next` per blob.
pub const Reader = struct {
    r: *Io.Reader,
    header: Header,
    /// Count read so far, checked against `header.blobs` at the end.
    seen: u64 = 0,
    last: [layout.md5_len]u8 = @splat(0),

    /// Parses the header. `r` must outlive the `Reader`.
    pub fn init(r: *Io.Reader) (Error || Io.Reader.Error)!Reader {
        var h: Header = .{ .schema = 0, .created = 0, .has_cred_key = false, .blobs = 0, .bytes = 0 };
        var got: u8 = 0;
        while (true) {
            const line = try takeLine(r) orelse return error.BadManifest;
            if (std.mem.eql(u8, line, "--")) break;
            const sp = std.mem.indexOfScalar(u8, line, ' ') orelse return error.BadManifest;
            const key = line[0..sp];
            const val = line[sp + 1 ..];
            if (std.mem.eql(u8, key, "inkhold-backup")) {
                h.format = std.fmt.parseInt(u32, val, 10) catch return error.BadManifest;
                if (h.format != format_version) return error.BadManifest;
                got |= 1;
            } else if (std.mem.eql(u8, key, "inkhold")) {
                h.setInkhold(val);
            } else if (std.mem.eql(u8, key, "schema")) {
                h.schema = std.fmt.parseInt(i64, val, 10) catch return error.BadManifest;
                got |= 2;
            } else if (std.mem.eql(u8, key, "created")) {
                h.created = std.fmt.parseInt(i64, val, 10) catch return error.BadManifest;
            } else if (std.mem.eql(u8, key, "cred-key")) {
                h.has_cred_key = std.mem.eql(u8, val, "yes");
            } else if (std.mem.eql(u8, key, "blobs")) {
                h.blobs = std.fmt.parseInt(u64, val, 10) catch return error.BadManifest;
                got |= 4;
            } else if (std.mem.eql(u8, key, "bytes")) {
                h.bytes = std.fmt.parseInt(u64, val, 10) catch return error.BadManifest;
            }
            // Unknown keys are skipped: a newer writer may add some.
        }
        if (got != 7) return error.BadManifest;
        return .{ .r = r, .header = h };
    }

    /// The next md5, or null at the end. A line out of order, malformed, or a
    /// count that disagrees with the header is `BadManifest`: a truncated
    /// copy must never pass as a complete one.
    pub fn next(self: *Reader) (Error || Io.Reader.Error)!?[layout.md5_len]u8 {
        const line = try takeLine(self.r) orelse {
            if (self.seen != self.header.blobs) return error.BadManifest;
            return null;
        };
        if (!layout.isMd5(line)) return error.BadManifest;
        var md5: [layout.md5_len]u8 = undefined;
        @memcpy(&md5, line);
        if (self.seen > 0 and std.mem.order(u8, &self.last, &md5) != .lt) return error.BadManifest;
        self.last = md5;
        self.seen += 1;
        if (self.seen > self.header.blobs) return error.BadManifest;
        return md5;
    }
};

/// One line without its `\n`, or null at end of input. A final line with no
/// newline is a truncated write and refused.
fn takeLine(r: *Io.Reader) (Error || Io.Reader.Error)!?[]const u8 {
    const line = r.takeDelimiterInclusive('\n') catch |e| switch (e) {
        error.EndOfStream => {
            if (r.bufferedLen() != 0) return error.BadManifest;
            return null;
        },
        error.StreamTooLong => return error.BadManifest,
        error.ReadFailed => return error.ReadFailed,
    };
    return line[0 .. line.len - 1];
}

// ---- tests ----

const testing = std.testing;

fn sample(w: *Io.Writer, md5s: []const []const u8) !void {
    var h: Header = .{ .schema = 16, .created = 1793761200, .has_cred_key = false, .blobs = md5s.len, .bytes = 1234 };
    h.setInkhold("0.0.0");
    try writeHeader(w, &h);
    for (md5s) |m| try writeMd5(w, m);
}

const a = "00000000000000000000000000000000";
const b = "0123456789abcdef0123456789abcdef";
const c = "ffffffffffffffffffffffffffffffff";

test "a manifest round-trips its header and its blobs in order" {
    var buf: [1024]u8 = undefined;
    var w: Io.Writer = .fixed(&buf);
    try sample(&w, &.{ a, b, c });

    var r: Io.Reader = .fixed(w.buffered());
    var m = try Reader.init(&r);
    try testing.expectEqual(@as(i64, 16), m.header.schema);
    try testing.expectEqual(@as(i64, 1793761200), m.header.created);
    try testing.expectEqual(@as(u64, 3), m.header.blobs);
    try testing.expectEqual(@as(u64, 1234), m.header.bytes);
    try testing.expect(!m.header.has_cred_key);
    try testing.expectEqualStrings("0.0.0", m.header.inkhold());
    try testing.expectEqualStrings(a, &(try m.next()).?);
    try testing.expectEqualStrings(b, &(try m.next()).?);
    try testing.expectEqualStrings(c, &(try m.next()).?);
    try testing.expect(try m.next() == null);
}

test "a truncated manifest never passes as complete" {
    var buf: [1024]u8 = undefined;
    var w: Io.Writer = .fixed(&buf);
    try sample(&w, &.{ a, b, c });
    const whole = w.buffered();

    // Cut after the second md5: the count no longer matches the header.
    const cut = std.mem.indexOf(u8, whole, c).?;
    var r1: Io.Reader = .fixed(whole[0..cut]);
    var m1 = try Reader.init(&r1);
    _ = try m1.next();
    _ = try m1.next();
    try testing.expectError(error.BadManifest, m1.next());

    // Cut mid-line: a partial md5 is refused, not read as the end.
    var r2: Io.Reader = .fixed(whole[0 .. whole.len - 5]);
    var m2 = try Reader.init(&r2);
    _ = try m2.next();
    _ = try m2.next();
    try testing.expectError(error.BadManifest, m2.next());

    // Cut inside the header.
    var r3: Io.Reader = .fixed(whole[0..20]);
    try testing.expectError(error.BadManifest, Reader.init(&r3));
}

test "out-of-order or duplicated md5s are refused" {
    var buf: [1024]u8 = undefined;
    var w: Io.Writer = .fixed(&buf);
    var h: Header = .{ .schema = 16, .created = 0, .has_cred_key = false, .blobs = 2, .bytes = 0 };
    try writeHeader(&w, &h);
    try w.writeAll(b ++ "\n" ++ a ++ "\n");
    var r: Io.Reader = .fixed(w.buffered());
    var m = try Reader.init(&r);
    _ = try m.next();
    try testing.expectError(error.BadManifest, m.next());
}

test "a newer format version is refused rather than misread" {
    var r: Io.Reader = .fixed("inkhold-backup 2\nschema 16\nblobs 0\n--\n");
    try testing.expectError(error.BadManifest, Reader.init(&r));
}

test "unknown header keys from a newer writer are skipped" {
    var r: Io.Reader = .fixed("inkhold-backup 1\nschema 16\nhostname pi\nblobs 0\n--\n");
    var m = try Reader.init(&r);
    try testing.expect(try m.next() == null);
}
