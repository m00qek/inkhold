//! Device file enumeration, tree edits (delete, create, move, copy) and raw download.

const std = @import("std");
const router = @import("../../http/router.zig");
const context = @import("../../http/context.zig");
const json = @import("../../http/json.zig");
const reply = @import("../../http/reply.zig");
const multipart = @import("../../http/multipart.zig");
const sync = @import("../../services/sync.zig");
const filesmod = @import("../../services/files.zig");
const blobstore = @import("../../store/blobs.zig");
const Context = context.Context;
const Request = router.Request;
const Params = router.Params;
const fail = reply.fail;
const badRequest = reply.badRequest;
const serverError = reply.serverError;
const device = @import("../device.zig");
const resolveEquipment = device.resolveEquipment;

/// `page` is 0-based; `size <= 0` or absent means all.
pub const PageReq = struct { page: ?i32 = null, size: ?i32 = null };

pub const SummaryByIdReq = struct { ids: ?[]const i64 = null, page: ?i32 = null, size: ?i32 = null };

/// One entry as the device file API expects it. Field names are literal (mixed
/// snake/camelCase, from a capture and the allenporter reference). Unverified
/// on hardware: `path_display` has a leading and no trailing slash,
/// `lastUpdateTime` is milliseconds, `is_downloadable = !is_folder`.
const EntriesVO = struct {
    tag: []const u8, // "file" | "folder"
    id: []const u8, // our files.id, as a string
    name: []const u8,
    path_display: []const u8,
    content_hash: []const u8, // md5 for files; "" for folders
    is_downloadable: bool,
    size: i64,
    lastUpdateTime: i64,
    parent_path: []const u8,
};

const ListFolderReq = struct { path: ?[]const u8 = null, recursive: ?bool = null, equipmentNo: ?[]const u8 = null };

const ListFolderVO = struct { success: bool = true, equipmentNo: []const u8, entries: []const EntriesVO };

const QueryByPathReq = struct { path: ?[]const u8 = null };

const QueryByIdReq = struct { id: ?[]const u8 = null };

/// A not-found omits `entriesVO` (null optionals are dropped).
const EntriesQueryVO = struct { success: bool = true, equipmentNo: []const u8, entriesVO: ?EntriesVO = null };

const DownloadReq = struct { id: ?[]const u8 = null };

const DownloadVO = struct {
    success: bool = true,
    equipmentNo: []const u8,
    id: []const u8,
    url: []const u8,
    name: []const u8,
    path_display: []const u8,
    content_hash: []const u8,
    size: i64,
    is_downloadable: bool,
};

/// `delete_folder_v3` deletes files too (the capture's `id: "19"` was a note).
/// An unknown id omits `metadata`.
const DeleteFolderReq = struct { id: ?[]const u8 = null, equipmentNo: ?[]const u8 = null };

const DeleteMetadataVO = struct {
    tag: []const u8, // "file" | "folder"
    id: []const u8, // our files.id, as a string
    name: []const u8,
};

const DeleteFolderVO = struct { success: bool = true, equipmentNo: []const u8, metadata: ?DeleteMetadataVO = null };

/// `create_folder_v2`, shaped after the spec's `CreateFolderLocalDTO/VO`.
/// `path_display` matters: under `autorename` it is how the device learns
/// where its folder landed.
const CreateFolderReq = struct {
    path: ?[]const u8 = null,
    autorename: ?bool = null,
    equipmentNo: ?[]const u8 = null,
};

const CreateMetadataVO = struct {
    tag: []const u8 = "folder",
    id: []const u8,
    name: []const u8,
    path_display: []const u8,
};

const CreateFolderVO = struct { success: bool = true, equipmentNo: []const u8, metadata: ?CreateMetadataVO = null };

/// `move_v3`. `to_path` is the full destination path including the filename,
/// despite the OpenAPI "parent directory" wording. Same parent = rename.
const MoveReq = struct {
    id: ?[]const u8 = null,
    to_path: ?[]const u8 = null,
    autorename: ?bool = null,
    equipmentNo: ?[]const u8 = null,
};

