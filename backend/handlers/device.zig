//! Device-face handlers: the Supernote sync protocol (bind, sync bracket,
//! hash-diff summaries, file API, OSS upload/download byte paths).

const std = @import("std");
const router = @import("../http/router.zig");
const context = @import("../http/context.zig");
const json = @import("../http/json.zig");
const reply = @import("../http/reply.zig");
const multipart = @import("../http/multipart.zig");
const upload_cap = @import("upload_cap.zig");
const sync = @import("../services/sync.zig");
const filesmod = @import("../services/files.zig");
const authsvc = @import("../services/auth/service.zig");
const blobstore = @import("../store/blobs.zig");

const Context = context.Context;
const Request = router.Request;
const Params = router.Params;
const fail = reply.fail;
const badRequest = reply.badRequest;
const serverError = reply.serverError;

/// Upper bound on a device-declared byte count; keeps `used + size` far from
/// overflow. Larger values are rejected, not clamped.
pub const max_declared_bytes: i64 = 64 * 1024 * 1024 * 1024; // 64 GiB

// ---- request/response bodies ----

/// `label` is the device's default folder tree. `totalCapacity` is the device's
/// own storage in KB (spec: 设备总容量; a Nomad sent "25485312"), not a quota
/// request; it is ignored.
const BindReq = struct {
    equipmentNo: []const u8,
    /// Consulted only for a tokenless call; never trusted on its own.
    account: ?[]const u8 = null,
    name: ?[]const u8 = null,
    label: ?[]const []const u8 = null,
    totalCapacity: ?[]const u8 = null,
};
const UnbindReq = struct { equipmentNo: []const u8 };

const UserCheckReq = struct { email: ?[]const u8 = null };
const UserQueryVO = struct { success: bool = true, email: []const u8, userName: []const u8, totalCapacity: []const u8 };

/// `get_space_usage`. Field names and nesting are literal from a live Nomad
/// capture: `used` and `allocationVO.allocated` are bytes, `tag` is the account
/// class. Do not add fields the device was never observed to receive.
const SpaceUsageReq = struct { equipmentNo: ?[]const u8 = null, version: ?[]const u8 = null };
const AllocationVO = struct { tag: []const u8 = "Individual", allocated: i64 };
const SpaceUsageVO = struct { success: bool = true, used: i64, allocationVO: AllocationVO };

const SyncStartReq = struct { equipmentNo: ?[]const u8 = null };
const SyncStartVO = struct { success: bool = true, equipmentNo: []const u8, synType: bool = true };
const SyncEndReq = struct { equipmentNo: ?[]const u8 = null, flag: ?[]const u8 = null };
const SyncEndVO = struct { success: bool = true, equipmentNo: []const u8 };

/// `page` is 0-based; `size <= 0` or absent means all.
const PageReq = struct { page: ?i32 = null, size: ?i32 = null };
const SummaryByIdReq = struct { ids: ?[]const i64 = null, page: ?i32 = null, size: ?i32 = null };

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

/// Field names are literal from the capture. `finish.size` is a string and
/// unused; the size bound at apply is authoritative.
const UploadApplyReq = struct { path: []const u8, fileName: []const u8, equipmentNo: ?[]const u8 = null, size: i64 = 0 };
const UploadApplyVO = struct {
    success: bool = true,
    equipmentNo: []const u8,
    bucketName: []const u8 = "ufile",
    innerName: []const u8,
    // Cosmetic S3-style fields the device echoes; placeholders as captured.
    xAmzDate: []const u8 = "20260101T000000Z",
    authorization: []const u8 = "capture",
    fullUploadUrl: []const u8,
    partUploadUrl: []const u8,
};

