//! The faces a book (EPUB, FB2) is set in, embedded for the wasm build. The
//! package ships them as font files but not, unlike the base 14, pre-hexdumped
//! into C, so they are exported here.
//!
//! Charis SIL, MuPDF's default book face (`TOFU_NOTO` in build_mupdf.zig keeps
//! MuPDF asking for it), under the names `fitz/font-table.h` declares.
//!
//! Noto Serif, the one Noto face a book needs: MuPDF's fallback for a
//! character Charis lacks in the Latin, Greek, Cyrillic and common scripts,
//! such as U+FEFF, which Moby Dick has 1,661 of. It maps them at no width;
//! without it they take a stand-in's width and the lines, and pages, drift.
//! `TOFU_NOTO` drops it with every other Noto face, so the shim hands it to
//! MuPDF through the system-fallback hook (`ink_fallback_font`).

fn font(comptime name: []const u8) type {
    return struct {
        const bytes = @embedFile(name);
        const data: [bytes.len]u8 = bytes.*;
        const size: c_uint = bytes.len;
    };
}

const regular = font("CharisSIL.cff");
const bold = font("CharisSIL-Bold.cff");
const italic = font("CharisSIL-Italic.cff");
const bold_italic = font("CharisSIL-BoldItalic.cff");
const noto_serif = font("NotoSerif-Regular.otf");

comptime {
    @export(&regular.data, .{ .name = "_binary_CharisSIL_cff" });
    @export(&regular.size, .{ .name = "_binary_CharisSIL_cff_size" });
    @export(&bold.data, .{ .name = "_binary_CharisSIL_Bold_cff" });
    @export(&bold.size, .{ .name = "_binary_CharisSIL_Bold_cff_size" });
    @export(&italic.data, .{ .name = "_binary_CharisSIL_Italic_cff" });
    @export(&italic.size, .{ .name = "_binary_CharisSIL_Italic_cff_size" });
    @export(&bold_italic.data, .{ .name = "_binary_CharisSIL_BoldItalic_cff" });
    @export(&bold_italic.size, .{ .name = "_binary_CharisSIL_BoldItalic_cff_size" });
    @export(&noto_serif.data, .{ .name = "ink_noto_serif" });
    @export(&noto_serif.size, .{ .name = "ink_noto_serif_size" });
}
