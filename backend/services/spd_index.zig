//! The `.spd` blob index: one parser open at ingest yields the gallery's scalar
//! facts (`spd_index`) and the embedded thumbnail (`thumbs/`).

const std = @import("std");
const repeat = @import("../util/repeat.zig").repeat;
const sqlite = @import("../db/sqlite.zig");
const blobstore = @import("../store/blobs.zig");
const thumbstore = @import("../store/thumbs.zig");
const thumbnail = @import("thumbnail.zig");
/// The `.spd` parser. It deserializes READONLY into `:memory:`, since the file
/// is attacker-supplied; this service is the bounded, best-effort wrapper.
const spd = @import("spd");

const Allocator = std.mem.Allocator;

/// Bump when the stored shape or its derivation changes; stale rows heal
/// per-blob on the next thumbnail request.
pub const index_version: i64 = 1;

/// The row `store` writes. All optional: a `.spd` may omit any config key.
/// `thumb_w`/`thumb_h` are the thumbnail's dims: NULL means none shipped, 0
/// means stored but undecodable (the gallery uses its default aspect).
pub const Row = struct {
    /// False for a blob that is not a parseable `.spd`; recorded so it is not
    /// re-derived on every thumbnail request.
    indexable: bool = false,
    surface_w: ?f32 = null,
    surface_h: ?f32 = null,
    ppi: ?u32 = null,
    vp_x: ?f32 = null,
    vp_y: ?f32 = null,
    app_version: ?[]const u8 = null,
    fmt_ver: ?[]const u8 = null,
    layer_count: u32 = 0,
    thumb_w: ?u32 = null,
    thumb_h: ?u32 = null,
};

/// Owns its memory, free of borrows from the `.spd` bytes, so the large buffer
/// is released before the DB lock is taken. `thumb` is null when none is
/// acceptable.
pub const Derived = struct {
    arena: std.heap.ArenaAllocator,
    row: Row,
    thumb: ?thumbnail.Extracted,

    pub fn deinit(self: *Derived) void {
        self.arena.deinit();
    }
};

// ---------------------------------------------------------------------------
// Derive: pure CPU, called outside the DB lock.
// ---------------------------------------------------------------------------

/// Derives the row and thumbnail for `image`. Bad input becomes
/// `indexable = false`; only allocation fails. A corrupt layer tree keeps the
/// extracted thumbnail: the thumb columns describe the thumbnail.
pub fn derive(gpa: Allocator, image: []const u8) Allocator.Error!Derived {
    var arena = std.heap.ArenaAllocator.init(gpa);
    errdefer arena.deinit();
    const a = arena.allocator();

    var out: Derived = .{ .arena = arena, .row = .{}, .thumb = null };

    // Cheap gate before the parser sees the bytes (it rechecks; defence in depth).
    const magic = thumbnail.sqlite_magic;
    if (image.len < magic.len or !std.mem.eql(u8, image[0..magic.len], magic)) return out;

    var doc = spd.open(gpa, image) catch |e| switch (e) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return out, // not a database / not an .spd / corrupt → a recorded fact
    };
    defer doc.deinit();

    // ---- the thumbnail, off the same open ----
    // Best-effort and bounded; kept even when the metadata below fails.
    thumb: {
        const blob = (doc.thumbnail(gpa) catch |e| switch (e) {
            error.OutOfMemory => return error.OutOfMemory,
            else => break :thumb,
        }) orelse break :thumb;
        defer gpa.free(blob);

        if (blob.len == 0 or blob.len > thumbnail.max_thumbnail_bytes) break :thumb;
        const mime = thumbnail.sniffMime(blob) orelse break :thumb;

        // Undecodable dims are stored as 0, never NULL.
        if (thumbnail.imageDims(blob)) |d| {
            out.row.thumb_w = d.w;
            out.row.thumb_h = d.h;
        } else {
            out.row.thumb_w = 0;
            out.row.thumb_h = 0;
        }
        out.thumb = .{ .mime = mime, .bytes = try a.dupe(u8, blob) };
    }

    // ---- the metadata, same handle ----
    var meta = doc.metadata(gpa) catch |e| switch (e) {
        error.OutOfMemory => return error.OutOfMemory,
        else => {
            out.arena = arena; // re-snapshot: `a` allocated the thumb above
            return out;
        },
    };
    defer meta.deinit();

    out.row.indexable = true;
    out.row.surface_w = meta.width;
    out.row.surface_h = meta.height;
    out.row.ppi = meta.ppi;
    out.row.vp_x = meta.vp_x;
    out.row.vp_y = meta.vp_y;
    out.row.app_version = try dupeOpt(a, meta.app_version);
    out.row.fmt_ver = try dupeOpt(a, meta.fmt_ver);
    out.row.layer_count = @intCast(meta.layers.len);

    out.arena = arena; // moved last: `a` allocations above must precede this
    return out;
}

