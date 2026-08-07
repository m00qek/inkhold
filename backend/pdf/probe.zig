//! The Zig face of `probe.c` — MuPDF's answer to "what shape is this PDF?".
//!
//! Everything that touches MuPDF is on the other side of this boundary, and it
//! has to stay that way: `fz_try`/`fz_catch` are `setjmp`/`longjmp`, and a Zig
//! frame inside one is undefined behaviour. So this file declares the C entry
//! point and converts its result into a Zig error union — no MuPDF type ever
//! appears here.
//!
//! See `docs/scratch/pdf-index.md`.

const std = @import("std");

/// Mirrors `struct ink_pdf_info` in `probe.c`. `extern struct` so the layout is
/// the C one rather than Zig's (which is free to reorder).
const Info = extern struct {
    pages: i32,
    width: f32,
    height: f32,
};

extern fn ink_pdf_probe(fd: c_int, out: *Info) c_int;

/// Why a PDF has no shape. Every one of these is a VERDICT about the file, not
/// a transient failure — the caller records it so the file is never probed
/// again, which is what stops the deferred worker retrying it for ever.
pub const Error = error{
    /// MuPDF could not allocate a context. The only one here that is about US
    /// rather than the file, and the only one worth retrying.
    NoContext,
    /// Not a PDF, or damaged past MuPDF's repair.
    Unopenable,
    /// Opens, but needs a password. Nothing to read without one.
    Encrypted,
    /// Opened, but reports no pages — or a page 1 with a degenerate box, which
    /// is the same thing as far as a shape is concerned.
    NoPages,
};

/// What the index stores for a PDF.
pub const Shape = struct {
    pages: u32,
    /// Page 1 in POINTS, already rotated and cropped (`fz_bound_page`). Not the
    /// `/MediaBox` — see `probe.c` for why that distinction has already cost
    /// this project twice.
    width: f32,
    height: f32,

    /// The aspect the gallery reserves a tile with.
    pub fn aspect(self: Shape) f32 {
        return self.width / self.height;
    }
};

/// Probe an already-open PDF.
///
/// A FILE, NOT A PATH. The blob store hands out descriptors (`BlobStore.open`)
/// and holds only a directory HANDLE — this `Io.Dir` has no `realpath`, so there
/// is no path to pass without threading the store's root down from the config.
/// Taking the descriptor also closes a TOCTOU window and makes the answer
/// independent of the process's working directory. MuPDF streams from it and
/// never closes it (`probe.c` dups for its own `FILE*`).
pub fn probeFile(file: std.Io.File) Error!Shape {
    var info: Info = undefined;
    return switch (ink_pdf_probe(file.handle, &info)) {
        0 => .{
            .pages = @intCast(info.pages),
            .width = info.width,
            .height = info.height,
        },
        -1 => Error.NoContext,
        -2 => Error.Unopenable,
        -3 => Error.Encrypted,
        -4 => Error.NoPages,
        // The C side returns only the five above. A new code reaching here means
        // the two files have drifted, which is worth failing loudly over rather
        // than silently treating as "unopenable".
        else => Error.Unopenable,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;

/// Open `path` relative to the build root and probe it. Test-only: the server
/// gets its descriptor from the blob store, never from a path.
fn probePath(path: []const u8) Error!Shape {
    const f = std.Io.Dir.cwd().openFile(testing.io, path, .{}) catch return Error.Unopenable;
    defer f.close(testing.io);
    return probeFile(f);
}

test "a file that is not a PDF is a verdict, not a crash" {
    // `build.zig` is a real, readable, definitely-not-a-PDF file, so this needs
    // no temp file and cannot collide with a parallel test.
    try testing.expectError(Error.Unopenable, probePath("build.zig"));
}

test "a missing file is Unopenable rather than a hang or a panic" {
    try testing.expectError(Error.Unopenable, probePath("/nonexistent/definitely/not/here.pdf"));
}

test "a real PDF reports its page count and its page-1 box, in points" {
    // The wasm ABI suite's own fixture, so both halves of the app are asserted
    // against the same file — and it is the same 2:1 page the gallery e2e
    // (`pdfThumbnail.spec.ts`) expects a tile to take its shape from. That test
    // exists because nothing on the wire states a PDF's shape; this states it.
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
    // THE ASSERTION THIS WHOLE FILE EXISTS FOR. `testdata/rotate90.pdf` is a
    // 200x100 MediaBox with `/Rotate 90`, so the honest answer is 100x200. A
    // hand-rolled parser reading `/MediaBox` would say 200x100 and be wrong in
    // the one way this project has already been wrong twice: the export put ink
    // ninety degrees out on a rotated page, and `pdf-links.md` §2 records the
    // same trap for link rects.
    const shape = probePath("backend/pdf/testdata/rotate90.pdf") catch |e| switch (e) {
        Error.Unopenable => return error.SkipZigTest,
        else => return e,
    };
    try testing.expectEqual(@as(u32, 1), shape.pages);
    try testing.expectEqual(@as(f32, 100), shape.width);
    try testing.expectEqual(@as(f32, 200), shape.height);
    try testing.expect(shape.aspect() < 1); // portrait once rotated
}
