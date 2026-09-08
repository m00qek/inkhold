const std = @import("std");

/// Compile-time configuration for the vendored SQLite amalgamation
/// (`vendor/sqlite`, 3.53.3). Every flag is deliberate — see `linkSqlite`.
const sqlite_flags = [_][]const u8{
    // ---- Required by our code ----

    // `note_page_fts` is an FTS5 external-content table. FTS5 is a *build
    // option*, not a given: on a host SQLite built without it the schema
    // migration fails at runtime. Vendoring turns that into a guarantee.
    "-DSQLITE_ENABLE_FTS5",

    // Serialized. serve mode runs one thread per connection over a SINGLE
    // shared connection, and `ctx.db_lock` already serializes access — so
    // mode 2 (multi-thread) would also be correct *today*. We pick 1 anyway:
    //   - db_lock is NOT made redundant by this. Mode 1 protects individual
    //     API calls; our multi-statement transactions still need db_lock for
    //     atomicity. So mode 1 is purely a safety net under the real lock.
    //   - The failure mode of mode 2 is silent memory corruption the moment
    //     any future code (a WAL checkpointer, an index worker) touches the
    //     connection off the lock. Mode 1 degrades that to "merely slow".
    //   - The cost is an uncontended mutex per call, which is nothing at
    //     single-household scale.
    "-DSQLITE_THREADSAFE=1",

    // ~2 MB page cache (negative = KiB), matching the figure the resource
    // budget counts on. `sqlite.zig` also sets this via PRAGMA at open time;
    // pinning the compiled-in default means a connection opened by any other
    // path cannot silently inherit SQLite's much larger upstream default.
    "-DSQLITE_DEFAULT_CACHE_SIZE=-2000",

    // ---- Omissions: each is verified unused by the code today ----

    // No sqlite3_*_text16/column_text16 anywhere; the wrapper is UTF-8 only
    // and `unicode61` tokenizes UTF-8. Removes the whole UTF-16 transcoding
    // layer and its collations.
    "-DSQLITE_OMIT_UTF16",

    // Nothing loads extensions, and FTS5 above is compiled in statically
    // rather than loaded. Also drops the `load_extension()` SQL function,
    // which is worth removing on its own given the device-facing surface.
    "-DSQLITE_OMIT_LOAD_EXTENSION",

    // The deprecated API set (sqlite3_profile, sqlite3_trace,
    // sqlite3_aggregate_count, ...) — none appear in src/.
    "-DSQLITE_OMIT_DEPRECATED",

    // Shared-cache mode is deprecated upstream and we never open with it.
    "-DSQLITE_OMIT_SHARED_CACHE",

    // sqlite3_progress_handler is never installed.
    "-DSQLITE_OMIT_PROGRESS_CALLBACK",

    // ---- Hardening / size, no behaviour we rely on ----

    // Double-quoted string literals off. Upstream's own recommendation: with
    // DQS on, a misspelled column name silently degrades to a string literal
    // instead of erroring. Audited — every string literal in our SQL is
    // single-quoted, and the double quotes in `search/query.zig`'s MATCH
    // expressions are parsed by FTS5's query parser (from a *bound
    // parameter*), never by the SQL tokenizer, so they are unaffected.
    "-DSQLITE_DQS=0",

    // sqlite3_status/_db_status are never read, so the allocator's global
    // bookkeeping is pure overhead.
    "-DSQLITE_DEFAULT_MEMSTATUS=0",

    // A LIKE against a blob never matches. We only LIKE over TEXT columns.
    "-DSQLITE_LIKE_DOESNT_MATCH_BLOBS",

    // Deliberately NOT omitted:
    //   SQLITE_OMIT_JSON — unused today, but a `json_extract()` in some
    //     future migration would fail at *runtime* ("no such function"),
    //     which is exactly the trap vendoring is meant to close. ~30 KB is
    //     not worth reopening it.
    //   SQLITE_OMIT_AUTOINIT — would need an explicit sqlite3_initialize()
    //     call that is easy to forget on a new entry point.
    //   spellfix1 / editdist3 / soundex — considered and rejected: phonetic
    //     matching is English-oriented, the same reason `porter` was ruled
    //     out for a Portuguese corpus.
};

