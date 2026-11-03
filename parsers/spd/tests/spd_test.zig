//! Integration tests for the `.spd` parser: the real-device fixture
//! `layers_hidden.spd` (synthetic content), plus databases built in-test with
//! `sqlite3_serialize` for the hardening cases.

const std = @import("std");
const spd = @import("spd");
const c = spd.sqlite.c;

const layers_hidden = @embedFile("fixtures/layers_hidden.spd");

// ---- the `tid` gate ----
// `surface_2`'s tiles form an asymmetric box under the verified mapping, so
// reverting to the transpose swaps the extents and fails.
test "tid gate: real file decodes to the verified high=x / low12=y mapping" {
    const gpa = std.testing.allocator;
    var doc = try spd.open(gpa, layers_hidden);
    defer doc.deinit();

    var it = try doc.iterateLayer(2);
    defer it.deinit();

    var n: usize = 0;
    var min_x: u32 = std.math.maxInt(u32);
    var max_x: u32 = 0;
    var min_y: u16 = std.math.maxInt(u16);
    var max_y: u16 = 0;
    while (try it.next()) |tile| {
        n += 1;
        min_x = @min(min_x, tile.x);
        max_x = @max(max_x, tile.x);
        min_y = @min(min_y, tile.y);
        max_y = @max(max_y, tile.y);
        try std.testing.expect(std.mem.startsWith(u8, tile.png, "\x89PNG\r\n\x1a\n"));
    }

    try std.testing.expectEqual(@as(usize, 6), n);
    try std.testing.expectEqual(@as(u32, 1950), min_x);
    try std.testing.expectEqual(@as(u32, 1951), max_x);
    try std.testing.expectEqual(@as(u16, 1948), min_y);
    try std.testing.expectEqual(@as(u16, 1950), max_y);

    try std.testing.expect((max_x - min_x) != (max_y - min_y));
}

test "real file: metadata scalars and the Z-ordered layer tree" {
    const gpa = std.testing.allocator;
    var doc = try spd.open(gpa, layers_hidden);
    defer doc.deinit();

    var meta = try doc.metadata(gpa);
    defer meta.deinit();

    try std.testing.expectEqualStrings("2", meta.fmt_ver.?);
    try std.testing.expectEqualStrings("1.1.82", meta.app_version.?);
    try std.testing.expectEqual(@as(u32, 72), meta.ppi.?);
    try std.testing.expectApproxEqAbs(@as(f32, 1404.0), meta.width.?, 0.01);
    try std.testing.expectApproxEqAbs(@as(f32, 1872.0), meta.height.?, 0.01);
    try std.testing.expectApproxEqAbs(@as(f32, 249984.0), meta.vp_x.?, 0.01);
    try std.testing.expectApproxEqAbs(@as(f32, 249984.0), meta.vp_y.?, 0.01);

    // Z-order, topmost first; Layer 2 is hidden, Layer 3 semi-transparent.
    try std.testing.expectEqual(@as(usize, 4), meta.layers.len);
    const expect = [_]struct { id: i32, name: []const u8, vis: bool, op: u8 }{
        .{ .id = 3, .name = "Layer 3", .vis = true, .op = 102 }, // ~40% opacity
        .{ .id = 2, .name = "Layer 2", .vis = false, .op = 255 }, // hidden
        .{ .id = 1, .name = "Layer 1", .vis = true, .op = 255 },
        .{ .id = 9999, .name = "Reference Layer", .vis = true, .op = 255 },
    };
    for (expect, meta.layers) |e, got| {
        try std.testing.expectEqual(e.id, got.id);
        try std.testing.expectEqualStrings(e.name, got.name);
        try std.testing.expectEqual(e.vis, got.visible);
        try std.testing.expectEqual(e.op, got.opacity);
    }
    try std.testing.expect(meta.layers[3].isReference());
}

test "real file: thumbnail extraction yields the embedded JPEG" {
    const gpa = std.testing.allocator;
    var doc = try spd.open(gpa, layers_hidden);
    defer doc.deinit();

    const thumb = (try doc.thumbnail(gpa)) orelse return error.TestExpectedThumbnail;
    defer gpa.free(thumb);

    // TEXT affinity would have truncated this via column_text.
    try std.testing.expect(thumb.len > 10_000);
    try std.testing.expect(std.mem.startsWith(u8, thumb, "\xff\xd8\xff\xe0"));
    try std.testing.expectEqualStrings("JFIF", thumb[6..10]);
}

test "real file: the empty reference layer yields zero tiles, not an error" {
    const gpa = std.testing.allocator;
    var doc = try spd.open(gpa, layers_hidden);
    defer doc.deinit();

    var it = try doc.iterateLayer(spd.reference_layer_id);
    defer it.deinit();
    try std.testing.expectEqual(@as(?spd.Tile, null), try it.next());
}

// ---- hardening: hermetic synthetic databases ----

test "open rejects a non-SQLite blob" {
    try std.testing.expectError(error.NotSqlite, spd.open(std.testing.allocator, "not a database at all"));
}