/// Every never-404 case omits `entriesVO`; on success it carries the entry
/// after the move, so the device learns any autorenamed name.
const MoveVO = struct { success: bool = true, equipmentNo: []const u8, entriesVO: ?EntriesVO = null };

// ---- device file enumeration + raw download ----

/// `n`'s slices are arena-owned and reused.
fn entriesVO(arena: std.mem.Allocator, n: filesmod.TreeNode) !EntriesVO {
    return .{
        .tag = if (n.is_folder) "folder" else "file",
        .id = try std.fmt.allocPrint(arena, "{d}", .{n.id}),
        .name = n.name,
        .path_display = n.path_display,
        .content_hash = n.md5,
        .is_downloadable = !n.is_folder, // FLAGGED assumption (see EntriesVO)
        .size = @intCast(n.size),
        .lastUpdateTime = n.updated_at * 1000, // ms — FLAGGED assumption (see EntriesVO)
        .parent_path = n.parent_path,
    };
}

/// Dropbox form: leading slash, no trailing slash, root = "/". Owned by `arena`.
pub fn folderPath(arena: std.mem.Allocator, raw: []const u8) ![]const u8 {
    const t = std.mem.trimEnd(u8, std.mem.trim(u8, raw, " "), "/");
    if (t.len == 0) return "/";
    if (t[0] != '/') return std.fmt.allocPrint(arena, "/{s}", .{t});
    return arena.dupe(u8, t);
}

fn parseId(s: ?[]const u8) ?u64 {
    const v = s orelse return null;
    return std.fmt.parseInt(u64, v, 10) catch null;
}

/// Splits a full path into parent (Dropbox form, root `/`) and final name; an
/// empty name means nothing to act on. Slices point into `path`.
const SplitPath = struct { parent: []const u8, name: []const u8 };

fn splitPath(path: []const u8) SplitPath {
    const t = std.mem.trimEnd(u8, path, "/");
    if (std.mem.lastIndexOfScalar(u8, t, '/')) |i| {
        return .{ .parent = if (i == 0) "/" else t[0..i], .name = t[i + 1 ..] };
    }
    return .{ .parent = "/", .name = t }; // a bare name at the root (or empty)
}

/// POST …/2/files/list_folder: the download trigger; the device pulls whatever
/// this reports that it lacks.
pub fn listFolder(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files;
    var parsed = json.readBody(ListFolderReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();

    const eno = try a.dupe(u8, resolveEquipment(ctx, parsed.value.equipmentNo, &caller));
    const recursive = parsed.value.recursive orelse false;
    const target = try folderPath(a, parsed.value.path orelse "/");
    const is_root = std.mem.eql(u8, target, "/");

    // `manual_db_lock`: DB touched only here; the VO is built unlocked.
    const nodes: []filesmod.TreeNode = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        if (is_root) {
            break :blk (if (recursive)
                files.walkTree(a, caller.user_id)
            else
                files.walkChildren(a, caller.user_id, null, target)) catch return serverError(ctx, req);
        }
        // An unknown path lists nothing.
        const fid = (files.resolvePath(caller.user_id, target) catch return serverError(ctx, req)) orelse
            break :blk &[_]filesmod.TreeNode{};
        break :blk (if (recursive)
            files.walkSubtree(a, caller.user_id, fid, target)
        else
            files.walkChildren(a, caller.user_id, fid, target)) catch return serverError(ctx, req);
    };

    var entries: std.ArrayList(EntriesVO) = .empty;
    for (nodes) |n| try entries.append(a, try entriesVO(a, n));
    try json.respond(ctx.gpa, req, .ok, ListFolderVO{ .equipmentNo = eno, .entries = entries.items }, null);
}

