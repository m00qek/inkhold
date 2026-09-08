//! Admin handlers (control-plane, admin-only): household user management —
//! create, list, delete, and password reset — the per-person device and quota
//! controls, the server-wide settings and health readouts, plus the
//! re-authentication ("elevation") gate that guards all of them. These own no
//! service of their own; they drive the auth `Service` directly — plus `Files`,
//! which `deleteUser` needs to release the account's blob references, and the
//! `Settings`/`health` services for the two server-wide panels.
//!
//! **Every route here except `elevate`/`lock` is `require_admin`**, which since
//! the console landed means "an admin who re-entered their password recently"
//! (see `http/router.zig`'s `authorize`). Admin is a capability on an ordinary
//! household account, so `is_admin` alone travels on a tablet left unlocked on a
//! table; these endpoints permanently delete other people's notes.

const std = @import("std");
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

/// No `password` field: the SERVER generates the temporary password. See
/// `createUser` below.
const CreateUserReq = struct { email: []const u8, isAdmin: bool = false };

/// `temporaryPassword` is plaintext and is returned EXACTLY ONCE — only its hash
/// is stored, so no later request can produce it again.
const CreateUserVO = struct { success: bool = true, userId: u64, temporaryPassword: []const u8 };
const ResetPasswordVO = struct { success: bool = true, temporaryPassword: []const u8 };
const UsersVO = struct { success: bool = true, users: []const authsvc.UserInfo };

/// The service structs are serialized verbatim here, snake_case field names and
/// all, because `UsersVO` above already set that precedent for this face and a
/// second naming convention on the same screen would be worse than the first one
/// being unfashionable.
const DevicesVO = struct { success: bool = true, devices: []const authsvc.DeviceInfo };

/// Same field name as the caller-scoped `/api/controlplane/equipment/unlink`
/// takes — it is the same operation with the ownership moved to the URL, so it
/// should not need a different body.
const UnlinkDeviceReq = struct { equipmentNo: []const u8 };

const QuotaVO = struct { success: bool = true, used_bytes: i64, total_bytes: i64 };
const SetQuotaReq = struct { totalBytes: i64 };

/// `retentionDays` is what the console edits; the bounds travel with it so the
/// field can validate before it ever posts, and `defaultDays` so the UI can say
/// what the install started at.
const RetentionVO = struct {
    success: bool = true,
    retentionDays: i64,
    defaultDays: i64,
    minDays: i64,
    maxDays: i64,
    /// Epoch seconds of the last change, 0 if never — also the moment the
    /// non-retroactive grace period started (see `services/settings.zig`).
    changedAt: i64,
};
const SetRetentionReq = struct { retentionDays: i64 };

/// `dbLock` is absent (null, so omitted) when the server is not measuring — the
/// integration harness drives handlers with no lock and no stats table, and an
/// empty object there would read as "measured, and idle".
const HealthVO = struct {
    success: bool = true,
    health: healthmod.Health,
    dbLock: ?DbLockVO = null,
};

/// The `db_lock` readout: the aggregate occupancy that sets the server's
/// sustained request ceiling, plus the per-route attribution that says which
/// route sets it. See http/lock_stats.zig.
const DbLockVO = struct {
    /// Lock windows recorded since start. Not requests: a `manual_db_lock` route
    /// contributes several windows per request (`"manual": true` marks them).
    ///
    /// **Pooled reads are excluded here and included per route.** A `read_only`
    /// route runs on its own connection and occupies the lock for nothing but its
    /// session lookup, so counting its work in the aggregate would overstate the
    /// one figure that says how much of the global serialization point is left —
    /// by exactly the amount the reader pool freed. Each route's row still
    /// reports the work (`reader_windows` / `reader_ns`), because a route whose
    /// cost stops being visible is a blind spot, not a fix.
    windows: u64,
    /// Total time the lock has been held, summed. `windows / total_held_ns` is
    /// the ceiling in requests per second — the whole point of the endpoint.
    total_held_ns: u64,
    routes: []const lockstats.RouteReport,
};

/// `password` is the login challenge — `sha256_hex(md5_hex(pw) + randomCode)` —
/// exactly as `auth.loginNew` takes it. No account field: the session says who
/// the caller is, and letting a body name a different one would be a way to
/// re-authenticate as somebody else.
const ElevateReq = struct { password: []const u8 };

/// `elevatedUntil` is the current (sliding) idle deadline, epoch seconds.
const ElevateVO = struct { success: bool = true, elevatedUntil: i64 };

// ---- handlers ----

/// POST /api/admin/users `{email, isAdmin?}` -> create a household user
/// (elevated-admin-only) -> `{success, userId, temporaryPassword}`.
///
/// **API CHANGE: the request no longer carries a password.** It used to take
/// `password` (an md5 hex digest the admin's browser computed), which meant the
/// admin invented a housemate's credential and knew it from then on — and left
/// nothing for the UI to "show once", since the person who typed it already had
/// it. The server now generates a strong temporary password, returns the
/// plaintext here and only here, and stores its hash. The account starts
/// must-change, so that secret unlocks nothing but its own replacement.
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

