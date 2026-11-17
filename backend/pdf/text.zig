//! Zig face of `text.c`: a PDF's pages as plain text, one page at a time, with
//! the reopen schedule and the failed-page count.

const std = @import("std");
const probe = @import("probe.zig");

/// The same set as `probe.zig`: `text.c` returns the same integers.
pub const Error = probe.Error;

/// Pages between reopens; a measured decision, not a knob. Held open, a 446 MB
/// book costs +6.5 MB and leaves 0.3 MB of the server's budget.
pub const batch_pages: u32 = 32;

const Handle = opaque {};

extern fn ink_pdf_text_open(fd: c_int, out: *?*Handle) c_int;
extern fn ink_pdf_text_page(t: *Handle, number: i32, out: *[*]const u8) i32;
extern fn ink_pdf_text_close(t: ?*Handle) void;
extern fn ink_pdf_text_peak(t: ?*const Handle) u64;

/// `text.c`'s "this page did not render to text".
const page_failed: i32 = -5;
/// `text.c`'s "this page's text needed more than the memory ceiling".
const page_too_large: i32 = -7;

fn verdictOf(code: c_int) Error {
    return switch (code) {
        -1 => Error.NoContext,
        -2 => Error.Unopenable,
        -3 => Error.Encrypted,
        -4 => Error.NoPages,
        -6 => Error.TooLarge,
        else => Error.Unopenable,
    };
}

