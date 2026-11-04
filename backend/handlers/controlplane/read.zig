//! Tree, note metadata and page payloads.

const std = @import("std");
const router = @import("../../http/router.zig");
const context = @import("../../http/context.zig");
const json = @import("../../http/json.zig");
const reply = @import("../../http/reply.zig");
const controlplane = @import("../../services/controlplane.zig");
const blobstore = @import("../../store/blobs.zig");
const Context = context.Context;
const Request = router.Request;
const Params = router.Params;
const fail = reply.fail;
const badRequest = reply.badRequest;
const serverError = reply.serverError;

/// GET /api/controlplane/tree?parent={id} -> a folder's children, breadcrumb and
/// syncVersion (`parent` omitted or `root` = the root). A pure index read under the
/// global lock; only a cold blob is backfilled (parsed) in-flight, once.
pub fn tree(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files;

    const parent = reply.queryParam(req.head.target, "parent");
    var parent_id: ?u64 = null;
    if (parent) |p| {
        if (p.len != 0 and !std.mem.eql(u8, p, "root")) {
            parent_id = std.fmt.parseInt(u64, p, 10) catch return badRequest(ctx, req);
        }
    }

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);
    const vo = svc.listing(arena.allocator(), caller.user_id, parent_id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// GET /api/controlplane/file/metadata/{id} -> the full page list (per-page content
/// hash and dims), for every previewable kind. A pure index read.
pub fn note(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files;
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);
    const vo = (svc.noteMeta(arena.allocator(), caller.user_id, id) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .not_found, "NOT_FOUND", "no such note");
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// GET /note/{id}/page/{n}?v={hash} -> the immutable per-page payload. A missing
/// page or stale `?v=` is a 404, prompting a metadata refetch. `immutable` is honest
/// because the body is opaque layer bitmaps whose md5 is `?v=`; the 20-byte SNPG
/// envelope is versioned in band, so bumping `page_payload.VERSION` must also turn
/// over the `?v=` domain (`note_index.pageContentHash`). `manual_db_lock`: plan
/// under the lock, then stream unlocked with a computed `Content-Length`.
pub fn page(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return pageBytes(ctx, req, params, .live);
}

/// GET /api/controlplane/bin/note/{id}/page/{n}?v={hash} -> the same for a trashed
/// note; `.trashed` can never serve a live note, nor the live route a trashed one.
pub fn binPage(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return pageBytes(ctx, req, params, .trashed);
}

pub fn pageBytes(ctx: *Context, req: *Request, params: Params, scope: controlplane.ControlPlaneService.ReadScope) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files;
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const n = std.fmt.parseInt(u64, params.get("n") orelse return badRequest(ctx, req), 10) catch
        return badRequest(ctx, req);
    // Capture `?v=` before responding (responding invalidates the head strings).
    const v = reply.queryParam(req.head.target, "v");

    var svc = controlplane.ControlPlaneService.init(files);

    // The only DB touches. `pagePlanOf` needs the lock; `writePage` is DB-free. The
    // plan is inline storage with no borrow of statement memory, so it outlives the unlock.
    const planned = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        const entry = (svc.lookup(scope, caller.user_id, id) catch return serverError(ctx, req)) orelse
            break :blk null;
        defer entry.deinit(ctx.gpa);
        break :blk svc.pagePlanOf(entry, n) catch return serverError(ctx, req);
    } orelse return reply.notFound(req);

    // Checked against the stored hash, so a stale `?v=` costs no file I/O.
    if (v == null or !std.ascii.eqlIgnoreCase(v.?, &planned.plan.content_hash))
        return reply.notFound(req);

    return writePageResponse(ctx, req, svc, planned);
}

/// Streams a resolved page's SNPG payload with ETag = content hash and `immutable`.
/// The caller resolved `planned` under the lock and validated `?v=` where needed.
pub fn writePageResponse(ctx: *Context, req: *Request, svc: controlplane.ControlPlaneService, planned: controlplane.PagePlan) anyerror!void {
    var etag_buf: [36]u8 = undefined;
    const etag = std.fmt.bufPrint(&etag_buf, "\"{s}\"", .{planned.plan.content_hash}) catch
        return serverError(ctx, req);

    var wbuf: [blobstore.chunk_len]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .content_length = planned.plan.content_length,
        .respond_options = .{ .extra_headers = &.{
            .{ .name = "content-type", .value = "application/octet-stream" },
            .{ .name = "cache-control", .value = "public, max-age=31536000, immutable" },
            .{ .name = "etag", .value = etag },
        } },
    }) catch return;

    // The head is already sent, so a mid-stream failure must close the connection
    // (truncation signal). Never call `body.end()` on a short body: it asserts the
    // `Content-Length` was reached and panics in safe builds.
    svc.writePage(planned, &body.writer) catch return error.StreamTruncated;
    body.end() catch {};
}
