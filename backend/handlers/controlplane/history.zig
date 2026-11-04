//! The history-of-this-file routes.

const std = @import("std");
const router = @import("../../http/router.zig");
const context = @import("../../http/context.zig");
const json = @import("../../http/json.zig");
const reply = @import("../../http/reply.zig");
const controlplane = @import("../../services/controlplane.zig");
const derived = @import("../../store/derived.zig");
const Context = context.Context;
const Request = router.Request;
const Params = router.Params;
const fail = reply.fail;
const badRequest = reply.badRequest;
const serverError = reply.serverError;
const read = @import("read.zig");
const bytes = @import("bytes.zig");

/// GET /api/controlplane/note/{id}/history -> the file's versions, newest first,
/// current one flagged.
pub fn history(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return historyList(ctx, req, params, .live);
}

/// GET /api/controlplane/bin/note/{id}/history -> the version list of a trashed
/// file, view-only; restore the file first to restore a version.
pub fn binHistory(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return historyList(ctx, req, params, .trashed);
}

fn historyList(ctx: *Context, req: *Request, params: Params, scope: controlplane.ControlPlaneService.ReadScope) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);
    const vo = (svc.historyIn(arena.allocator(), caller.user_id, id, scope) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .not_found, "NOT_FOUND", "no such note");
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// GET /api/controlplane/note/{id}/history/{md5}/meta -> a retained version's page
/// list and geometry from its own `note_index`, as `NoteMetaVO`. `fileHash` and
/// `size` are the version's; `id` and `name` stay the file's.
pub fn historyMeta(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const md5 = params.get("md5") orelse return badRequest(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);
    const vo = (svc.historyNoteMeta(arena.allocator(), caller.user_id, id, md5) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .not_found, "NOT_FOUND", "no such version");
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// GET /api/controlplane/note/{id}/history/{md5}/page/{n} -> page `n` of a retained
/// version. No `?v=`: `{md5}` already pins the blob. `manual_db_lock`.
pub fn historyPage(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return pageIn(ctx, req, params, .live);
}

/// GET /api/controlplane/bin/note/{id}/history/{md5}/page/{n} -> the same for a
/// trashed file.
pub fn binHistoryPage(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return pageIn(ctx, req, params, .trashed);
}

fn pageIn(ctx: *Context, req: *Request, params: Params, scope: controlplane.ControlPlaneService.ReadScope) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const md5 = params.get("md5") orelse return badRequest(ctx, req);
    const n = std.fmt.parseInt(u64, params.get("n") orelse return badRequest(ctx, req), 10) catch
        return badRequest(ctx, req);

    var svc = controlplane.ControlPlaneService.init(files);

    // The only DB touches (gate and plan), then stream unlocked, as in `read.pageBytes`.
    const planned = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        if ((files.historyVersionIn(scope, caller.user_id, id, md5) catch return serverError(ctx, req)) == null)
            break :blk null;
        break :blk svc.pagePlanForMd5(md5, n) catch return serverError(ctx, req);
    } orelse return reply.notFound(req);

    return read.writePageResponse(ctx, req, svc, planned);
}

/// POST /api/controlplane/note/{id}/history/{md5}/restore -> re-point the file at a
/// retained version through `linkBlobIndexed`, never a raw `UPDATE`, so it is
/// re-derived and the displaced current is retained (undoable). 507 over quota.
pub fn historyRestore(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const md5 = params.get("md5") orelse return badRequest(ctx, req);

    const entry = files.restoreVersion(caller.user_id, id, md5) catch |err| switch (err) {
        error.NotFound => return fail(ctx, req, .not_found, "NOT_FOUND", "no such version"),
        error.QuotaExceeded => return fail(ctx, req, .insufficient_storage, "QUOTA_EXCEEDED", "restoring this version would exceed your storage"),
        else => return serverError(ctx, req),
    };
    defer entry.deinit(ctx.gpa);

    try json.respond(ctx.gpa, req, .ok, controlplane.RestoredVersionVO{
        .md5 = entry.md5 orelse "",
        .size = @intCast(entry.size),
        .createdAt = entry.updated_at * 1000, // epoch s → ms
    }, null);
}

/// GET /api/controlplane/note/{id}/history/{md5}/raw[?download=1] -> a retained
/// version's raw bytes, for the whole-blob viewers (`.spd`, `.txt`, images). Same
/// headers as `/file/{id}` for the file's name; `{md5}` pins the blob, so no `?v=`.
/// `manual_db_lock`, streamed unlocked.
pub fn historyRaw(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return rawIn(ctx, req, params, .live);
}

/// GET /api/controlplane/bin/note/{id}/history/{md5}/raw[?download=1] -> the same
/// for a trashed file.
pub fn binHistoryRaw(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return rawIn(ctx, req, params, .trashed);
}

fn rawIn(ctx: *Context, req: *Request, params: Params, scope: controlplane.ControlPlaneService.ReadScope) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const md5 = params.get("md5") orelse return badRequest(ctx, req);
    // Capture query params BEFORE responding (responding invalidates head strings).
    const forced_download = if (reply.queryParam(req.head.target, "download")) |d|
        !std.mem.eql(u8, d, "0")
    else
        false;

    var svc = controlplane.ControlPlaneService.init(files);

    // The only DB touches (gate and name lookup). `name` is duped by `rowToEntry`,
    // so it is no borrow of statement memory.
    const resolved = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        const v = (files.historyVersionIn(scope, caller.user_id, id, md5) catch return serverError(ctx, req)) orelse
            break :blk null;
        // The version shares the file's name (hence its disposition); the current
        // md5 is irrelevant here.
        const entry = (svc.lookup(scope, caller.user_id, id) catch return serverError(ctx, req)) orelse
            break :blk null;
        if (entry.md5) |m| ctx.gpa.free(m);
        break :blk .{ .name = entry.name, .md5_hex = v.md5, .size = v.size };
    } orelse return reply.notFound(req);
    defer ctx.gpa.free(resolved.name);

    return bytes.streamRawBlob(ctx, req, resolved.name, &resolved.md5_hex, resolved.size, forced_download);
}

/// GET /api/controlplane/note/{id}/history/{md5}/page/{n}/text -> a retained
/// version's page transcript and word boxes from its own `note_page_index`, never a
/// re-parse. Same `PageTextVO` and `no-cache` policy as the live text route: `{md5}`
/// pins the content, not the JSON shape. No finished recognition is a 404.
pub fn historyPageText(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return pageTextIn(ctx, req, params, .live);
}

/// GET /api/controlplane/bin/note/{id}/history/{md5}/page/{n}/text -> the same for
/// a trashed file.
pub fn binHistoryPageText(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return pageTextIn(ctx, req, params, .trashed);
}

fn pageTextIn(ctx: *Context, req: *Request, params: Params, scope: controlplane.ControlPlaneService.ReadScope) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const md5 = params.get("md5") orelse return badRequest(ctx, req);
    const n = std.fmt.parseInt(u64, params.get("n") orelse return badRequest(ctx, req), 10) catch
        return badRequest(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);

    const version = (files.historyVersionIn(scope, caller.user_id, id, md5) catch return serverError(ctx, req)) orelse
        return reply.notFound(req);

    // Keyed by the version's md5, so it reads that version's own transcript.
    const pt = (svc.pageTextForMd5(arena.allocator(), &version.md5, n) catch return serverError(ctx, req)) orelse
        return reply.notFound(req);

    try json.respondWith(ctx.gpa, req, .ok, pt.vo, &.{
        .{ .name = "cache-control", .value = "no-cache" },
    });
}
