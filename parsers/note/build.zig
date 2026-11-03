//! Standalone build for the `.note` parser package (pure Zig, no libc).

const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const note = b.addModule("note", .{ .root_source_file = b.path("src/root.zig") });

    const test_step = b.step("test", "Run the .note parser tests");

    const unit_mod = b.createModule(.{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
    });
    test_step.dependOn(&b.addRunArtifact(b.addTest(.{ .root_module = unit_mod })).step);

    for ([_][]const u8{ "tests/note_test.zig", "tests/note_container_test.zig", "tests/content_test.zig" }) |path| {
        const it_mod = b.createModule(.{
            .root_source_file = b.path(path),
            .target = target,
            .optimize = optimize,
        });
        it_mod.addImport("note", note);
        test_step.dependOn(&b.addRunArtifact(b.addTest(.{ .root_module = it_mod })).step);
    }
}