/// Not found omits `entriesVO`.
pub fn queryByPathV3(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files;
    var parsed = json.readBody(QueryByPathReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const eno = try a.dupe(u8, caller.equipmentNo() orelse "");

    const id = (files.resolvePath(caller.user_id, parsed.value.path orelse "") catch return serverError(ctx, req)) orelse
        return json.respond(ctx.gpa, req, .ok, EntriesQueryVO{ .equipmentNo = eno }, null);
    const node = (files.nodeById(a, caller.user_id, id) catch return serverError(ctx, req)) orelse
        return json.respond(ctx.gpa, req, .ok, EntriesQueryVO{ .equipmentNo = eno }, null);
    try json.respond(ctx.gpa, req, .ok, EntriesQueryVO{ .equipmentNo = eno, .entriesVO = try entriesVO(a, node) }, null);
}

/// By id; unknown omits `entriesVO`.
pub fn queryV3(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files;
    var parsed = json.readBody(QueryByIdReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const eno = try a.dupe(u8, caller.equipmentNo() orelse "");

    const id = parseId(parsed.value.id) orelse
        return json.respond(ctx.gpa, req, .ok, EntriesQueryVO{ .equipmentNo = eno }, null);
    const node = (files.nodeById(a, caller.user_id, id) catch return serverError(ctx, req)) orelse
        return json.respond(ctx.gpa, req, .ok, EntriesQueryVO{ .equipmentNo = eno }, null);
    try json.respond(ctx.gpa, req, .ok, EntriesQueryVO{ .equipmentNo = eno, .entriesVO = try entriesVO(a, node) }, null);
}

/// POST …/3/files/download_v3. The URL is built from `Host` (the address the
/// device dialed) and our own scheme, and carries a short-TTL file-scoped
/// `?t=` token because the device sends no `x-access-token` on the GET.
pub fn downloadV3(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files;

    // Capture Host before the body read invalidates head strings.
    var host_buf: [256]u8 = undefined;
    const host = router.headerCopy(req, "host", &host_buf);

    var parsed = json.readBody(DownloadReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const eno = try a.dupe(u8, caller.equipmentNo() orelse "");

    const id = parseId(parsed.value.id) orelse return fail(ctx, req, .ok, "NOT_FOUND", "no such file");
    const node = (files.nodeById(a, caller.user_id, id) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .ok, "NOT_FOUND", "no such file");

    const id_str = try std.fmt.allocPrint(a, "{d}", .{node.id});

    const tokens = ctx.download_tokens orelse return serverError(ctx, req);
    const now_ms = std.Io.Clock.real.now(ctx.io).toMilliseconds();
    const tok = tokens.mint(ctx.io, node.id, caller.user_id, now_ms) catch return serverError(ctx, req);
    const scheme = if (ctx.config.tls.enabled) "https" else "http";
    const url = try std.fmt.allocPrint(a, "{s}://{s}/oss/get/{s}?t={s}", .{ scheme, host, id_str, &tok });
    try json.respond(ctx.gpa, req, .ok, DownloadVO{
        .equipmentNo = eno,
        .id = id_str,
        .url = url,
        .name = node.name,
        .path_display = node.path_display,
        .content_hash = node.md5,
        .size = @intCast(node.size),
        .is_downloadable = !node.is_folder,
    }, null);
}

/// POST …/3/files/delete_folder_v3: soft-delete into the bin. The device walks
/// the subtree itself (children first, one request each, with retries), so
/// this trashes exactly one row; `Files.trash` keeps the first `deleted_at`.
/// Quota is refunded only at purge. `getAnyState` so a retry on a trashed row
/// still settles. An unknown or foreign id answers success: a 404 here made the
/// device re-download what it deleted, and it hides other users' ids.
pub fn deleteFolderV3(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files;
    var parsed = json.readBody(DeleteFolderReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const eno = try a.dupe(u8, resolveEquipment(ctx, parsed.value.equipmentNo, &caller));

    const id = parseId(parsed.value.id) orelse
        return json.respond(ctx.gpa, req, .ok, DeleteFolderVO{ .equipmentNo = eno }, null);

    // Read before trashing so a retry still reports the name.
    const entry = (files.getAnyState(caller.user_id, id) catch return serverError(ctx, req)) orelse
        return json.respond(ctx.gpa, req, .ok, DeleteFolderVO{ .equipmentNo = eno }, null);
    defer entry.deinit(ctx.gpa);

    const name = try a.dupe(u8, entry.name);
    files.trash(caller.user_id, id) catch return serverError(ctx, req);

    try json.respond(ctx.gpa, req, .ok, DeleteFolderVO{
        .equipmentNo = eno,
        .metadata = .{
            .tag = if (entry.is_folder) "folder" else "file",
            .id = try std.fmt.allocPrint(a, "{d}", .{id}),
            .name = name,
        },
    }, null);
}

/// POST …/2/files/create_folder_v2. The device sends `autorename: false`
/// (idempotent). A missing path or a file on the path answers success with no
/// `metadata`, never an error the firmware might retry forever.
pub fn createFolderV2(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files;
    var parsed = json.readBody(CreateFolderReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const eno = try a.dupe(u8, resolveEquipment(ctx, parsed.value.equipmentNo, &caller));

    const path = parsed.value.path orelse
        return json.respond(ctx.gpa, req, .ok, CreateFolderVO{ .equipmentNo = eno }, null);

    const entry = files.createFolderPath(caller.user_id, path, parsed.value.autorename orelse false) catch |err| switch (err) {
        // Not retryable: answer the settled shape.
        error.NameConflict, error.NotFound, error.NotAFolder => return json.respond(ctx.gpa, req, .ok, CreateFolderVO{ .equipmentNo = eno }, null),
        else => return serverError(ctx, req),
    };
    defer entry.deinit(ctx.gpa);

    // The real path: `autorename` may have changed the leaf.
    const display = files.pathOf(a, caller.user_id, entry.id) catch return serverError(ctx, req);

    try json.respond(ctx.gpa, req, .ok, CreateFolderVO{
        .equipmentNo = eno,
        .metadata = .{
            .id = try std.fmt.allocPrint(a, "{d}", .{entry.id}),
            .name = try a.dupe(u8, entry.name),
            .path_display = display,
        },
    }, null);
}

/// POST …/3/files/move_v3. Must never 404: the firmware aborts the whole sync.
/// Every unusable or refused input answers success with `entriesVO` omitted.
/// A foreign id looks missing, and no destination folders are provisioned for
/// an id we cannot move.
pub fn moveV3(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files;
    var parsed = json.readBody(MoveReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const eno = try a.dupe(u8, resolveEquipment(ctx, parsed.value.equipmentNo, &caller));

    const id = parseId(parsed.value.id) orelse
        return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null);
    const to_path = parsed.value.to_path orelse
        return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null);
    const split = splitPath(to_path);
    if (split.name.len == 0)
        return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null);

    // Foreign or unknown id settles as success; no phantom destination folders.
    const gate = (files.getAnyState(caller.user_id, id) catch return serverError(ctx, req)) orelse
        return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null);
    gate.deinit(ctx.gpa);

    // A file on the parent path is a NameConflict and settles as success.
    const parent: ?u64 = if (std.mem.eql(u8, split.parent, "/"))
        null
    else
        files.ensureFolderPath(caller.user_id, split.parent) catch |e| switch (e) {
            error.NameConflict => return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null),
            else => return serverError(ctx, req),
        };

    const moved = files.move(caller.user_id, id, parent, split.name, parsed.value.autorename orelse false) catch |e| switch (e) {
        // All settled outcomes; never clobbers a sibling (NameConflict) and
        // refuses a folder into its own subtree (InvalidMove).
        error.NotFound, error.NameConflict, error.InvalidMove, error.NotAFolder => return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null),
        else => return serverError(ctx, req),
    };
    moved.deinit(ctx.gpa);

    const node = (files.nodeById(a, caller.user_id, moved.id) catch return serverError(ctx, req)) orelse
        return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null);
    try json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno, .entriesVO = try entriesVO(a, node) }, null);
}

