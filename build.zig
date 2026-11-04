const std = @import("std");

const build_mupdf = @import("build_mupdf.zig");
const buildMupdfNative = build_mupdf.buildMupdfNative;
const buildMupdfWasm = build_mupdf.buildMupdfWasm;

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
fn linkSqlite(b: *std.Build, mod: *std.Build.Module, headers: *std.Build.Module) void {
    mod.link_libc = true;
    mod.addImport("c", headers); // `@import("c")` in db/sqlite.zig
    mod.addIncludePath(b.path("vendor/sqlite"));
    mod.addCSourceFile(.{
        .file = b.path("vendor/sqlite/sqlite3.c"),
        .flags = &sqlite_flags,
    });
}

/// `sqlite3.h` translated for `target`, imported as `c` by the SQLite wrappers.
fn sqliteHeaders(b: *std.Build, target: std.Build.ResolvedTarget) *std.Build.Module {
    const tc = b.addTranslateC(.{
        .root_source_file = b.path("vendor/sqlite/sqlite3.h"),
        .target = target,
        .optimize = .ReleaseSafe,
    });
    return tc.createModule();
}

/// The `.spd` parser for one target. Headers only: `linkSqlite` in the
/// importing artifact supplies the symbols, so there is one SQLite compile.
fn spdModule(b: *std.Build, headers: *std.Build.Module) *std.Build.Module {
    const mod = b.createModule(.{ .root_source_file = b.path("parsers/spd/src/root.zig") });
    mod.link_libc = true;
    mod.addImport("c", headers);
    return mod;
}

// ---------------------------------------------------------------------------
// MuPDF (`zig build wasm-pdf-decode`, and the native server library)
// ---------------------------------------------------------------------------
//
// MuPDF 1.28.1 is a pinned tarball dependency (`build.zig.zon`), unpacked into
// `zig-pkg/`, and is never patched. Our shims are `webapp/wasm/pdf_shim.c` and
// `backend/pdf/*.c`.

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

    const wasi_target = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const sqlite_c = sqliteHeaders(b, target);
    const sqlite_c_wasi = sqliteHeaders(b, wasi_target);
    const spd_mod = spdModule(b, sqlite_c);

    // The schema as a header-only module, so the wasm search index imports
    // `fts_tokenizer` from the same declaration as the server.
    const schema_mod = b.createModule(.{
        .root_source_file = b.path("backend/db/schema.zig"),
    });
    schema_mod.link_libc = true;
    schema_mod.addImport("c", sqlite_c_wasi);

    // ---- WebAssembly SQLite core: the `.spd` decoder and the search index ----
    // One artifact, two ABIs: SQLite is ~290 KB gzip of 362 KB, so two modules
    // would ship it twice. Targets WASI only for libc headers; the null VFS makes
    // no syscalls, which the ABI test checks under a real WASI.
    const sqlite_core_mod = b.createModule(.{
        .root_source_file = b.path("webapp/wasm/sqlite_core.zig"),
        .target = wasi_target,
        .optimize = .ReleaseSmall,
    });
    sqlite_core_mod.addImport("spd", spdModule(b, sqlite_c_wasi));
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
    linkSqlite(b, serve_mod, sqlite_c);
    // MuPDF for the PDF probe and text pass (~6.7 MB of binary).
    serve_mod.linkLibrary(buildMupdfNative(b, mupdf_dep, target, optimize));
    const serve_exe = b.addExecutable(.{ .name = "inkhold", .root_module = serve_mod });
    b.installArtifact(serve_exe);
    const run_serve = b.addRunArtifact(serve_exe);
    run_serve.addPassthruArgs();
    const serve_step = b.step("serve", "Run the Inkhold server");
    serve_step.dependOn(&run_serve.step);

    // Derive-path bench: a standalone executable so it can be cross-compiled and
    // run on the Pi. Not installed by default; needs no MuPDF.
    const derive_mod = b.createModule(.{
        .root_source_file = b.path("backend/bench/derive.zig"),
        .target = target,
        .optimize = optimize,
    });
    derive_mod.addImport("supernote", supernote);
    derive_mod.addImport("spd", spd_mod);
    linkSqlite(b, derive_mod, sqlite_c);
    const derive_exe = b.addExecutable(.{ .name = "derive-bench", .root_module = derive_mod });
    const derive_step = b.step("derive-bench", "Build the derive-path bench (measurement only)");
    derive_step.dependOn(&b.addInstallArtifact(derive_exe, .{}).step);

    // Write-side bench (`--mode probe`), same arrangement.
    const idxwrite_mod = b.createModule(.{
        .root_source_file = b.path("backend/bench/index_write.zig"),
        .target = target,
        .optimize = optimize,
    });
    idxwrite_mod.addImport("supernote", supernote);
    idxwrite_mod.addImport("spd", spd_mod);
    linkSqlite(b, idxwrite_mod, sqlite_c);
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
    linkSqlite(b, backend_test_mod, sqlite_c);
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
