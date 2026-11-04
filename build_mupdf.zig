//! Compiling the vendored MuPDF: flag sets, source lists, and the native and wasm libraries.

const std = @import("std");

/// Flags only the wasm target uses; `mupdf_trim_flags` is shared with the native
/// build so the browser and server cannot disagree about a document.
const mupdf_wasm_only = [_][]const u8{
    // The wasm exception-handling contract (see `buildMupdfWasm`).
    "-fwasm-exceptions",
    "-mllvm",
    "-wasm-enable-sjlj",

    // wasi-libc has no `mkstemp`; `pdf_shim.c` stubs it and clang 21 errors on
    // the implicit declaration otherwise.
    "-Wno-implicit-function-declaration",
};

// Size trim, measured: NO_CJK drops the CJK CMap tables (-881 KB, not covered by
// TOFU_CJK), HYPHEN (-643 KB), TOFU/TOFU_CJK keep only the 14 base-35 fonts, JPX
// (-227 KB) degrades to "unsupported image". Formats kept: PDF, EPUB, FB2, CBZ,
// XPS.
const mupdf_trim_flags = [_][]const u8{
    "-DNDEBUG",

    "-DTOFU",
    "-DTOFU_CJK",
    "-DNO_CJK",

    "-DFZ_ENABLE_JS=0",
    "-DFZ_ENABLE_JPX=0",
    "-DFZ_ENABLE_HYPHEN=0",
    "-DFZ_ENABLE_SVG=0",
    "-DFZ_ENABLE_MD=0",
    "-DFZ_ENABLE_MOBI=0",
    "-DFZ_ENABLE_OFFICE=0",
    "-DFZ_ENABLE_BARCODE=0",
    "-DFZ_ENABLE_BROTLI=0",
    "-DFZ_ENABLE_DOCX_OUTPUT=0",
    "-DFZ_ENABLE_ODT_OUTPUT=0",
    "-DFZ_ENABLE_OCR_OUTPUT=0",

    // lcms2 is Artifex's multi-threaded fork, under a symbol prefix.
    "-DHAVE_LCMS2MT",
    "-DLCMS2MT_PREFIX=lcms2mt_",

    "-w",
};

/// UBSan off for vendored MuPDF only (never `backend/pdf/*.c`). `zig cc` traps
/// UB at Debug/ReleaseSafe with no message, and lcms2 in the text pass's colour
/// pipeline trips it (a function-pointer cast in `cmsopt.c` on x86-64, a
/// different site in `cmsxform.c` on armv6), so a narrower opt-out does not work.
const mupdf_vendor_only = [_][]const u8{"-fno-sanitize=undefined"};

const mupdf_wasm_flags = mupdf_wasm_only ++ mupdf_trim_flags;

/// Native flags: no exception-handling contract and no `mkstemp` stub needed.
const mupdf_native_flags = mupdf_trim_flags;

/// Per-library build flags, mirroring MuPDF's own `Makelists` (`*_BUILD_CFLAGS`).
const mupdf_freetype_flags = [_][]const u8{
    "-DFT_CONFIG_MODULES_H=\"slimftmodules.h\"",
    "-DFT_CONFIG_OPTIONS_H=\"slimftoptions.h\"",
    "-DFT2_BUILD_LIBRARY",
};

const mupdf_gumbo_flags = [_][]const u8{"-std=c99"};

const mupdf_zlib_flags = [_][]const u8{ "-DHAVE_UNISTD_H", "-DHAVE_STDARG_H" };

const mupdf_jbig2dec_flags = [_][]const u8{
    "-DHAVE_STDINT_H",
    "-DJBIG_EXTERNAL_MEMENTO_H=\"mupdf/memento.h\"",
};

const mupdf_harfbuzz_flags = [_][]const u8{
    "-std=gnu++11",
    "-fno-exceptions",
    "-fno-rtti",
    "-fno-threadsafe-statics",
    "-fvisibility-inlines-hidden",
    "-DHAVE_FALLBACK=1",
    "-DHAVE_FREETYPE",
    "-DHAVE_OT",
    "-DHAVE_ROUND",
    "-DHAVE_UCDN",
    "-DHB_NO_MT",
    "-DHB_NO_PRAGMA_GCC_DIAGNOSTIC",
    // HarfBuzz allocates through MuPDF's allocator, so the store cap bounds shaping too.
    "-Dhb_malloc_impl=fz_hb_malloc",
    "-Dhb_calloc_impl=fz_hb_calloc",
    "-Dhb_free_impl=fz_hb_free",
    "-Dhb_realloc_impl=fz_hb_realloc",
};

