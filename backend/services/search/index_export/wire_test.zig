//! Tests for the manifest on the wire, its plan and its size.

const std = @import("std");
const pending = @import("../../pending.zig");
const testing = std.testing;
const index_export = @import("../index_export.zig");
const nibble = index_export.nibble;
const Row = index_export.Row;
const Manifest = index_export.Manifest;
const Cursor = index_export.Cursor;
const manifest = index_export.manifest;
const manifest_format_version = index_export.manifest_format_version;
const manifest_magic = index_export.manifest_magic;
const manifest_header_len = index_export.manifest_header_len;
const writeManifest = index_export.writeManifest;
const bodyEtag = index_export.bodyEtag;
const fixture = @import("fixture.zig");
const Fixture = fixture.Fixture;
const fill = fixture.fill;

/// Shared with `webapp/tests/unit/manifestCodec.test.ts`, each side checked
/// against hand-written expectations; do not regenerate to make one pass.
const manifest_golden = @embedFile("../testdata/manifest_golden.bin");

/// Rows chosen to hit every branch: a gap inside a tier, `pending` in the
/// high nibble, anchors at tier changes, a two-byte file_id, an absent
/// index_version, and index_version 0.
const golden_manifest: Manifest = .{
    .coverage = .{ .notes = 3, .unsearchable = 1 },
    .rows = &.{
        .{ .file_id = 7, .md5 = "0123456789abcdef0123456789abcdef", .updated_at = 1_700_000_000, .index_version = 15, .tier = .note, .derivation = .derived },
        .{ .file_id = 8, .md5 = "fedcba9876543210fedcba9876543210", .updated_at = 1_699_990_000, .index_version = 15, .tier = .note, .derivation = .pending },
        .{ .file_id = 300, .md5 = "00112233445566778899aabbccddeeff", .updated_at = 1_600_000_000, .index_version = null, .tier = .marked, .derivation = .pending },
        .{ .file_id = 301, .md5 = "d41d8cd98f00b204e9800998ecf8427e", .updated_at = 1_599_999_999, .index_version = 3, .tier = .other, .derivation = .derived },
        .{ .file_id = 302, .md5 = "ffffffffffffffffffffffffffffffff", .updated_at = 1_500_000_000, .index_version = 0, .tier = .other, .derivation = .derived },
    },
};

test "the golden manifest encodes byte for byte" {
    const gpa = std.testing.allocator;
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);

    try writeManifest(gpa, &out, golden_manifest);

    try testing.expectEqualSlices(u8, manifest_golden, out.items);
}

test "the golden manifest is the size its annotated dump claims" {
    try testing.expectEqual(@as(usize, 130), manifest_golden.len);
    try testing.expectEqual(@as(usize, 9), manifest_header_len);
    try testing.expectEqualSlices(u8, manifest_magic, manifest_golden[0..4]);
    try testing.expectEqual(manifest_format_version, manifest_golden[4]);
}

test "index_version ZERO is a real version and not an absent one" {
    const gpa = std.testing.allocator;
    var absent: std.ArrayList(u8) = .empty;
    defer absent.deinit(gpa);
    var zero: std.ArrayList(u8) = .empty;
    defer zero.deinit(gpa);
    const row: Row = .{
        .file_id = 1,
        .md5 = "0123456789abcdef0123456789abcdef",
        .updated_at = 0,
        .index_version = null,
        .tier = .note,
        .derivation = .derived,
    };
    var row_zero = row;
    row_zero.index_version = 0;
    try writeManifest(gpa, &absent, .{ .rows = &.{row}, .coverage = .{} });
    try writeManifest(gpa, &zero, .{ .rows = &.{row_zero}, .coverage = .{} });
    try testing.expect(!std.mem.eql(u8, absent.items, zero.items));
}