const UploadFinishReq = struct {
    content_hash: []const u8,
    equipmentNo: ?[]const u8 = null,
    fileName: ?[]const u8 = null,
    innerName: []const u8,
    path: ?[]const u8 = null,
    size: ?[]const u8 = null,
};
const UploadFinishVO = struct {
    success: bool = true,
    equipmentNo: []const u8,
    id: []const u8, // the real created files.id, as a string
    name: []const u8,
    path_display: []const u8,
    size: i64 = 0, // the capture returned 0 here; the device ignores it
    content_hash: []const u8,
};

/// Planner stubs: empty lists keep the Planner app from erroring during sync.
const ScheduleGroupAllVO = struct { success: bool = true, pageToken: []const u8 = "", scheduleTaskGroup: []const struct {} = &.{} };
const ScheduleTaskAllVO = struct { success: bool = true, nextPageToken: []const u8 = "", nextSyncToken: i64 = 0, scheduleTask: []const struct {} = &.{} };

// ---- handlers ----

/// Returns the device serial (body `equipmentNo`, then the token's, then "")
/// and lazily binds it. The official app never calls `bindEquipment`, so its
/// `ANDROID-…` id is first seen on a file call. Best-effort and `user_id`-scoped.
fn resolveEquipment(ctx: *Context, body_eno: ?[]const u8, caller: *const context.Caller) []const u8 {
    const eno = body_eno orelse caller.equipmentNo() orelse "";
    if (caller.audience == .device and body_eno != null and eno.len > 0) {
        const svc = ctx.service.?;
        if (!(svc.isDeviceBound(caller.user_id, eno) catch true)) {
            // A placeholder until `bindEquipment` reports the real name.
            svc.bindDevice(caller.user_id, eno, "Supernote") catch {};
            std.log.info("device {s} auto-bound from a file call; no name reported yet", .{eno});
        }
    }
    return eno;
}

