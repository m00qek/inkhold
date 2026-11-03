//! Standalone build for the `.spd` parser package; links the vendored SQLite
//! as the root `build.zig`'s `linkSqlite` does.

const std = @import("std");

/// Flags for the vendored SQLite, kept compatible with the root project's.
const sqlite_flags = [_][]const u8{
    "-DSQLITE_THREADSAFE=1",
    "-DSQLITE_DQS=0",
    "-DSQLITE_DEFAULT_MEMSTATUS=0",
    // sqlite3_deserialize is the read-only in-memory open; do not omit it.
};

const vendor_sqlite = "../../vendor/sqlite";

fn addSqliteHeaders(b: *std.Build, mod: *std.Build.Module) void {
    mod.link_libc = true;
    mod.addIncludePath(b.path(vendor_sqlite ++ "/sqlite3.h").dirname());
}

/// Compiles the vendored amalgamation into `mod`; once per test root.
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

    // Consumers link SQLite themselves; this only carries the header include.
    const spd = b.addModule("spd", .{ .root_source_file = b.path("src/root.zig") });
    addSqliteHeaders(b, spd);

    const test_step = b.step("test", "Run the .spd parser tests");

    const unit_mod = b.createModule(.{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
    });
    linkSqlite(b, unit_mod);
    test_step.dependOn(&b.addRunArtifact(b.addTest(.{ .root_module = unit_mod })).step);

    const it_mod = b.createModule(.{
        .root_source_file = b.path("tests/spd_test.zig"),
        .target = target,
        .optimize = optimize,
    });
    it_mod.addImport("spd", spd);
    linkSqlite(b, it_mod); // the single copy of the C for this artifact
    test_step.dependOn(&b.addRunArtifact(b.addTest(.{ .root_module = it_mod })).step);
}