test "an md5 the manifest cannot spell never reaches the wire" {
    const gpa = std.testing.allocator;
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    const bad: Row = .{
        .file_id = 1,
        .md5 = "0123456789ABCDEF0123456789ABCDEF",
        .updated_at = 0,
        .index_version = null,
        .tier = .note,
        .derivation = .derived,
    };
    try testing.expectError(error.InvalidMd5, writeManifest(gpa, &out, .{ .rows = &.{bad}, .coverage = .{} }));
}

test "the ETag is the body, so a manifest that lost a row cannot answer 304" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    _ = try f.putNote(1, "keep.note", &.{"fica"});
    const gone = try f.putNote(1, "gone.note", &.{"sai"});

    var a: std.ArrayList(u8) = .empty;
    defer a.deinit(gpa);
    try writeManifest(gpa, &a, try f.manifest(1));
    const etag_before = bodyEtag(a.items);

    // Stable, or every visit refetches.
    var again: std.ArrayList(u8) = .empty;
    defer again.deinit(gpa);
    try writeManifest(gpa, &again, try f.manifest(1));
    try testing.expectEqualSlices(u8, &etag_before, &bodyEtag(again.items));

    try f.files.trash(1, gone);
    var b: std.ArrayList(u8) = .empty;
    defer b.deinit(gpa);
    try writeManifest(gpa, &b, try f.manifest(1));
    try testing.expect(!std.mem.eql(u8, &etag_before, &bodyEtag(b.items)));
}

test "the manifest carries no document names, and that is a decision" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    _ = try f.putNote(1, "Reunião trimestral.note", &.{"pauta"});

    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    try writeManifest(gpa, &out, try f.manifest(1));
    try testing.expect(std.mem.indexOf(u8, out.items, "Reuni") == null);
    try testing.expect(std.mem.indexOf(u8, out.items, ".note") == null);

    try testing.expect(out.items.len < manifest_header_len + 2 + 32);
    // The absolute anchor survived.
    try testing.expect(out.items[out.items.len - 6] != 0);
}

/// VM steps of one drained manifest.
fn manifestSteps(f: *Fixture, user_id: u64) !i64 {
    var c = try Cursor.open(f.db, user_id, f.files.terms);
    defer c.finalize();
    while (try c.next()) |_| {}
    return c.stmt.vmSteps();
}

test "WORK PIN: the manifest costs the caller's own live library, and nothing else's" {
    // The manifest is complete, so it cannot be flat in library size; pin
    // linear in the caller's own live documents, flat in others' and the bin.
    var f = try Fixture.init();
    defer f.deinit();

    try fill(&f, 1, "d", 0, 40);
    const base = try manifestSteps(&f, 1);

    // Another user's library; the bound allows +1 per b-tree level.
    try fill(&f, 2, "o", 0, 400);
    try testing.expect((try manifestSteps(&f, 1)) - base <= 8);

    // The caller's own bin: through the total index it cost +2,000 steps.
    for (0..400) |i| {
        const id = try f.putBytes(
            1,
            try std.fmt.allocPrint(f.a(), "t{d:0>4}.pdf", .{i}),
            try std.fmt.allocPrint(f.a(), "%PDF-1.4 trashed {d}", .{i}),
        );
        try f.files.trash(1, id);
    }
    try testing.expect((try manifestSteps(&f, 1)) - base <= 8);

    // Two slopes over the same fixture so a quadratic term shows. 173 steps
    // per document, about 92 of them the shared tenant predicate; a hand-copied
    // cheaper predicate would be a second opinion that can silently lose a
    // document. On a Pi 1 B+ with 322 documents: 178 ms p50.
    try fill(&f, 1, "d", 40, 240);
    const at_240 = try manifestSteps(&f, 1);
    try fill(&f, 1, "d", 240, 440);
    const at_440 = try manifestSteps(&f, 1);

    const slope_1 = @divTrunc(at_240 - base, 200);
    const slope_2 = @divTrunc(at_440 - at_240, 200);
    try testing.expect(slope_2 <= slope_1 + 4);

    // A level band too, so a cheap empty answer or a per-row walk fails.
    try testing.expect(slope_1 >= 60 and slope_1 <= 300);

    try testing.expectEqual(@as(usize, 440), (try f.manifest(1)).rows.len);
}