test "open rejects a too-short blob" {
    try std.testing.expectError(error.NotSqlite, spd.open(std.testing.allocator, "SQLite"));
}

test "open rejects a valid SQLite database that is not an .spd" {
    const gpa = std.testing.allocator;
    const db = openWritable();
    exec(db, "CREATE TABLE something_else(x);");
    const bytes = try serialize(gpa, db);
    defer gpa.free(bytes);
    _ = c.sqlite3_close(db);

    try std.testing.expectError(error.NotSpd, spd.open(gpa, bytes));
}

test "open reports a header-valid but truncated database as Corrupt" {
    const gpa = std.testing.allocator;
    const db = openWritable();
    exec(db, "CREATE TABLE config(name TEXT PRIMARY KEY, value BLOB);");
    // Spill past the first page so truncation severs the b-tree.
    exec(db, "WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i<400) " ++
        "INSERT INTO config SELECT 'k'||i, zeroblob(64) FROM s;");
    const bytes = try serialize(gpa, db);
    defer gpa.free(bytes);
    _ = c.sqlite3_close(db);

    // The header still claims the original page count, so reading faults.
    const truncated = bytes[0 .. bytes.len / 2];
    try std.testing.expectError(error.Corrupt, spd.open(gpa, truncated));
}

test "malformed protobuf ls (truncated length) is surfaced, not a silent empty tree" {
    const gpa = std.testing.allocator;
    const db = openWritable();
    exec(db, "CREATE TABLE config(name TEXT PRIMARY KEY, value BLOB);");
    insertConfigBlob(db, "ls", &[_]u8{ 0x0a, 0x14, 0x08, 0x01 });
    const bytes = try serialize(gpa, db);
    defer gpa.free(bytes);
    _ = c.sqlite3_close(db);

    var doc = try spd.open(gpa, bytes);
    defer doc.deinit();
    try std.testing.expectError(error.Malformed, doc.metadata(gpa));
}

test "malformed protobuf ls (over-long varint) errors instead of panicking" {
    const gpa = std.testing.allocator;
    const db = openWritable();
    exec(db, "CREATE TABLE config(name TEXT PRIMARY KEY, value BLOB);");
    const ls = [_]u8{ 0x0a, 0x0b, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80 };
    insertConfigBlob(db, "ls", &ls);
    const bytes = try serialize(gpa, db);
    defer gpa.free(bytes);
    _ = c.sqlite3_close(db);

    var doc = try spd.open(gpa, bytes);
    defer doc.deinit();
    try std.testing.expectError(error.VarintOverflow, doc.metadata(gpa));
}

test "the read-only guarantee: a parse cannot modify the input database" {
    const gpa = std.testing.allocator;
    const db = openWritable();
    exec(db, "CREATE TABLE config(name TEXT PRIMARY KEY, value BLOB);");
    insertConfigText(db, "fmt_ver", "2");
    const bytes = try serialize(gpa, db);
    defer gpa.free(bytes);
    _ = c.sqlite3_close(db);

    const before = try gpa.dupe(u8, bytes);
    defer gpa.free(before);

    var doc = try spd.open(gpa, bytes);
    defer doc.deinit();

    const rc = c.sqlite3_exec(doc.db, "UPDATE config SET value='x' WHERE name='fmt_ver'", null, null, null);
    try std.testing.expect(rc == c.SQLITE_READONLY);

    try std.testing.expectEqualSlices(u8, before, bytes);
}

test "round-trip: metadata, layer tree, tiles, and thumbnail on a synthetic .spd" {
    const gpa = std.testing.allocator;
    const db = openWritable();
    exec(db, "CREATE TABLE config(name TEXT PRIMARY KEY, value BLOB);");
    insertConfigText(db, "fmt_ver", "2");
    insertConfigText(db, "surface.width", "1404.0");
    insertConfigText(db, "vp.x", "249984.0");
    insertConfigBlob(db, "thumbnail", "\xff\xd8\xff\xe0JFIFthumb");

    const layer1 = [_]u8{ 0x08, 0x01, 0x12, 0x07, 'L', 'a', 'y', 'e', 'r', ' ', '1' };
    const layer_ref = [_]u8{ 0x08, 0x8F, 0x4E, 0x12, 0x0F } ++ "Reference Layer".*;
    var ls: std.ArrayList(u8) = .empty;
    defer ls.deinit(gpa);
    try ls.append(gpa, 0x0a);
    try ls.append(gpa, @intCast(layer1.len));
    try ls.appendSlice(gpa, &layer1);
    try ls.append(gpa, 0x0a);
    try ls.append(gpa, @intCast(layer_ref.len));
    try ls.appendSlice(gpa, &layer_ref);
    insertConfigBlob(db, "ls", ls.items);

    exec(db, "CREATE TABLE surface_1(tid INTEGER PRIMARY KEY, tile BLOB) WITHOUT ROWID;");
    insertTile(db, spd.packTid(5, 3), "\x89PNG\r\n\x1a\nFAKE");

    const bytes = try serialize(gpa, db);
    defer gpa.free(bytes);
    _ = c.sqlite3_close(db);

    var doc = try spd.open(gpa, bytes);
    defer doc.deinit();

    var meta = try doc.metadata(gpa);
    defer meta.deinit();
    try std.testing.expectEqualStrings("2", meta.fmt_ver.?);
    try std.testing.expectApproxEqAbs(@as(f32, 1404.0), meta.width.?, 0.01);
    try std.testing.expectEqual(@as(?[]const u8, null), meta.app_version); // absent stays null
    try std.testing.expectEqual(@as(usize, 2), meta.layers.len);
    try std.testing.expectEqualStrings("Layer 1", meta.layers[0].name);
    try std.testing.expect(meta.layers[1].isReference());

    const thumb = (try doc.thumbnail(gpa)).?;
    defer gpa.free(thumb);
    try std.testing.expectEqualStrings("\xff\xd8\xff\xe0JFIFthumb", thumb);

    var it = try doc.iterateLayer(1);
    defer it.deinit();
    const tile = (try it.next()).?;
    try std.testing.expectEqual(@as(u32, 5), tile.x);
    try std.testing.expectEqual(@as(u16, 3), tile.y);
    try std.testing.expectEqualStrings("\x89PNG\r\n\x1a\nFAKE", tile.png);
    try std.testing.expectEqual(@as(?spd.Tile, null), try it.next());
}

