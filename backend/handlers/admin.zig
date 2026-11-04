//! Admin handlers: household users, per-person devices and quota, server-wide
//! settings and health, and the elevation gate. Everything but `elevate`/`lock`
//! is `require_admin` (admin plus a recent password re-entry).

const router = @import("../http/router.zig");
const context = @import("../http/context.zig");
const json = @import("../http/json.zig");
const reply = @import("../http/reply.zig");
const transport = @import("../http/transport.zig");
const authsvc = @import("../services/auth/service.zig");
const settingsmod = @import("../services/settings.zig");
const healthmod = @import("../services/health.zig");
const filesmod = @import("../services/files.zig");
const lockstats = @import("../http/lock_stats.zig");
const authhandlers = @import("auth.zig"); // for `api_version`, the one place it is defined

const Context = context.Context;
const Request = router.Request;
const Params = router.Params;
const fail = reply.fail;
const badRequest = reply.badRequest;
const serverError = reply.serverError;

// ---- request/response bodies ----

/// No `password`: the server generates the temporary one.
const CreateUserReq = struct { email: []const u8, isAdmin: bool = false };

/// `temporaryPassword` is returned exactly once; only its hash is stored.
const CreateUserVO = struct { success: bool = true, userId: u64, temporaryPassword: []const u8 };
const ResetPasswordVO = struct { success: bool = true, temporaryPassword: []const u8 };
const UsersVO = struct { success: bool = true, users: []const authsvc.UserInfo };

/// Service structs serialized verbatim (snake_case), matching `UsersVO`.
const DevicesVO = struct { success: bool = true, devices: []const authsvc.DeviceInfo };

const UnlinkDeviceReq = struct { equipmentNo: []const u8 };

const QuotaVO = struct { success: bool = true, used_bytes: i64, total_bytes: i64 };
const SetQuotaReq = struct { totalBytes: i64 };

/// Bounds travel with the value so the console can validate before posting.
const RetentionVO = struct {
    success: bool = true,
    retentionDays: i64,
    defaultDays: i64,
    minDays: i64,
    maxDays: i64,
    /// Epoch seconds of the last change (0 if never); also when the
    /// non-retroactive grace period started.
    changedAt: i64,
};
const SetRetentionReq = struct { retentionDays: i64 };

/// `dbLock` is omitted when nothing is measuring, so it never reads as idle.
const HealthVO = struct {
    success: bool = true,
    health: healthmod.Health,
    dbLock: ?DbLockVO = null,
};

/// Aggregate `db_lock` occupancy plus per-route attribution.
const DbLockVO = struct {
    /// Lock windows since start; a `manual_db_lock` route contributes several per
    /// request. Pooled reads are excluded here (they hold the lock only for the
    /// session lookup) but reported per route.
    windows: u64,
    /// Total hold time; `windows / total_held_ns` gives the requests/s ceiling.
    total_held_ns: u64,
    routes: []const lockstats.RouteReport,
};

/// `password` is the login challenge, as `auth.loginNew` takes it. No account
/// field: the session names the caller.
const ElevateReq = struct { password: []const u8 };

/// Sliding idle deadline, epoch seconds.
const ElevateVO = struct { success: bool = true, elevatedUntil: i64 };

// ---- handlers ----

