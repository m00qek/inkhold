//! Auth handlers: version, login-code issuance, login, change-password, logout,
//! and the SPA session-restore (`/me`). Thin HTTP shells over the auth `Service`:
//! parse the body, call the service, respond with the official envelope.

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

/// `password` is the login challenge: `sha256_hex(md5_hex(pw) + randomCode)`.
///
/// Device-ness is read from `equipment` (the client's self-declared face: 1 web ·
/// 2 app · 3 terminal · 4 user platform), NOT from `equipmentNo`. The official
/// Android app logs in with `equipmentNo: null` but `equipment: 2`, supplying its
/// serial per-request instead — so `equipmentNo != null` misses it. `equipment`
/// is type-loose on the wire (the app sends the int `2`, the web the string
/// `"1"`), hence `json.LooseInt`. See docs/design/login-in-app.md.
const LoginReq = struct {
    account: []const u8,
    password: []const u8,
    equipmentNo: ?[]const u8 = null,
    equipment: ?json.LooseInt = null,
};
const LoginVO = struct {
    success: bool = true,
    token: ?[]const u8 = null,
    /// Whether the account itself is usable/provisioned — the app reads this to
    /// confirm the login "took". Always `"Y"` for a successful device login (the
    /// household account is always provisioned). Distinct from `isBindEquipment`,
    /// which is about the SERIAL, not the account.
    isBind: ?[]const u8 = null,
    isBindEquipment: ?[]const u8 = null,
    /// The issued session is a first-login `pending` one — the client must route
    /// to the change-password page before anything else works.
    mustChangePassword: bool = false,
};

/// Whether a login body describes a DEVICE client (sync/file face) rather than
/// the web SPA. True when a serial is present (the Nomad's `login/equipment`) OR
/// the client self-declares an app/terminal face via `equipment` ∈ {2,3}. The
/// web SPA sends neither (`equipment` 1/absent), so it stays control-plane.
fn isDeviceLogin(in: LoginReq) bool {
    if (in.equipmentNo != null) return true;
    if (in.equipment) |e| return e.value == 2 or e.value == 3;
    return false;
}

/// GET /api/user/me — lets the SPA restore its session after a reload (the
/// session cookie is HttpOnly, so JS can't inspect it directly).
const MeVO = struct { success: bool = true, email: []const u8, isAdmin: bool, mustChangePassword: bool };

/// `newPassword` is `md5_hex(new_plaintext)`, computed by the client.
///
/// `currentPassword` is `md5_hex(current_plaintext)`, hashed at the same client
/// seam so an existing password is no more exposed on the wire than a new one.
/// It is OPTIONAL on the wire and REQUIRED by policy of a `controlplane` caller —
/// see the handler, which is where that policy lives. A first-login `pending`
/// caller omits it: it has nothing to check against but the temporary password it
/// proved seconds ago.
const ChangePasswordReq = struct { newPassword: []const u8, currentPassword: ?[]const u8 = null };

// ---- handlers ----

/// GET /api/version -> the API version string.
pub fn version(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = ctx;
    _ = params;
    try req.respond(api_version, .{
        .extra_headers = &.{.{ .name = "content-type", .value = "text/plain" }},
    });
}

/// POST …/query/random/code -> issue a single-use login challenge code.
pub fn randomCode(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    var parsed = json.readBody(RandomCodeReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    const code = svc.getRandomCode(parsed.value.account) catch return serverError(ctx, req);
    const now_ms = std.Io.Clock.real.now(ctx.io).toSeconds() * 1000;
    try json.respond(ctx.gpa, req, .ok, RandomCodeVO{ .randomCode = &code, .timestamp = now_ms }, null);
}

/// POST …/login/new (or /login/equipment) -> verify the challenge and issue a
/// session. Control-plane logins get an HttpOnly cookie; device logins get the
/// token in the body plus `isBindEquipment` telling them whether they still need
/// to bind.
pub fn loginNew(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    var parsed = json.readBody(LoginReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const in = parsed.value;

    // Discriminate the face by the client's self-declared kind, not by whether it
    // supplied a serial — the app is a device client that logs in without one.
    const is_device = isDeviceLogin(in);

    const session = svc.login(in.account, in.password, is_device, in.equipmentNo) catch |err| switch (err) {
        error.NoChallenge => return fail(ctx, req, .ok, "NO_CHALLENGE", "request a random code first"),
        error.InvalidCredentials => return fail(ctx, req, .ok, "INVALID_CREDENTIALS", "account or password incorrect"),
        else => return serverError(ctx, req),
    };

    const must_change = session.audience == .pending;
    if (is_device) {
        // Token in the BODY: a device client reads `token` from JSON and carries
        // it in `x-access-token`. `isBindEquipment` reports whether the SUPPLIED
        // serial (the Nomad sends one; the app does not) is already bound — the app
        // self-binds lazily on its first file call, so "N" here is expected for it.
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

/// PUT /api/user/password -> change password. Revokes every existing session and
/// issues a fresh control-plane session (delivered as a new cookie). Reachable by
/// a first-login `pending` token or a full control-plane session.
///
/// **This handler owns the POLICY half of the current-password check; the service
/// owns the MECHANISM half.** Here: a `controlplane` caller MUST supply
/// `currentPassword`, because a live session is a longer-lived thing than a
/// password prompt — a borrowed laptop, an unlocked screen — and without the
/// demand anyone who reaches a signed-in window can lock the owner out of their
/// own household cloud (docs/scratch/user-options.md §4). A `pending` caller must
/// NOT be made to supply one: the only credential it could offer is the temporary
/// password it proved seconds ago.
///
/// In the service: whenever a current password IS supplied it is verified, for
/// every audience. The two halves together mean the check cannot be dodged by
/// picking a caller — a `pending` token with a WRONG current password is refused
/// too, it simply is not required to send one.
pub fn changePassword(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    const caller = ctx.caller.?; // guaranteed by the router (controlplane/pending scope)
    var parsed = json.readBody(ChangePasswordReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    // POLICY. Answered with the SAME code a wrong one gets: "you did not prove the
    // current password" is one outcome, not two, and the account page renders it
    // as "That isn't your current password." either way.
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

/// POST /api/user/logout -> delete the presented token and clear the cookie.
pub fn logout(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    if (transport.presentedToken(req)) |tok| svc.logout(tok) catch {};
    var cbuf: [128]u8 = undefined;
    const cleared = try sessionCookie(&cbuf, "", ctx.config.tls.enabled, 0); // Max-Age=0 expires it
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, cleared);
}

/// GET /api/user/me -> the caller's identity, for SPA session restore on reload.
pub fn me(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
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

/// Builds a session Set-Cookie value into `buf`. `Secure` is added only under
/// TLS (otherwise a dev browser on plain HTTP would never send it back).
fn sessionCookie(buf: []u8, token: []const u8, secure: bool, max_age: i64) ![]const u8 {
    return std.fmt.bufPrint(buf, "{s}={s}; HttpOnly; SameSite=Strict; Path=/; Max-Age={d}{s}", .{
        context.session_cookie_name, token, max_age, if (secure) "; Secure" else "",
    });
}
