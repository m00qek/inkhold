const std = @import("std");

/// Compile-time configuration for the vendored SQLite amalgamation
/// (`vendor/sqlite`, 3.53.3).
const sqlite_flags = [_][]const u8{
    // FTS5 is a build option, so vendoring guarantees it. Still required after
    // the server index went: `search/fuzzy.zig`'s `temp.token_fold` folds terms
    // through it for parity with the browser index, and migrations create and
    // drop `segment_fts`.
    "-DSQLITE_ENABLE_FTS5",

    // Serialized. `db_lock` is still needed for multi-statement atomicity; mode 1
    // turns any future off-lock use into slowness instead of memory corruption.
    "-DSQLITE_THREADSAFE=1",

    // ~2 MB page cache, so a connection that skips the PRAGMA cannot inherit
    // upstream's much larger default.
    "-DSQLITE_DEFAULT_CACHE_SIZE=-2000",

    // ---- Omissions, each verified unused ----

    "-DSQLITE_OMIT_UTF16",

    // Also removes the `load_extension()` SQL function from the device-facing surface.
    "-DSQLITE_OMIT_LOAD_EXTENSION",

    "-DSQLITE_OMIT_DEPRECATED",

    "-DSQLITE_OMIT_SHARED_CACHE",

    "-DSQLITE_OMIT_PROGRESS_CALLBACK",

    // ---- Hardening / size ----

    // With DQS on, a misspelled column silently becomes a string literal. All our
    // literals are single-quoted; MATCH quotes come from bound parameters.
    "-DSQLITE_DQS=0",

    "-DSQLITE_DEFAULT_MEMSTATUS=0",

    "-DSQLITE_LIKE_DOESNT_MATCH_BLOBS",

    // Kept on purpose: JSON (a future migration's `json_extract()` would fail only
    // at runtime) and AUTOINIT (an explicit init is easy to forget).
};

/// Hard-trimmed SQLite for the browser (`zig build wasm-sqlite-core`): `.spd`
/// deserialize + SELECTs, and the FTS5 search index. No files, no threads.
/// `OS_OTHER` drops the OS VFS (`sqlite_vfs_null.c` supplies a null one), and
/// `OMIT_WAL` is safe because the parser rewrites `.spd` WAL headers first.
/// `TEMP_STORE=3` is essential: the null VFS cannot open files, so a temp spill
/// (an FTS5 merge) would corrupt the index. Its absence is invisible in tests, so
/// `idx_open` checks `sqlite3_compileoption_used` and refuses to run without it.
const sqlite_core_wasm_flags = [_][]const u8{
    "-DSQLITE_THREADSAFE=0",
    "-DSQLITE_OS_OTHER=1",
    "-DSQLITE_OMIT_WAL",
    "-DSQLITE_OMIT_AUTOINIT",
    "-DSQLITE_OMIT_JSON",
    "-DSQLITE_OMIT_UTF16",
    "-DSQLITE_OMIT_LOAD_EXTENSION",
    "-DSQLITE_OMIT_DEPRECATED",
    "-DSQLITE_OMIT_SHARED_CACHE",
    "-DSQLITE_OMIT_PROGRESS_CALLBACK",
    "-DSQLITE_OMIT_AUTHORIZATION",
    "-DSQLITE_OMIT_COMPLETE",
    "-DSQLITE_OMIT_DECLTYPE",
    "-DSQLITE_OMIT_TRACE",
    "-DSQLITE_OMIT_AUTOVACUUM",
    "-DSQLITE_UNTESTABLE",
    "-DSQLITE_DQS=0",
    "-DSQLITE_DEFAULT_MEMSTATUS=0",
    "-DSQLITE_LIKE_DOESNT_MATCH_BLOBS",
    "-DSQLITE_ENABLE_FTS5",
    "-DSQLITE_TEMP_STORE=3",
    // No grammar-altering omissions (OMIT_TRIGGER/VIEW/CTE/...): they need a
    // regenerated Lemon parser, and the amalgamation then fails to compile.
};

