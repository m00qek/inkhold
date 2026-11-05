//! Device-face handlers: the Supernote sync protocol (bind, sync bracket,
//! hash-diff summaries, file API, OSS upload/download byte paths).

const std = @import("std");
const router = @import("../http/router.zig");
const context = @import("../http/context.zig");
const json = @import("../http/json.zig");
const reply = @import("../http/reply.zig");
const sync = @import("../services/sync.zig");
const library = @import("../services/library.zig");

const device_files = @import("device/files.zig");
const device_upload = @import("device/upload.zig");
const device_socket = @import("device/socket.zig");

// ---- the file API and OSS download (`device/files.zig`) ----
pub const listFolder = device_files.listFolder;
pub const queryByPathV3 = device_files.queryByPathV3;
pub const queryV3 = device_files.queryV3;
pub const downloadV3 = device_files.downloadV3;
pub const deleteFolderV3 = device_files.deleteFolderV3;
pub const createFolderV2 = device_files.createFolderV2;
pub const moveV3 = device_files.moveV3;
pub const copyV3 = device_files.copyV3;
pub const ossGet = device_files.ossGet;

// ---- the three-step upload (`device/upload.zig`) ----
pub const uploadApply = device_upload.uploadApply;
pub const ossPut = device_upload.ossPut;
pub const uploadFinish = device_upload.uploadFinish;
pub const socketIo = device_socket.socketIo;
const PageReq = device_files.PageReq;
const SummaryByIdReq = device_files.SummaryByIdReq;

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

/// The tablet stores `userId` and `uniqueMachineId` at sign-in and drops its
/// file-sync records when either differs next time (DESIGN.md §4): the
/// library id is what tells it that it now talks to another library.
const CheckExistsVO = struct {
    success: bool = true,
    userId: u64,
    uniqueMachineId: []const u8,
};
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

/// Planner stubs: empty lists keep the Planner app from erroring during sync.

// ---- handlers ----

/// Returns the device serial (body `equipmentNo`, then the token's, then "")
/// and lazily binds it. The official app never calls `bindEquipment`, so its
/// `ANDROID-…` id is first seen on a file call. Best-effort and `user_id`-scoped.
pub fn resolveEquipment(ctx: *Context, body_eno: ?[]const u8, caller: *const context.Caller) []const u8 {
    const eno = body_eno orelse caller.equipmentNo() orelse "";
    if (caller.audience == .device and body_eno != null and eno.len > 0) {
        const svc = ctx.service;
        if (!(svc.isDeviceBound(caller.user_id, eno) catch true)) {
            // A placeholder until `bindEquipment` reports the real name.
            svc.bindDevice(caller.user_id, eno, "Supernote") catch |e|
                std.log.warn("device {s}: auto-bind failed: {t}", .{ eno, e });
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
    const svc = ctx.service;
    var parsed = json.readBody(UnbindReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const eno = parsed.value.equipmentNo;
    if (ctx.caller) |c| {
        // Still "success": the following `bindEquipment` re-binds anyway.
        svc.unlinkDevice(c.user_id, eno) catch |e| std.log.warn("device {s}: pre-login unlink failed: {t}", .{ eno, e });
    }
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// `success:true` iff an account with this email exists here.
pub fn checkExists(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service;
    var parsed = json.readBody(UserCheckReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const email = parsed.value.email orelse return fail(ctx, req, .ok, "BAD_REQUEST", "email required");
    const user_id = (svc.userIdByEmail(email) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .ok, "USER_NOT_FOUND", "no such account");
    const machine_id = library.machineId(svc.db) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, CheckExistsVO{ .userId = user_id, .uniqueMachineId = &machine_id }, null);
}

pub fn queryServer(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// Binds the calling device, provisions its `label` folders and ensures a
/// capacity row.
pub fn bindEquipment(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service;
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
    if (in.name) |reported| svc.nameDevice(user_id, in.equipmentNo, reported) catch |e|
        std.log.warn("device {s}: name not stored: {t}", .{ in.equipmentNo, e });
    // Sent only when the account is added, so a stale name usually means it never arrived.
    if (in.name) |reported| {
        std.log.info("device {s} bound via bindEquipment, reported name \"{s}\"", .{ in.equipmentNo, reported });
    } else {
        std.log.info("device {s} bound via bindEquipment but reported NO name", .{in.equipmentNo});
    }

    // Creates the capacity row if missing but never lets the device set it:
    // `totalCapacity` is ignored so a device token cannot raise its own quota.
    ctx.files.ensureCapacity(user_id) catch |e| std.log.warn("user {d}: capacity row not created: {t}", .{ user_id, e });
    if (in.label) |labels| {
        // The device creates the folder itself on its first sync, so this is a convenience.
        for (labels) |path| _ = ctx.files.ensureFolderPath(user_id, path) catch |e|
            std.log.warn("user {d}: sync folder {s} not created: {t}", .{ user_id, path, e });
    }
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// POST /api/user/query. `totalCapacity` is emitted in bytes as a guess: no
/// capture shows the device displaying it (only `get_space_usage` is confirmed
/// bytes), and the bind-time KB field is a different quantity.
pub fn userQuery(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service;
    const caller = ctx.caller.?; // device scope
    const info = (svc.userInfo(ctx.gpa, caller.user_id) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .unauthorized, "NO_USER", "session user no longer exists");
    defer ctx.gpa.free(info.email);
    const total: i64 = if (ctx.files.capacity(caller.user_id)) |cap| cap.total else |_| 0;
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
    const files = ctx.files;

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
    const svc = ctx.service;
    const caller = ctx.caller.?; // device scope
    const n = svc.deviceCount(caller.user_id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, BindStatusVO{ .bindStatus = n > 0 }, null);
}

/// The `get_space_usage` numbers in the app's envelope (bytes).
const CapacityQueryVO = struct { success: bool = true, usedCapacity: i64, totalCapacity: i64 };

pub fn capacityQuery(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files;
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
    const files = ctx.files;

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
    const files = ctx.files;

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
    const files = ctx.files;

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var syncsvc = sync.SyncService.init(files);
    const vo = syncsvc.summaryGroup(arena.allocator(), caller.user_id, parsed.value.page orelse 0, parsed.value.size orelse 0) catch
        return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// The To-Do app's listings: REFUSED until Inkhold stores to-dos. The app
/// (decompiled `TaskSync.syncTaskList`) deletes from the tablet every list it
/// once synced that the server does not list, so an honest "no lists" would
/// wipe them. A `success: false` reply at 200 ends its sync with a generic
/// error before it compares anything (401/403/404 take other paths in the
/// app). The earlier stub's `pageToken: ""` read as "another page" and looped
/// the app into a crash, which by accident protected the lists too.
pub fn scheduleGroupAll(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    return fail(ctx, req, .ok, todo_unsupported, todo_unsupported_msg);
}

pub fn scheduleTaskAll(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    return fail(ctx, req, .ok, todo_unsupported, todo_unsupported_msg);
}

const todo_unsupported = "TODO_SYNC_UNSUPPORTED";
const todo_unsupported_msg = "To-Do sync is not supported by this server yet";

test {
    _ = device_files;
    _ = device_upload;
    _ = device_socket;
}