/// A PDF opened for a text pass, reopening every `batch_pages` extractions.
/// The descriptor must outlive the extractor; MuPDF dups it.
pub const Extractor = struct {
    file: std.Io.File,
    /// A field only so a test can drive the reopen boundary.
    batch: u32 = batch_pages,
    handle: ?*Handle = null,
    /// Asserted stable across reopens: downstream bands are indexed by page.
    pages: u32 = 0,
    since_open: u32 = 0,
    /// Pages that opened but could not be rendered to text.
    failed_pages: u32 = 0,
    /// Of those, the pages whose text needed more than the memory ceiling:
    /// what makes the text pass's verdict `too_large`.
    too_large_pages: u32 = 0,
    /// The most any of its MuPDF contexts held at once (`budget.h`).
    peak_bytes: u64 = 0,

    pub fn open(file: std.Io.File) Error!Extractor {
        var ex: Extractor = .{ .file = file };
        try ex.reopen();
        return ex;
    }

    /// The page count must not move: the caller reserved a band of that many
    /// masked rowids.
    fn reopen(self: *Extractor) Error!void {
        self.release();
        var h: ?*Handle = null;
        const rc = ink_pdf_text_open(self.file.handle, &h);
        if (rc <= 0) return verdictOf(rc);
        const n: u32 = @intCast(rc);
        if (self.pages != 0 and n != self.pages) return Error.Unopenable;
        self.pages = n;
        self.handle = h;
        self.since_open = 0;
    }

    /// Page `n`'s text (0-based), borrowed until the next call, or null when
    /// that page could not be rendered. Batches count pages read, not calls.
    pub fn page(self: *Extractor, n: u32) Error!?[]const u8 {
        if (n >= self.pages) return Error.NoPages;
        if (self.since_open >= self.batch) try self.reopen();
        const h = self.handle orelse return Error.Unopenable;
        var data: [*]const u8 = undefined;
        const len = ink_pdf_text_page(h, @intCast(n), &data);
        self.since_open += 1;
        if (len == page_failed or len == page_too_large) {
            self.failed_pages += 1;
            if (len == page_too_large) self.too_large_pages += 1;
            return null;
        }
        if (len < 0) return Error.Unopenable; // drift between the two files
        return data[0..@intCast(len)];
    }

    pub fn close(self: *Extractor) void {
        self.release();
    }

    fn release(self: *Extractor) void {
        self.peak_bytes = @max(self.peak_bytes, ink_pdf_text_peak(self.handle));
        ink_pdf_text_close(self.handle);
        self.handle = null;
    }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;

/// Test-only: the server gets descriptors from the blob store.
fn openPath(path: []const u8) Error!struct { f: std.Io.File, ex: Extractor } {
    const f = std.Io.Dir.cwd().openFile(testing.io, path, .{}) catch return Error.Unopenable;
    errdefer f.close(testing.io);
    return .{ .f = f, .ex = try Extractor.open(f) };
}

test "a file that is not a PDF is a verdict from the text pass too, not a crash" {
    try testing.expectError(Error.Unopenable, openPath("build.zig"));
}

test "a missing file is Unopenable rather than a hang or a panic" {
    try testing.expectError(Error.Unopenable, openPath("/nonexistent/definitely/not/here.pdf"));
}

test "every page of a text PDF comes back, in page order, as its own string" {
    var o = openPath("backend/pdf/testdata/text-three-page.pdf") catch |e| switch (e) {
        Error.Unopenable => return error.SkipZigTest, // not run from the build root
        else => return e,
    };
    defer o.f.close(testing.io);
    defer o.ex.close();

    try testing.expectEqual(@as(u32, 3), o.ex.pages);
    const want = [_][]const u8{ "Marmalade", "Quince", "Sourdough" };
    for (want, 0..) |w, i| {
        const text = (try o.ex.page(@intCast(i))).?;
        try testing.expect(std.mem.indexOf(u8, text, w) != null);
        // A leaked or accumulated buffer would show another page's word.
        for (want, 0..) |other, j| {
            if (i == j) continue;
            try testing.expect(std.mem.indexOf(u8, text, other) == null);
        }
    }
    try testing.expectEqual(@as(u32, 0), o.ex.failed_pages);
}

test "MuPDF's text is valid UTF-8, so the index copy needs no repair on the happy path" {
    var o = openPath("backend/pdf/testdata/text-three-page.pdf") catch |e| switch (e) {
        Error.Unopenable => return error.SkipZigTest,
        else => return e,
    };
    defer o.f.close(testing.io);
    defer o.ex.close();
    for (0..o.ex.pages) |i| {
        const text = (try o.ex.page(@intCast(i))).?;
        try testing.expect(std.unicode.utf8ValidateSlice(text));
    }
}

test "a PDF with no text at all yields empty pages — a result, not a failure" {
    // Bare `/MediaBox` pages with no content stream: empty strings, not errors.
    var o = openPath("backend/pdf/testdata/three-page.pdf") catch |e| switch (e) {
        Error.Unopenable => return error.SkipZigTest,
        else => return e,
    };
    defer o.f.close(testing.io);
    defer o.ex.close();

    try testing.expectEqual(@as(u32, 3), o.ex.pages);
    for (0..3) |i| try testing.expectEqualStrings("", (try o.ex.page(@intCast(i))).?);
    try testing.expectEqual(@as(u32, 0), o.ex.failed_pages);
}

test "THE REOPEN: the document is re-opened on the batch boundary and the text does not change" {
    // Batch of 1 so every page crosses the reopen boundary.
    var o = openPath("backend/pdf/testdata/text-three-page.pdf") catch |e| switch (e) {
        Error.Unopenable => return error.SkipZigTest,
        else => return e,
    };
    defer o.f.close(testing.io);
    defer o.ex.close();
    o.ex.batch = 1;

    var whole: [3][]const u8 = undefined;
    var bufs: [3][512]u8 = undefined;
    for (0..3) |i| {
        const t = (try o.ex.page(@intCast(i))).?;
        @memcpy(bufs[i][0..t.len], t);
        whole[i] = bufs[i][0..t.len];
        try testing.expectEqual(@as(u32, 1), o.ex.since_open);
    }
    try testing.expect(std.mem.indexOf(u8, whole[2], "Sourdough") != null);
    try testing.expectEqual(@as(u32, 3), o.ex.pages); // stable across every reopen
}

test "asking past the last page is a verdict, not an out-of-bounds read into MuPDF" {
    var o = openPath("backend/pdf/testdata/text-three-page.pdf") catch |e| switch (e) {
        Error.Unopenable => return error.SkipZigTest,
        else => return e,
    };
    defer o.f.close(testing.io);
    defer o.ex.close();
    try testing.expectError(Error.NoPages, o.ex.page(3));
    try testing.expectError(Error.NoPages, o.ex.page(9999));
}

/// Test-only: a fixture from the build root; a missing one or a refusing
/// MuPDF fails the test (see `probe.zig`'s `probeFixture`).
fn openFixture(path: []const u8) !struct { f: std.Io.File, ex: Extractor } {
    const f = try std.Io.Dir.cwd().openFile(testing.io, path, .{});
    errdefer f.close(testing.io);
    return .{ .f = f, .ex = try Extractor.open(f) };
}

test "an XPS's text comes back page by page, as a PDF's does" {
    var o = try openFixture("backend/pdf/testdata/text-three-page.xps");
    defer o.f.close(testing.io);
    defer o.ex.close();

    try testing.expectEqual(@as(u32, 3), o.ex.pages);
    const want = [_][]const u8{ "Marmalade", "Quince", "Sourdough" };
    for (want, 0..) |w, i| {
        const text = (try o.ex.page(@intCast(i))).?;
        try testing.expect(std.mem.indexOf(u8, text, w) != null);
    }
}

// The worker never runs a CBZ's text pass (`pdf_index.hasText`); MuPDF's
// answer for one is still pinned, so skipping it stays a saving, not a loss.
test "a CBZ has pages but no text: empty pages, not a failure" {
    var o = try openFixture("backend/pdf/testdata/two-page.cbz");
    defer o.f.close(testing.io);
    defer o.ex.close();

    try testing.expectEqual(@as(u32, 2), o.ex.pages);
    for (0..2) |i| try testing.expectEqualStrings("", (try o.ex.page(@intCast(i))).?);
}

test "nor does the text pass's (an EPUB of text alone)" {
    try testing.expectError(Error.Unopenable, openFixture("backend/pdf/testdata/one-chapter.epub"));
}

test {
    _ = probe; // so `pdf-release-test`, rooted here, runs the probe's tests too
}

extern fn ink_pdf_text_held_after_close(fd: c_int) i64;

test "a PDF whose font decompresses past the ceiling stops at it, and its page is too large" {
    // `font-bomb.pdf`: one page whose embedded font is 40 MiB of zeros, a few
    // KB compressed. MuPDF gives up on the font and reads the page with a
    // substitute, whose text may not be the page's: left out, as too large.
    var o = try openFixture("backend/pdf/testdata/font-bomb.pdf");
    defer o.f.close(testing.io);
    defer o.ex.close();
    try testing.expectEqual(@as(?[]const u8, null), try o.ex.page(0));
    try testing.expectEqual(@as(u32, 1), o.ex.too_large_pages);
    o.ex.close();
    try testing.expect(o.ex.peak_bytes > 0);
    try testing.expect(o.ex.peak_bytes <= probe.budgetBytes());
}

test "a page whose text alone passes the ceiling is a too-large page, not an empty one" {
    // `text-bomb.pdf`: page 1 shows four million characters from a content
    // stream of a few KB; page 2 says "Quince". Page 1's text is past the
    // ceiling, and page 2 is still read.
    var o = try openFixture("backend/pdf/testdata/text-bomb.pdf");
    defer o.f.close(testing.io);
    defer o.ex.close();
    try testing.expectEqual(@as(u32, 2), o.ex.pages);
    try testing.expectEqual(@as(?[]const u8, null), try o.ex.page(0));
    try testing.expectEqual(@as(u32, 1), o.ex.too_large_pages);
    const text = (try o.ex.page(1)).?;
    try testing.expect(std.mem.indexOf(u8, text, "Quince") != null);
    try testing.expectEqual(@as(u32, 1), o.ex.too_large_pages);
}

test "the ceiling's count returns to zero once a text pass's context is dropped" {
    // A miscounted `realloc` or `free` would leave bytes counted, or wrap.
    for ([_][]const u8{
        "backend/pdf/testdata/text-three-page.pdf",
        "backend/pdf/testdata/text-three-page.xps",
        "backend/pdf/testdata/font-bomb.pdf",
        "backend/pdf/testdata/text-bomb.pdf",
    }) |path| {
        const f = try std.Io.Dir.cwd().openFile(testing.io, path, .{});
        defer f.close(testing.io);
        try testing.expectEqual(@as(i64, 0), ink_pdf_text_held_after_close(f.handle));
    }
}

test "a text pass whose page is past the ceiling gives back every block" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try probe.writeManyForms(testing.io, tmp.dir, "forms.pdf", 60_000);
    const f = try tmp.dir.openFile(testing.io, "forms.pdf", .{});
    defer f.close(testing.io);
    // Opens (the page tree is small), then page 1 is past the ceiling.
    try testing.expectEqual(@as(i64, 0), ink_pdf_text_held_after_close(f.handle));
}