/// POST …/3/files/copy_v3, used for conflict resolution: the firmware copies a
/// diverged note aside to `…_CONFLICT_<ts>.note` (it picks the name). Never
/// 404s, like `move_v3`. The copy shares the source blob.
pub fn copyV3(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files;
    var parsed = json.readBody(MoveReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const eno = try a.dupe(u8, resolveEquipment(ctx, parsed.value.equipmentNo, &caller));

    const id = parseId(parsed.value.id) orelse
        return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null);
    const to_path = parsed.value.to_path orelse
        return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null);
    const split = splitPath(to_path);
    if (split.name.len == 0)
        return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null);

    const gate = (files.getAnyState(caller.user_id, id) catch return serverError(ctx, req)) orelse
        return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null);
    gate.deinit(ctx.gpa);

    const parent: ?u64 = if (std.mem.eql(u8, split.parent, "/"))
        null
    else
        files.ensureFolderPath(caller.user_id, split.parent) catch |e| switch (e) {
            error.NameConflict => return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null),
            else => return serverError(ctx, req),
        };

    const copied = files.copy(caller.user_id, id, parent, split.name, parsed.value.autorename orelse false) catch |e| switch (e) {
        // All settled outcomes; folder copies (IsFolder) are not performed.
        error.NotFound, error.IsFolder, error.NameConflict, error.NotAFolder, error.QuotaExceeded => return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null),
        else => return serverError(ctx, req),
    };
    copied.deinit(ctx.gpa);

    const node = (files.nodeById(a, caller.user_id, copied.id) catch return serverError(ctx, req)) orelse
        return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null);
    try json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno, .entriesVO = try entriesVO(a, node) }, null);
}

