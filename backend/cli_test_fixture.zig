//! Fixture and helpers shared by the `cli` tests.

const std = @import("std");
const testing = std.testing;
const cli = @import("cli.zig");
const Invocation = cli.Invocation;
const Style = cli.Style;
const execute = cli.execute;

/// Runs a command with captured stdout/stderr. Caller frees both slices.
pub const Captured = struct {
    code: u8,
    out: []u8,
    err: []u8,

    pub fn deinit(self: Captured, gpa: std.mem.Allocator) void {
        gpa.free(self.out);
        gpa.free(self.err);
    }
};

pub fn capture(gpa: std.mem.Allocator, inv: Invocation) !Captured {
    var out: std.Io.Writer.Allocating = .init(gpa);
    errdefer out.deinit();
    var err: std.Io.Writer.Allocating = .init(gpa);
    errdefer err.deinit();
    const code = try execute(gpa, testing.io, inv, &out.writer, &err.writer, Style.plain);
    var out_list = out.toArrayList();
    errdefer out_list.deinit(gpa);
    var err_list = err.toArrayList();
    errdefer err_list.deinit(gpa);
    return .{
        .code = code,
        .out = try out_list.toOwnedSlice(gpa),
        .err = try err_list.toOwnedSlice(gpa),
    };
}