fn dupeOpt(a: Allocator, v: ?[]const u8) Allocator.Error!?[]const u8 {
    return if (v) |s| try a.dupe(u8, s) else null;
}

/// `derive` for a stored blob, buffered whole (bounded by
/// `thumbnail.max_source_bytes`; `sqlite3_deserialize` needs it contiguous).
/// Null when absent, unreadable or too large. Runs outside the DB lock.
pub fn deriveStored(gpa: Allocator, blobs: blobstore.BlobStore, md5: []const u8) Allocator.Error!?Derived {
    const size = blobs.sizeOf(md5) catch return null;
    if (size == 0 or size > thumbnail.max_source_bytes) return null;

    const buf = try gpa.alloc(u8, @intCast(size));
    defer gpa.free(buf);
    const bytes = blobs.readRange(md5, 0, size, buf) catch return null;
    return try derive(gpa, bytes);
}

// ---------------------------------------------------------------------------
// Write, inside the caller's transaction
// ---------------------------------------------------------------------------

const upsert_sql =
    \\INSERT INTO spd_index(blob_md5, index_version, indexable, indexed_at, surface_w,
    \\                      surface_h, ppi, vp_x, vp_y, app_version, fmt_ver,
    \\                      layer_count, thumb_w, thumb_h)
    \\VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
    \\ON CONFLICT(blob_md5) DO UPDATE SET
    \\  index_version=excluded.index_version, indexable=excluded.indexable,
    \\  indexed_at=excluded.indexed_at, surface_w=excluded.surface_w,
    \\  surface_h=excluded.surface_h, ppi=excluded.ppi, vp_x=excluded.vp_x,
    \\  vp_y=excluded.vp_y, app_version=excluded.app_version,
    \\  fmt_ver=excluded.fmt_ver, layer_count=excluded.layer_count,
    \\  thumb_w=excluded.thumb_w, thumb_h=excluded.thumb_h;
;

/// Upserts `d`'s row. Call inside the caller's transaction; the `blobs` row must
/// exist (FK). Racing derives are wasteful but never a constraint violation.
pub fn store(db: sqlite.Db, blob_md5: []const u8, d: Derived, now: i64) !void {
    try db.run(
        upsert_sql,
        &.{
            .{ .text = blob_md5 },
            .{ .int = index_version },
            .{ .int = if (d.row.indexable) 1 else 0 },
            .{ .int = now },
            .{ .float_opt = widen(d.row.surface_w) },
            .{ .float_opt = widen(d.row.surface_h) },
            .{ .int_opt = widenInt(d.row.ppi) },
            .{ .float_opt = widen(d.row.vp_x) },
            .{ .float_opt = widen(d.row.vp_y) },
            .{ .text_opt = d.row.app_version },
            .{ .text_opt = d.row.fmt_ver },
            .{ .int = d.row.layer_count },
            .{ .int_opt = widenInt(d.row.thumb_w) },
            .{ .int_opt = widenInt(d.row.thumb_h) },
        },
    );
}

/// Zig does not coerce optional payloads implicitly.
fn widen(v: ?f32) ?f64 {
    return if (v) |x| x else null;
}

fn widenInt(v: ?u32) ?i64 {
    return if (v) |x| x else null;
}

/// True when this blob has a row at the current version, so re-ingest of
/// dedup'd content skips the parse and the unindexable marker sticks.
pub fn isCurrent(db: sqlite.Db, blob_md5: []const u8) !bool {
    var s = try db.prepare("SELECT 1 FROM spd_index WHERE blob_md5 = ?1 AND index_version = ?2;");
    defer s.finalize();
    s.bindText(1, blob_md5);
    s.bindInt(2, index_version);
    return try s.step();
}

/// Called inside the blob GC transaction; ON DELETE CASCADE is the backstop.
pub fn deleteForBlob(db: sqlite.Db, blob_md5: []const u8) !void {
    try db.run("DELETE FROM spd_index WHERE blob_md5 = ?1;", &.{.{ .text = blob_md5 }});
}

