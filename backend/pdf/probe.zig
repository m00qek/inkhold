//! Zig face of `probe.c`: MuPDF's page count and page-1 shape for a PDF.

const std = @import("std");

/// Mirrors `struct ink_pdf_info` in `probe.c`.
const Info = extern struct {
    pages: i32,
    width: f32,
    height: f32,
};

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
        else => Error.Unopenable,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;

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