test "a file with no thumbnail cleanly reports none" {
    const gpa = std.testing.allocator;
    const db = openWritable();
    exec(db, "CREATE TABLE config(name TEXT PRIMARY KEY, value BLOB);");
    insertConfigText(db, "fmt_ver", "2");
    const bytes = try serialize(gpa, db);
    defer gpa.free(bytes);
    _ = c.sqlite3_close(db);

    var doc = try spd.open(gpa, bytes);
    defer doc.deinit();
    try std.testing.expectEqual(@as(?[]u8, null), try doc.thumbnail(gpa));
}

// ---- minimal in-test `.spd` builder over the vendored SQLite ----

fn openWritable() *c.sqlite3 {
    var db: ?*c.sqlite3 = null;
    std.debug.assert(c.sqlite3_open(":memory:", &db) == c.SQLITE_OK);
    return db.?;
}

fn exec(db: *c.sqlite3, sql: [:0]const u8) void {
    std.debug.assert(c.sqlite3_exec(db, sql.ptr, null, null, null) == c.SQLITE_OK);
}

fn insertConfigText(db: *c.sqlite3, key: [:0]const u8, val: []const u8) void {
    var st: ?*c.sqlite3_stmt = null;
    std.debug.assert(c.sqlite3_prepare_v2(db, "INSERT INTO config(name,value) VALUES(?1,?2)", -1, &st, null) == c.SQLITE_OK);
    defer _ = c.sqlite3_finalize(st);
    _ = c.sqlite3_bind_text(st, 1, key.ptr, @intCast(key.len), spd.sqlite.transient());
    _ = c.sqlite3_bind_text(st, 2, val.ptr, @intCast(val.len), spd.sqlite.transient());
    std.debug.assert(c.sqlite3_step(st) == c.SQLITE_DONE);
}

fn insertConfigBlob(db: *c.sqlite3, key: [:0]const u8, bytes: []const u8) void {
    var st: ?*c.sqlite3_stmt = null;
    std.debug.assert(c.sqlite3_prepare_v2(db, "INSERT INTO config(name,value) VALUES(?1,?2)", -1, &st, null) == c.SQLITE_OK);
    defer _ = c.sqlite3_finalize(st);
    _ = c.sqlite3_bind_text(st, 1, key.ptr, @intCast(key.len), spd.sqlite.transient());
    _ = c.sqlite3_bind_blob(st, 2, bytes.ptr, @intCast(bytes.len), spd.sqlite.transient());
    std.debug.assert(c.sqlite3_step(st) == c.SQLITE_DONE);
}

fn insertTile(db: *c.sqlite3, tid: i64, png: []const u8) void {
    var st: ?*c.sqlite3_stmt = null;
    std.debug.assert(c.sqlite3_prepare_v2(db, "INSERT INTO surface_1(tid,tile) VALUES(?1,?2)", -1, &st, null) == c.SQLITE_OK);
    defer _ = c.sqlite3_finalize(st);
    _ = c.sqlite3_bind_int64(st, 1, tid);
    _ = c.sqlite3_bind_blob(st, 2, png.ptr, @intCast(png.len), spd.sqlite.transient());
    std.debug.assert(c.sqlite3_step(st) == c.SQLITE_DONE);
}

fn serialize(gpa: std.mem.Allocator, db: *c.sqlite3) ![]u8 {
    var size: c.sqlite3_int64 = 0;
    const p = c.sqlite3_serialize(db, "main", &size, 0);
    if (p == null) return error.OutOfMemory;
    defer c.sqlite3_free(p);
    return gpa.dupe(u8, @as([*]const u8, @ptrCast(p))[0..@intCast(size)]);
}