/// POST /api/admin/users. The server generates the temporary password and
/// returns it once; the account starts must-change.
pub fn createUser(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    const actor = ctx.caller.?; // require_admin guarantees an elevated admin caller
    var parsed = json.readBody(CreateUserReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const in = parsed.value;

    const created = svc.createUser(actor.user_id, in.email, in.isAdmin) catch |err| switch (err) {
        error.EmailExists => return fail(ctx, req, .ok, "EMAIL_EXISTS", "an account with that email already exists"),
        else => return serverError(ctx, req),
    };
    try json.respond(ctx.gpa, req, .ok, CreateUserVO{
        .userId = created.id,
        .temporaryPassword = created.temp_password.slice(),
    }, null);
}

pub fn listUsers(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    const users = svc.listUsers(ctx.gpa) catch return serverError(ctx, req);
    defer authsvc.Service.freeUsers(ctx.gpa, users);
    try json.respond(ctx.gpa, req, .ok, UsersVO{ .users = users }, null);
}

/// DELETE /api/admin/users/:id. Not the last admin, not yourself.
pub fn deleteUser(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const svc = ctx.service.?;
    const actor = ctx.caller.?;
    const files = ctx.files.?; // deletion must release the account's blob references
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    svc.deleteUser(actor.user_id, id, files.*) catch |err| switch (err) {
        error.LastAdmin => return fail(ctx, req, .ok, "LAST_ADMIN", "cannot remove the last administrator"),
        // Distinct from LAST_ADMIN, which is about the household.
        error.CannotDeleteSelf => return fail(ctx, req, .ok, "CANNOT_DELETE_SELF", "another administrator has to remove your account"),
        else => return serverError(ctx, req),
    };
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// POST /api/admin/users/:id/reset. Server-picked temporary password, returned
/// once; sets must-change and revokes the target's sessions (and so elevation).
pub fn resetPassword(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const svc = ctx.service.?;
    const actor = ctx.caller.?;
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const temp = svc.resetPassword(actor.user_id, id) catch |e| switch (e) {
        error.CannotResetSelf => return fail(ctx, req, .ok, "CANNOT_RESET_SELF", "change your own password on your account page"),
        else => return serverError(ctx, req),
    };
    try json.respond(ctx.gpa, req, .ok, ResetPasswordVO{ .temporaryPassword = temp.slice() }, null);
}

// ---- one person's devices, and their quota ----
// The services take `actor` and `target` and do the ownership checks; these
// shells never re-derive ownership.

pub fn listDevices(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const svc = ctx.service.?;
    const actor = ctx.caller.?; // require_admin guarantees an elevated admin caller
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const devices = svc.listUserDevices(ctx.gpa, actor.user_id, id) catch |err| switch (err) {
        error.UserNotFound => return fail(ctx, req, .not_found, "USER_NOT_FOUND", "no such user"),
        else => return serverError(ctx, req),
    };
    defer authsvc.Service.freeDevices(ctx.gpa, devices);
    try json.respond(ctx.gpa, req, .ok, DevicesVO{ .devices = devices }, null);
}

/// POST /api/admin/users/{id}/devices/unlink. A soft status flip: sessions die,
/// the binding row survives for re-pairing. `DEVICE_NOT_FOUND` (404) also covers
/// a serial owned by another housemate, so nothing leaks.
pub fn unlinkDevice(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const svc = ctx.service.?;
    const actor = ctx.caller.?;
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    var parsed = json.readBody(UnlinkDeviceReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    svc.adminUnlinkDevice(actor.user_id, id, parsed.value.equipmentNo) catch |err| switch (err) {
        error.DeviceNotFound => return fail(ctx, req, .not_found, "DEVICE_NOT_FOUND", "that user has no such device"),
        else => return serverError(ctx, req),
    };
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

pub fn getQuota(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const svc = ctx.service.?;
    const actor = ctx.caller.?;
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const files = ctx.files orelse return serverError(ctx, req);
    const q = svc.userQuota(actor.user_id, id, files.*) catch |err| switch (err) {
        error.UserNotFound => return fail(ctx, req, .not_found, "USER_NOT_FOUND", "no such user"),
        else => return serverError(ctx, req),
    };
    try json.respond(ctx.gpa, req, .ok, QuotaVO{ .used_bytes = q.used_bytes, .total_bytes = q.total_bytes }, null);
}

/// PUT /api/admin/users/{id}/quota. An allotment below usage is accepted and
/// deletes nothing; the meter must draw `used > total`.
pub fn setQuota(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const svc = ctx.service.?;
    const actor = ctx.caller.?;
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    var parsed = json.readBody(SetQuotaReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    const files = ctx.files orelse return serverError(ctx, req);
    const q = svc.setUserQuota(actor.user_id, id, parsed.value.totalBytes, files.*) catch |err| switch (err) {
        error.UserNotFound => return fail(ctx, req, .not_found, "USER_NOT_FOUND", "no such user"),
        error.InvalidQuota => return fail(ctx, req, .bad_request, "INVALID_QUOTA", "an allotment cannot be negative"),
        else => return serverError(ctx, req),
    };
    try json.respond(ctx.gpa, req, .ok, QuotaVO{ .used_bytes = q.used_bytes, .total_bytes = q.total_bytes }, null);
}

// ---- server-wide: retention and health ----

pub fn getRetention(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const files = ctx.files orelse return serverError(ctx, req);
    const set = settingsmod.Settings.init(ctx.io, files.db);
    const r = set.binRetention() catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, retentionVO(r), null);
}

/// PUT /api/admin/settings/retention. Never purges retroactively: the new
/// window starts at this write (`settings.sweepCutoff`).
pub fn setRetention(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const files = ctx.files orelse return serverError(ctx, req);
    var parsed = json.readBody(SetRetentionReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    const set = settingsmod.Settings.init(ctx.io, files.db);
    const r = set.setBinRetentionDays(parsed.value.retentionDays) catch |err| switch (err) {
        error.InvalidRetention => return fail(ctx, req, .bad_request, "INVALID_RETENTION", "retention must be between 1 and 365 days"),
        else => return serverError(ctx, req),
    };
    try json.respond(ctx.gpa, req, .ok, retentionVO(r), null);
}

fn retentionVO(r: settingsmod.Retention) RetentionVO {
    return .{
        .retentionDays = r.days(),
        .defaultDays = @divTrunc(filesmod.Files.bin_retention_s, settingsmod.seconds_per_day),
        .minDays = settingsmod.min_retention_days,
        .maxDays = settingsmod.max_retention_days,
        .changedAt = r.changed_at,
    };
}

/// GET /api/admin/health. Household-wide totals only, never per-person.
/// `memory_bytes` is null where unknown and must not render as 0 B.
pub fn health(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const files = ctx.files orelse return serverError(ctx, req);
    const snap = healthmod.snapshot(ctx.io, files.db, authhandlers.api_version) catch
        return serverError(ctx, req);

    // Stack-allocated: reporting the lock must not allocate on the path it measures.
    var rows: [lockstats.max_routes]lockstats.RouteReport = undefined;
    const db_lock: ?DbLockVO = if (ctx.lock_stats) |st| blk: {
        const t = st.totals();
        break :blk .{
            .windows = t.count,
            .total_held_ns = t.total_ns,
            .routes = lockstats.report(st, ctx.routes, &rows),
        };
    } else null;

    try json.respond(ctx.gpa, req, .ok, HealthVO{ .health = snap, .dbLock = db_lock }, null);
}

// ---- elevation (re-authentication) ----

/// POST /api/admin/elevate. Uses the login challenge (`random/code` then
/// `sha256_hex(md5_hex(pw) + code)`), since the LAN may be plain HTTP. A
/// non-admin gets the same `INVALID_CREDENTIALS` as a wrong password, so
/// admins cannot be enumerated.
pub fn elevate(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    const caller = ctx.caller.?;
    // Copy the token first: the body read overwrites the head buffer it slices.
    var token_buf: [128]u8 = undefined;
    const presented = transport.presentedToken(req) orelse return serverError(ctx, req);
    if (presented.len > token_buf.len) return serverError(ctx, req);
    const token = token_buf[0..presented.len];
    @memcpy(token, presented);

    var parsed = json.readBody(ElevateReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    const until = svc.elevate(caller.user_id, token, parsed.value.password) catch |err| switch (err) {
        error.NoChallenge => return fail(ctx, req, .ok, "NO_CHALLENGE", "request a random code first"),
        // One code for every rejection, or this becomes an oracle.
        error.InvalidCredentials => return fail(ctx, req, .ok, "INVALID_CREDENTIALS", "password incorrect"),
        else => return serverError(ctx, req),
    };
    try json.respond(ctx.gpa, req, .ok, ElevateVO{ .elevatedUntil = until }, null);
}

/// POST /api/admin/lock. Idempotent and immediate (the caller is resolved from
/// the session row per request); succeeds even after elevation lapsed.
pub fn lock(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    const token = transport.presentedToken(req) orelse return serverError(ctx, req);
    svc.lockElevation(token) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}
