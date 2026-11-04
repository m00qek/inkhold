//! The recycle bin: list, trash, restore, purge and its read-only views.

const std = @import("std");
const router = @import("../../http/router.zig");
const context = @import("../../http/context.zig");
const json = @import("../../http/json.zig");
const reply = @import("../../http/reply.zig");
const controlplane = @import("../../services/controlplane.zig");
const Context = context.Context;
const Request = router.Request;
const Params = router.Params;
const fail = reply.fail;
const badRequest = reply.badRequest;
const serverError = reply.serverError;
const bytes = @import("bytes.zig");

/// GET /api/controlplane/bin -> the caller's trashed entries, newest deletion
/// first, as a flat list; grouping is the client's.
pub fn bin(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files;

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);
    const vo = svc.bin(arena.allocator(), caller.user_id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// DELETE /api/controlplane/entry/{id} -> move a live entry and its subtree to the
/// bin. `entries` is the fanout for the undo toast, counted before the trash. No
/// quota refund here; `purge` frees the bytes.
pub fn trash(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files;
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    // `get`, not `getAnyState`: an already-trashed row is a 404, like a missing one.
    const entry = (files.get(caller.user_id, id) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .not_found, "NOT_FOUND", "no such entry");
    defer entry.deinit(ctx.gpa);

    const fanout = files.liveSubtreeCount(caller.user_id, id) catch return serverError(ctx, req);
    files.trash(caller.user_id, id) catch |err| switch (err) {
        error.NotFound => return fail(ctx, req, .not_found, "NOT_FOUND", "no such entry"),
        else => return serverError(ctx, req),
    };

    var idbuf: [24]u8 = undefined;
    const id_str = std.fmt.bufPrint(&idbuf, "{d}", .{id}) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, controlplane.TrashedVO{
        .id = id_str,
        .name = entry.name,
        .isFolder = entry.is_folder,
        .entries = @intCast(fanout),
    }, null);
}

/// POST /api/controlplane/bin/{id}/restore -> bring a trashed entry back. Reports
/// what happened: restore also revives the ancestor chain and descendants, and
/// auto-renames when a live entry took the name.
pub fn restore(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files;
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    const done = files.restore(caller.user_id, id) catch |err| switch (err) {
        error.NotFound => return fail(ctx, req, .not_found, "NOT_FOUND", "no such entry"),
        else => return serverError(ctx, req),
    };
    defer done.deinit(ctx.gpa);

    try json.respond(ctx.gpa, req, .ok, controlplane.RestoredVO{
        .name = done.name,
        .renamed = done.renamed,
        .ancestors = @intCast(done.ancestors),
        .descendants = @intCast(done.descendants),
    }, null);
}

/// DELETE /api/controlplane/bin/{id} -> destroy one trashed entry and its subtree.
/// A live id is a 404 (`Files.purge` refuses anything outside the bin).
pub fn purge(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files;
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    files.purge(caller.user_id, id) catch |err| switch (err) {
        error.NotFound => return fail(ctx, req, .not_found, "NOT_FOUND", "no such entry"),
        else => return serverError(ctx, req),
    };
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// DELETE /api/controlplane/bin -> destroy everything in the caller's bin.
pub fn emptyBin(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files;

    const n = files.emptyBin(caller.user_id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, controlplane.EmptiedVO{ .entries = @intCast(n) }, null);
}

/// GET /api/controlplane/bin/file/metadata/{id} -> the page list of a trashed item.
/// The bin routes read through `Files.getTrashed`, which sees only trashed rows;
/// `Files.get` stays live-only.
pub fn binNote(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files;
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);
    const vo = (svc.binNoteMeta(arena.allocator(), caller.user_id, id) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .not_found, "NOT_FOUND", "no such note");
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// GET /api/controlplane/bin/note/{id}/page/{n}/text -> a trashed note's page
/// transcript (retained md5-keyed after trash). A live id is a 404. `no-cache`,
/// never `immutable`: nothing in the URL pins the JSON shape.
pub fn binPageText(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files;
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const n = std.fmt.parseInt(u64, params.get("n") orelse return badRequest(ctx, req), 10) catch
        return badRequest(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);

    const pt = (svc.binPageText(arena.allocator(), caller.user_id, id, n) catch return serverError(ctx, req)) orelse
        return reply.notFound(req);

    try json.respondWith(ctx.gpa, req, .ok, pt.vo, &.{
        .{ .name = "cache-control", .value = "no-cache" },
    });
}