/// MuPDF sources we skip. `office.c`/`mobi.c` are not guarded internally, so the
/// `FZ_ENABLE_*` flags alone do not remove them.
const mupdf_excluded_sources = [_][]const u8{
    "tessocr.cpp", // OCR — needs tesseract + leptonica
    "zxingbarcode.cpp", // barcodes — needs zxing-cpp + zint (C++20)
    "leptonica-wrap.c", // ditto, leptonica
    "office.c", // FZ_ENABLE_OFFICE=0, but the file itself is unguarded
    "mobi.c", // FZ_ENABLE_MOBI=0, ditto
    "md.c", // FZ_ENABLE_MD=0 — guarded, but would want cmark-gfm's headers
    // Upstream bug: includes `<openjpeg.h>` above its `FZ_ENABLE_JPX` guard.
    "encode-jpx.c",
    // Upstream bug: its disabled stub has the wrong signature, which `wasm-ld`
    // turns into a trapping call. `pdf_shim.c` provides correct stubs.
    "load-jpx.c",
};

/// Read a `*_SRC += path` list out of MuPDF's own `Makelists`. Thirdparty trees
/// cannot be directory-walked (FreeType `#include`s sources into each other).
fn mupdfListedSources(
    b: *std.Build,
    dep: *std.Build.Dependency,
    groups: []const []const u8,
) []const []const u8 {
    var root_dir = dep.builder.root.openDir(b.graph.io, ".", .{}) catch
        @panic("mupdf: cannot open the pinned dependency");
    defer root_dir.close(b.graph.io);
    const text = root_dir.readFileAlloc(
        b.graph.io,
        "Makelists",
        b.allocator,
        .limited(4 << 20),
    ) catch @panic("mupdf: cannot read Makelists from the pinned dependency");

    var out: std.ArrayList([]const u8) = .empty;
    var lines = std.mem.tokenizeScalar(u8, text, '\n');
    lines: while (lines.next()) |raw| {
        const line = std.mem.trim(u8, raw, " \t\r");
        for (groups) |group| {
            const prefix = b.fmt("{s}_SRC +=", .{group});
            if (!std.mem.startsWith(u8, line, prefix)) continue;
            const path = std.mem.trim(u8, line[prefix.len..], " \t");
            if (path.len == 0) continue :lines;
            if (isExcludedMupdfSource(path)) continue :lines;
            out.append(b.allocator, path) catch @panic("OOM");
            continue :lines;
        }
    }
    if (out.items.len == 0) @panic("mupdf: Makelists yielded no sources — did the pin change?");
    return out.toOwnedSlice(b.allocator) catch @panic("OOM");
}

/// List MuPDF's own sources in `sub_path`, sorted (the Makefile's wildcard).
fn mupdfDirSources(
    b: *std.Build,
    dep: *std.Build.Dependency,
    sub_path: []const u8,
    extension: []const u8,
) []const []const u8 {
    var dir = dep.builder.root.openDir(b.graph.io, sub_path, .{ .iterate = true }) catch
        @panic(b.fmt("mupdf: cannot open {s} in the pinned dependency", .{sub_path}));
    defer dir.close(b.graph.io);

    var out: std.ArrayList([]const u8) = .empty;
    var it = dir.iterate();
    while (it.next(b.graph.io) catch @panic("mupdf: directory iteration failed")) |entry| {
        if (entry.kind != .file) continue;
        if (!std.mem.endsWith(u8, entry.name, extension)) continue;
        if (isExcludedMupdfSource(entry.name)) continue;
        out.append(b.allocator, b.pathJoin(&.{ sub_path, b.dupe(entry.name) })) catch @panic("OOM");
    }
    // Sorted so the build's cache key is stable across filesystems.
    const files = out.toOwnedSlice(b.allocator) catch @panic("OOM");
    std.mem.sort([]const u8, files, {}, struct {
        fn lessThan(_: void, a: []const u8, c: []const u8) bool {
            return std.mem.order(u8, a, c) == .lt;
        }
    }.lessThan);
    return files;
}

fn isExcludedMupdfSource(path: []const u8) bool {
    const name = std.fs.path.basename(path);
    for (mupdf_excluded_sources) |excluded| {
        if (std.mem.eql(u8, name, excluded)) return true;
    }
    return false;
}

/// Include order mirrors MuPDF's `THIRD_CFLAGS`; `include/mupdf` goes last and
/// is only for HarfBuzz's `ucdn.h`.
const mupdf_includes = [_][]const u8{
    "include",
    "thirdparty/freetype/include",
    "scripts/freetype",
    "thirdparty/gumbo-parser/src",
    "thirdparty/harfbuzz/src",
    "thirdparty/libjpeg",
    "scripts/libjpeg",
    "thirdparty/lcms2/include",
    "thirdparty/zlib",
    "thirdparty/jbig2dec",
    "include/mupdf",
};

/// MuPDF's own source directories. Native keeps the wasm set: `--gc-sections`
/// already drops the unused handlers.
const mupdf_source_dirs = [_][]const u8{
    "source/fitz",
    "source/pdf",
    "source/xps",
    "source/html",
    "source/cbz",
    "source/reflow",
};

const MupdfGroup = struct { name: []const u8, extra: []const []const u8 };