/// Hard-trimmed SQLite for the browser (`zig build wasm-sqlite-core`).
///
/// The browser needs SQLite for exactly two things — `sqlite3_deserialize` a
/// `.spd` image and run a handful of `SELECT`s over `config`/`surface_*`, and
/// build and query the local FTS5 search index. No files, no threads. So this
/// profile drops everything neither path touches, on top of the backend's
/// omissions:
///
///   * `THREADSAFE=0`  — the wasm instance is single-threaded; no mutexes.
///   * `OS_OTHER=1`    — remove the built-in unix/win VFS wholesale (file I/O,
///                       byte-range locking, mmap, the process randomness/time
///                       syscalls). `webapp/wasm/sqlite_vfs_null.c` supplies the
///                       minimal default VFS `sqlite3_initialize` still requires.
///   * `OMIT_WAL`      — the parser rewrites a real `.spd`'s WAL header to
///                       rollback-journal before deserialize (`neutralizeWalMode`),
///                       and `:memory:` never runs WAL, so the WAL module is dead.
///   * `OMIT_AUTOINIT` — every entry point that can be the first call into the
///                       module calls `sqlite3_initialize` explicitly.
///   * `OMIT_JSON` + no RTREE/GEOPOLY — every optional SQL module dropped except
///                       the one that is now load-bearing:
///   * `ENABLE_FTS5`   — global search is answered in the browser
///                       (`client-side-search-impl.md`). MEASURED on this
///                       artifact: 667,211 raw / 290,879 gzip without it against
///                       828,562 / 362,009 with, so FTS5 costs **+71,130 bytes
///                       gzip** and that is the whole download cost of the
///                       feature. `precompress.mjs` pins the total.
///   * `TEMP_STORE=3`  — **THE DANGEROUS ONE.** The null VFS cannot open a file
///                       (`nullOpen` returns `SQLITE_IOERR` unconditionally), so
///                       anything that spilled to temp storage would spill to a
///                       temp FILE and fail. `3` forces temp storage to memory
///                       and cannot be overridden by a pragma. Without it an
///                       FTS5 merge *"surfaces as a corrupt index in production
///                       rather than as a build error"* (`wasm-search-bench.md`
///                       §0).
///                       REMOVING IT CHANGES NOTHING OBSERVABLE — measured, up
///                       to 80,000 documents and an 80,000-row `ORDER BY rank`.
///                       So it is not defended by a behavioural test: the module
///                       asks the compiled amalgamation for it
///                       (`sqlite3_compileoption_used`) and `idx_open` refuses
///                       to open without it, which is what
///                       `webapp/wasm/tests/sqlite_core_abi.mjs` asserts.
///   * the read-only-safe omissions (UTF16, LOAD_EXTENSION, DEPRECATED,
///     SHARED_CACHE, PROGRESS_CALLBACK, AUTHORIZATION, COMPLETE, DECLTYPE,
///     TRACE, AUTOVACUUM) + `UNTESTABLE` + `DQS=0` + `MEMSTATUS=0`.
///
/// Honest caveat: there is no "read-only" flag — the b-tree/pager/SQL core stays
/// to run any SELECT. The win is dropping every optional module + the OS layer.
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
    // NB: the grammar-altering omissions (OMIT_TRIGGER/VIEW/WINDOWFUNC/CTE/
    // ATTACH/PRAGMA/…) are deliberately NOT used. They require regenerating the
    // Lemon parser, which the vendored *amalgamation* ships pre-built — enabling
    // them makes `sqlite3.c` fail to compile (the parser tables still reference
    // the removed routines). Every flag above is amalgamation-safe.
};

/// Compiles the vendored SQLite amalgamation into `mod`, replacing what used
/// to be `mod.linkSystemLibrary("sqlite3", .{})`. This is what makes the
/// binary self-contained AND what makes FTS5 a compile-time fact rather than
/// a property of whatever libsqlite3 the host distro happens to ship.
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
// MuPDF -> wasm (`zig build wasm-pdf-decode`)
// ---------------------------------------------------------------------------
//
// MuPDF 1.28.1 is a PINNED TARBALL DEPENDENCY (`build.zig.zon`), not vendored:
// it is ~72 MB of source of which we compile maybe a fifth, and a tree that size
// in the repo would dwarf everything else in it. `b.dependency("mupdf", .{})`
// unpacks it into the gitignored `zig-pkg/`.
//
// Nothing below patches MuPDF. The two shims are ours (`webapp/wasm/pdf_shim.c`).

