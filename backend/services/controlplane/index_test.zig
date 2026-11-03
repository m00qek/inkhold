//! Tests that index-driven reads match the parse-driven path, and repair it.

const std = @import("std");
const Entry = @import("../files.zig").Entry;
const blobstore = @import("../../store/blobs.zig");
const testing = std.testing;
const nb = @import("note_builder");
const cp = @import("../controlplane.zig");
const ControlPlaneService = cp.ControlPlaneService;
const fixture = @import("fixture.zig");
const Fixture = fixture.Fixture;
const seedNote = fixture.seedNote;
const seedBytes = fixture.seedBytes;
const servePage = fixture.servePage;

test "hasRecognizedText means finished pages, not recognition merely enabled" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    const enabled = &[_]nb.Kv{
        .{ .key = "APPLY_EQUIPMENT", .value = "N6" },
        .{ .key = "FILE_RECOGN_TYPE", .value = "1" },
        .{ .key = "FILE_RECOGN_LANGUAGE", .value = "pt_BR" },
    };
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };

    const running = try nb.serialize(gpa, .{
        .header = enabled,
        .pages = &.{.{
            .style = "style_white",
            .layers = &.{.{ .slot = .main, .bitmap = &bmp }},
            .recogn_status = 2, // still running — zero finished pages
        }},
    });
    defer gpa.free(running);
    const done = try nb.serialize(gpa, .{ .header = enabled, .pages = &.{
        .{
            .style = "style_white",
            .layers = &.{.{ .slot = .main, .bitmap = &bmp }},
            .recogn_status = 1,
            .recogn_labels = &.{ "hello", "world" },
        },
        .{ .style = "style_white", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
    } });
    defer gpa.free(done);

    _ = try seedBytes(&f, null, "running.note", running);
    _ = try seedBytes(&f, null, "done.note", done);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);
    const root = try svc.listing(arena.allocator(), 1, null);

    for (root.entries) |e| {
        const want = std.mem.eql(u8, e.name, "done.note");
        try testing.expectEqual(want, e.hasRecognizedText.?);
        try testing.expectEqualStrings("note", e.fileType.?);
    }

    // The badge agrees with what a find can reach: a finished page containing
    // the term (in-document search runs in the browser off this table).
    for (root.entries) |e| {
        var s = try f.db.prepare(
            "SELECT COUNT(*) FROM note_page_index p JOIN files f ON f.md5 = p.blob_md5 " ++
                "WHERE f.id = ?1 AND p.recogn_status = 1 AND p.text LIKE '%hello%';",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(try std.fmt.parseInt(u64, e.id, 10)));
        try testing.expect(try s.step());
        try testing.expectEqual(e.hasRecognizedText.?, s.columnInt(0) > 0);
    }

    _ = try seedBytes(&f, null, "x.pdf", "%PDF-1.7 nope");
    const again = try svc.listing(arena.allocator(), 1, null);
    for (again.entries) |e| {
        if (std.mem.eql(u8, e.name, "x.pdf")) try testing.expect(!e.hasRecognizedText.?);
    }
}

/// A `std.Io.Writer` that counts and drops bytes, so the test measures the
/// server rather than a growing collector.
const CountingSink = struct {
    writer: std.Io.Writer,
    total: u64 = 0,

    fn init() CountingSink {
        return .{ .writer = .{ .buffer = &.{}, .vtable = &.{ .drain = drain } } };
    }

    fn drain(w: *std.Io.Writer, data: []const []const u8, splat: usize) std.Io.Writer.Error!usize {
        const self: *CountingSink = @alignCast(@fieldParentPtr("writer", w));
        var n: usize = 0;
        for (data[0 .. data.len - 1]) |d| n += d.len;
        n += data[data.len - 1].len * splat;
        self.total += n;
        return n;
    }
};

/// Peak *live* heap, measured by wrapping the allocator the service is handed.
const PeakAllocator = struct {
    child: std.mem.Allocator,
    live: usize = 0,
    peak: usize = 0,

    fn allocator(self: *PeakAllocator) std.mem.Allocator {
        return .{ .ptr = self, .vtable = &.{ .alloc = alloc, .resize = resize, .remap = remap, .free = free } };
    }
    fn grew(self: *PeakAllocator, n: usize) void {
        self.live += n;
        self.peak = @max(self.peak, self.live);
    }
    fn alloc(ctx: *anyopaque, len: usize, a: std.mem.Alignment, ra: usize) ?[*]u8 {
        const self: *PeakAllocator = @ptrCast(@alignCast(ctx));
        const p = self.child.rawAlloc(len, a, ra) orelse return null;
        self.grew(len);
        return p;
    }
    fn resize(ctx: *anyopaque, m: []u8, a: std.mem.Alignment, new_len: usize, ra: usize) bool {
        const self: *PeakAllocator = @ptrCast(@alignCast(ctx));
        if (!self.child.rawResize(m, a, new_len, ra)) return false;
        self.live -= m.len;
        self.grew(new_len);
        return true;
    }
    fn remap(ctx: *anyopaque, m: []u8, a: std.mem.Alignment, new_len: usize, ra: usize) ?[*]u8 {
        const self: *PeakAllocator = @ptrCast(@alignCast(ctx));
        const p = self.child.rawRemap(m, a, new_len, ra) orelse return null;
        self.live -= m.len;
        self.grew(new_len);
        return p;
    }
    fn free(ctx: *anyopaque, m: []u8, a: std.mem.Alignment, ra: usize) void {
        const self: *PeakAllocator = @ptrCast(@alignCast(ctx));
        self.child.rawFree(m, a, ra);
        self.live -= m.len;
    }
};

