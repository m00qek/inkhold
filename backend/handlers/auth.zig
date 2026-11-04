//! Auth handlers: login challenge, login, password change, logout, `/me`.

const std = @import("std");
const router = @import("../http/router.zig");
const context = @import("../http/context.zig");
const json = @import("../http/json.zig");
const reply = @import("../http/reply.zig");
const transport = @import("../http/transport.zig");
const authsvc = @import("../services/auth/service.zig");

const Context = context.Context;
const Request = router.Request;
const Params = router.Params;
const fail = reply.fail;
const badRequest = reply.badRequest;
const serverError = reply.serverError;

/// Smoke-test API version (distinct from the package version).
pub const api_version = "0.0.1";

// ---- request/response bodies ----

const RandomCodeReq = struct { account: []const u8, countryCode: ?[]const u8 = null };
const RandomCodeVO = struct { success: bool = true, randomCode: []const u8, timestamp: i64 };

/// `password` is `sha256_hex(md5_hex(pw) + randomCode)`. Device-ness comes from
/// `equipment` (1 web, 2 app, 3 terminal, 4 user platform), not `equipmentNo`:
/// the Android app logs in with `equipmentNo: null`, `equipment: 2`. The field is
/// an int from the app and a string from the web, hence `LooseInt`.
const LoginReq = struct {
    account: []const u8,
    password: []const u8,
    equipmentNo: ?[]const u8 = null,
    equipment: ?json.LooseInt = null,
};
const LoginVO = struct {
    success: bool = true,
    token: ?[]const u8 = null,
    /// Always "Y" on a device login; the app reads it to confirm the login took.
    /// `isBindEquipment` is about the serial.
    isBind: ?[]const u8 = null,
    isBindEquipment: ?[]const u8 = null,
    /// A `pending` session: the client must change the password first.
    mustChangePassword: bool = false,
};

/// A serial present (Nomad `login/equipment`) or `equipment` in {2,3}.
fn isDeviceLogin(in: LoginReq) bool {
    if (in.equipmentNo != null) return true;
    if (in.equipment) |e| return e.value == 2 or e.value == 3;
    return false;
}

/// The session cookie is HttpOnly, so the SPA restores its session through `/me`.
const MeVO = struct { success: bool = true, email: []const u8, isAdmin: bool, mustChangePassword: bool };

/// Both fields are `md5_hex` of the plaintext, hashed client-side.
/// `currentPassword` is required of a `controlplane` caller (see the handler);
/// a `pending` caller omits it.
const ChangePasswordReq = struct { newPassword: []const u8, currentPassword: ?[]const u8 = null };

// ---- handlers ----

pub fn version(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = ctx;
    _ = params;
    try req.respond(api_version, .{
        .extra_headers = &.{.{ .name = "content-type", .value = "text/plain" }},
    });
}

pub fn randomCode(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service;
    var parsed = json.readBody(RandomCodeReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    const code = svc.getRandomCode(parsed.value.account) catch return serverError(ctx, req);
    const now_ms = std.Io.Clock.real.now(ctx.io).toSeconds() * 1000;
    try json.respond(ctx.gpa, req, .ok, RandomCodeVO{ .randomCode = &code, .timestamp = now_ms }, null);
}

/// POST …/login/new and /login/equipment. Control-plane logins get an HttpOnly
/// cookie; device logins get the token in the body.
pub fn loginNew(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service;
    var parsed = json.readBody(LoginReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const in = parsed.value;

    const is_device = isDeviceLogin(in);

    const session = svc.login(in.account, in.password, is_device, in.equipmentNo) catch |err| switch (err) {
        error.NoChallenge => return fail(ctx, req, .ok, "NO_CHALLENGE", "request a random code first"),
        error.InvalidCredentials => return fail(ctx, req, .ok, "INVALID_CREDENTIALS", "account or password incorrect"),
        else => return serverError(ctx, req),
    };

    const must_change = session.audience == .pending;
    if (is_device) {
        // The app sends no serial and self-binds on its first file call, so "N" is
        // expected for it.
        const bound = if (in.equipmentNo) |eno| (svc.isDeviceBound(session.user_id, eno) catch false) else false;
        try json.respond(ctx.gpa, req, .ok, LoginVO{
            .token = &session.token,
            .isBind = "Y",
            .isBindEquipment = if (bound) "Y" else "N",
            .mustChangePassword = must_change,
        }, null);
    } else {
        var cbuf: [256]u8 = undefined;
        const cookie = try sessionCookie(&cbuf, &session.token, ctx.config.tls.enabled, authsvc.controlplane_absolute_s);
        try json.respond(ctx.gpa, req, .ok, LoginVO{ .mustChangePassword = must_change }, cookie);
    }
}

/// PUT /api/user/password. Revokes every session and issues a fresh
/// control-plane cookie. A `controlplane` caller must prove the current password
/// (a live session outlasts a password prompt); a `pending` one need not, but the
/// service verifies any password supplied, whatever the audience.
pub fn changePassword(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service;
    const caller = ctx.caller.?; // guaranteed by the router (controlplane/pending scope)
    var parsed = json.readBody(ChangePasswordReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    // Same code as a wrong password: one outcome.
    if (caller.audience == .controlplane and parsed.value.currentPassword == null)
        return fail(ctx, req, .ok, "INVALID_CREDENTIALS", "current password required");

    const session = svc.changePassword(caller.user_id, parsed.value.currentPassword, parsed.value.newPassword) catch |err| switch (err) {
        error.WrongCurrentPassword => return fail(ctx, req, .ok, "INVALID_CREDENTIALS", "that is not your current password"),
        error.SamePassword => return fail(ctx, req, .ok, "SAME_PASSWORD", "choose a different password"),
        error.InvalidPassword => return fail(ctx, req, .ok, "INVALID_PASSWORD", "malformed password"),
        else => return serverError(ctx, req),
    };
    var cbuf: [256]u8 = undefined;
    const cookie = try sessionCookie(&cbuf, &session.token, ctx.config.tls.enabled, authsvc.controlplane_absolute_s);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, cookie);
}

pub fn logout(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service;
    // The cookie is cleared regardless; a row that outlives it expires on its own.
    if (transport.presentedToken(req)) |tok| svc.logout(tok) catch |e| std.log.warn("logout: session not revoked: {t}", .{e});
    var cbuf: [128]u8 = undefined;
    const cleared = try sessionCookie(&cbuf, "", ctx.config.tls.enabled, 0); // Max-Age=0 expires it
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, cleared);
}

pub fn me(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service;
    const caller = ctx.caller.?;
    const info = (svc.userInfo(ctx.gpa, caller.user_id) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .unauthorized, "NO_USER", "session user no longer exists");
    defer ctx.gpa.free(info.email);
    try json.respond(ctx.gpa, req, .ok, MeVO{
        .email = info.email,
        .isAdmin = info.is_admin,
        .mustChangePassword = info.must_change,
    }, null);
}

// ---- helpers ----

/// `Secure` only under TLS, or a plain-HTTP dev browser never sends it back.
fn sessionCookie(buf: []u8, token: []const u8, secure: bool, max_age: i64) ![]const u8 {
    return std.fmt.bufPrint(buf, "{s}={s}; HttpOnly; SameSite=Strict; Path=/; Max-Age={d}{s}", .{
        context.session_cookie_name, token, max_age, if (secure) "; Secure" else "",
    });
}
