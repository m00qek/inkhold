//! The `.spd` blob index: open the SQLite drawing once, at ingest, and keep the
//! scalar facts the gallery needs in the `spd_index` table — while the SAME
//! parser open lifts the embedded thumbnail out into the `thumbs/` derived
//! store. See for the design.
//!
//! ## Two halves, on purpose (the `note_index` shape)
//!
//! `derive` is **pure CPU and touches no database**; `store` writes the row and
//! must run inside the caller's transaction. Same structural constraint as
//! `note_index`: `upload/finish` runs under the whole-handler global DB lock,
//! so the SQLite deserialize + reads happen before `BEGIN`, unlocked.
//!
//! ## One parser open, both extractions
//!
//! `derive` calls `spd.open` ONCE and reads `metadata()` and `thumbnail()` off
//! the same handle — the metadata rides the open the thumbnail already paid
//! for. Every parser error except `Allocator.Error` maps to `indexable = 0`, a
//! recorded fact rather than an error (mirroring `note_index.parseBlobSource`),
//! so hostile input is derived once and memoized, never retried forever.
//! **`thumb_w`/`thumb_h` still populate whenever a thumbnail was extracted,
//! independent of `indexable`** — they describe the thumbnail, not the layer
//! tree, and a corrupt `ls` protobuf must not blind the masonry layout.
//!
//! ## Self-healing is ON-DEMAND, not a boot backfill
//!
//! There is no startup sweep. The `/thumbnail/{hash}` serve path repairs on
//! miss (`Files.repairDerivedThumb`, which dispatches here when the blob's own
//! magic is SQLite), gated by `needsRepair` — the row is the memo, so a
//! current row saying "not parseable" or "ships no thumbnail" serves 404
//! WITHOUT re-deriving. An `index_version` bump, a pre-v13 database, and a
//! lost `thumbs/` file all heal per-blob on next request.
//!
//! ## Keyed by blob md5
//!
//! Blobs are content-addressed and immutable, so a row can never be stale, and
//! it is shared by every file that dedups onto the same content. Rows are NOT
//! per-user; ownership is enforced at read time through `files` (`holdsBlob`).

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const blobstore = @import("../store/blobs.zig");
const thumbstore = @import("../store/thumbs.zig");
const thumbnail = @import("thumbnail.zig");
/// The single `.spd` parser (`parsers/spd`), wired in natively via the root
/// `build.zig`. It owns the SQLite deserialize (READONLY into `:memory:` — the
/// file is attacker-supplied), the WAL-header rewrite, and every `config` read;
/// this service is the bounded, best-effort safety wrapper around it.
const spd = @import("spd");

const Allocator = std.mem.Allocator;

/// Bump when the stored shape or its derivation changes: rows at an older
/// version are re-derived by the on-demand repair the next time a thumbnail is
/// requested (there is no sweep — healing is per-blob, on read).
///
/// - **1** → the original shape.
pub const index_version: i64 = 1;

