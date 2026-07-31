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

/// Hard-trimmed SQLite for the WASM `.spd` decoder (`zig build wasm-spd-decode`).
///
/// The browser needs SQLite only to `sqlite3_deserialize` a memory image
/// read-only and run a handful of `SELECT`s over `config`/`surface_*` — no
/// writes, no files, no threads. So this profile drops everything that path
/// does not touch, on top of the backend's omissions:
///
///   * `THREADSAFE=0`  — the wasm instance is single-threaded; no mutexes.
///   * `OS_OTHER=1`    — remove the built-in unix/win VFS wholesale (file I/O,
///                       byte-range locking, mmap, the process randomness/time
///                       syscalls). `webapp/wasm/sqlite_vfs_null.c` supplies the
///                       minimal default VFS `sqlite3_initialize` still requires.
///   * `OMIT_WAL`      — the parser rewrites a real `.spd`'s WAL header to
///                       rollback-journal before deserialize (`neutralizeWalMode`),
///                       and `:memory:` never runs WAL, so the WAL module is dead.
///   * `OMIT_AUTOINIT` — the single entry point (`spd_decode.open`) calls
///                       `sqlite3_initialize` explicitly.
///   * `OMIT_JSON` + no FTS5/RTREE/GEOPOLY (opt-in, never enabled here) — every
///                       optional SQL module dropped.
///   * the read-only-safe omissions (UTF16, LOAD_EXTENSION, DEPRECATED,
///     SHARED_CACHE, PROGRESS_CALLBACK, AUTHORIZATION, COMPLETE, DECLTYPE,
///     TRACE, AUTOVACUUM) + `UNTESTABLE` + `DQS=0` + `MEMSTATUS=0`.
///
/// Honest caveat: there is no "read-only" flag — the b-tree/pager/SQL core stays
/// to run any SELECT. The win is dropping every optional module + the OS layer.
const spd_sqlite_wasm_flags = [_][]const u8{
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
    // Consumes one page's "SNPG" payload (see docs/wasm-note-decoder.md) and
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

    // ---- WebAssembly `.spd` viewer decoder (frontend) ----
    // The SAME `parsers/spd` parser, compiled to WASM so the browser viewer
    // never re-parses `.spd` in JS (the drift the PoC proved). SQLite is
    // compiled in RIGHT HERE with the hard-trimmed, OS-less, read-only profile
    // (`spd_sqlite_wasm_flags`) plus the null VFS — a second, tiny copy distinct
    // from the backend's full-featured one, because the two builds want opposite
    // things (FTS5 + threads server-side; none of it in the browser). Targets
    // wasm32-WASI, not freestanding: the SQLite amalgamation needs libc HEADERS
    // (<string.h>, <stdlib.h>) that only wasi-libc provides. The `OS_OTHER` VFS
    // means no WASI syscall is exercised on the read path — the imports are
    // present but inert (verified by the ABI test).
    const wasi_target = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const spd_decode_mod = b.createModule(.{
        .root_source_file = b.path("webapp/wasm/spd_decode.zig"),
        .target = wasi_target,
        .optimize = .ReleaseSmall,
    });
    spd_decode_mod.addImport("spd", spd_mod);
    spd_decode_mod.link_libc = true;
    spd_decode_mod.addIncludePath(b.path("vendor/sqlite"));
    // The trimmed amalgamation + the null VFS, compiled into THIS artifact only
    // (never the native modules, which linkSqlite their own full build).
    spd_decode_mod.addCSourceFile(.{
        .file = b.path("vendor/sqlite/sqlite3.c"),
        .flags = &spd_sqlite_wasm_flags,
    });
    spd_decode_mod.addCSourceFile(.{
        .file = b.path("webapp/wasm/sqlite_vfs_null.c"),
        .flags = &spd_sqlite_wasm_flags,
    });
    const spd_decode = b.addExecutable(.{ .name = "spd-decode", .root_module = spd_decode_mod });
    // WASI *reactor*: exports `_initialize` (runs libc/C ctors) and the `spd_*`
    // functions, with no `_start`/`main`. This is the shape a browser wants —
    // instantiate, call `_initialize` once, then call the ABI. (Plain
    // `entry = .disabled` still emitted a command-style `_start` here because
    // wasi-libc is linked; the exec model is the right knob.)
    spd_decode.wasi_exec_model = .reactor;
    spd_decode.rdynamic = true; // keep the `export fn`s
    const spd_decode_step = b.step("wasm-spd-decode", "Build the .spd viewer decoder wasm");
    spd_decode_step.dependOn(&b.addInstallArtifact(spd_decode, .{}).step);

    // ---- Server: `zig build serve -- [config.zon]` ----
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
    const serve_exe = b.addExecutable(.{ .name = "inkhold", .root_module = serve_mod });
    b.installArtifact(serve_exe);
    const run_serve = b.addRunArtifact(serve_exe);
    if (b.args) |args| run_serve.addArgs(args);
    const serve_step = b.step("serve", "Run the Inkhold server");
    serve_step.dependOn(&run_serve.step);

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