const mupdf_third_groups = [_]MupdfGroup{
    .{ .name = "FREETYPE", .extra = &mupdf_freetype_flags },
    .{ .name = "GUMBO", .extra = &mupdf_gumbo_flags },
    .{ .name = "LIBJPEG", .extra = &.{} },
    .{ .name = "LCMS2", .extra = &.{} },
    .{ .name = "ZLIB", .extra = &mupdf_zlib_flags },
    .{ .name = "JBIG2DEC", .extra = &mupdf_jbig2dec_flags },
};

/// Adds MuPDF's own sources, fonts and thirdparty tree to `mod`, for both targets.
fn addMupdfSources(
    b: *std.Build,
    dep: *std.Build.Dependency,
    mod: *std.Build.Module,
    flags: []const []const u8,
) void {
    for (&mupdf_includes) |inc| mod.addIncludePath(dep.path(inc));

    // Vendored code only; `backend/pdf/*.c` is added by the caller without this.
    const vflags = concatFlags(b, flags, &mupdf_vendor_only);

    for (&mupdf_source_dirs) |sub| {
        mod.addCSourceFiles(.{
            .root = dep.path(""),
            .files = mupdfDirSources(b, dep, sub, ".c"),
            .flags = vflags,
        });
    }
    // The 14 URW base-35 faces, pre-hexdumped in the tarball's `generated/`.
    mod.addCSourceFiles(.{
        .root = dep.path(""),
        .files = mupdfDirSources(b, dep, "generated/resources/fonts/urw", ".c"),
        .flags = vflags,
    });
    for (&mupdf_third_groups) |group| {
        mod.addCSourceFiles(.{
            .root = dep.path(""),
            .files = mupdfListedSources(b, dep, &.{group.name}),
            .flags = concatFlags(b, vflags, group.extra),
        });
    }
    mod.addCSourceFiles(.{
        .root = dep.path(""),
        .files = mupdfListedSources(b, dep, &.{"HARFBUZZ"}),
        .flags = concatFlags(b, vflags, &mupdf_harfbuzz_flags),
    });
}

/// MuPDF for the server (`backend/pdf/probe.c`, `backend/pdf/text.c`).
pub fn buildMupdfNative(
    b: *std.Build,
    dep: *std.Build.Dependency,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
) *std.Build.Step.Compile {
    const mod = b.createModule(.{ .target = target, .optimize = optimize });
    mod.link_libc = true;
    mod.link_libcpp = true; // HarfBuzz is C++
    addMupdfSources(b, dep, mod, &mupdf_native_flags);
    mod.addCSourceFile(.{
        .file = b.path("backend/pdf/probe.c"),
        .flags = &mupdf_native_flags,
    });
    // Separate from `probe.c`: the text pass caps the MuPDF store at 4 MB, the
    // probe runs at the default.
    mod.addCSourceFile(.{
        .file = b.path("backend/pdf/text.c"),
        .flags = &mupdf_native_flags,
    });
    return b.addLibrary(.{ .name = "mupdf-native", .root_module = mod, .linkage = .static });
}

// MuPDF compiles at `wasm32-wasi+exception_handling` (wasi-libc's setjmp.h
// requires it for `fz_try`), but the final link must use plain `wasm32-wasi`
// because Zig's rebuilt wasi-libc fails with the feature on. So: a static library
// at one target linked at another, plus Zig's vendored setjmp `rt.c` compiled
// without `-wasm-enable-sjlj`. Browser floor: Chrome 95, Firefox 131, Safari 18.4.
pub fn buildMupdfWasm(b: *std.Build, dep: *std.Build.Dependency) *std.Build.Step.Compile {
    const eh_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .wasi,
        .cpu_features_add = std.Target.wasm.featureSet(&.{.exception_handling}),
    });
    const mod = b.createModule(.{ .target = eh_target, .optimize = .ReleaseSmall });
    mod.link_libc = true;
    mod.link_libcpp = true;

    addMupdfSources(b, dep, mod, &mupdf_wasm_flags);

    mod.addCSourceFile(.{
        .file = b.path("webapp/wasm/pdf_shim.c"),
        .flags = &mupdf_wasm_flags,
    });

    // Zig's vendored setjmp runtime, located via the lib dir so any toolchain works.
    mod.addCSourceFile(.{
        .file = std.Build.LazyPath.zig_lib.path(b, "libc/wasi/libc-top-half/musl/src/setjmp/wasm32/rt.c"),
        .flags = &.{"-fwasm-exceptions"}, // NB: no `-wasm-enable-sjlj` here
    });

    return b.addLibrary(.{ .name = "mupdf-wasm", .root_module = mod, .linkage = .static });
}

fn concatFlags(b: *std.Build, a: []const []const u8, c: []const []const u8) []const []const u8 {
    const out = b.allocator.alloc([]const u8, a.len + c.len) catch @panic("OOM");
    @memcpy(out[0..a.len], a);
    @memcpy(out[a.len..], c);
    return out;
}
