//! Tests for `thumbAspect`.

const std = @import("std");
const repeat = @import("../../util/repeat.zig").repeat;
const Files = @import("../files.zig").Files;
const testing = std.testing;
const sqlite = @import("../../db/sqlite.zig");
const nb = @import("note_builder");
const cp = @import("../controlplane.zig");
const ControlPlaneService = cp.ControlPlaneService;
const fixture = @import("fixture.zig");
const Fixture = fixture.Fixture;
const seedNote = fixture.seedNote;
const seedBytes = fixture.seedBytes;
const entryNamed = fixture.entryNamed;

/// A minimal PNG whose IHDR says 320×240 (as in `spd_index.zig`'s tests).
const mini_png = "\x89PNG\r\n\x1a\n" ++
    "\x00\x00\x00\x0d" ++ "IHDR" ++
    "\x00\x00\x01\x40" ++ "\x00\x00\x00\xf0" ++ // 320 × 240
    "\x08\x02\x00\x00\x00" ++ (repeat(u8, "p", 16));

/// A minimal `.spd` (SQLite with a `config` thumbnail), caller-owned bytes.
fn buildSpdBytes(thumb: []const u8) ![]u8 {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try db.exec("CREATE TABLE config(name TEXT PRIMARY KEY NOT NULL, value BLOB);");
    try db.exec("INSERT INTO config(name, value) VALUES('fmt_ver', '2');");
    var s = try db.prepare("INSERT INTO config(name, value) VALUES('thumbnail', ?1);");
    defer s.finalize();
    s.bindBlob(1, thumb);
    _ = try s.step();
    return db.serializeAlloc(testing.allocator);
}

test "thumbAspect: cover dims when a cover ships, page-0 EFFECTIVE dims otherwise, absent for the shapeless" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };

    const covered = try nb.serialize(gpa, .{
        .pages = &.{.{ .style = "style_white", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }},
        .covers = &.{.{ .bytes = mini_png }},
    });
    defer gpa.free(covered);
    _ = try seedBytes(&f, null, "covered.note", covered);

    // Coverless landscape: stored page dims are already orientation-applied.
    const landscape = try nb.serialize(gpa, .{
        .pages = &.{.{ .style = "style_white", .orientation = "1090", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} }},
    });
    defer gpa.free(landscape);
    _ = try seedBytes(&f, null, "landscape.note", landscape);

    _ = try seedNote(&f, null, "portrait.note", &.{"AAAA"});
    _ = try seedBytes(&f, null, "photo.png", "png-shaped bytes, but not indexed server-side");
    _ = try seedBytes(&f, null, "notes.txt", "plain text");
    const dir = try f.files.createFolder(1, null, "Folder");
    defer testing.allocator.free(dir.name);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);
    const root = try svc.listing(a, 1, null);

    const cov = try entryNamed(root, "covered.note");
    try testing.expectEqual(@as(i64, 320), cov.thumbAspect.?.w);
    try testing.expectEqual(@as(i64, 240), cov.thumbAspect.?.h);

    const land = try entryNamed(root, "landscape.note");
    try testing.expectEqual(@as(i64, 1872), land.thumbAspect.?.w);
    try testing.expectEqual(@as(i64, 1404), land.thumbAspect.?.h);

    const port = try entryNamed(root, "portrait.note");
    try testing.expectEqual(@as(i64, 1404), port.thumbAspect.?.w);
    try testing.expectEqual(@as(i64, 1872), port.thumbAspect.?.h);

    try testing.expect((try entryNamed(root, "photo.png")).thumbAspect == null);
    try testing.expect((try entryNamed(root, "notes.txt")).thumbAspect == null);
    try testing.expect((try entryNamed(root, "Folder")).thumbAspect == null);

    // Absent is a missing key, never `"thumbAspect":null`.
    const with = try std.json.Stringify.valueAlloc(a, cov, .{ .emit_null_optional_fields = false });
    try testing.expect(std.mem.indexOf(u8, with, "\"thumbAspect\":{\"w\":320,\"h\":240}") != null);
    const without = try std.json.Stringify.valueAlloc(a, try entryNamed(root, "photo.png"), .{ .emit_null_optional_fields = false });
    try testing.expect(std.mem.indexOf(u8, without, "thumbAspect") == null);
}

test "thumbAspect: a .spd serves its thumbnail's dims, live and in the bin; a stale spd row omits" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const spd_bytes = try buildSpdBytes(mini_png);
    defer gpa.free(spd_bytes);
    const id = try seedBytes(&f, null, "drawing.spd", spd_bytes);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    const live = try entryNamed(try svc.listing(a, 1, null), "drawing.spd");
    try testing.expectEqualStrings("spd", live.fileType.?);
    try testing.expectEqual(@as(i64, 320), live.thumbAspect.?.w);
    try testing.expectEqual(@as(i64, 240), live.thumbAspect.?.h);

    try f.files.trash(1, id);
    const b = try svc.bin(a, 1);
    try testing.expectEqual(@as(usize, 1), b.entries.len);
    try testing.expectEqual(@as(i64, 320), b.entries[0].thumbAspect.?.w);
    try testing.expectEqual(@as(i64, 240), b.entries[0].thumbAspect.?.h);
    const json = try std.json.Stringify.valueAlloc(a, b.entries[0], .{ .emit_null_optional_fields = false });
    try testing.expect(std.mem.indexOf(u8, json, "\"thumbAspect\":{\"w\":320,\"h\":240}") != null);

    // A stale spd row drops out via the LEFT JOIN's version filter (it heals in
    // `Files.repairDerivedThumb`, not here).
    try f.db.exec("UPDATE spd_index SET index_version = 0;");
    const stale = try svc.bin(a, 1);
    try testing.expect(stale.entries[0].thumbAspect == null);
}

test "thumbAspect: the bin HEALS a stale note index row (firstPage + aspect restored)" {
    var f = try Fixture.init();
    defer f.deinit();
    const id = try seedNote(&f, null, "n.note", &.{"AAAA"});

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var svc = ControlPlaneService.init(&f.files);

    try f.files.trash(1, id);
    try f.db.exec("UPDATE note_index SET index_version = 0;");

    const b = try svc.bin(a, 1);
    try testing.expectEqual(@as(usize, 1), b.entries.len);
    try testing.expect(b.entries[0].firstPage != null);
    try testing.expect(b.entries[0].thumbAspect != null);
    try testing.expect((try svc.bin(a, 1)).entries[0].firstPage != null);
}