/// The manifest as JSON, the encoding being measured against.
fn writeJson(gpa: std.mem.Allocator, out: *std.ArrayList(u8), m: Manifest) !void {
    try out.print(
        gpa,
        "{{\"coverage\":{{\"notes\":{d},\"unsearchable\":{d}}},\"rows\":[",
        .{ m.coverage.notes, m.coverage.unsearchable },
    );
    for (m.rows, 0..) |r, i| {
        if (i != 0) try out.append(gpa, ',');
        try out.print(
            gpa,
            "{{\"id\":{d},\"md5\":\"{s}\",\"tier\":{d},\"updatedAt\":{d},\"derivation\":{d}",
            .{ r.file_id, r.md5, @backingInt(r.tier), r.updated_at, @backingInt(r.derivation) },
        );
        if (r.index_version) |v| try out.print(gpa, ",\"indexVersion\":{d}", .{v});
        try out.append(gpa, '}');
    }
    try out.appendSlice(gpa, "]}");
}

/// gzip level 6, as every figure in this tree.
fn gzipLen(gpa: std.mem.Allocator, bytes: []const u8) !usize {
    var sink: std.Io.Writer.Allocating = try .initCapacity(gpa, 4096);
    defer sink.deinit();
    const window = try gpa.alloc(u8, std.compress.flate.max_window_len);
    defer gpa.free(window);
    var c = try std.compress.flate.Compress.init(&sink.writer, window, .gzip, .level_6);
    try c.writer.writeAll(bytes);
    try c.writer.flush();
    return sink.written().len;
}

test "MEASUREMENT: what one manifest costs on the wire, and how it grows" {
    // 1,222 documents (the real corpus), timestamps spread over two years.
    // Measured: JSON 143,139 raw / 38,597 gzip, binary 27,663 / 26,937. md5s
    // are 72.6% of the gzipped binary and do not compress.
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    var json: std.ArrayList(u8) = .empty;
    defer json.deinit(gpa);
    var bin: std.ArrayList(u8) = .empty;
    defer bin.deinit(gpa);

    var rng = std.Random.DefaultPrng.init(0x5EA5);
    var filled: usize = 0;
    var json_gz_full: usize = 0;
    var bin_gz_full: usize = 0;
    for ([_]usize{ 13, 1222 }) |n| {
        try fill(&f, 1, "d", filled, n);
        var i = filled;
        while (i < n) : (i += 1) {
            try f.touch(@intCast(i + 1), 1_690_000_000 + rng.random().intRangeLessThan(i64, 0, 63_072_000));
        }
        filled = n;

        const m = try f.manifest(1);
        try testing.expectEqual(n, m.rows.len);

        json.clearRetainingCapacity();
        bin.clearRetainingCapacity();
        try writeJson(gpa, &json, m);
        try writeManifest(gpa, &bin, m);
        const json_gz = try gzipLen(gpa, json.items);
        const bin_gz = try gzipLen(gpa, bin.items);
        if (n == 1222) {
            json_gz_full = json_gz;
            bin_gz_full = bin_gz;
        }

        // Bounds, not equalities: timestamps are randomised.
        try testing.expect(json.items.len / n <= 130); // measured 117-119
        try testing.expect(json_gz / n <= 45); // measured 31.6 at scale, 39.6 at 13
        try testing.expect(bin.items.len / n <= 26); // measured 22.6
        try testing.expect(bin_gz / n <= 30); // measured 22.0 at scale, 25.4 at 13

        // The floor is 16 raw md5 bytes per row.
        try testing.expect(bin.items.len > n * 16);
    }

    // Binary gzip at most three quarters of JSON gzip (measured 69.8%).
    try testing.expect(bin_gz_full * 4 <= json_gz_full * 3);

    try testing.expect(bin_gz_full > 1222 * 16);
}
