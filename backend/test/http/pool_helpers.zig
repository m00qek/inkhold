//! Helpers shared by the `pool_test` tests.

const std = @import("std");
const context = @import("../../http/context.zig");
const router = @import("../../http/router.zig");
const Context = context.Context;

/// A read-only handler through `ctx.files`, so pooled dispatch runs end to end.
pub fn poolReadHandler(ctx: *Context, req: *router.Request, _: router.Params) anyerror!void {
    const files = ctx.files;
    _ = files.syncVersion(1) catch return serverErrorish(req);
    try req.respond("{\"success\":true}", .{ .status = .ok });
}

pub fn serverErrorish(req: *router.Request) anyerror!void {
    try req.respond("{\"success\":false}", .{ .status = .internal_server_error });
}