/// The repair gate: true when no row exists at the current `index_version`, or
/// a current row claims a thumbnail whose `thumbs/` file is gone. A row saying
/// unindexable or no-thumbnail is the memo, so a corrupt `.spd` costs its
/// deserialize once, not on every gallery load.
pub fn needsRepair(db: sqlite.Db, thumbs: thumbstore.ThumbStore, md5: []const u8) !bool {
    var r = (try db.row(
        "SELECT thumb_w IS NOT NULL FROM spd_index WHERE blob_md5 = ?1 AND index_version = ?2;",
        &.{ .{ .text = md5 }, .{ .int = index_version } },
    )) orelse return true; // no current row: derive (and memoize)
    defer r.finalize();
    const claims_thumbnail = r.int(0) != 0;
    return claims_thumbnail and !thumbs.has(md5);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;
const schema = @import("../db/schema.zig");

/// A JPEG-magic stand-in with undecodable dims (`thumb_w = 0`), and a minimal
/// PNG whose IHDR carries 320x240.
const fake_jpeg = "\xff\xd8\xff\xe0" ++ (repeat(u8, "thumbnail-pixels", 4));
const mini_png = "\x89PNG\r\n\x1a\n" ++
    "\x00\x00\x00\x0d" ++ "IHDR" ++
    "\x00\x00\x01\x40" ++ "\x00\x00\x00\xf0" ++ // 320 × 240
    "\x08\x02\x00\x00\x00" ++ (repeat(u8, "p", 16));

/// `ls` is a raw protobuf blob (null = omit).
const SpdSpec = struct {
    thumbnail: ?[]const u8 = null,
    ls: ?[]const u8 = null,
    ppi: ?[]const u8 = null,
    surface_w: ?[]const u8 = null,
    surface_h: ?[]const u8 = null,
    vp_x: ?[]const u8 = null,
    vp_y: ?[]const u8 = null,
};

/// Builds a minimal `.spd` in memory: a SQLite db with a `config` table.
fn buildSpd(gpa: Allocator, spec: SpdSpec) ![]u8 {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try db.exec("CREATE TABLE config(name TEXT PRIMARY KEY NOT NULL, value BLOB);");
    try db.exec("INSERT INTO config(name, value) VALUES('fmt_ver', '2');");
    try db.exec("INSERT INTO config(name, value) VALUES('appVersion', '1.1.78');");

    const put = struct {
        fn kv(d: sqlite.Db, name: []const u8, value: ?[]const u8) !void {
            const v = value orelse return;
            try d.run(
                "INSERT INTO config(name, value) VALUES(?1, ?2);",
                &.{ .{ .text = name }, .{ .blob = v } },
            );
        }
    }.kv;
    try put(db, "thumbnail", spec.thumbnail);
    try put(db, "ls", spec.ls);
    try put(db, "ppi", spec.ppi);
    try put(db, "surface.width", spec.surface_w);
    try put(db, "surface.height", spec.surface_h);
    try put(db, "vp.x", spec.vp_x);
    try put(db, "vp.y", spec.vp_y);
    return db.serializeAlloc(gpa);
}

/// Two-layer `ls` protobuf, copied from the parser's own (unexported) fixture.
const two_layer_ls = blk: {
    const layer_a = [_]u8{ 0x08, 0x01, 0x12, 0x03, 'T', 'o', 'p', 0x40, 0x80, 0x01 };
    const layer_b = [_]u8{ 0x08, 0x8F, 0x4E, 0x12, 0x03, 'R', 'e', 'f', 0x20, 0x00 };
    break :blk [_]u8{ 0x0a, layer_a.len } ++ layer_a ++ [_]u8{ 0x0a, layer_b.len } ++ layer_b;
};

const Fixture = struct {
    db: sqlite.Db,
    thumbs: thumbstore.ThumbStore,
    tmp: testing.TmpDir,

    fn init() !Fixture {
        const db = try sqlite.Db.openMemory();
        try schema.migrate(db);
        const tmp = testing.tmpDir(.{});
        const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
        return .{ .db = db, .thumbs = try thumbstore.ThumbStore.init(testing.io, thumbs_dir), .tmp = tmp };
    }

    fn deinit(f: *Fixture) void {
        f.db.close();
        f.tmp.cleanup();
    }

    fn storeWithBlob(f: *Fixture, md5: []const u8, d: Derived, now: i64) !void {
        try f.db.run(
            "INSERT OR IGNORE INTO blobs(md5, size, refcount, created_at) VALUES(?1, 1, 1, 0);",
            &.{.{ .text = md5 }},
        );
        try store(f.db, md5, d, now);
    }
};

test "derive + store round-trips every column, layer_count 2, PNG thumb dims" {
    const gpa = testing.allocator;
    var f = try Fixture.init();
    defer f.deinit();

    const bytes = try buildSpd(gpa, .{
        .thumbnail = mini_png,
        .ls = &two_layer_ls,
        .ppi = "72",
        .surface_w = "1404.0",
        .surface_h = "1872.0",
        .vp_x = "-10.5",
        .vp_y = "3.25",
    });
    defer gpa.free(bytes);

    var d = try derive(gpa, bytes);
    defer d.deinit();
    try testing.expect(d.row.indexable);
    try testing.expectEqual(@as(u32, 2), d.row.layer_count);
    try testing.expectEqual(@as(?u32, 320), d.row.thumb_w);
    try testing.expectEqual(@as(?u32, 240), d.row.thumb_h);
    try testing.expectEqualStrings("image/png", d.thumb.?.mime);
    try testing.expectEqualSlices(u8, mini_png, d.thumb.?.bytes);

    const md5 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    try f.storeWithBlob(md5, d, 42);

    var s = try f.db.prepare(
        "SELECT index_version, indexable, indexed_at, surface_w, surface_h, ppi, " ++
            "vp_x, vp_y, app_version, fmt_ver, layer_count, thumb_w, thumb_h " ++
            "FROM spd_index WHERE blob_md5 = ?1;",
    );
    defer s.finalize();
    s.bindText(1, md5);
    try testing.expect(try s.step());
    try testing.expectEqual(index_version, s.columnInt(0));
    try testing.expectEqual(@as(i64, 1), s.columnInt(1));
    try testing.expectEqual(@as(i64, 42), s.columnInt(2));
    try testing.expectEqual(@as(f64, 1404.0), s.columnFloat(3));
    try testing.expectEqual(@as(f64, 1872.0), s.columnFloat(4));
    try testing.expectEqual(@as(i64, 72), s.columnInt(5));
    try testing.expectEqual(@as(f64, -10.5), s.columnFloat(6));
    try testing.expectEqual(@as(f64, 3.25), s.columnFloat(7));
    try testing.expectEqualStrings("1.1.78", s.columnText(8));
    try testing.expectEqualStrings("2", s.columnText(9));
    try testing.expectEqual(@as(i64, 2), s.columnInt(10));
    try testing.expectEqual(@as(i64, 320), s.columnInt(11));
    try testing.expectEqual(@as(i64, 240), s.columnInt(12));

    try testing.expect(try isCurrent(f.db, md5));
}

test "a .spd with no thumbnail stores NULL thumb dims; undecodable dims store 0" {
    const gpa = testing.allocator;
    var f = try Fixture.init();
    defer f.deinit();

    {
        const bytes = try buildSpd(gpa, .{});
        defer gpa.free(bytes);
        var d = try derive(gpa, bytes);
        defer d.deinit();
        try testing.expect(d.row.indexable);
        try testing.expect(d.thumb == null);
        try testing.expect(d.row.thumb_w == null);

        const md5 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        try f.storeWithBlob(md5, d, 0);
        var s = try f.db.prepare("SELECT thumb_w IS NULL FROM spd_index WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, md5);
        try testing.expect(try s.step());
        try testing.expectEqual(@as(i64, 1), s.columnInt(0));
    }

    {
        const bytes = try buildSpd(gpa, .{ .thumbnail = fake_jpeg });
        defer gpa.free(bytes);
        var d = try derive(gpa, bytes);
        defer d.deinit();
        try testing.expectEqualStrings("image/jpeg", d.thumb.?.mime);
        try testing.expectEqual(@as(?u32, 0), d.row.thumb_w);
        try testing.expectEqual(@as(?u32, 0), d.row.thumb_h);
    }
}

test "a corrupt ls protobuf records indexable = 0 but KEEPS the thumbnail dims" {
    const gpa = testing.allocator;

    // A layer claiming a 20-byte length inside a 4-byte body.
    const bad_ls = [_]u8{ 0x0a, 0x14, 0x08, 0x01 };
    const bytes = try buildSpd(gpa, .{ .thumbnail = mini_png, .ls = &bad_ls });
    defer gpa.free(bytes);

    var d = try derive(gpa, bytes);
    defer d.deinit();
    try testing.expect(!d.row.indexable); // the layer tree is corrupt: a fact
    try testing.expectEqual(@as(u32, 0), d.row.layer_count);
    // The thumbnail rode the same open and must survive.
    try testing.expect(d.thumb != null);
    try testing.expectEqual(@as(?u32, 320), d.row.thumb_w);
    try testing.expectEqual(@as(?u32, 240), d.row.thumb_h);
}

test "non-SQLite / corrupt / empty bytes derive as indexable = 0, never an error" {
    const gpa = testing.allocator;

    for ([_][]const u8{
        "this is definitely not sqlite",
        "",
        "SQLite format 3", // 15 bytes: magic truncated
        thumbnail.sqlite_magic ++ (repeat(u8, "\x00", 64)), // header-valid, body garbage
    }) |bytes| {
        var d = try derive(gpa, bytes);
        defer d.deinit();
        try testing.expect(!d.row.indexable);
        try testing.expect(d.thumb == null);
        try testing.expect(d.row.thumb_w == null);
    }

    const bytes = try buildSpd(gpa, .{ .thumbnail = fake_jpeg });
    defer gpa.free(bytes);
    if (bytes.len > 200) @memset(bytes[100..200], 0xAB);
    var d = try derive(gpa, bytes);
    d.deinit();
}

test "an oversized or non-image thumbnail blob is refused (no thumb, dims NULL)" {
    const gpa = testing.allocator;

    {
        const huge = try gpa.alloc(u8, thumbnail.max_thumbnail_bytes + 1);
        defer gpa.free(huge);
        @memset(huge, 0);
        huge[0] = 0xFF;
        huge[1] = 0xD8;
        huge[2] = 0xFF;
        const bytes = try buildSpd(gpa, .{ .thumbnail = huge });
        defer gpa.free(bytes);
        var d = try derive(gpa, bytes);
        defer d.deinit();
        try testing.expect(d.row.indexable); // the drawing itself is fine
        try testing.expect(d.thumb == null);
        try testing.expect(d.row.thumb_w == null);
    }

    {
        const bytes = try buildSpd(gpa, .{ .thumbnail = "just some bytes, not an image at all" });
        defer gpa.free(bytes);
        var d = try derive(gpa, bytes);
        defer d.deinit();
        try testing.expect(d.thumb == null);
        try testing.expect(d.row.thumb_w == null);
    }
}

test "isCurrent goes false after a version bump; deleteForBlob drops the row" {
    const gpa = testing.allocator;
    var f = try Fixture.init();
    defer f.deinit();

    const bytes = try buildSpd(gpa, .{ .thumbnail = fake_jpeg });
    defer gpa.free(bytes);
    var d = try derive(gpa, bytes);
    defer d.deinit();

    const md5 = "cccccccccccccccccccccccccccccccc";
    try f.storeWithBlob(md5, d, 0);
    try testing.expect(try isCurrent(f.db, md5));

    try f.db.exec("UPDATE spd_index SET index_version = 0;");
    try testing.expect(!try isCurrent(f.db, md5));

    try store(f.db, md5, d, 1); // the upsert repairs it in place
    try testing.expect(try isCurrent(f.db, md5));

    try deleteForBlob(f.db, md5);
    try testing.expect(!try isCurrent(f.db, md5));
}

test "needsRepair: missing/stale row or a lost thumbs file, but NEVER a memoized 404" {
    const gpa = testing.allocator;
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = "dddddddddddddddddddddddddddddddd";

    try testing.expect(try needsRepair(f.db, f.thumbs, md5));

    const bytes = try buildSpd(gpa, .{ .thumbnail = fake_jpeg });
    defer gpa.free(bytes);
    var d = try derive(gpa, bytes);
    defer d.deinit();
    try f.storeWithBlob(md5, d, 0);
    try f.thumbs.put(md5, d.thumb.?.bytes);
    try testing.expect(!try needsRepair(f.db, f.thumbs, md5));

    f.thumbs.remove(md5);
    try testing.expect(try needsRepair(f.db, f.thumbs, md5));

    try f.thumbs.put(md5, d.thumb.?.bytes);
    try f.db.exec("UPDATE spd_index SET index_version = 0;");
    try testing.expect(try needsRepair(f.db, f.thumbs, md5));
    try f.db.exec("UPDATE spd_index SET index_version = 1;");

    // A current row claiming no thumbnail is a memoized 404.
    try f.db.exec("UPDATE spd_index SET thumb_w = NULL, thumb_h = NULL, indexable = 0;");
    f.thumbs.remove(md5);
    try testing.expect(!try needsRepair(f.db, f.thumbs, md5));
}