/// GET /api/admin/users -> list all users (admin-only).
pub fn listUsers(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    const users = svc.listUsers(ctx.gpa) catch return serverError(ctx, req);
    defer authsvc.Service.freeUsers(ctx.gpa, users);
    try json.respond(ctx.gpa, req, .ok, UsersVO{ .users = users }, null);
}

/// DELETE /api/admin/users/:id -> remove a user (admin-only; not the last admin).
pub fn deleteUser(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const svc = ctx.service.?;
    const actor = ctx.caller.?;
    const files = ctx.files.?; // deletion must release the account's blob references
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    svc.deleteUser(actor.user_id, id, files.*) catch |err| switch (err) {
        error.LastAdmin => return fail(ctx, req, .ok, "LAST_ADMIN", "cannot remove the last administrator"),
        // Distinct from LAST_ADMIN on purpose: that one is about the household
        // ("somebody has to be able to administer this"), this one is about you
        // ("not from here"). Collapsing them would tell a household of two that
        // it has only one admin.
        error.CannotDeleteSelf => return fail(ctx, req, .ok, "CANNOT_DELETE_SELF", "another administrator has to remove your account"),
        else => return serverError(ctx, req),
    };
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// POST /api/admin/users/:id/reset -> reset a user's password
/// (elevated-admin-only) -> `{success, temporaryPassword}`.
///
/// **API CHANGE: the request body is now empty** — it used to carry
/// `{password: md5_hex(temp)}`. Same inversion as `createUser`: the server picks
/// the temporary password and hands back the plaintext once. Sets must-change and
/// logs the target out everywhere (which also drops any elevation their sessions
/// held, since elevation lives on the session row).
pub fn resetPassword(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const svc = ctx.service.?;
    const actor = ctx.caller.?;
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const temp = svc.resetPassword(actor.user_id, id) catch |e| switch (e) {
        // Named rather than a generic 500, because the answer is a place to go:
        // your own password is changed on your account page, which verifies the
        // current one and hands you a session instead of a password to retype.
        error.CannotResetSelf => return fail(ctx, req, .ok, "CANNOT_RESET_SELF", "change your own password on your account page"),
        else => return serverError(ctx, req),
    };
    try json.respond(ctx.gpa, req, .ok, ResetPasswordVO{ .temporaryPassword = temp.slice() }, null);
}

// ---- one person's devices, and their quota ----
//
// These are the first admin routes that act on ANOTHER account's resources by an
// id from the URL rather than on the account row itself. The services they call
// (`listUserDevices`, `adminUnlinkDevice`, `userQuota`, `setUserQuota`) all take
// `actor` and `target` separately and do the ownership work; these shells only
// translate their errors. Nothing here should ever re-derive ownership itself —
// two places deciding who owns a device is how they come to disagree.

/// GET /api/admin/users/{id}/devices -> that user's device bindings, active and
/// revoked alike -> `{success, devices:[{equipment_no, name, model, firmware,
/// active, created_at}]}`.
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

/// POST /api/admin/users/{id}/devices/unlink `{equipmentNo}` -> revoke one of
/// that user's device bindings -> `{success}`.
///
/// A soft status flip, exactly as the caller-scoped
/// `/api/controlplane/equipment/unlink` does: the tablet stops syncing and its
/// sessions die, but the binding row survives, which is what makes re-pairing
/// possible (with the device in hand).
///
/// `DEVICE_NOT_FOUND` covers both "no such serial" and "that serial belongs to a
/// different housemate" — see `Service.adminUnlinkDevice` for why they must be
/// indistinguishable. It is a 404 rather than a 403 for the same reason: a
/// distinct status would leak the very fact the shared error is hiding.
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

/// GET /api/admin/users/{id}/quota -> `{success, used_bytes, total_bytes}` — the
/// two numbers the console's storage meter is drawn from.
pub fn getQuota(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const svc = ctx.service.?;
    const actor = ctx.caller.?;
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const q = svc.userQuota(actor.user_id, id) catch |err| switch (err) {
        error.UserNotFound => return fail(ctx, req, .not_found, "USER_NOT_FOUND", "no such user"),
        else => return serverError(ctx, req),
    };
    try json.respond(ctx.gpa, req, .ok, QuotaVO{ .used_bytes = q.used_bytes, .total_bytes = q.total_bytes }, null);
}

/// PUT /api/admin/users/{id}/quota `{totalBytes}` -> set the allotment ->
/// `{success, used_bytes, total_bytes}`.
///
/// **An allotment below current usage is accepted and destroys nothing.** It
/// stops that account's next sync until they free space; their notes are
/// untouched. The response therefore reports `used_bytes` unchanged and above
/// `total_bytes`, which is a state the meter has to be able to draw — it is the
/// whole point of the control, not an inconsistency to normalize away.
pub fn setQuota(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const svc = ctx.service.?;
    const actor = ctx.caller.?;
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    var parsed = json.readBody(SetQuotaReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    const q = svc.setUserQuota(actor.user_id, id, parsed.value.totalBytes) catch |err| switch (err) {
        error.UserNotFound => return fail(ctx, req, .not_found, "USER_NOT_FOUND", "no such user"),
        error.InvalidQuota => return fail(ctx, req, .bad_request, "INVALID_QUOTA", "an allotment cannot be negative"),
        else => return serverError(ctx, req),
    };
    try json.respond(ctx.gpa, req, .ok, QuotaVO{ .used_bytes = q.used_bytes, .total_bytes = q.total_bytes }, null);
}

// ---- server-wide: retention and health ----

/// GET /api/admin/settings/retention -> the recycle bin's retention window.
pub fn getRetention(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const files = ctx.files orelse return serverError(ctx, req);
    const set = settingsmod.Settings.init(ctx.io, files.db);
    const r = set.binRetention() catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, retentionVO(r), null);
}

/// PUT /api/admin/settings/retention `{retentionDays}` -> change the window.
///
/// **Changing it never purges retroactively.** Shortening the window does not
/// make anything already in the bin due: the new window's clock starts at this
/// write, so every existing entry gets a full window from now. See
/// `services/settings.zig`'s `sweepCutoff` for the rule and why the alternatives
/// were worse.
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

/// GET /api/admin/health -> `{success, health:{version, memory_bytes,
/// memory_anon_bytes, memory_budget_bytes, blob_bytes, blob_count}, dbLock:{…}}`.
///
/// Household-wide totals only. `memory_bytes` is null where the platform cannot
/// report it, and must render as "unknown" rather than 0 B. There is deliberately
/// no per-person figure of any kind here — see `services/health.zig`.
///
/// `dbLock` is the other half of the resource story and belongs on the same
/// endpoint for the same reason: this server's throughput ceiling is set by one
/// global mutex, and a memory panel with no lock panel next to it answers only
/// half of "is this box coping". It stays inside the privacy rule above — a route
/// path and a hold time name no person. See http/lock_stats.zig.
pub fn health(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const files = ctx.files orelse return serverError(ctx, req);
    const snap = healthmod.snapshot(ctx.io, files.db, authhandlers.api_version) catch
        return serverError(ctx, req);

    // Stack-allocated, one row per route: reporting the lock must not allocate a
    // growing buffer on the path it is measuring.
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

/// POST /api/admin/elevate `{password}` -> grant this session admin elevation
/// -> `{success, elevatedUntil}`.
///
/// **Not `require_admin`**, and it cannot be: that check is what demands
/// elevation, so gating the endpoint that grants it behind itself is a deadlock.
/// The authorization it does instead lives in `Service.elevate`, which refuses a
/// non-admin with the SAME `INVALID_CREDENTIALS` a wrong password gets — a
/// housemate poking at this must not be able to learn who the administrators are.
///
/// **Reuses the login challenge flow**: fetch a code from
/// `POST /api/official/user/query/random/code` first, then send
/// `sha256_hex(md5_hex(password) + randomCode)` here, exactly as the login page
/// does. A "just POST the password" endpoint would be a real regression on a
/// deployment that is plaintext HTTP over a LAN.
///
/// `.pending` is absent from the route's scopes, so a session that still owes a
/// password change is turned away before it reaches here (the service refuses it
/// as well). Rate-limited **by user**, not by IP — see the route table.
pub fn elevate(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    const caller = ctx.caller.?;
    // Read the token BEFORE `readBody`: `presentedToken` slices the request head
    // buffer, which parsing the body overwrites.
    var token_buf: [128]u8 = undefined;
    const presented = transport.presentedToken(req) orelse return serverError(ctx, req);
    if (presented.len > token_buf.len) return serverError(ctx, req);
    const token = token_buf[0..presented.len];
    @memcpy(token, presented);

    var parsed = json.readBody(ElevateReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    const until = svc.elevate(caller.user_id, token, parsed.value.password) catch |err| switch (err) {
        error.NoChallenge => return fail(ctx, req, .ok, "NO_CHALLENGE", "request a random code first"),
        // One code for every rejection — wrong password, not an admin, still owing
        // a password change. Splitting them would make this an oracle.
        error.InvalidCredentials => return fail(ctx, req, .ok, "INVALID_CREDENTIALS", "password incorrect"),
        else => return serverError(ctx, req),
    };
    try json.respond(ctx.gpa, req, .ok, ElevateVO{ .elevatedUntil = until }, null);
}

/// POST /api/admin/lock -> drop this session's elevation immediately
/// ("Lock console"). Idempotent, and takes effect on the very next request: the
/// caller is resolved from the session row every time, so there is no cached
/// capability to outlive the clear.
///
/// Not `require_admin` — locking is always allowed, and a caller whose elevation
/// already lapsed must still get a 200 rather than the 428 gate.
pub fn lock(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    const token = transport.presentedToken(req) orelse return serverError(ctx, req);
    svc.lockElevation(token) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}
