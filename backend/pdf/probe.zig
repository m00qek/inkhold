//! Zig face of `probe.c`: MuPDF's page count and page-1 shape for a paged
//! document (a PDF, an XPS or a CBZ).

const std = @import("std");
const pool_mod = @import("pool.zig");

/// Mirrors `struct ink_pdf_info` in `probe.c`.
const Info = extern struct {
    pages: i32,
    width: f32,
    height: f32,
    peak_bytes: u64,
    held_after: u64,
};

extern fn ink_mupdf_budget() usize;

// The pool `budget.c` allocates from: its exports must be in every binary that
// links MuPDF, and its tests run with these.
comptime {
    _ = @import("pool.zig");
}

/// What one MuPDF context may hold at once (`backend/pdf/budget.h`).
pub fn budgetBytes() usize {
    return ink_mupdf_budget();
}

extern fn ink_pdf_probe(fd: c_int, out: *Info) c_int;

/// Why a PDF has no shape. Each is a verdict about the file, recorded so it is
/// never probed again.
pub const Error = error{
    /// The only one about us rather than the file, and worth retrying.
    NoContext,
    Unopenable,
    Encrypted,
    /// Also covers a degenerate page-1 box.
    NoPages,
    /// Opening it needed more memory than `budgetBytes`: the file is too much
    /// for this server, whatever it is.
    TooLarge,
};

pub const Shape = struct {
    pages: u32,
    /// Page 1 in points, rotated and cropped (`fz_bound_page`), not `/MediaBox`.
    width: f32,
    height: f32,

    pub fn aspect(self: Shape) f32 {
        return self.width / self.height;
    }
};

/// Probe an already-open PDF. Takes a descriptor because the blob store holds
/// only a directory handle with no `realpath`. Never closes `file`.
pub fn probeFile(file: std.Io.File) Error!Shape {
    return probeMeasured(file).result;
}

/// `probeFile`, with the most MuPDF held at once while it ran.
/// `held_after` is what the ceiling still counted once MuPDF was dropped: 0,
/// unless a block leaked or was miscounted.
pub fn probeMeasured(file: std.Io.File) struct { result: Error!Shape, peak_bytes: u64, held_after: u64 } {
    var info: Info = undefined;
    const rc = ink_pdf_probe(file.handle, &info);
    return .{ .result = resultOf(rc, info), .peak_bytes = info.peak_bytes, .held_after = info.held_after };
}