/// Compile-time trim for the wasm build. Measured, not guessed —
/// object sizes were ranked to find these:
///
///   * `NO_CJK` (-881 KB) is the single biggest win and the one nobody guesses.
///     It drops `pdf-cmap-load.c`'s embedded Adobe predefined-CMap tables — an
///     899 KB object. `TOFU_CJK` does NOT cover it: that flag drops CJK *fonts*,
///     this one drops CJK *encodings*. Consistent to take both.
///   * `FZ_ENABLE_HYPHEN=0` (-643 KB) drops `resources/hyphen/hyph-all.zip`,
///     which is otherwise linked unconditionally.
///   * `TOFU`/`TOFU_CJK` drop the embedded Noto/SIL/Han/Droid fonts, leaving the
///     14 URW base-35 faces a PDF actually needs. Documents that embed their
///     fonts (nearly all of them) are unaffected.
///   * `FZ_ENABLE_JPX=0` (-227 KB) drops openjpeg. JPEG 2000 in a PDF is rare and
///     degrades to "unsupported image", not a broken page.
///
/// The format set is deliberate: PDF + EPUB + FB2 + CBZ + XPS. §9.5 measured all
/// five at only +106 KB gzip over PDF-only, which is the whole reason MuPDF beat
/// PDF.js here. What IS turned off is everything with no viewer story and a real
/// cost: SVG, Markdown (would pull in cmark-gfm), MOBI, Office, barcodes, the
/// JS interpreter (mujs), brotli, and every document *writer*.
/// The wasm target's own flags. Everything BELOW this is shared with the native
/// build (`mupdf_trim_flags`) — the split exists so the measured decisions
/// cannot drift between the two targets, which is the one thing that would make
/// the browser and the server disagree about a document.
const mupdf_wasm_only = [_][]const u8{
    // --- The wasm exception-handling contract. See `buildMupdfWasm`. ---
    "-fwasm-exceptions",
    "-mllvm",
    "-wasm-enable-sjlj",

    // wasi-libc has no `mkstemp` and clang 21 makes an implicit declaration a
    // hard error. `pdf_shim.c` supplies a stub; this lets the reference compile.
    // Native libc has the real thing, so this is wasm-only.
    "-Wno-implicit-function-declaration",
};

const mupdf_trim_flags = [_][]const u8{
    "-DNDEBUG",

    // --- Fonts and encodings ---
    "-DTOFU",
    "-DTOFU_CJK",
    "-DNO_CJK",

    // --- Formats/features off ---
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

    // lcms2 here is Artifex's multi-threaded fork under a symbol prefix; MuPDF's
    // own sources need both defines to see the right declarations.
    "-DHAVE_LCMS2MT",
    "-DLCMS2MT_PREFIX=lcms2mt_",

    // Upstream's warnings are upstream's business — MuPDF and its thirdparty
    // tree are noisy under clang and none of it is ours to fix.
    "-w",
};

/// UBSan OFF — for the VENDORED tree only, and never for `backend/pdf/*.c`,
/// which is ours and keeps every check. `addMupdfSources` appends this; the two
/// files we wrote do not get it.
///
/// **Not a preference. A crash.** `zig cc` compiles C at Debug and ReleaseSafe
/// with `-fsanitize=undefined -fsanitize-trap=undefined`, so a violation is a
/// `ud2`: the process dies with "Illegal instruction" and no message, and there
/// is nothing to catch. MuPDF and its eight thirdparty trees were never written
/// to be UBSan-clean, and at least two sites are reachable from a single text
/// extraction:
///
///   - x86-64 traps in lcms2's `cmsPipelineEval16` — upstream casts an
///     interpolation routine to the pipeline's own function-pointer type
///     (`cmsopt.c:781`, differing only in `const _cms_interp_struc*` versus
///     `const void*`) and then calls through it. Identical ABI, formally UB.
///   - armv6 traps at a DIFFERENT site in the same call chain
///     (`cmsxform.c:2740`, transform creation), so it is not one cast and a
///     per-category opt-out does not travel across targets. `-fsanitize=function`
///     is not even emitted on 32-bit ARM.
///
/// **Found the hard way, and worth stating.** The probe never reaches the colour
/// pipeline — it opens, counts and bounds a page — so this lay dormant from the
/// day MuPDF was linked in. The TEXT pass interprets page content, which converts
/// colours: every text test died at ReleaseSafe while every one of them passed at
/// Debug, and ReleaseSafe is what `make serve` and every release artifact build.
/// A blanket per-file `-fno-sanitize=undefined` was the alternative to shipping a
/// server that segfaults on the first PDF; scoping it to code we do not maintain
/// is the part that keeps it honest.
const mupdf_vendor_only = [_][]const u8{"-fno-sanitize=undefined"};

/// What `buildMupdfWasm` compiles with: the target's contract plus the shared trim.
const mupdf_wasm_flags = mupdf_wasm_only ++ mupdf_trim_flags;

/// What `buildMupdfNative` compiles with: the shared trim and nothing else. The
/// server needs no exception-handling contract (ordinary `setjmp`/`longjmp`) and
/// no `mkstemp` stub.
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
    // HarfBuzz allocates through MuPDF's allocator, so the store cap actually
    // bounds shaping too.
    "-Dhb_malloc_impl=fz_hb_malloc",
    "-Dhb_calloc_impl=fz_hb_calloc",
    "-Dhb_free_impl=fz_hb_free",
    "-Dhb_realloc_impl=fz_hb_realloc",
};