/// POST /api/terminal/equipment/unlink: the device's pre-login unlink, always
/// success. Without a caller it touches nothing: a real unlink there would let
/// any LAN client log out a device by its printed serial, and the following
/// `bindEquipment` re-binds anyway. Not yet validated on a live Nomad.
pub fn unlinkEquipmentLenient(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    var parsed = json.readBody(UnbindReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const eno = parsed.value.equipmentNo;
    if (ctx.caller) |c| {
        svc.unlinkDevice(c.user_id, eno) catch {};
    }
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// `success:true` iff an account with this email exists here.
pub fn checkExists(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    var parsed = json.readBody(UserCheckReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const email = parsed.value.email orelse return fail(ctx, req, .ok, "BAD_REQUEST", "email required");
    const exists = svc.userExistsByEmail(email) catch return serverError(ctx, req);
    if (exists) {
        try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
    } else {
        try fail(ctx, req, .ok, "USER_NOT_FOUND", "no such account");
    }
}

pub fn queryServer(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// Binds the calling device, provisions its `label` folders and ensures a
/// capacity row.
pub fn bindEquipment(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    var parsed = json.readBody(BindReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const in = parsed.value;

    // The only route that accepts a tokenless call: the Nomad sends this ~6 ms
    // before storing the token login returned, so the device name would never
    // land. Fall back to the live device session for this serial and account;
    // anyone else is still refused.
    const user_id = if (ctx.caller) |c| c.user_id else blk: {
        const account = in.account orelse return fail(ctx, req, .unauthorized, "UNAUTHORIZED", "unauthorized");
        const owner = svc.deviceSessionOwner(in.equipmentNo, account) catch return serverError(ctx, req);
        break :blk owner orelse return fail(ctx, req, .unauthorized, "UNAUTHORIZED", "unauthorized");
    };

    const name = in.name orelse "Supernote";
    svc.bindDevice(user_id, in.equipmentNo, name) catch return serverError(ctx, req);
    // The device's reported name overwrites the placeholder `resolveEquipment`
    // may have stamped (`bindDevice` never overwrites). Uses `in.name`, so the
    // fallback never clobbers a real label.
    if (in.name) |reported| svc.nameDevice(user_id, in.equipmentNo, reported) catch {};
    // Sent only when the account is added, so a stale name usually means it never arrived.
    if (in.name) |reported| {
        std.log.info("device {s} bound via bindEquipment, reported name \"{s}\"", .{ in.equipmentNo, reported });
    } else {
        std.log.info("device {s} bound via bindEquipment but reported NO name", .{in.equipmentNo});
    }

    // Creates the capacity row if missing but never lets the device set it:
    // `totalCapacity` is ignored so a device token cannot raise its own quota.
    svc.ensureCapacity(user_id, authsvc.default_capacity) catch {};
    if (ctx.files) |files| {
        if (in.label) |labels| {
            for (labels) |path| _ = files.ensureFolderPath(user_id, path) catch {};
        }
    }
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// POST /api/user/query. `totalCapacity` is emitted in bytes as a guess: no
/// capture shows the device displaying it (only `get_space_usage` is confirmed
/// bytes), and the bind-time KB field is a different quantity.
pub fn userQuery(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    const caller = ctx.caller.?; // device scope
    const info = (svc.userInfo(ctx.gpa, caller.user_id) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .unauthorized, "NO_USER", "session user no longer exists");
    defer ctx.gpa.free(info.email);
    const total = svc.userCapacity(caller.user_id) catch 0;
    var cbuf: [24]u8 = undefined;
    const cap_str = std.fmt.bufPrint(&cbuf, "{d}", .{total}) catch "0";
    try json.respond(ctx.gpa, req, .ok, UserQueryVO{
        .email = info.email,
        .userName = info.email,
        .totalCapacity = cap_str,
    }, null);
}

/// POST …/2/users/get_space_usage, from the caller's `capacity` row; the device
/// shows this number because its own `totalCapacity` is ignored. A malformed
/// body is drained, not failed.
pub fn getSpaceUsage(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files orelse return serverError(ctx, req);

    if (json.readBody(SpaceUsageReq, ctx.gpa, req)) |parsed| parsed.deinit() else |_| {}

    const cap = files.capacity(caller.user_id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, SpaceUsageVO{
        .used = cap.used,
        .allocationVO = .{ .allocated = cap.total },
    }, null);
}

/// The official app calls this right after login.
const BindStatusVO = struct { success: bool = true, errorCode: ?[]const u8 = null, errorMsg: ?[]const u8 = null, bindStatus: bool };

/// Whether the account has any active binding; identified by token.
pub fn bindStatus(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    const caller = ctx.caller.?; // device scope
    const n = svc.deviceCount(caller.user_id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, BindStatusVO{ .bindStatus = n > 0 }, null);
}

/// The `get_space_usage` numbers in the app's envelope (bytes).
const CapacityQueryVO = struct { success: bool = true, usedCapacity: i64, totalCapacity: i64 };

pub fn capacityQuery(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files orelse return serverError(ctx, req);
    const cap = files.capacity(caller.user_id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, CapacityQueryVO{
        .usedCapacity = cap.used,
        .totalCapacity = cap.total,
    }, null);
}

/// `synType:true` = incremental sync (the device diffs against the hash summary).
pub fn syncStart(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    var parsed = json.readBody(SyncStartReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const eno = resolveEquipment(ctx, parsed.value.equipmentNo, &caller);
    try json.respond(ctx.gpa, req, .ok, SyncStartVO{ .equipmentNo = eno, .synType = true }, null);
}

/// `flag` is the device's success indicator; acknowledged only.
pub fn syncEnd(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    var parsed = json.readBody(SyncEndReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const eno = resolveEquipment(ctx, parsed.value.equipmentNo, &caller);
    try json.respond(ctx.gpa, req, .ok, SyncEndVO{ .equipmentNo = eno }, null);
}

/// The md5 diff source: one entry per live file.
pub fn summaryHash(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    var parsed = json.readBody(PageReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const files = ctx.files orelse return serverError(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var syncsvc = sync.SyncService.init(files);
    const vo = syncsvc.summaryHash(arena.allocator(), caller.user_id, parsed.value.page orelse 0, parsed.value.size orelse 0) catch
        return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

pub fn summaryById(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    var parsed = json.readBody(SummaryByIdReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const files = ctx.files orelse return serverError(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var syncsvc = sync.SyncService.init(files);
    const ids = parsed.value.ids orelse &[_]i64{};
    const vo = syncsvc.summaryById(arena.allocator(), caller.user_id, ids) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// Folders as summary groups.
pub fn summaryGroup(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    var parsed = json.readBody(PageReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const files = ctx.files orelse return serverError(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var syncsvc = sync.SyncService.init(files);
    const vo = syncsvc.summaryGroup(arena.allocator(), caller.user_id, parsed.value.page orelse 0, parsed.value.size orelse 0) catch
        return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

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
fn folderPath(arena: std.mem.Allocator, raw: []const u8) ![]const u8 {
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
    const files = ctx.files orelse return serverError(ctx, req);
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
    const files = ctx.files orelse return serverError(ctx, req);
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
    const files = ctx.files orelse return serverError(ctx, req);
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
    const files = ctx.files orelse return serverError(ctx, req);

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
    const files = ctx.files orelse return serverError(ctx, req);
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
    defer ctx.gpa.free(entry.name);
    defer if (entry.md5) |m| ctx.gpa.free(m);

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
    const files = ctx.files orelse return serverError(ctx, req);
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
    defer ctx.gpa.free(entry.name);
    defer if (entry.md5) |m| ctx.gpa.free(m);

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
    const files = ctx.files orelse return serverError(ctx, req);
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
    ctx.gpa.free(gate.name);
    if (gate.md5) |m| ctx.gpa.free(m);

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
    ctx.gpa.free(moved.name);
    if (moved.md5) |m| ctx.gpa.free(m);

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
    const files = ctx.files orelse return serverError(ctx, req);
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
    ctx.gpa.free(gate.name);
    if (gate.md5) |m| ctx.gpa.free(m);

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
    ctx.gpa.free(copied.name);
    if (copied.md5) |m| ctx.gpa.free(m);

    const node = (files.nodeById(a, caller.user_id, copied.id) catch return serverError(ctx, req)) orelse
        return json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno }, null);
    try json.respond(ctx.gpa, req, .ok, MoveVO{ .equipmentNo = eno, .entriesVO = try entriesVO(a, node) }, null);
}

/// GET /oss/get/:id?t=<token>: `.public`, authorized by the `?t=` capability
/// (file-scoped, multi-use within its TTL). Any failure is 403, never 401: a
/// 401 logs the device out. Served raw, not multipart (uploads are multipart;
/// raw is accepted), streamed with a known length.
pub fn ossGet(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const files = ctx.files orelse return serverError(ctx, req);
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
    defer ctx.gpa.free(entry.name);
    defer if (entry.md5) |m| ctx.gpa.free(m);
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

// ---- device upload byte-path: apply, /oss/put, finish ----

/// The apply `path` minus its trailing `file_name`, in Dropbox form. Owned by `a`.
fn uploadFolder(a: std.mem.Allocator, path: []const u8, file_name: []const u8) ![]const u8 {
    var p = path;
    if (std.mem.endsWith(u8, p, file_name)) p = p[0 .. p.len - file_name.len];
    return folderPath(a, p);
}

/// POST …/3/files/upload/apply: quota pre-check, mint a 16-hex `inner_name`
/// and record a session for the destination; returns an `/oss/put` URL.
pub fn uploadApply(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files orelse return serverError(ctx, req);

    // Capture Host before the body read invalidates head strings.
    var host_buf: [256]u8 = undefined;
    const host = router.headerCopy(req, "host", &host_buf);

    var parsed = json.readBody(UploadApplyReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const in = parsed.value;
    // Reject a negative or absurd size before any quota arithmetic.
    if (in.size < 0 or in.size > max_declared_bytes)
        return fail(ctx, req, .ok, "QUOTA_EXCEEDED", "not enough space");
    const size: u64 = @intCast(in.size);

    const fits = files.wouldFit(caller.user_id, size) catch return serverError(ctx, req);
    if (!fits) return fail(ctx, req, .ok, "QUOTA_EXCEEDED", "not enough space");

    var raw: [8]u8 = undefined;
    ctx.io.random(&raw);
    const inner = std.fmt.bytesToHex(raw, .lower); // [16]u8

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();

    const folder = uploadFolder(a, in.path, in.fileName) catch return serverError(ctx, req);
    files.createUploadSession(caller.user_id, &inner, folder, in.fileName, size) catch return serverError(ctx, req);

    const eno = try a.dupe(u8, resolveEquipment(ctx, in.equipmentNo, &caller));
    const scheme = if (ctx.config.tls.enabled) "https" else "http";
    const url = try std.fmt.allocPrint(a, "{s}://{s}/oss/put/{s}", .{ scheme, host, &inner });
    try json.respond(ctx.gpa, req, .ok, UploadApplyVO{
        .equipmentNo = eno,
        .innerName = &inner,
        .fullUploadUrl = url,
        .partUploadUrl = url,
    }, null);
}

/// The `uploadId` names a temp file, so only `[A-Za-z0-9_-]` within
/// `max_upload_id` is accepted; no `/` or `..` out of `tmp/`.
fn validUploadId(s: []const u8) bool {
    if (s.len == 0 or s.len > blobstore.max_upload_id) return false;
    for (s) |c| {
        const ok = std.ascii.isAlphanumeric(c) or c == '-' or c == '_';
        if (!ok) return false;
    }
    return true;
}

/// Refuses an over-cap `/oss/put` body and deletes its session. The device
/// protocol's failures are HTTP 200 with a coded envelope, matching the
/// `QUOTA_EXCEEDED` apply/finish give; a 413 would read as a network failure.
fn refuseOversize(ctx: *Context, req: *Request, files: *filesmod.Files, inner: []const u8) anyerror!void {
    {
        ctx.lockDb();
        defer ctx.unlockDb();
        files.deleteUploadSession(inner) catch {};
    }
    return fail(ctx, req, .ok, "QUOTA_EXCEEDED", "not enough space");
}

/// Charges a staged part to its session and re-checks the DB total. Returns true
/// if it already answered. The `Capped` sink bounds the filesystem; this catches
/// concurrent parts of one session (the device uploads sequentially, so that is
/// a hostile client). `error.NotFound` (session gone) is refused the same way.
fn chargeSession(
    ctx: *Context,
    req: *Request,
    files: *filesmod.Files,
    user_id: u64,
    inner: []const u8,
    sink: anytype,
    prior_part: u64,
    declared: u64,
) anyerror!bool {
    const delta = @as(i64, @intCast(sink.written)) - @as(i64, @intCast(prior_part));
    const total: ?u64 = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        break :blk files.addUploadReceived(user_id, inner, delta) catch |e| switch (e) {
            error.NotFound => null,
            else => {
                try serverError(ctx, req);
                return true;
            },
        };
    };
    const t = total orelse {
        try refuseOversize(ctx, req, files, inner);
        return true;
    };
    if (t > upload_cap.limitFor(declared)) {
        try refuseOversize(ctx, req, files, inner);
        return true;
    }
    return false;
}

/// POST /oss/put/:innerName: streams the one `name="file"` multipart part into
/// the blob store and records its md5 on the session; the device expects an
/// empty 200. Capped at the session's `declared_size` plus
/// `upload_cap.slack_bytes`.
pub fn ossPut(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // device scope
    const files = ctx.files orelse return serverError(ctx, req);

    // Copy the param out; the body read invalidates head strings.
    const inner_raw = params.get("innerName") orelse return reply.notFound(req);
    var inner_buf: [64]u8 = undefined;
    if (inner_raw.len == 0 or inner_raw.len > inner_buf.len) return reply.notFound(req);
    @memcpy(inner_buf[0..inner_raw.len], inner_raw);
    const inner = inner_buf[0..inner_raw.len];

    var ct_buf: [256]u8 = undefined;
    const ct = router.headerCopy(req, "content-type", &ct_buf);
    var bnd_buf: [multipart.max_term]u8 = undefined;
    const boundary = multipart.boundaryFromContentType(ct, &bnd_buf) orelse return badRequest(ctx, req);

    // Chunk parameters (large files come in parts), read before the body.
    const total_chunks = if (reply.queryParam(req.head.target, "totalChunks")) |s|
        std.fmt.parseInt(u32, s, 10) catch 0
    else
        0;
    const part_number = if (reply.queryParam(req.head.target, "partNumber")) |s|
        std.fmt.parseInt(u32, s, 10) catch 0
    else
        0;

    var uid_buf: [blobstore.max_upload_id]u8 = undefined;
    const upload_id: ?[]const u8 = if (reply.queryParam(req.head.target, "uploadId")) |raw| uid: {
        if (!validUploadId(raw)) return badRequest(ctx, req);
        @memcpy(uid_buf[0..raw.len], raw);
        break :uid uid_buf[0..raw.len];
    } else null;

    // A multi-chunk upload needs a valid id and part number, or one chunk would
    // be stored as the whole file.
    const chunked = total_chunks > 1;
    if (chunked and (upload_id == null or part_number == 0 or part_number > total_chunks))
        return badRequest(ctx, req);

    // The session must belong to this device; DB touch 1 of 3.
    var declared: u64 = 0;
    var received: u64 = 0;
    {
        ctx.lockDb();
        defer ctx.unlockDb();
        var arena = std.heap.ArenaAllocator.init(ctx.gpa);
        defer arena.deinit();
        const session = (files.uploadSession(arena.allocator(), caller.user_id, inner) catch return serverError(ctx, req)) orelse
            return reply.notFound(req);
        declared = session.declared_size;
        received = session.received_bytes;
    }

    // A retried part replaces its deterministic temp file, so its earlier bytes
    // are credited back instead of charged twice.
    const prior_part: u64 = if (chunked) files.blobs.stagedPartSize(upload_id.?, part_number) else received;

    // The cap: bytes are held to what is left of the session's declared size as
    // they arrive, per session not per part. Quota checked only at finish would
    // let one request fill the disk (and on a Pi take the database with it).
    const limit = upload_cap.remainingFor(declared, received -| prior_part);

    // The ingest is unlocked: blob storage never touches the DB.
    var rbuf: [blobstore.chunk_len]u8 = undefined;
    const reader = req.readerExpectContinue(&rbuf) catch return badRequest(ctx, req);

    var wbuf: [blobstore.chunk_len]u8 = undefined;

    if (chunked) {
        var ing = files.blobs.beginChunkIngest(upload_id.?, part_number, &wbuf) catch return serverError(ctx, req);
        var sink = upload_cap.Capped(blobstore.ChunkIngest).init(&ing, limit);
        multipart.extract(reader, boundary, &sink) catch |err| {
            // `ChunkIngest.abort` leaves the part on disk; startup `sweepTmp` reclaims it.
            ing.abort();
            if (err == error.UploadTooLarge) return refuseOversize(ctx, req, files, inner);
            return badRequest(ctx, req);
        };
        ing.finish() catch {
            ing.abort();
            return serverError(ctx, req);
        };
        ing.deinit();

        // Charge net of a retried part. DB touch 2.
        if (try chargeSession(ctx, req, files, caller.user_id, inner, &sink, prior_part, declared)) return;

        if (part_number == total_chunks) {
            // Implicitly merge chunks on the final part
            const res = files.blobs.mergeChunks(upload_id.?, total_chunks, &wbuf) catch return serverError(ctx, req);
            {
                ctx.lockDb();
                defer ctx.unlockDb();
                files.setUploadBlob(caller.user_id, inner, &res.md5) catch return serverError(ctx, req);
            }
        }
    } else {
        var ing = files.blobs.beginIngest(&wbuf) catch return serverError(ctx, req);
        var sink = upload_cap.Capped(blobstore.Ingest).init(&ing, limit);
        multipart.extract(reader, boundary, &sink) catch |err| {
            // `abort` drops the temp file; `refuseOversize` drops the session.
            ing.abort();
            if (err == error.UploadTooLarge) return refuseOversize(ctx, req, files, inner);
            return badRequest(ctx, req);
        };
        const res = ing.finish(null) catch {
            ing.abort();
            return serverError(ctx, req);
        };
        ing.deinit();

        // The single-shot body replaces whatever the session had received.
        if (try chargeSession(ctx, req, files, caller.user_id, inner, &sink, prior_part, declared)) return;

        // finish verifies this md5; an unfinished blob is an orphan for the sweep.
        {
            ctx.lockDb();
            defer ctx.unlockDb();
            files.setUploadBlob(caller.user_id, inner, &res.md5) catch return serverError(ctx, req);
        }
    }

    // The capture's accepted response: empty 200.
    try req.respond("", .{ .status = .ok });
}

/// POST …/2/files/upload/finish: verify the stored md5 against `content_hash`,
/// link the blob under the session's bound path (not finish's echoed one),
/// charge quota and delete the session.
pub fn uploadFinish(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files orelse return serverError(ctx, req);

    var parsed = json.readBody(UploadFinishReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const in = parsed.value;

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const eno = try a.dupe(u8, resolveEquipment(ctx, in.equipmentNo, &caller));

    const session = (files.uploadSession(a, caller.user_id, in.innerName) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .ok, "NOT_FOUND", "no such upload");
    const blob_md5 = session.blob_md5 orelse return fail(ctx, req, .ok, "NO_CONTENT", "upload not received");

    // On mismatch, commit nothing; the orphan blob goes to the sweep.
    if (!std.ascii.eqlIgnoreCase(blob_md5, in.content_hash))
        return fail(ctx, req, .ok, "HASH_MISMATCH", "content hash mismatch");

    const parent: ?u64 = if (std.mem.eql(u8, session.path, "/"))
        null
    else
        files.ensureFolderPath(caller.user_id, session.path) catch return serverError(ctx, req);

    // Commit the ingested size, not the declared one: a device could declare
    // 10 GiB for 100 bytes and make readers allocate accordingly.
    const real_size = files.blobs.sizeOf(blob_md5) catch return serverError(ctx, req);
    const entry = files.linkBlob(caller.user_id, parent, session.file_name, blob_md5, real_size) catch |e| switch (e) {
        error.QuotaExceeded => return fail(ctx, req, .ok, "QUOTA_EXCEEDED", "not enough space"),
        error.NameConflict => return fail(ctx, req, .ok, "NAME_CONFLICT", "name already used by a folder"),
        else => return serverError(ctx, req),
    };
    ctx.gpa.free(entry.name);
    if (entry.md5) |m| ctx.gpa.free(m);

    files.deleteUploadSession(in.innerName) catch {};

    const id_str = try std.fmt.allocPrint(a, "{d}", .{entry.id});
    try json.respond(ctx.gpa, req, .ok, UploadFinishVO{
        .equipmentNo = eno,
        .id = id_str,
        .name = session.file_name,
        .path_display = in.path orelse session.path, // echo the device's folder, à la capture
        .content_hash = blob_md5,
    }, null);
}

/// Planner app stubs.
pub fn scheduleGroupAll(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    try json.respond(ctx.gpa, req, .ok, ScheduleGroupAllVO{}, null);
}

pub fn scheduleTaskAll(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    try json.respond(ctx.gpa, req, .ok, ScheduleTaskAllVO{}, null);
}