test "THE MEMORY CLAIM: serving a page holds one chunk, not the page and not the note" {
    // The service gets a peak-tracking allocator while serving an 8 MiB layer.
    const gpa = testing.allocator;
    var f = try Fixture.init();
    defer f.deinit();
    defer f.files.gpa = gpa;

    // 8 and 16 MiB layers; equal-length names keep the duped `Entry.name` constant.
    const ids = blk: {
        var out: [2]u64 = undefined;
        for ([_]usize{ 8, 16 }, [_][]const u8{ "a.note", "b.note" }, 0..) |mib, name, i| {
            const layer = try gpa.alloc(u8, mib * 1024 * 1024);
            defer gpa.free(layer);
            for (layer, 0..) |*b, j| b.* = @truncate(j * 31 + 7);
            const bytes = try nb.serialize(gpa, .{ .pages = &.{.{ .layers = &.{
                .{ .slot = .main, .bitmap = layer },
            } }} });
            defer gpa.free(bytes);
            try testing.expect(bytes.len > mib * 1024 * 1024);
            out[i] = try seedBytes(&f, null, name, bytes);
        }
        break :blk out;
    };

    var peaks: [2]usize = undefined;
    var served: [2]u64 = undefined;
    for (ids, 0..) |id, i| {
        var counter = PeakAllocator{ .child = gpa };
        f.files.gpa = counter.allocator();
        var svc = ControlPlaneService.init(&f.files);

        const planned = (try svc.pagePlan(1, id, 0)).?;
        var sink = CountingSink.init();
        try svc.writePage(planned, &sink.writer);

        try testing.expectEqual(planned.plan.content_length, sink.total);
        try testing.expect(sink.total > 8 * 1024 * 1024);

        peaks[i] = counter.peak;
        served[i] = sink.total;
        f.files.gpa = gpa;
    }

    // Peak live heap stays under one chunk while serving far more...
    for (peaks, served) |peak, total| {
        try testing.expect(peak < blobstore.chunk_len);
        try testing.expect(peak * 100 < total);
    }
    // ...and does not scale with page size.
    try testing.expect(served[1] > 2 * served[0] - 4096);
    try testing.expectEqual(peaks[0], peaks[1]);
}

test "FINDING #8: noteMeta's per-page dims match the SNPG payload's, on a non-default device" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    // An N5 note is 1920×2560; the dims must match the SNPG header, not 1404×1872.
    const bmp = [_]u8{ 0x61, 0x00, 0x62, 0x03 };
    const bytes = try nb.serialize(gpa, .{
        .header = &.{.{ .key = "APPLY_EQUIPMENT", .value = "N5" }},
        .pages = &.{
            .{ .style = "style_white", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
            .{ .style = "style_5mm_dots", .layers = &.{.{ .slot = .main, .bitmap = &bmp }} },
        },
    });
    defer gpa.free(bytes);
    const id = try seedBytes(&f, null, "n5.note", bytes);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    const meta = (try svc.noteMeta(arena.allocator(), 1, id)).?;
    try testing.expectEqual(@as(usize, 2), meta.pages.len);

    for (meta.pages, 0..) |p, i| {
        const pb = (try servePage(svc, arena.allocator(), 1, id, i)).?;
        try testing.expectEqualStrings(p.hash, &pb.hash);
        // SNPG header: MAGIC[4] VERSION[1] variant[1] reserved[2] width[4] height[4].
        const w = std.mem.readInt(u32, pb.bytes[8..12], .little);
        const h = std.mem.readInt(u32, pb.bytes[12..16], .little);
        try testing.expectEqual(@as(i64, w), p.width);
        try testing.expectEqual(@as(i64, h), p.height);
        try testing.expectEqual(@as(i64, 1920), p.width);
        try testing.expectEqual(@as(i64, 2560), p.height);
    }

    const root = try svc.listing(arena.allocator(), 1, null);
    try testing.expectEqual(meta.pages[0].width, root.entries[0].firstPage.?.width);
    try testing.expectEqual(meta.pages[0].height, root.entries[0].firstPage.?.height);
}

test "bin: a trashed note carries its real first page; a folder and an unparseable blob carry none" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Work");
    defer testing.allocator.free(dir.name);
    _ = try seedNote(&f, dir.id, "deep.note", &.{ "AAAA", "BBBBBB" });
    const other = try seedBytes(&f, null, "shot.png", "not a note container");

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var svc = ControlPlaneService.init(&f.files);

    // Taken before the delete: the bin must agree (same blob, same cache key).
    const live = try svc.listing(arena.allocator(), 1, dir.id);
    const live_page = live.entries[0].firstPage.?;

    try f.files.trash(1, dir.id);
    try f.files.trash(1, other);

    const b = try svc.bin(arena.allocator(), 1);
    try testing.expectEqual(@as(usize, 3), b.entries.len);

    var seen_note = false;
    for (b.entries) |e| {
        if (std.mem.eql(u8, e.name, "deep.note")) {
            seen_note = true;
            const p = e.firstPage.?;
            try testing.expectEqual(@as(i64, 0), p.index);
            try testing.expectEqualStrings(live_page.hash, p.hash);
            try testing.expectEqual(live_page.width, p.width);
            try testing.expectEqual(live_page.height, p.height);
            try testing.expectEqual(@as(i64, 1404), e.thumbAspect.?.w);
            try testing.expectEqual(@as(i64, 1872), e.thumbAspect.?.h);
        }
        if (std.mem.eql(u8, e.name, "Work")) {
            try testing.expect(e.firstPage == null);
            try testing.expect(e.thumbAspect == null);
        }
        if (std.mem.eql(u8, e.name, "shot.png")) {
            try testing.expect(e.firstPage == null);
            try testing.expect(e.thumbAspect == null);
        }
    }
    try testing.expect(seen_note);
}