/// MuPDF sources we deliberately do NOT compile, keyed by file name.
///
/// The Makefile takes `$(wildcard source/fitz/*.c)` wholesale and lets the
/// `FZ_ENABLE_*` guards empty the files it does not want; we skip them outright
/// so the C++ toolchain and the OCR/barcode thirdparty trees never enter the
/// picture. `office.c`/`mobi.c` have no internal guard (only their registration
/// in `document-all.c` does), so they must be excluded here rather than defined
/// away.
const mupdf_excluded_sources = [_][]const u8{
    "tessocr.cpp", // OCR — needs tesseract + leptonica
    "zxingbarcode.cpp", // barcodes — needs zxing-cpp + zint (C++20)
    "leptonica-wrap.c", // ditto, leptonica
    "office.c", // FZ_ENABLE_OFFICE=0, but the file itself is unguarded
    "mobi.c", // FZ_ENABLE_MOBI=0, ditto
    "md.c", // FZ_ENABLE_MD=0 — guarded, but would want cmark-gfm's headers
    // Upstream bug, not a choice: `encode-jpx.c` puts `#include <openjpeg.h>`
    // ABOVE its `#if FZ_ENABLE_JPX`, so the file cannot compile with JPX off
    // however the flags are set. It is the JPX *writer*; a viewer never needs it.
    "encode-jpx.c",
    // A second, worse upstream bug in the same area: `load-jpx.c`'s disabled-path
    // `fz_load_jpx_info` stub is missing the `fz_colorspace *defcs` parameter its
    // own header declares. Harmless on x86, but `wasm-ld` replaces the mismatched
    // call with a TRAPPING stub — a JPX-bearing PDF would kill the module instead
    // of raising `FZ_ERROR_UNSUPPORTED`. Correctly-typed stubs live in
    // `pdf_shim.c` instead; MuPDF itself stays unpatched.
    "load-jpx.c",
};

/// Read a `*_SRC += path` list out of MuPDF's own `Makelists`.
///
/// The thirdparty trees CANNOT be directory-walked: FreeType's `src/` holds many
/// files that are `#include`d into one another and must not be compiled
/// separately, and HarfBuzz ships tests and unused shapers beside the real ones.
/// `Makelists` IS the authoritative list, it is a flat `VAR += path` format with
/// no conditionals in the parts we read, and it arrives with the pinned tarball —
/// so parsing it cannot drift from the source it describes, which a hand-copied
/// list in this file certainly would.
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

/// List MuPDF's OWN sources in `sub_path` — the `$(wildcard source/fitz/*.c)`
/// the Makefile uses, done natively. Unlike the thirdparty trees these really are
/// "every file in the directory", so a walk is the faithful translation.
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
    // Directory order is filesystem order and would make the build's cache key
    // (and any diff of it) unstable across machines. Sort, as the Makefile does.
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

/// Build MuPDF (+ its thirdparty deps + our shim) into a static library for
/// `wasm32-wasi` **with the exception-handling CPU feature on**.
///
/// THE SPLIT-TARGET DANCE, AND WHY IT IS NOT OPTIONAL. MuPDF's `fz_try`/`fz_catch`
/// is `setjmp`-based, and wasi-libc's `setjmp.h` `#error`s unless
/// `__wasm_exception_handling__` is defined — so every C compile here needs
/// `wasm32-wasi+exception_handling` plus `-fwasm-exceptions -mllvm -wasm-enable-sjlj`.
/// But the FINAL LINK must use the plain `wasm32-wasi` triple *without* that
/// feature: Zig rebuilds wasi-libc as part of linking, and its own copy of the
/// setjmp runtime fails to compile with the feature on ("undefined tag symbol
/// cannot be weak"). Hence a static library at one target linked into an
/// executable at another — the only arrangement that satisfies both.
///
/// That leaves the setjmp runtime itself missing (`__wasm_setjmp`,
/// `__wasm_longjmp`, `__wasm_setjmp_test`): Zig ships no wasm setjmp runtime but
/// DOES vendor the source, so we compile its `rt.c` ourselves here — with
/// `-fwasm-exceptions` but WITHOUT `-mllvm -wasm-enable-sjlj`, which that file
/// does not survive.
///
/// The consequence for the browser: the module carries a `tag` section and needs
/// Wasm exceptions — **Chrome 95+, Firefox 131+, Safari 18.4+**. That is a floor
/// no other part of Inkhold imposes, and Phase 2 must feature-detect it.
/// Include order mirrors MuPDF's `THIRD_CFLAGS`, which are applied to its own
/// sources too. `include/mupdf` goes LAST and exists only for HarfBuzz, which
/// takes its Unicode tables from MuPDF's bundled `ucdn.h`. Shared by both
/// targets — a divergence here is a divergence in what the two builds parse.
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