/// GET /oss/get/:id?t=<token>: `.public`, authorized by the `?t=` capability
/// (file-scoped, multi-use within its TTL). Any failure is 403, never 401: a
/// 401 logs the device out. Served raw, not multipart (uploads are multipart;
/// raw is accepted), streamed with a known length.
pub fn ossGet(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const files = ctx.files;
    const id = reply.pathId(params) orelse return reply.notFound(req);

    const tokens = ctx.download_tokens orelse return reply.forbidden(req);
    const t = reply.queryParam(req.head.target, "t") orelse return reply.forbidden(req);
    const now_ms = std.Io.Clock.real.now(ctx.io).toMilliseconds();
    const user_id = tokens.lookup(ctx.io, t, id, now_ms) orelse return reply.forbidden(req);

    // The only DB touch; `entry`'s strings are gpa-owned copies, safe after unlock.
    const got = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        break :blk files.get(user_id, id);
    };
    const entry = (got catch return serverError(ctx, req)) orelse return reply.notFound(req);
    defer entry.deinit(ctx.gpa);
    if (entry.is_folder) return reply.notFound(req);
    const md5 = entry.md5 orelse return reply.notFound(req);

    var file = files.blobs.open(md5) catch return reply.notFound(req);
    defer file.close(ctx.io);

    // Content-Disposition with the filename is required: without it the device
    // cannot materialize the note and the sync fails.
    var cd_buf: [512]u8 = undefined;
    const cd = std.fmt.bufPrint(&cd_buf, "attachment; filename=\"{s}\"", .{entry.name}) catch return serverError(ctx, req);

    var wbuf: [blobstore.chunk_len]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .content_length = entry.size,
        .respond_options = .{ .extra_headers = &.{
            .{ .name = "content-type", .value = "application/octet-stream" },
            .{ .name = "content-disposition", .value = cd },
            .{ .name = "accept-ranges", .value = "bytes" },
        } },
    }) catch return;

    // Pump exactly `entry.size`. On a short blob or a dropped connection, return
    // without `body.end()`, which asserts the full length and would panic.
    var rbuf: [blobstore.chunk_len]u8 = undefined;
    var fr = file.reader(ctx.io, &rbuf);
    fr.interface.streamExact64(&body.writer, entry.size) catch return error.StreamTruncated;
    body.end() catch {};
}
