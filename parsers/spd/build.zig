//! Standalone build for the `.spd` parser package.
//!
//! It is intentionally self-contained: `zig build test` here runs the whole
//! suite without touching the root project's `build.zig`. When a real consumer
//! (a viewer, a search indexer) adopts this library, it imports the `spd` module
//! and links the SAME vendored SQLite via `linkSqlite` — see the root project's
//! `build.zig`, whose `linkSqlite` this mirrors.

const std = @import("std");

/// Compile flags for the vendored SQLite amalgamation. A deliberately small set
/// — the parser needs threadsafe serialisation and the deserialize API (the
/// trust model), nothing FTS5-shaped. Kept compatible with the root project's
/// flags so the two never diverge on behaviour we depend on.
const sqlite_flags = [_][]const u8{
    "-DSQLITE_THREADSAFE=1",
    "-DSQLITE_DQS=0",
    "-DSQLITE_DEFAULT_MEMSTATUS=0",
    // NOT omitting sqlite3_serialize/deserialize: they ARE the read-only
    // in-memory open this parser is built around. Default-on in SQLite ≥ 3.36.
};

/// The vendored SQLite lives at the repo root, two levels up from this package.
const vendor_sqlite = "../../vendor/sqlite";

/// Makes `@cImport(@cInclude("sqlite3.h"))` in `sqlite.zig` resolve to the
/// vendored header for `mod`, without compiling the C (see `linkSqlite`).
fn addSqliteHeaders(b: *std.Build, mod: *std.Build.Module) void {
    mod.link_libc = true;
    mod.addIncludePath(b.path(vendor_sqlite ++ "/sqlite3.h").dirname());
}

/// Compiles the vendored amalgamation into `mod`. Applied to each test root
/// exactly once so a single copy of the C ends up in each artifact.
fn linkSqlite(b: *std.Build, mod: *std.Build.Module) void {
    addSqliteHeaders(b, mod);
    mod.addCSourceFile(.{
        .file = b.path(vendor_sqlite ++ "/sqlite3.c"),
        .flags = &sqlite_flags,
    });
}

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // The importable library. Consumers must link the vendored SQLite into the
    // module that pulls this in; it only carries the header include here so its
    // `@cImport` compiles.
    const spd = b.addModule("spd", .{ .root_source_file = b.path("src/root.zig") });
    addSqliteHeaders(b, spd);

    const test_step = b.step("test", "Run the .spd parser tests");

    // Unit tests that live beside the code (reached through root.zig).
    const unit_mod = b.createModule(.{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
    });
    linkSqlite(b, unit_mod);
    test_step.dependOn(&b.addRunArtifact(b.addTest(.{ .root_module = unit_mod })).step);

    // Integration tests: real fixture correctness + the `tid` gate + hardening,
    // built on in-test synthetic `.spd` databases.
    const it_mod = b.createModule(.{
        .root_source_file = b.path("tests/spd_test.zig"),
        .target = target,
        .optimize = optimize,
    });
    it_mod.addImport("spd", spd);
    linkSqlite(b, it_mod); // the single copy of the C for this artifact
    test_step.dependOn(&b.addRunArtifact(b.addTest(.{ .root_module = it_mod })).step);
}