/// MuPDF's own source directories. `source/svg` is excluded (FZ_ENABLE_SVG=0);
/// `source/tools`, `source/tests` and `source/helpers` are the CLI, the test
/// harness and the pthread/OpenSSL helpers.
///
/// The NATIVE build keeps the same set as the wasm one deliberately, even though
/// it registers only the PDF handler: `--gc-sections` already drops what nothing
/// reaches (measured — registering every handler cost only 0.4 MB), so trimming
/// the source list would buy almost nothing and would be a second, subtly
/// different MuPDF.
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

/// Adds MuPDF's own sources, its fonts and its thirdparty tree to `mod`, with
/// `flags`. The ONE description of what MuPDF is, for both targets; only the
/// flags and the per-target shim differ.
fn addMupdfSources(
    b: *std.Build,
    dep: *std.Build.Dependency,
    mod: *std.Build.Module,
    flags: []const []const u8,
) void {
    for (&mupdf_includes) |inc| mod.addIncludePath(dep.path(inc));

    // The one place the vendored opt-out is applied — see `mupdf_vendor_only`.
    // Every `addCSourceFiles` below is upstream's code; `backend/pdf/*.c` is
    // added by the CALLER with `flags` and never sees this.
    const vflags = concatFlags(b, flags, &mupdf_vendor_only);

    for (&mupdf_source_dirs) |sub| {
        mod.addCSourceFiles(.{
            .root = dep.path(""),
            .files = mupdfDirSources(b, dep, sub, ".c"),
            .flags = vflags,
        });
    }
    // The 14 URW base-35 faces, pre-hexdumped in the tarball's `generated/`.
    // Everything else under `resources/fonts` is dropped by TOFU/TOFU_CJK.
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

/// MuPDF for the SERVER (`backend/pdf/probe.c`) — page count, page-1 box, and
/// whether the file opens at all.
///
/// Everything about what MuPDF *is* comes from `addMupdfSources`, shared with the
/// wasm build. What differs is only what a native target needs: no
/// exception-handling contract (ordinary `setjmp`/`longjmp` works), no wasm
/// setjmp runtime, and our own shim instead of the browser's ABI.
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
    // The text pass (`backend/pdf/text.zig`). A SECOND file rather than more of
    // `probe.c`, because the two have opposite store contracts — the probe runs
    // at `FZ_STORE_DEFAULT` and never approaches it, the text pass caps at 4 MB
    // and is the reason the 50 MB budget closes. See the header of each.
    mod.addCSourceFile(.{
        .file = b.path("backend/pdf/text.c"),
        .flags = &mupdf_native_flags,
    });
    return b.addLibrary(.{ .name = "mupdf-native", .root_module = mod, .linkage = .static });
}