fn resultOf(rc: c_int, info: Info) Error!Shape {
    return switch (rc) {
        0 => .{
            .pages = @intCast(info.pages),
            .width = info.width,
            .height = info.height,
        },
        -1 => Error.NoContext,
        -2 => Error.Unopenable,
        -3 => Error.Encrypted,
        -4 => Error.NoPages,
        -6 => Error.TooLarge,
        else => Error.Unopenable,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;

test {
    _ = @import("pool.zig");
}

/// Test-only: the server gets descriptors from the blob store.
fn probePath(path: []const u8) Error!Shape {
    const f = std.Io.Dir.cwd().openFile(testing.io, path, .{}) catch return Error.Unopenable;
    defer f.close(testing.io);
    return probeFile(f);
}

test "a file that is not a PDF is a verdict, not a crash" {
    try testing.expectError(Error.Unopenable, probePath("build.zig"));
}

test "a missing file is Unopenable rather than a hang or a panic" {
    try testing.expectError(Error.Unopenable, probePath("/nonexistent/definitely/not/here.pdf"));
}

test "a real PDF reports its page count and its page-1 box, in points" {
    const shape = probePath("webapp/wasm/tests/fixtures/two-page.pdf") catch |e| switch (e) {
        Error.Unopenable => return error.SkipZigTest, // not run from the build root
        else => return e,
    };
    try testing.expectEqual(@as(u32, 2), shape.pages);
    try testing.expectEqual(@as(f32, 200), shape.width);
    try testing.expectEqual(@as(f32, 100), shape.height);
    try testing.expectEqual(@as(f32, 2), shape.aspect());
}

test "a device-panel PDF reports the 3:4 panel, not a guess" {
    const shape = probePath("webapp/wasm/tests/fixtures/two-page-panel.pdf") catch |e| switch (e) {
        Error.Unopenable => return error.SkipZigTest,
        else => return e,
    };
    try testing.expectEqual(@as(f32, 351), shape.width);
    try testing.expectEqual(@as(f32, 468), shape.height);
}

test "ROTATION IS APPLIED — /Rotate 90 reports the rotated box, not the MediaBox" {
    // 200x100 MediaBox with `/Rotate 90`: the right answer is 100x200.
    const shape = probePath("backend/pdf/testdata/rotate90.pdf") catch |e| switch (e) {
        Error.Unopenable => return error.SkipZigTest,
        else => return e,
    };
    try testing.expectEqual(@as(u32, 1), shape.pages);
    try testing.expectEqual(@as(f32, 100), shape.width);
    try testing.expectEqual(@as(f32, 200), shape.height);
    try testing.expect(shape.aspect() < 1); // portrait once rotated
}

/// Test-only: a fixture, by its path from the build root (`zig build test`
/// runs there). Unlike `probePath`, nothing here is a skip: a missing fixture
/// or a refusing MuPDF fails the test, so a dropped handler cannot pass quietly.
fn probeFixture(path: []const u8) !Shape {
    const f = try std.Io.Dir.cwd().openFile(testing.io, path, .{});
    defer f.close(testing.io);
    return probeFile(f);
}

// The other paged formats go through the same probe: MuPDF picks the format by
// content. Fixtures: `text-three-page.xps` is hand-made, three 400x300 pages
// with one glyph run each (the words of `text-three-page.pdf`; no font part, so
// MuPDF falls back to its own Times); `two-page.cbz` holds a 300x400 and a
// 400x300 PNG.

test "an XPS reports its pages and page-1 box like a PDF" {
    const shape = try probeFixture("backend/pdf/testdata/text-three-page.xps");
    try testing.expectEqual(@as(u32, 3), shape.pages);
    try testing.expect(shape.aspect() > 1); // 400x300
}

test "a CBZ reports one page per image, page 1's shape from its image" {
    const shape = try probeFixture("backend/pdf/testdata/two-page.cbz");
    try testing.expectEqual(@as(u32, 2), shape.pages);
    try testing.expect(shape.aspect() < 1); // the 300x400 page
}

// What keeps books off the Pi is the extension gate (`pdf_index.wants`), not
// this: MuPDF's CBZ handler takes any zip holding an image, an EPUB with a
// cover included.
test "an EPUB of text alone matches none of the server's handlers" {
    try testing.expectError(Error.Unopenable, probeFixture("backend/pdf/testdata/one-chapter.epub"));
}

test "a JPEG 2000 comic book reports its page shape: JPX headers are read on the server too" {
    // One 300x400 JP2 page (`jpx-page.cbz`); without JPX the page fails to load.
    const shape = try probeFixture("backend/pdf/testdata/jpx-page.cbz");
    try testing.expectEqual(@as(u32, 1), shape.pages);
    try testing.expect(shape.aspect() < 1);
}

// MuPDF would open more than a zip as a comic book: a tar, an OLE file. Here
// only a zip goes by its content (`open.h`); anything else is read as a PDF,
// whatever its name, so neither reaches those readers. A zip whose end record
// names another disk is still a zip, and opens.
test "a tar or an OLE file is read as a PDF, never as a comic book; an odd zip still opens" {
    for ([_][]const u8{
        "backend/pdf/testdata/two-page-tar.cbz",
        "backend/pdf/testdata/two-page-v7tar.cbz",
        "backend/pdf/testdata/ole-header.cbz",
    }) |path| {
        if (probeFixture(path)) |shape| {
            std.debug.print("{s} opened with {d} pages\n", .{ path, shape.pages });
            return error.TestUnexpectedResult;
        } else |_| {}
    }
    const disk = try probeFixture("backend/pdf/testdata/disk-one.cbz");
    try testing.expectEqual(@as(u32, 2), disk.pages);
}

/// Test-only: `probeMeasured` on a fixture from the build root.
fn probeFixtureMeasured(path: []const u8) !@TypeOf(probeMeasured(undefined)) {
    const f = try std.Io.Dir.cwd().openFile(testing.io, path, .{});
    defer f.close(testing.io);
    return probeMeasured(f);
}

// The memory ceiling (`pool.zig`) is the server's bound on what a document may
// cost, whatever its container says about itself. Each of these needs a 40 MiB
// part, read whole: by a plain zip entry, by a second directory hidden in a
// zip's comment (a reader that takes the first end record sees a small file),
// and by upper-case XPS pieces MuPDF joins. Each ends as `TooLarge`, and every
// block MuPDF held is given back.
test "a part past MuPDF's memory ceiling is TooLarge, however the file hides it" {
    for ([_][]const u8{
        "backend/pdf/testdata/over-budget.cbz",
        "backend/pdf/testdata/two-eocd.cbz",
        "backend/pdf/testdata/upper-pieces.xps",
    }) |path| {
        const m = try probeFixtureMeasured(path);
        try testing.expectError(Error.TooLarge, m.result);
        try testing.expectEqual(@as(u64, 0), m.held_after);
    }
}

test "a big part under the ceiling is MuPDF's to judge, not the ceiling's" {
    // A 17 MiB entry of zeros named `01.png`: read whole, then not an image.
    const m = try probeFixtureMeasured("backend/pdf/testdata/huge-page.cbz");
    if (m.result) |_| {} else |e| try testing.expect(e != Error.TooLarge);
    try testing.expect(m.peak_bytes > 16 * 1024 * 1024); // it was read
    try testing.expectEqual(@as(u64, 0), m.held_after);
}

/// A PDF whose page 1 names `n` form XObjects, each its own small stream
/// object (the test builds it, so the repository holds no multi-megabyte
/// fixture). MuPDF loads them all when it asks whether the page uses blending.
pub fn writeManyForms(io: std.Io, dir: std.Io.Dir, name: []const u8, n: u32) !void {
    const gpa = testing.allocator;
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    const first: u32 = 10;
    var offs: std.ArrayList(usize) = .empty;
    defer offs.deinit(gpa);
    try offs.appendNTimes(gpa, 0, first + n);
    try out.appendSlice(gpa, "%PDF-1.4\n");
    offs.items[1] = out.items.len;
    try out.appendSlice(gpa, "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    offs.items[2] = out.items.len;
    try out.appendSlice(gpa, "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
    offs.items[3] = out.items.len;
    try out.appendSlice(gpa, "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject 4 0 R >> >>\nendobj\n");
    offs.items[4] = out.items.len;
    try out.appendSlice(gpa, "4 0 obj\n<< ");
    for (0..n) |i| try out.print(gpa, "/X{d} {d} 0 R ", .{ i, first + i });
    try out.appendSlice(gpa, ">>\nendobj\n");
    for (0..n) |i| {
        offs.items[first + i] = out.items.len;
        try out.print(gpa, "{d} 0 obj\n<< /Subtype /Form /BBox [0 0 1 1] /Length 0 >>\nstream\n\nendstream\nendobj\n", .{first + i});
    }
    const xref = out.items.len;
    try out.print(gpa, "xref\n0 {d}\n", .{first + n});
    for (offs.items, 0..) |o, k| {
        if (o == 0) try out.print(gpa, "{d:0>10} 65535 f \n", .{@as(usize, if (k == 0) 0 else 0)}) else try out.print(gpa, "{d:0>10} 00000 n \n", .{o});
    }
    try out.print(gpa, "trailer\n<< /Size {d} /Root 1 0 R >>\nstartxref\n{d}\n%%EOF\n", .{ first + n, xref });
    try dir.writeFile(io, .{ .sub_path = name, .data = out.items });
}

// A document dropped after a throw, every time: before `probe.c`'s locals were
// `volatile`, an optimised build lost them in the longjmp and kept the whole
// document, nearly the ceiling, for the life of the server. A Debug build
// never showed it; `zig build test` also runs these tests optimised
// (`pdf-release-test`), where without `volatile` this one fails.
test "a probe refused at the ceiling while page 1 loads gives back every block" {
    // 60,000 forms: past the ceiling while page 1's resources are walked.
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try writeManyForms(testing.io, tmp.dir, "forms.pdf", 60_000);
    const f = try tmp.dir.openFile(testing.io, "forms.pdf", .{});
    defer f.close(testing.io);
    for (0..2) |_| {
        const m = probeMeasured(f);
        try testing.expectError(Error.TooLarge, m.result);
        try testing.expectEqual(@as(u64, 0), m.held_after);
    }
    // Under the ceiling, the same shape opens.
    try writeManyForms(testing.io, tmp.dir, "few.pdf", 1_000);
    const g = try tmp.dir.openFile(testing.io, "few.pdf", .{});
    defer g.close(testing.io);
    const m = probeMeasured(g);
    try testing.expectEqual(@as(u32, 1), (try m.result).pages);
    try testing.expectEqual(@as(u64, 0), m.held_after);
}

/// `fz_alloc_context`, as `budget.c` fills it.
const AllocContext = extern struct {
    user: ?*anyopaque,
    malloc: *const fn (?*anyopaque, usize) callconv(.c) ?*anyopaque,
    realloc: *const fn (?*anyopaque, ?*anyopaque, usize) callconv(.c) ?*anyopaque,
    free: *const fn (?*anyopaque, ?*anyopaque) callconv(.c) void,
};
extern fn ink_budget_init(b: *pool_mod.Budget, cap: usize, alloc: *AllocContext) c_int;
extern fn ink_budget_close(b: *pool_mod.Budget) void;
extern fn ink_budget_lost(b: *const pool_mod.Budget) c_uint;
extern fn ink_budget_settle(b: *pool_mod.Budget) void;
extern fn ink_budget_failure(b: *const pool_mod.Budget, code: c_int) c_int;
const fz_error_system: c_int = 2;

test "a refusal MuPDF's retry gets past is not lost; one it goes on without is" {
    var b: pool_mod.Budget = undefined;
    var ac: AllocContext = undefined;
    try testing.expectEqual(@as(c_int, 0), ink_budget_init(&b, 256 * 1024, &ac));
    defer ink_budget_close(&b);

    // MuPDF's way: refused, its cache evicted (a free), the same size again.
    const cache = ac.malloc(ac.user, 150 * 1024).?;
    try testing.expectEqual(@as(?*anyopaque, null), ac.malloc(ac.user, 150 * 1024));
    try testing.expectEqual(@as(c_uint, 1), ink_budget_lost(&b)); // pending
    ac.free(ac.user, cache);
    const retried = ac.malloc(ac.user, 150 * 1024).?;
    try testing.expectEqual(@as(c_uint, 0), ink_budget_lost(&b));
    try testing.expectEqual(@as(c_uint, 1), b.refusals);

    // Refused, and MuPDF went on to something else: lost.
    try testing.expectEqual(@as(?*anyopaque, null), ac.malloc(ac.user, 1024 * 1024));
    _ = ac.malloc(ac.user, 64).?;
    try testing.expectEqual(@as(c_uint, 1), ink_budget_lost(&b));

    // Refused with nothing after it, then a new page: settled as lost.
    try testing.expectEqual(@as(?*anyopaque, null), ac.realloc(ac.user, retried, 1024 * 1024));
    ink_budget_settle(&b);
    try testing.expectEqual(@as(c_uint, 2), ink_budget_lost(&b));
    try testing.expectEqual(@as(c_uint, 2), b.unrecovered);
    try testing.expectEqual(@as(usize, 0), b.pending);
}

test "an out-of-memory error is the system's while its failure is on record, whatever came after" {
    var b: pool_mod.Budget = undefined;
    var ac: AllocContext = undefined;
    try testing.expectEqual(@as(c_int, 0), ink_budget_init(&b, 256 * 1024, &ac));
    defer ink_budget_close(&b);

    try testing.expectEqual(@as(c_int, -2), ink_budget_failure(&b, fz_error_system));
    // As if `mmap` had failed once, and MuPDF had allocated since.
    b.system_failures = 1;
    try testing.expectEqual(@as(c_int, -1), ink_budget_failure(&b, fz_error_system));
    // An error of another kind stays the file's.
    try testing.expectEqual(@as(c_int, -2), ink_budget_failure(&b, 1));
    // A refusal MuPDF got past on its retry changes nothing.
    b.refusals = 1;
    try testing.expectEqual(@as(c_int, -1), ink_budget_failure(&b, fz_error_system));
    // One it went on without makes it the ceiling's first.
    b.unrecovered = 1;
    try testing.expectEqual(@as(c_int, -6), ink_budget_failure(&b, fz_error_system));
}

extern fn ink_hb_blocks() c_long;
extern fn ink_hb_allocs() c_ulong;

// HarfBuzz keeps a few hundred bytes in statics for the life of the process. From a
// document's pool, they were unmapped at its close, and the next document
// that shaped text crashed the server. `freetext-rich.pdf`: a FreeText comment
// with rich text and no appearance, which MuPDF lays out (HTML, HarfBuzz) as
// page 1 loads.
test "documents that shape text, one after another, neither crash nor leave HarfBuzz's blocks to grow" {
    const before = ink_hb_allocs();
    const first = try probeFixtureMeasured("backend/pdf/testdata/freetext-rich.pdf");
    _ = try first.result;
    try testing.expectEqual(@as(u64, 0), first.held_after);
    // HarfBuzz was reached, or this test proves nothing.
    try testing.expect(ink_hb_allocs() > before);
    const kept = ink_hb_blocks();
    for (0..4) |_| {
        const again = try probeFixtureMeasured("backend/pdf/testdata/freetext-rich.pdf");
        _ = try again.result;
        try testing.expectEqual(@as(u64, 0), again.held_after);
    }
    try testing.expectEqual(kept, ink_hb_blocks());
}
