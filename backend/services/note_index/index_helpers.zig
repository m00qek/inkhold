//! Helpers shared by the `index_test` tests.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const blobstore = @import("../../store/blobs.zig");
const sn = @import("supernote");
const testing = std.testing;
const schema = @import("../../db/schema.zig");
const noteindex = @import("../note_index.zig");
const store = noteindex.store;
const SliceSource = noteindex.SliceSource;
const pagePlan = noteindex.pagePlan;
const streamPage = noteindex.streamPage;
const serializeFromIndex = noteindex.serializeFromIndex;
const fixture = @import("fixture.zig");
const Blobs = fixture.Blobs;
const indexInto = fixture.indexInto;

/// Real device captures; local fixtures, not redistributed.
pub const sample = @embedFile("sample.note");

/// `page_payload.serialize`, `serializeFromIndex` and `streamPage` (off a real
/// blob) must agree byte for byte on every page, and equal the plan's
/// `content_length`.
pub fn assertGolden(bytes: []const u8, label: []const u8) !void {
    const gpa = testing.allocator;
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);

    var blobs = try Blobs.init();
    defer blobs.deinit();
    const md5 = try blobs.put(bytes);
    try testing.expectEqualStrings(&blobstore.md5HexOf(bytes), &md5);
    try indexInto(db, &md5, bytes);

    var note = try sn.parse(gpa, bytes);
    defer note.deinit();
    try testing.expect(note.pages.len > 0);

    for (0..note.pages.len) |i| {
        const from_parse = try sn.page_payload.serialize(gpa, note, i);
        defer gpa.free(from_parse);
        const from_index = try serializeFromIndex(gpa, db, &md5, i, SliceSource{ .bytes = bytes });
        defer gpa.free(from_index);

        const plan = (try pagePlan(db, &md5, i)).?;
        var streamed: std.Io.Writer.Allocating = .init(gpa);
        defer streamed.deinit();
        try streamPage(blobs.store, &md5, plan, &streamed.writer);

        testing.expectEqualSlices(u8, from_parse, from_index) catch |e| {
            std.debug.print("golden mismatch (buffered): {s} page {d}\n", .{ label, i });
            return e;
        };
        testing.expectEqualSlices(u8, from_parse, streamed.written()) catch |e| {
            std.debug.print("golden mismatch (streamed): {s} page {d}\n", .{ label, i });
            return e;
        };
        try testing.expectEqual(from_parse.len, @as(usize, @intCast(plan.content_length)));
    }
}