fn buildMupdfWasm(b: *std.Build, dep: *std.Build.Dependency) *std.Build.Step.Compile {
    const eh_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .wasi,
        .cpu_features_add = std.Target.wasm.featureSet(&.{.exception_handling}),
    });
    const mod = b.createModule(.{ .target = eh_target, .optimize = .ReleaseSmall });
    mod.link_libc = true;
    // HarfBuzz is C++ (`.cc`); this is what puts libc++'s headers on the compile.
    mod.link_libcpp = true;

    addMupdfSources(b, dep, mod, &mupdf_wasm_flags);

    // --- Ours ---
    mod.addCSourceFile(.{
        .file = b.path("webapp/wasm/pdf_shim.c"),
        .flags = &mupdf_wasm_flags,
    });

    // The setjmp runtime, from Zig's own vendored wasi-libc source tree. Taken
    // from `b.graph.zig_lib_directory` rather than a hard-coded `/usr/lib/zig`
    // so a CI toolchain unpacked anywhere still finds it.
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

    // `inkhold --version`. Read from `build.zig.zon` rather than restated here,
    // so the number a user quotes in a bug report is the package version and
    // there is exactly one place to bump at release time. (This is the SERVER's
    // version — deliberately not `routes.api_version`, which is the sync-protocol
    // number and is not what somebody filing a bug report means.)
    const build_options = b.addOptions();
    build_options.addOption([]const u8, "version", @import("build.zig.zon").version);

    // The standalone `.note` parser (`parsers/note`), the shared library module
    // (.note parse + render). Target-agnostic so both native (backend, CLI) and
    // wasm (frontend) importers can use it — a module import crosses subsystem
    // boundaries that a relative path cannot. Pure Zig, no C to compile. Its own
    // `build.zig` stays for `cd parsers/note && zig build test`, which runs the
    // parser's unit + integration suite (same arrangement as `parsers/spd`).
    const supernote = b.addModule("supernote", .{
        .root_source_file = b.path("parsers/note/src/root.zig"),
    });

    // ---- WebAssembly render module (browser reader) ----
    // Imports the parser/renderer directly, so it carries no test/debug code.
    const wasm_target = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .freestanding });

    // ---- WebAssembly single-page decoder (Option-3 NoteRenderer seam) ----
    // Consumes one page's "SNPG" payload and
    // outputs RGBA8888. References only `page_payload`, so no container/parser
    // code is compiled in. Separate from the whole-file `wasm` module above.
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

    // ---- TLS (ianic/tls.zig, zig-0.16.x) — first-class in-process TLS ----
    const tls_dep = b.dependency("tls", .{ .target = target, .optimize = optimize });
    const tls_mod = tls_dep.module("tls");

    // The standalone `.spd` parser (`parsers/spd`), imported natively by the
    // backend for embedded-thumbnail extraction at ingest. It shares the
    // backend's SINGLE vendored SQLite: only the headers go on this module (so
    // its `@cImport(@cInclude("sqlite3.h"))` resolves), while the amalgamation
    // itself is compiled EXACTLY ONCE — by `linkSqlite` into whichever artifact
    // imports the module (serve_exe / backend tests). The parser's own
    // standalone `build.zig` SQLite compile is deliberately NOT pulled in here;
    // both the backend's `db/sqlite.zig` externs and the parser's `sqlite.zig`
    // externs then resolve to that one compiled copy at link time. (The parser's
    // `build.zig` stays only for `cd parsers/spd && zig build test`, a separate
    // binary that compiles its own SQLite.)
    const spd_mod = b.createModule(.{
        .root_source_file = b.path("parsers/spd/src/root.zig"),
    });
    spd_mod.link_libc = true;
    spd_mod.addIncludePath(b.path("vendor/sqlite"));

    // ---- WebAssembly SQLite core: the `.spd` decoder AND the search index ----
    // ONE artifact, two ABIs (`spd_*` + `idx_*`), because SQLite alone is
    // ~290 KB gzip of the 362 KB artifact: two modules would ship ~580 KB to
    // avoid ~10 KB of Zig a given page happens not to call, which is the wrong
    // trade — `client-side-search-impl.md` §5, which also names the file:
    // an artifact called `spd-decode` that also runs search is a lie in the
    // build graph.
    //
    // The `.spd` half is the SAME `parsers/spd` parser the backend uses, so the
    // browser viewer never re-parses `.spd` in JS (the drift the PoC proved).
    // SQLite is compiled in RIGHT HERE with the hard-trimmed, OS-less profile
    // (`sqlite_core_wasm_flags`) plus the null VFS — a second copy distinct from
    // the backend's full-featured one. Targets wasm32-WASI, not freestanding:
    // the SQLite amalgamation needs libc HEADERS (<string.h>, <stdlib.h>) that
    // only wasi-libc provides. The `OS_OTHER` VFS means no WASI syscall is
    // exercised — the imports are present but inert (the ABI test verifies it by
    // instantiating under a REAL WASI, so a stray syscall would show up).
    const wasi_target = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const sqlite_core_mod = b.createModule(.{
        .root_source_file = b.path("webapp/wasm/sqlite_core.zig"),
        .target = wasi_target,
        .optimize = .ReleaseSmall,
    });
    sqlite_core_mod.addImport("spd", spd_mod);
    sqlite_core_mod.link_libc = true;
    sqlite_core_mod.addIncludePath(b.path("vendor/sqlite"));
    // The trimmed amalgamation + the null VFS, compiled into THIS artifact only
    // (never the native modules, which linkSqlite their own full build).
    sqlite_core_mod.addCSourceFile(.{
        .file = b.path("vendor/sqlite/sqlite3.c"),
        .flags = &sqlite_core_wasm_flags,
    });
    sqlite_core_mod.addCSourceFile(.{
        .file = b.path("webapp/wasm/sqlite_vfs_null.c"),
        .flags = &sqlite_core_wasm_flags,
    });
    const sqlite_core = b.addExecutable(.{ .name = "sqlite-core", .root_module = sqlite_core_mod });
    // WASI *reactor*: exports `_initialize` (runs libc/C ctors) and the ABI
    // functions, with no `_start`/`main`. This is the shape a browser wants —
    // instantiate, call `_initialize` once, then call the ABI. (Plain
    // `entry = .disabled` still emitted a command-style `_start` here because
    // wasi-libc is linked; the exec model is the right knob.)
    sqlite_core.wasi_exec_model = .reactor;
    sqlite_core.rdynamic = true; // keep the `export fn`s
    const sqlite_core_step = b.step("wasm-sqlite-core", "Build the .spd decoder + search index wasm");
    sqlite_core_step.dependOn(&b.addInstallArtifact(sqlite_core, .{}).step);

    // The proof that the module WORKS rather than merely links, and the only
    // place `-DSQLITE_TEMP_STORE=3` is checked — the flag whose absence would
    // otherwise surface as a corrupt index in a browser rather than as a build
    // failure. Its own step, like the PDF one, because `zig build test` is
    // Zig-only and must stay runnable without Node.
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

    // ---- THROWAWAY: the fuzzy-ladder-in-wasm harness (`zig build wasm-fuzzy-bench`) ----
    // Exists only to produce `docs/scratch/wasm-fuzzy-bench.md`, and to settle by
    // COMPILATION rather than by reading whether `client-side-search-impl.md`
    // §9.3's "`fuzzy.zig` is portable as written" survives a build.
    //
    // Note what has to be imported for that to even be attempted: the SHIPPING
    // `backend/services/search/fuzzy.zig` AND `backend/db/sqlite.zig`, the
    // backend wrapper it depends on. §9.3 reads "it imports exactly `std` and
    // `sqlite.zig`. Both exist in the wasm module this plan already builds" —
    // but the `sqlite.zig` in that module is `parsers/spd/src/sqlite.zig`, a
    // different file that exposes only the `@cImport`. Wiring the backend one in
    // here is the honest version of the claim.
    //
    // Built with the SHIPPING `sqlite_core_wasm_flags`, so what it measures is
    // the engine configuration the browser actually gets. Nothing shipping is
    // touched; delete this block and `wasm_fuzzy_bench.zig` with the report.
    const fuzzy_bench_mod = b.createModule(.{
        // AT THE REPO ROOT deliberately: a Zig module cannot `@import` a file
        // outside its root directory, and this harness has to reach BOTH
        // `backend/services/search/fuzzy.zig` and `webapp/wasm/spd_decode.zig`
        // to be the fused module the plan proposes. That is a real constraint
        // on the port, not a harness quirk — recorded in the report.
        .root_source_file = b.path("wasm_fuzzy_bench.zig"),
        .target = wasi_target,
        .optimize = .ReleaseSmall,
    });
    // `fuzzy.zig` and `db/sqlite.zig` come in by RELATIVE PATH from the harness,
    // not as named modules: `fuzzy.zig` reaches its wrapper with
    // `@import("../../db/sqlite.zig")`, and a named `sqlite` module would make
    // that same file the root of a second module ("file exists in modules
    // 'sqlite' and 'fuzzy'"). Pulling both into this root module is also the
    // more honest test — it is the shipping file, not a copy.
    fuzzy_bench_mod.addImport("spd", spd_mod);
    fuzzy_bench_mod.link_libc = true;
    fuzzy_bench_mod.addIncludePath(b.path("vendor/sqlite"));
    fuzzy_bench_mod.addCSourceFile(.{
        .file = b.path("vendor/sqlite/sqlite3.c"),
        .flags = &sqlite_core_wasm_flags,
    });
    fuzzy_bench_mod.addCSourceFile(.{
        .file = b.path("webapp/wasm/sqlite_vfs_null.c"),
        .flags = &sqlite_core_wasm_flags,
    });
    const fuzzy_bench = b.addExecutable(.{ .name = "fuzzy-bench", .root_module = fuzzy_bench_mod });
    fuzzy_bench.wasi_exec_model = .reactor;
    fuzzy_bench.rdynamic = true;
    const fuzzy_bench_step = b.step("wasm-fuzzy-bench", "THROWAWAY: build the fuzzy-ladder-in-wasm harness");
    fuzzy_bench_step.dependOn(&b.addInstallArtifact(fuzzy_bench, .{}).step);

    // ---- WebAssembly PDF decoder (MuPDF) ----
    //  `.spd` above — a thin Zig
    // module over a compiled-in C library, reactor-model, memory-only ABI — but
    // the library is MuPDF, so the C build is the interesting part and lives in
    // `buildMupdfWasm` above. The link deliberately uses the PLAIN `wasi_target`
    // shared with `.spd`, not the exception-handling one the library is built at.
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

    // The proof that the artifact is a working module and not a dead-stripped
    // shell that merely links: instantiate it under Node's WASI, open a fixture
    // PDF from memory and render its pages. Deliberately its OWN step rather
    // than part of `zig build test` — that suite is Zig-only and must stay
    // runnable without Node.
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
    });
    serve_mod.addImport("tls", tls_mod);
    serve_mod.addImport("supernote", supernote); // backend can use the .note library
    serve_mod.addImport("spd", spd_mod); // native .spd parser for thumbnail extraction
    serve_mod.addOptions("build_options", build_options); // `--version`
    linkSqlite(b, serve_mod);
    // MuPDF for the server's PDF probe (`backend/pdf/probe.c`). ~6.7 MB of
    // binary, measured.
    serve_mod.linkLibrary(buildMupdfNative(b, mupdf_dep, target, optimize));
    const serve_exe = b.addExecutable(.{ .name = "inkhold", .root_module = serve_mod });
    b.installArtifact(serve_exe);
    const run_serve = b.addRunArtifact(serve_exe);
    if (b.args) |args| run_serve.addArgs(args);
    const serve_step = b.step("serve", "Run the Inkhold server");
    serve_step.dependOn(&run_serve.step);

    // ---- Search bench (`zig build bench`) — MEASUREMENT ONLY ----
    //
    // A standalone executable that opens an EXISTING corpus READ-ONLY and times
    // library-wide search on it. Deliberately its own artifact rather than a
    // `test "BENCH …"`: the numbers wanted are the deployment target's, and a
    // cross-compiled test binary cannot be `zig build test`-run from the dev box
    // — this one is scp'd to the Pi and run there. It links the same vendored
    // SQLite as the server so the pragmas, the page cache and FTS5 are the
    // server's, not the host distro's. NOT installed by `zig build`; nothing in
    // the server depends on it.
    const bench_mod = b.createModule(.{
        .root_source_file = b.path("backend/search_bench.zig"),
        .target = target,
        .optimize = optimize,
    });
    linkSqlite(b, bench_mod);
    const bench_exe = b.addExecutable(.{ .name = "search-bench", .root_module = bench_mod });
    const bench_step = b.step("bench", "Build the search bench (measurement only)");
    bench_step.dependOn(&b.addInstallArtifact(bench_exe, .{}).step);

    // The IN-DOCUMENT bench — same posture as `search-bench` above (standalone,
    // read-only, never installed by `zig build`, nothing in the server depends
    // on it), answering `client-side-search-impl.md` §7.3: what the two live
    // in-doc reads cost against the shipped `segment_fts`-free scan shape.
    const indoc_mod = b.createModule(.{
        .root_source_file = b.path("backend/indoc_bench.zig"),
        .target = target,
        .optimize = optimize,
    });
    linkSqlite(b, indoc_mod);
    const indoc_exe = b.addExecutable(.{ .name = "indoc-bench", .root_module = indoc_mod });
    const indoc_step = b.step("indoc-bench", "Build the in-document search bench (measurement only)");
    indoc_step.dependOn(&b.addInstallArtifact(indoc_exe, .{}).step);

    // The DERIVE bench — same posture again, answering `golden-search.md` §7's
    // last derive-cost item: what the fold, deflate level 6 and the two file
    // writes cost per document on the ARM1176 the design is shaped around.
    // It calls the real `derive_search.writeDerived`, so it needs the note
    // parser the derive path's neighbours import; it does NOT need MuPDF,
    // because it reads page text from the corpus rather than extracting it.
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

    // ---- Tests ----
    const test_step = b.step("test", "Run all tests");

    // Backend tests: rooted at backend/main.zig (so http/ can import ../config),
    // aggregating config/app/transport/router. Imports tls (transport uses it).
    const backend_test_mod = b.createModule(.{
        .root_source_file = b.path("backend/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    backend_test_mod.addImport("tls", tls_mod);
    backend_test_mod.addImport("supernote", supernote);
    backend_test_mod.addImport("spd", spd_mod);
    // The parser package's synthetic `.note` builder, reused by the backend's
    // own tests (golden byte-equality, recognition seeding). One copy of the
    // builder exists — in `parsers/note/tests/` — and it imports the parser
    // under the package-local name "note", so wire that name here.
    const note_builder_mod = b.createModule(.{
        .root_source_file = b.path("parsers/note/tests/note_builder.zig"),
    });
    note_builder_mod.addImport("note", supernote);
    backend_test_mod.addImport("note_builder", note_builder_mod);
    backend_test_mod.addOptions("build_options", build_options); // cli.zig's `--version`
    linkSqlite(b, backend_test_mod);
    // The same MuPDF the server links, so `pdf/probe.zig`'s tests exercise the
    // real library rather than a stub.
    backend_test_mod.linkLibrary(buildMupdfNative(b, mupdf_dep, target, optimize));
    // Real device captures, for the `.note` index golden test. Wired in as named
    // imports because @embedFile cannot reach outside its module's directory.
    for ([_][]const u8{ "sample.note", "sample-2.note", "layers_edited.note" }) |fixture| {
        backend_test_mod.addAnonymousImport(fixture, .{
            .root_source_file = b.path(b.pathJoin(&.{ "parsers/note/tests/fixtures", fixture })),
        });
    }
    test_step.dependOn(&b.addRunArtifact(b.addTest(.{ .root_module = backend_test_mod })).step);

    // The `.note` parser's own unit tests, run here as well so the root suite
    // stays self-contained. Its fixture/property integration tests live in
    // `parsers/note/tests/` and run via `cd parsers/note && zig build test`.
    const note_unit_mod = b.createModule(.{
        .root_source_file = b.path("parsers/note/src/root.zig"),
        .target = target,
        .optimize = optimize,
    });
    test_step.dependOn(&b.addRunArtifact(b.addTest(.{ .root_module = note_unit_mod })).step);
}
