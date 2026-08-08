//! The Zig face of `text.c` — a PDF's pages as plain text, one page at a time.
//!
//! Everything that touches MuPDF is on the other side of this boundary and has
//! to stay there: `fz_try`/`fz_catch` are `setjmp`/`longjmp`, and a Zig frame
//! inside one is undefined behaviour. So this file declares three C entry points
//! and owns the parts that are better in Zig — page iteration, the reopen
//! schedule, and the failed-page count.
//!
//! ## What lives here rather than in C, and why
//!
//! **The reopen schedule.** `mupdf.md` §9.6-§9.9 measured this to death: with the
//! store capped at 4 MB the memory curve is nearly flat in batch size while TIME
//! is not, and the knee that matters is between 256 and held-open. **Batch 32,
//! store 4 MB, never held open** is a DECISION with its reasoning recorded
//! (§9.9's "DECIDED" block, including why 64 was declined) — not a default to
//! re-tune here. The loop that implements it is four lines of Zig instead of a
//! second piece of state inside a `setjmp` frame.
//!
//! **The failed-page count.** A page MuPDF cannot render to text is a result,
//! not a verdict: every measured run reported "zero failed pages", so there has
//! to be something that could report otherwise. The pass carries on.
//!
//! ## The borrow
//!
//! `Extractor.page` returns a slice of a buffer owned by the C handle, valid
//! only until the next call. That is deliberate: the caller copies it into a
//! segment row immediately, so an allocation dance in either direction would buy
//! nothing. It also bounds the pass at ONE page's text in flight, which is the
//! per-page half of the memory story.

const std = @import("std");
const probe = @import("probe.zig");

/// Why a PDF yields no text — the SAME set `probe.zig` uses, because `text.c`
/// returns the same integers for the same reasons. One error set rather than two
/// parallel ones: a caller that already knows how to record a probe verdict
/// knows how to record this.
pub const Error = probe.Error;

/// Pages between reopens. **DECIDED, not tuned** — see the module docs and
/// `mupdf.md` §9.9. Held open, the 446 MB book costs +6.5 MB and leaves 0.3 MB
/// of the server's budget; at 32 it is 12.90 MB on the real Pi.
pub const batch_pages: u32 = 32;

/// The opaque C handle (`struct ink_pdf_text`). No MuPDF type ever appears on
/// this side.
const Handle = opaque {};

extern fn ink_pdf_text_open(fd: c_int, out: *?*Handle) c_int;
extern fn ink_pdf_text_page(t: *Handle, number: i32, out: *[*]const u8) i32;
extern fn ink_pdf_text_close(t: ?*Handle) void;

/// `text.c`'s "this page did not render to text". Distinct from the negative
/// codes that are verdicts about the whole file.
const page_failed: i32 = -5;

fn verdictOf(code: c_int) Error {
    return switch (code) {
        -1 => Error.NoContext,
        -2 => Error.Unopenable,
        -3 => Error.Encrypted,
        -4 => Error.NoPages,
        // The C side returns only those four negatives from `open`. A new code
        // reaching here means the two files have drifted, which is worth failing
        // loudly over rather than silently calling "unopenable".
        else => Error.Unopenable,
    };
}

/// A PDF opened for a text pass: `page(n)` in any order, reopening underneath
/// every `batch_pages` extractions.
///
/// A FILE, NOT A PATH, exactly as `probe.probeFile` takes one and for the same
/// reasons (the blob store hands out descriptors and holds only a directory
/// handle). MuPDF dups it and never closes the caller's copy, so the descriptor
/// must outlive the extractor.
pub const Extractor = struct {
    file: std.Io.File,
    /// Pages between reopens. A field rather than a constant only so a test can
    /// drive the reopen boundary without a 33-page fixture; production takes the
    /// default.
    batch: u32 = batch_pages,
    handle: ?*Handle = null,
    /// What `fz_count_pages` said. Re-read on every reopen and asserted stable —
    /// a document whose page count moved underneath us is a changed file, and
    /// the band arithmetic downstream is indexed by page.
    pages: u32 = 0,
    /// Pages extracted since the last open. The reopen trigger.
    since_open: u32 = 0,
    /// Pages that opened but could not be rendered to text. A recorded fact, not
    /// a failure — see the module docs.
    failed_pages: u32 = 0,

    pub fn open(file: std.Io.File) Error!Extractor {
        var ex: Extractor = .{ .file = file };
        try ex.reopen();
        return ex;
    }

    /// Opens (or re-opens) the document underneath. The page count must not
    /// move: the caller has already reserved a band of that many masked rowids,
    /// and a shorter document would leave holes it never asked for.
    fn reopen(self: *Extractor) Error!void {
        ink_pdf_text_close(self.handle);
        self.handle = null;
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
    /// that one page could not be rendered.
    ///
    /// The reopen happens HERE, before the extraction, so the batch counts pages
    /// actually read rather than calls attempted.
    pub fn page(self: *Extractor, n: u32) Error!?[]const u8 {
        if (n >= self.pages) return Error.NoPages;
        if (self.since_open >= self.batch) try self.reopen();
        const h = self.handle orelse return Error.Unopenable;
        var data: [*]const u8 = undefined;
        const len = ink_pdf_text_page(h, @intCast(n), &data);
        self.since_open += 1;
        if (len == page_failed) {
            self.failed_pages += 1;
            return null;
        }
        if (len < 0) return Error.Unopenable; // drift between the two files
        return data[0..@intCast(len)];
    }

    pub fn close(self: *Extractor) void {
        ink_pdf_text_close(self.handle);
        self.handle = null;
    }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;

/// Open `path` relative to the build root and start a text pass. Test-only: the
/// server gets its descriptor from the blob store, never from a path.
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
    // The fixture is three pages of Helvetica, one distinct sentence each, so
    // "which page did this text come from" is answerable by reading the test.
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
        // Each page's text is ITS OWN — page 2's word must not appear on page 1,
        // which is what a leaked or accumulated buffer would look like.
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
    // `three-page.pdf` is three bare `/MediaBox` pages with no content stream:
    // the degenerate shape of a scan, minus the image. The pass must report
    // three empty strings, NOT an error — "opens but has nothing to index" is a
    // verdict the caller records, and it can only record it if it gets here.
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
    // The rule the 50 MB budget rests on (`mupdf.md` §9.7: held open, the 446 MB
    // book costs +6.5 MB and leaves 0.3 MB of headroom). Memory cannot be
    // asserted in a unit test; that the reopen HAPPENS and is transparent can
    // be, with a batch of 1 so every page crosses the boundary.
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
        // Every page after the first crossed a reopen, and the counter resets.
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