/// Compiles the vendored SQLite amalgamation into `mod`, so the binary is
/// self-contained and FTS5 is guaranteed.
fn linkSqlite(b: *std.Build, mod: *std.Build.Module) void {
    mod.link_libc = true;
    // `@cImport({ @cInclude("sqlite3.h") })` in db/sqlite.zig resolves here.
    mod.addIncludePath(b.path("vendor/sqlite"));
    mod.addCSourceFile(.{
        .file = b.path("vendor/sqlite/sqlite3.c"),
        .flags = &sqlite_flags,
    });
}

// ---------------------------------------------------------------------------
// MuPDF (`zig build wasm-pdf-decode`, and the native server library)
// ---------------------------------------------------------------------------
//
// MuPDF 1.28.1 is a pinned tarball dependency (`build.zig.zon`), unpacked into
// `zig-pkg/`, and is never patched. Our shims are `webapp/wasm/pdf_shim.c` and
// `backend/pdf/*.c`.

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
    const text = dep.builder.build_root.handle.readFileAlloc(
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
    var dir = dep.builder.build_root.handle.openDir(b.graph.io, sub_path, .{ .iterate = true }) catch
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
fn buildMupdfNative(
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
fn buildMupdfWasm(b: *std.Build, dep: *std.Build.Dependency) *std.Build.Step.Compile {
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
    const zig_lib = b.graph.zig_lib_directory.path orelse
        @panic("mupdf: no Zig lib directory — cannot find the wasm setjmp runtime");
    mod.addCSourceFile(.{
        .file = .{ .cwd_relative = b.pathJoin(&.{
            zig_lib, "libc/wasi/libc-top-half/musl/src/setjmp/wasm32/rt.c",
        }) },
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

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Off by default so panic traces have symbols; container images strip
    // (58.4 MB -> 10.1 MB, ReleaseSafe musl).
    const strip = b.option(bool, "strip", "Strip debug info from the server binary") orelse false;

    // The package version from `build.zig.zon`, not `routes.api_version`.
    const build_options = b.addOptions();
    build_options.addOption([]const u8, "version", @import("build.zig.zon").version);

    // The `.note` parser as a target-agnostic module for native and wasm importers.
    const supernote = b.addModule("supernote", .{
        .root_source_file = b.path("parsers/note/src/root.zig"),
    });

    const wasm_target = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .freestanding });

    // ---- WebAssembly single-page decoder ----
    // One page's "SNPG" payload to RGBA8888; references only `page_payload`.
    const note_decode_mod = b.createModule(.{
        .root_source_file = b.path("webapp/wasm/note_decode.zig"),
        .target = wasm_target,
        .optimize = .ReleaseSmall,
    });
    note_decode_mod.addImport("supernote", supernote);
    const note_decode = b.addExecutable(.{ .name = "note-decode", .root_module = note_decode_mod });
    note_decode.entry = .disabled; // reactor: exported functions, no _start
    note_decode.rdynamic = true; // keep the `export fn`s
    const note_decode_step = b.step("wasm-note-decode", "Build the single-page RGBA decoder wasm");
    note_decode_step.dependOn(&b.addInstallArtifact(note_decode, .{}).step);

    // ---- TLS (ianic/tls.zig) ----
    const tls_dep = b.dependency("tls", .{ .target = target, .optimize = optimize });
    const tls_mod = tls_dep.module("tls");

    // The `.spd` parser, sharing the backend's single SQLite compile: only the
    // headers go here, and `linkSqlite` in the importing artifact supplies the
    // symbols.
    const spd_mod = b.createModule(.{
        .root_source_file = b.path("parsers/spd/src/root.zig"),
    });
    spd_mod.link_libc = true;
    spd_mod.addIncludePath(b.path("vendor/sqlite"));

    // The schema as a header-only module, so the wasm search index imports
    // `fts_tokenizer` from the same declaration as the server.
    const schema_mod = b.createModule(.{
        .root_source_file = b.path("backend/db/schema.zig"),
    });
    schema_mod.link_libc = true;
    schema_mod.addIncludePath(b.path("vendor/sqlite"));

    // ---- WebAssembly SQLite core: the `.spd` decoder and the search index ----
    // One artifact, two ABIs: SQLite is ~290 KB gzip of 362 KB, so two modules
    // would ship it twice. Targets WASI only for libc headers; the null VFS makes
    // no syscalls, which the ABI test checks under a real WASI.
    const wasi_target = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const sqlite_core_mod = b.createModule(.{
        .root_source_file = b.path("webapp/wasm/sqlite_core.zig"),
        .target = wasi_target,
        .optimize = .ReleaseSmall,
    });
    sqlite_core_mod.addImport("spd", spd_mod);
    sqlite_core_mod.addImport("schema", schema_mod);
    sqlite_core_mod.link_libc = true;
    sqlite_core_mod.addIncludePath(b.path("vendor/sqlite"));
    sqlite_core_mod.addCSourceFile(.{
        .file = b.path("vendor/sqlite/sqlite3.c"),
        .flags = &sqlite_core_wasm_flags,
    });
    sqlite_core_mod.addCSourceFile(.{
        .file = b.path("webapp/wasm/sqlite_vfs_null.c"),
        .flags = &sqlite_core_wasm_flags,
    });
    const sqlite_core = b.addExecutable(.{ .name = "sqlite-core", .root_module = sqlite_core_mod });
    // WASI reactor: `_initialize` plus the ABI, no `_start` (`entry = .disabled`
    // still emits one when wasi-libc is linked).
    sqlite_core.wasi_exec_model = .reactor;
    sqlite_core.rdynamic = true; // keep the `export fn`s
    const sqlite_core_step = b.step("wasm-sqlite-core", "Build the .spd decoder + search index wasm");
    sqlite_core_step.dependOn(&b.addInstallArtifact(sqlite_core, .{}).step);

    // Node-driven ABI test; the only check of `TEMP_STORE=3`. Separate from
    // `zig build test`, which must run without Node.
    const sqlite_core_abi_test = b.addSystemCommand(&.{ "node", "webapp/wasm/tests/sqlite_core_abi.mjs" });
    sqlite_core_abi_test.addFileArg(sqlite_core.getEmittedBin());
    sqlite_core_abi_test.addFileArg(b.path("parsers/spd/tests/fixtures/layers_hidden.spd"));
    sqlite_core_abi_test.expectExitCode(0);
    sqlite_core_abi_test.stdio = .inherit;
    const sqlite_core_test_step = b.step(
        "wasm-sqlite-core-test",
        "Drive both ABIs of the built sqlite-core wasm (needs Node)",
    );
    sqlite_core_test_step.dependOn(&sqlite_core_abi_test.step);

    // ---- WebAssembly PDF decoder (MuPDF) ----
    // Linked at plain `wasi_target`; see `buildMupdfWasm`.
    const mupdf_dep = b.dependency("mupdf", .{});
    const pdf_decode_mod = b.createModule(.{
        .root_source_file = b.path("webapp/wasm/pdf_decode.zig"),
        .target = wasi_target,
        .optimize = .ReleaseSmall,
    });
    pdf_decode_mod.link_libc = true;
    pdf_decode_mod.linkLibrary(buildMupdfWasm(b, mupdf_dep));
    const pdf_decode = b.addExecutable(.{ .name = "pdf-decode", .root_module = pdf_decode_mod });
    pdf_decode.wasi_exec_model = .reactor;
    pdf_decode.rdynamic = true; // keep the `export fn`s
    const pdf_decode_step = b.step("wasm-pdf-decode", "Build the PDF viewer decoder wasm (MuPDF)");
    pdf_decode_step.dependOn(&b.addInstallArtifact(pdf_decode, .{}).step);

    // Instantiates the module under Node's WASI and renders a fixture PDF.
    const pdf_decode_abi_test = b.addSystemCommand(&.{ "node", "webapp/wasm/tests/pdf_decode_abi.mjs" });
    pdf_decode_abi_test.addFileArg(pdf_decode.getEmittedBin());
    pdf_decode_abi_test.addFileArg(b.path("webapp/wasm/tests/fixtures/two-page.pdf"));
    pdf_decode_abi_test.expectExitCode(0);
    pdf_decode_abi_test.stdio = .inherit;
    const pdf_decode_test_step = b.step(
        "wasm-pdf-decode-test",
        "Render a fixture PDF through the built wasm (needs Node)",
    );
    pdf_decode_test_step.dependOn(&pdf_decode_abi_test.step);

    // ---- Server: `zig build serve -- [--config=config.zon]` ----
    const serve_mod = b.createModule(.{
        .root_source_file = b.path("backend/main.zig"),
        .target = target,
        .optimize = optimize,
        .strip = strip,
    });
    serve_mod.addImport("tls", tls_mod);
    serve_mod.addImport("supernote", supernote); // backend can use the .note library
    serve_mod.addImport("spd", spd_mod); // native .spd parser for thumbnail extraction
    serve_mod.addOptions("build_options", build_options); // `--version`
    linkSqlite(b, serve_mod);
    // MuPDF for the PDF probe and text pass (~6.7 MB of binary).
    serve_mod.linkLibrary(buildMupdfNative(b, mupdf_dep, target, optimize));
    const serve_exe = b.addExecutable(.{ .name = "inkhold", .root_module = serve_mod });
    b.installArtifact(serve_exe);
    const run_serve = b.addRunArtifact(serve_exe);
    if (b.args) |args| run_serve.addArgs(args);
    const serve_step = b.step("serve", "Run the Inkhold server");
    serve_step.dependOn(&run_serve.step);

    // Derive-path bench: a standalone executable so it can be cross-compiled and
    // run on the Pi. Not installed by default; needs no MuPDF.
    const derive_mod = b.createModule(.{
        .root_source_file = b.path("backend/derive_bench.zig"),
        .target = target,
        .optimize = optimize,
    });
    derive_mod.addImport("supernote", supernote);
    derive_mod.addImport("spd", spd_mod);
    linkSqlite(b, derive_mod);
    const derive_exe = b.addExecutable(.{ .name = "derive-bench", .root_module = derive_mod });
    const derive_step = b.step("derive-bench", "Build the derive-path bench (measurement only)");
    derive_step.dependOn(&b.addInstallArtifact(derive_exe, .{}).step);

    // Write-side bench (`--mode probe`), same arrangement.
    const idxwrite_mod = b.createModule(.{
        .root_source_file = b.path("backend/index_write_bench.zig"),
        .target = target,
        .optimize = optimize,
    });
    idxwrite_mod.addImport("supernote", supernote);
    idxwrite_mod.addImport("spd", spd_mod);
    linkSqlite(b, idxwrite_mod);
    const idxwrite_exe = b.addExecutable(.{ .name = "index-write-bench", .root_module = idxwrite_mod });
    const idxwrite_step = b.step("index-write-bench", "Build the write-side search bench (measurement only)");
    idxwrite_step.dependOn(&b.addInstallArtifact(idxwrite_exe, .{}).step);

    // ---- Tests ----
    const test_step = b.step("test", "Run all tests");

    // Rooted at backend/main.zig so http/ can import ../config.
    const backend_test_mod = b.createModule(.{
        .root_source_file = b.path("backend/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    backend_test_mod.addImport("tls", tls_mod);
    backend_test_mod.addImport("supernote", supernote);
    backend_test_mod.addImport("spd", spd_mod);
    // The shared `.note` fixture builder, which imports the parser as "note".
    const note_builder_mod = b.createModule(.{
        .root_source_file = b.path("parsers/note/tests/note_builder.zig"),
    });
    note_builder_mod.addImport("note", supernote);
    backend_test_mod.addImport("note_builder", note_builder_mod);
    backend_test_mod.addOptions("build_options", build_options); // cli.zig's `--version`
    linkSqlite(b, backend_test_mod);
    backend_test_mod.linkLibrary(buildMupdfNative(b, mupdf_dep, target, optimize));
    // Device captures for the golden test; @embedFile cannot leave its module dir.
    for ([_][]const u8{ "sample.note", "sample-2.note", "layers_edited.note" }) |fixture| {
        backend_test_mod.addAnonymousImport(fixture, .{
            .root_source_file = b.path(b.pathJoin(&.{ "parsers/note/tests/fixtures", fixture })),
        });
    }
    test_step.dependOn(&b.addRunArtifact(b.addTest(.{ .root_module = backend_test_mod })).step);

    // The `.note` parser's own unit tests.
    const note_unit_mod = b.createModule(.{
        .root_source_file = b.path("parsers/note/src/root.zig"),
        .target = target,
        .optimize = optimize,
    });
    test_step.dependOn(&b.addRunArtifact(b.addTest(.{ .root_module = note_unit_mod })).step);
}