/// The row `store` writes — the config scalars plus the thumbnail's pixel dims.
/// Field types follow `spd.Metadata` (`ppi: ?u32`, dims `?f32`); every one is
/// optional because a `.spd` may legitimately omit any given config key.
///
/// `thumb_w`/`thumb_h` are the THUMBNAIL's dims, not the surface's: NULL means
/// the source ships no thumbnail; 0 means one was stored but its dimensions
/// could not be decoded (WebP/GIF, or a hostile header) — the masonry gallery
/// falls back to its default aspect for 0.
pub const Row = struct {
    /// False when the blob is not a parseable `.spd`. Recorded explicitly so
    /// other file types living in the tree are not re-derived on every
    /// thumbnail request forever.
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

/// Everything `store` (and the thumbs write) needs, owning its own memory —
/// deliberately free of any borrow from the `.spd` bytes, so the (large)
/// buffer can be released before the DB lock is taken. `thumb` is the
/// extracted, cap/sniff-validated thumbnail, arena-owned; null when the source
/// ships none we can accept.
pub const Derived = struct {
    arena: std.heap.ArenaAllocator,
    row: Row,
    thumb: ?thumbnail.Extracted,

    pub fn deinit(self: *Derived) void {
        self.arena.deinit();
    }
};

// ---------------------------------------------------------------------------
// Derive — pure CPU. MUST be called outside the DB lock.
// ---------------------------------------------------------------------------

/// Derives the index row + thumbnail for `image`. Never fails on bad input:
/// anything that does not open or parse comes back as `indexable = false` — a
/// recorded fact rather than an error. Only allocation can fail.
///
/// ONE `spd.open` behind the `sqlite_magic` pre-check; the thumbnail is read
/// off the same handle and passed through the service caps
/// (`max_thumbnail_bytes`), the MIME sniff, and `imageDims`. A corrupt layer
/// tree (`metadata` fails) still keeps whatever thumbnail was extracted — the
/// thumb columns describe the thumbnail, not the layer tree.
pub fn derive(gpa: Allocator, image: []const u8) Allocator.Error!Derived {
    var arena = std.heap.ArenaAllocator.init(gpa);
    errdefer arena.deinit();
    const a = arena.allocator();

    var out: Derived = .{ .arena = arena, .row = .{}, .thumb = null };

    // Cheap gate BEFORE the parser sees the bytes: obvious non-databases are
    // refused here rather than handed to a more permissive general library.
    // (The parser rechecks this magic; keeping the pre-check is defence in
    // depth, and the 16 MiB `max_source_bytes` cap upstream already bounded
    // what we buffer.)
    const magic = thumbnail.sqlite_magic;
    if (image.len < magic.len or !std.mem.eql(u8, image[0..magic.len], magic)) return out;

    var doc = spd.open(gpa, image) catch |e| switch (e) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return out, // not a database / not an .spd / corrupt → a recorded fact
    };
    defer doc.deinit();

    // ---- the thumbnail, off the same open ----
    // Best-effort and bounded: an oversized or non-image blob is "no
    // thumbnail", and the parser's copy is freed on the way out so a rejected
    // blob never leaks. Kept even when the metadata below fails.
    thumb: {
        const blob = (doc.thumbnail(gpa) catch |e| switch (e) {
            error.OutOfMemory => return error.OutOfMemory,
            else => break :thumb,
        }) orelse break :thumb;
        defer gpa.free(blob);

        if (blob.len == 0 or blob.len > thumbnail.max_thumbnail_bytes) break :thumb;
        const mime = thumbnail.sniffMime(blob) orelse break :thumb;

        // NULL vs 0 is the column contract: dims we could not decode are stored
        // as 0 ("thumbnail exists, aspect unknown"), never left NULL.
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
    // A failure here (a corrupt `ls` protobuf, a half-truncated db) records
    // `indexable = 0` but keeps the thumbnail extracted above.
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

/// `derive` for a blob already in the store: buffers it whole (bounded by
/// `thumbnail.max_source_bytes` — `sqlite3_deserialize` needs the image
/// contiguous) and derives. Null when the blob is absent, unreadable, or too
/// large to buffer — best-effort, the caller must never fail an upload (or a
/// repair) over a preview. Runs OUTSIDE the DB lock/transaction by contract.
pub fn deriveStored(gpa: Allocator, blobs: blobstore.BlobStore, md5: []const u8) Allocator.Error!?Derived {
    const size = blobs.sizeOf(md5) catch return null;
    if (size == 0 or size > thumbnail.max_source_bytes) return null;

    const buf = try gpa.alloc(u8, @intCast(size));
    defer gpa.free(buf);
    const bytes = blobs.readRange(md5, 0, size, buf) catch return null;
    return try derive(gpa, bytes);
}

// ---------------------------------------------------------------------------
// Write — inside the caller's transaction.
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

/// Writes `d`'s row for `blob_md5`. Call inside the caller's transaction (the
/// `blobs` row must already exist — the FK ties index lifetime to blob
/// lifetime). Upsert, so two racing derives of the same blob are wasteful but
/// never a constraint violation.
pub fn store(db: sqlite.Db, blob_md5: []const u8, d: Derived, now: i64) !void {
    var s = try db.prepare(upsert_sql);
    defer s.finalize();
    s.bindText(1, blob_md5);
    s.bindInt(2, index_version);
    s.bindInt(3, if (d.row.indexable) 1 else 0);
    s.bindInt(4, now);
    s.bindFloatOpt(5, widen(d.row.surface_w));
    s.bindFloatOpt(6, widen(d.row.surface_h));
    s.bindIntOpt(7, widenInt(d.row.ppi));
    s.bindFloatOpt(8, widen(d.row.vp_x));
    s.bindFloatOpt(9, widen(d.row.vp_y));
    s.bindTextOpt(10, d.row.app_version);
    s.bindTextOpt(11, d.row.fmt_ver);
    s.bindInt(12, d.row.layer_count);
    s.bindIntOpt(13, widenInt(d.row.thumb_w));
    s.bindIntOpt(14, widenInt(d.row.thumb_h));
    _ = try s.step();
}

/// `?f32` → `?f64` for the bind (SQLite's REAL is a double; the widening is
/// lossless, but Zig does not coerce optional payloads implicitly).
fn widen(v: ?f32) ?f64 {
    return if (v) |x| x else null;
}

/// `?u32` → `?i64`, same reason.
fn widenInt(v: ?u32) ?i64 {
    return if (v) |x| x else null;
}

/// True when this blob already has an index row at the CURRENT version — the
/// cheap gate that keeps re-ingest of dedup'd content from re-opening the same
/// `.spd`, and that makes the unindexable marker stick instead of retrying
/// forever.
pub fn isCurrent(db: sqlite.Db, blob_md5: []const u8) !bool {
    var s = try db.prepare("SELECT 1 FROM spd_index WHERE blob_md5 = ?1 AND index_version = ?2;");
    defer s.finalize();
    s.bindText(1, blob_md5);
    s.bindInt(2, index_version);
    return try s.step();
}

/// Drops a blob's index row. Called from the blob GC path *inside its
/// transaction*; the schema's ON DELETE CASCADE is the structural backstop,
/// this is the explicit statement of intent (and works with FKs off).
pub fn deleteForBlob(db: sqlite.Db, blob_md5: []const u8) !void {
    var s = try db.prepare("DELETE FROM spd_index WHERE blob_md5 = ?1;");
    defer s.finalize();
    s.bindText(1, blob_md5);
    _ = try s.step();
}

/// The no-retry repair gate, in one place (decision 7 of the plan). True when
/// the serve path should re-derive:
///   - no row at the current `index_version` (missing, or stale after a bump) —
///     a pre-v13 database and a never-derived blob both land here;
///   - a current row CLAIMS a thumbnail (`thumb_w IS NOT NULL`) but the
///     `thumbs/` file is gone (a backup restore that skipped the derived dir).
/// False otherwise — in particular for a current row saying `indexable = 0` or
/// "ships no thumbnail" (`thumb_w IS NULL`): the row is the memo, so a corrupt
/// `.spd` costs its 16 MiB deserialize ONCE, not on every gallery load.
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

/// A JPEG-magic stand-in plus filler (no real frame header → dims undecodable,
/// exercising the `thumb_w = 0` contract), and a real minimal PNG whose IHDR
/// carries 320×240 (dims decodable).
const fake_jpeg = "\xff\xd8\xff\xe0" ++ ("thumbnail-pixels" ** 4);
const mini_png = "\x89PNG\r\n\x1a\n" ++
    "\x00\x00\x00\x0d" ++ "IHDR" ++
    "\x00\x00\x01\x40" ++ "\x00\x00\x00\xf0" ++ // 320 × 240
    "\x08\x02\x00\x00\x00" ++ ("p" ** 16);

/// What the `.spd` fixture carries beyond the thumbnail. Mirrors the real keys
/// (`spd-format.md`); `ls` is a raw protobuf blob (null = omit).
const SpdSpec = struct {
    thumbnail: ?[]const u8 = null,
    ls: ?[]const u8 = null,
    ppi: ?[]const u8 = null,
    surface_w: ?[]const u8 = null,
    surface_h: ?[]const u8 = null,
    vp_x: ?[]const u8 = null,
    vp_y: ?[]const u8 = null,
};

/// Builds a minimal `.spd`: an in-memory SQLite db with a `config(name, value)`
/// table, serialized to bytes. Hermetic — no committed binary, no on-disk file.
fn buildSpd(gpa: Allocator, spec: SpdSpec) ![]u8 {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try db.exec("CREATE TABLE config(name TEXT PRIMARY KEY NOT NULL, value BLOB);");
    try db.exec("INSERT INTO config(name, value) VALUES('fmt_ver', '2');");
    try db.exec("INSERT INTO config(name, value) VALUES('appVersion', '1.1.78');");

    const put = struct {
        fn kv(d: sqlite.Db, name: []const u8, value: ?[]const u8) !void {
            const v = value orelse return;
            var s = try d.prepare("INSERT INTO config(name, value) VALUES(?1, ?2);");
            defer s.finalize();
            s.bindText(1, name);
            s.bindBlob(2, v);
            _ = try s.step();
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

/// A hand-built two-layer `ls` protobuf — {id=1 "Top" opacity=128} above
/// {id=9999 "Ref" hidden}. Duplicated from the parser's own fixture
/// (parsers/spd/src/spd.zig, "parseLayerTree reads a hand-built two-layer
/// tree") because those inline bytes are not exported.
const two_layer_ls = blk: {
    const layer_a = [_]u8{ 0x08, 0x01, 0x12, 0x03, 'T', 'o', 'p', 0x40, 0x80, 0x01 };
    const layer_b = [_]u8{ 0x08, 0x8F, 0x4E, 0x12, 0x03, 'R', 'e', 'f', 0x20, 0x00 };
    break :blk [_]u8{ 0x0a, layer_a.len } ++ layer_a ++ [_]u8{ 0x0a, layer_b.len } ++ layer_b;
};

/// A migrated in-memory db + a thumbs store on a temp dir — everything the
/// derive/store/repair cycle touches, without the full `Files` service.
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

    /// Inserts the `blobs` row (the FK) and stores `d` under `md5`.
    fn storeWithBlob(f: *Fixture, md5: []const u8, d: Derived, now: i64) !void {
        var s = try f.db.prepare("INSERT OR IGNORE INTO blobs(md5, size, refcount, created_at) VALUES(?1, 1, 1, 0);");
        defer s.finalize();
        s.bindText(1, md5);
        _ = try s.step();
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

    // No thumbnail key at all → thumb NULL (the "source ships none" fact).
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

    // A sniffable JPEG whose dims cannot be decoded → 0/0, thumbnail kept.
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

    // A layer submessage claiming a 20-byte length inside a 4-byte body — the
    // parser's own malformed-tree fixture.
    const bad_ls = [_]u8{ 0x0a, 0x14, 0x08, 0x01 };
    const bytes = try buildSpd(gpa, .{ .thumbnail = mini_png, .ls = &bad_ls });
    defer gpa.free(bytes);

    var d = try derive(gpa, bytes);
    defer d.deinit();
    try testing.expect(!d.row.indexable); // the layer tree is corrupt: a fact
    try testing.expectEqual(@as(u32, 0), d.row.layer_count);
    // ... but the thumbnail rode the same open and must not be blinded.
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
        thumbnail.sqlite_magic ++ ("\x00" ** 64), // header-valid, body garbage
    }) |bytes| {
        var d = try derive(gpa, bytes);
        defer d.deinit();
        try testing.expect(!d.row.indexable);
        try testing.expect(d.thumb == null);
        try testing.expect(d.row.thumb_w == null);
    }

    // A real `.spd`, then corrupted mid-file: still a recorded fact, no crash.
    const bytes = try buildSpd(gpa, .{ .thumbnail = fake_jpeg });
    defer gpa.free(bytes);
    if (bytes.len > 200) @memset(bytes[100..200], 0xAB);
    var d = try derive(gpa, bytes);
    d.deinit();
}

test "an oversized or non-image thumbnail blob is refused (no thumb, dims NULL)" {
    const gpa = testing.allocator;

    // Oversized: valid JPEG magic, one byte over the cap.
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

    // Not a recognisable image: no thumbnail, not a wrong Content-Type.
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

    // Simulate a version bump: the stored row is now stale.
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

    // No row at all → repair (the pre-v13 / never-derived case).
    try testing.expect(try needsRepair(f.db, f.thumbs, md5));

    // A current row claiming a thumbnail, file present → no repair.
    const bytes = try buildSpd(gpa, .{ .thumbnail = fake_jpeg });
    defer gpa.free(bytes);
    var d = try derive(gpa, bytes);
    defer d.deinit();
    try f.storeWithBlob(md5, d, 0);
    try f.thumbs.put(md5, d.thumb.?.bytes);
    try testing.expect(!try needsRepair(f.db, f.thumbs, md5));

    // File lost (a backup restore without thumbs/) → repair.
    f.thumbs.remove(md5);
    try testing.expect(try needsRepair(f.db, f.thumbs, md5));

    // Stale index_version → repair even with the file present.
    try f.thumbs.put(md5, d.thumb.?.bytes);
    try f.db.exec("UPDATE spd_index SET index_version = 0;");
    try testing.expect(try needsRepair(f.db, f.thumbs, md5));
    try f.db.exec("UPDATE spd_index SET index_version = 1;");

    // The no-retry gate: a current row with NO thumbnail claimed (a corrupt
    // `.spd`, or one that ships none) is a memoized 404 — no re-derive.
    try f.db.exec("UPDATE spd_index SET thumb_w = NULL, thumb_h = NULL, indexable = 0;");
    f.thumbs.remove(md5);
    try testing.expect(!try needsRepair(f.db, f.thumbs, md5));
}
