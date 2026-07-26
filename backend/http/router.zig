//! A tiny declarative HTTP router over `std.http.Server`.
//!
//! Routes are a flat table of `{ method, path, handler }` (see routes.zig).
//! Paths support `:name` segment parameters, captured into `Params`. This keeps
//! the framework surface minimal while giving a clear, table-driven entrypoint —
//! and leaves transport/TLS to transport.zig.

const std = @import("std");
const context = @import("context.zig");
const ratelimit = @import("ratelimit.zig");
const static = @import("static.zig");
const Context = context.Context;

pub const Method = std.http.Method;
pub const Request = std.http.Server.Request;
pub const Scope = context.Scope;
pub const Caller = context.Caller;
pub const RateLimit = ratelimit.RateLimit;

/// Captured `:name` path parameters (fixed capacity — routes are short).
pub const Params = struct {
    entries: [max]Entry = undefined,
    len: usize = 0,

    pub const max = 8;
    const Entry = struct { name: []const u8, value: []const u8 };

    pub fn get(self: *const Params, name: []const u8) ?[]const u8 {
        for (self.entries[0..self.len]) |e| {
            if (std.mem.eql(u8, e.name, name)) return e.value;
        }
        return null;
    }

    fn put(self: *Params, name: []const u8, value: []const u8) void {
        // Fail loud, not silent: an over-capacity route (more `:name` segments
        // than `max`) used to have its overflow captures quietly dropped, which
        // a future handler would experience as a mysteriously-missing param.
        // A ReleaseSafe/Debug build traps here the moment such a route matches.
        // (The route table also guards this at compile time; see routes.zig.)
        std.debug.assert(self.len < max);
        self.entries[self.len] = .{ .name = name, .value = value };
        self.len += 1;
    }
};

pub const Handler = *const fn (ctx: *Context, req: *Request, params: Params) anyerror!void;

pub const Route = struct {
    method: Method,
    path: []const u8,
    /// The audiences allowed to call this route. `&.{.public}` = no auth; a set
    /// like `&.{.controlplane, .pending}` = any listed audience. No default — every route
    /// must declare it, so the auth boundary can never be forgotten.
    scopes: []const Scope,
    handler: Handler,
    /// If set, the caller must also be an administrator (checked after scope).
    require_admin: bool = false,
    /// Optional per-route rate limit (token bucket). Null = unlimited.
    rate_limit: ?RateLimit = null,
    /// This handler manages its own `ctx.db_lock` windows — dispatch must NOT
    /// take the automatic whole-handler lock around it. Set only on the streaming
    /// transfer routes (`/oss/get`, `/oss/put`), whose byte transfer is pure
    /// filesystem + socket work: holding the one global DB lock across a multi-MB
    /// transfer would serialize every other request behind it. Such a handler MUST
    /// wrap each of its DB touches in `ctx.lockDb()`/`ctx.unlockDb()` itself.
    /// `transport.handle` still holds the lock around `resolveCaller` (a session
    /// read) before dispatching unlocked. See transport.zig.
    manual_db_lock: bool = false,
};

pub const Decision = enum { ok, unauthorized, forbidden, needs_elevation };

/// HTTP status for a lapsed/absent admin elevation.
///
/// **Deliberately NOT 401, and deliberately not 403 either.** The SPA's failure
/// sink maps BOTH of those to `UNAUTHORIZED` before it ever looks at the body
/// (see `webapp/src/api/client.ts`) and routes to the login page — so
/// reusing either would sign the admin OUT of the whole app instead of showing
/// the re-authentication gate. That means a distinct `errorCode` alone is not
/// enough: the STATUS has to be distinguishable too.
///
/// 428 says the request is missing a precondition, which is exactly the case: the
/// session is perfectly valid, it simply has not proved the password recently.
/// A client wiring this up should route 428 / `ELEVATION_REQUIRED` to the gate and
/// retry the original request after a successful `POST /api/admin/elevate`.
pub const elevation_required_status: std.http.Status = .precondition_required; // 428
pub const elevation_required_code = "ELEVATION_REQUIRED";

/// Decides whether `caller` may reach a route with `scopes`/`require_admin`.
/// Pure, so it's unit tested directly (device/control-plane separation, pending limits,
/// admin gating, the elevation gate).
pub fn authorize(scopes: []const Scope, require_admin: bool, caller: ?Caller) Decision {
    for (scopes) |s| if (s == .public) return .ok; // a public route needs no caller
    const c = caller orelse return .unauthorized;
    var audience_ok = false;
    for (scopes) |s| if (s == c.audience) {
        audience_ok = true;
        break;
    };
    if (!audience_ok) return .forbidden;
    if (require_admin) {
        // A non-admin gets the plain 403 an ordinary permission failure gets — it
        // must not learn that an elevation gate exists behind it, let alone be
        // invited to try the password.
        if (!c.is_admin) return .forbidden;
        // `require_admin` covers EVERY admin route, the read-only listing
        // included: an idle tablet that still reached `GET /api/admin/users` would
        // expose every household member's email and quota, which is the same line
        // the console draws everywhere else.
        if (!c.elevated) return .needs_elevation;
    }
    return .ok;
}

/// Match `req` against `routes`, apply the route's rate limit, enforce its scope
/// against `caller`, and invoke the handler. Responds 404 (no match), 429 (rate
/// limited), 401 (unauthenticated), or 403 (wrong audience / not admin).
pub fn dispatch(routes: []const Route, ctx: *Context, req: *Request, caller: ?Caller) !void {
    const path = stripQuery(req.head.target);
    var params: Params = .{};
    for (routes, 0..) |r, idx| {
        if (req.head.method == r.method and match(r.path, path, &params)) {
            if (r.rate_limit) |rl| {
                if (rateLimited(ctx, idx, rl, caller)) |retry_ms| return tooManyRequests(req, retry_ms);
            }
            switch (authorize(r.scopes, r.require_admin, caller)) {
                .ok => {},
                .unauthorized => return req.respond("unauthorized\n", .{ .status = .unauthorized }),
                .forbidden => return req.respond("forbidden\n", .{ .status = .forbidden }),
                .needs_elevation => return elevationRequired(req),
            }
            ctx.caller = caller;
            return r.handler(ctx, req, params);
        }
    }
    // No API route matched. When a web_dir is configured, fall back to serving
    // the built SPA's static files (GET only); API routes always take precedence
    // because this runs only after the loop above found no match.
    if (try static.serve(ctx, req)) return;
    try req.respond("not found\n", .{ .status = .not_found });
}

/// Returns the retry-after (ms) if the request is over the route's limit, else
/// null. Keys per route + identity so different routes don't share buckets. The
/// IP dimension applies pre-auth (protects e.g. login); the user dimension only
/// once a caller is known. Limiter errors fail open (allow).
fn rateLimited(ctx: *Context, route_idx: usize, rl: RateLimit, caller: ?Caller) ?i64 {
    const lim = ctx.limiter orelse return null;
    const now_ms = std.Io.Clock.real.now(ctx.io).toMilliseconds();
    const rate = rl.refillPerMs();
    var kbuf: [96]u8 = undefined;

    if (rl.by == .ip or rl.by == .both) {
        if (ctx.client_ip) |ip| {
            const key = std.fmt.bufPrint(&kbuf, "{d}:ip:{s}", .{ route_idx, ip }) catch return null;
            if (lim.take(ctx.io, key, rl.max, rate, now_ms) catch null) |retry_ms| return retry_ms;
        }
    }
    if (rl.by == .user or rl.by == .both) {
        if (caller) |c| {
            const key = std.fmt.bufPrint(&kbuf, "{d}:user:{d}", .{ route_idx, c.user_id }) catch return null;
            if (lim.take(ctx.io, key, rl.max, rate, now_ms) catch null) |retry_ms| return retry_ms;
        }
    }
    return null;
}

/// The re-authentication gate's response: the standard failure envelope, so a
/// client reads `errorCode` exactly as it does everywhere else, under a status
/// the SPA's session-expired sink does not swallow (see
/// `elevation_required_status`). Written literally rather than through
/// `reply.fail` because `reply` imports this module.
fn elevationRequired(req: *Request) !void {
    try req.respond(
        "{\"success\":false,\"errorCode\":\"" ++ elevation_required_code ++
            "\",\"errorMsg\":\"re-enter your password to use the admin console\"}",
        .{
            .status = elevation_required_status,
            .extra_headers = &.{.{ .name = "content-type", .value = "application/json" }},
        },
    );
}

fn tooManyRequests(req: *Request, retry_ms: i64) !void {
    var buf: [16]u8 = undefined;
    const secs = @divTrunc(retry_ms, 1000) + 1; // round up to whole seconds, min 1
    const retry_after = std.fmt.bufPrint(&buf, "{d}", .{secs}) catch "1";
    try req.respond("rate limited\n", .{
        .status = .too_many_requests,
        .extra_headers = &.{.{ .name = "retry-after", .value = retry_after }},
    });
}

test "authorize: scope sets, device/control-plane boundary, pending limits, admin gating" {
    const dev: Caller = .{ .user_id = 1, .audience = .device };
    const cp: Caller = .{ .user_id = 1, .audience = .controlplane };
    const pend: Caller = .{ .user_id = 1, .audience = .pending };
    const admin: Caller = .{ .user_id = 1, .audience = .controlplane, .is_admin = true, .elevated = true };

    // public: always allowed, even without a caller.
    try std.testing.expectEqual(Decision.ok, authorize(&.{.public}, false, null));

    // protected without a session -> 401.
    try std.testing.expectEqual(Decision.unauthorized, authorize(&.{.controlplane}, false, null));

    // matching audience -> ok; crossing the boundary -> 403.
    try std.testing.expectEqual(Decision.ok, authorize(&.{.device}, false, dev));
    try std.testing.expectEqual(Decision.ok, authorize(&.{.controlplane}, false, cp));
    try std.testing.expectEqual(Decision.forbidden, authorize(&.{.device}, false, cp)); // control plane -> sync API
    try std.testing.expectEqual(Decision.forbidden, authorize(&.{.controlplane}, false, dev)); // device -> page API

    // pending token reaches only routes that list `.pending`.
    try std.testing.expectEqual(Decision.forbidden, authorize(&.{.controlplane}, false, pend));
    try std.testing.expectEqual(Decision.ok, authorize(&.{ .controlplane, .pending }, false, pend)); // change-password
    try std.testing.expectEqual(Decision.ok, authorize(&.{ .controlplane, .pending }, false, cp)); // full control plane too

    // multi-audience route (e.g. logout): any listed audience passes; none -> 401.
    const any = &[_]Scope{ .controlplane, .device, .pending };
    try std.testing.expectEqual(Decision.ok, authorize(any, false, dev));
    try std.testing.expectEqual(Decision.ok, authorize(any, false, pend));
    try std.testing.expectEqual(Decision.unauthorized, authorize(any, false, null));

    // require_admin: only an ELEVATED admin caller of an allowed audience passes.
    try std.testing.expectEqual(Decision.forbidden, authorize(&.{.controlplane}, true, cp));
    try std.testing.expectEqual(Decision.ok, authorize(&.{.controlplane}, true, admin));
}

test "authorize: an un-elevated admin is gated, distinguishably from every other refusal" {
    const cp: Caller = .{ .user_id = 1, .audience = .controlplane };
    const stale: Caller = .{ .user_id = 1, .audience = .controlplane, .is_admin = true }; // admin, elevation lapsed
    const fresh: Caller = .{ .user_id = 1, .audience = .controlplane, .is_admin = true, .elevated = true };

    // The gate: an admin whose elevation lapsed gets its OWN decision — not
    // `unauthorized` (which the SPA reads as a dead session and would sign them
    // out of the whole app) and not the `forbidden` a non-admin gets.
    try std.testing.expectEqual(Decision.needs_elevation, authorize(&.{.controlplane}, true, stale));
    try std.testing.expect(Decision.needs_elevation != Decision.unauthorized);
    try std.testing.expect(Decision.needs_elevation != Decision.forbidden);
    try std.testing.expect(elevation_required_status != .unauthorized);
    try std.testing.expect(elevation_required_status != .forbidden);

    // A NON-admin is refused as an ordinary permission failure and learns nothing
    // about a gate behind it.
    try std.testing.expectEqual(Decision.forbidden, authorize(&.{.controlplane}, true, cp));

    // Elevation is only ever consulted on `require_admin` routes: it is not a
    // second audience, and an ordinary route must not start demanding it.
    try std.testing.expectEqual(Decision.ok, authorize(&.{.controlplane}, false, stale));
    try std.testing.expectEqual(Decision.ok, authorize(&.{.controlplane}, false, cp));

    // And elevation never substitutes for the audience check.
    const elevated_device: Caller = .{ .user_id = 1, .audience = .device, .is_admin = true, .elevated = true };
    try std.testing.expectEqual(Decision.forbidden, authorize(&.{.controlplane}, true, elevated_device));
    try std.testing.expectEqual(Decision.ok, authorize(&.{.controlplane}, true, fresh));
}

/// The route in the table that matches `req`'s method + path, or null. Lets a
/// caller read a matched route's declarative fields (e.g. `manual_db_lock`)
/// *before* dispatching — `dispatch` re-matches, which is cheap on a flat table
/// of this size and keeps the single matching rule in one place.
pub fn matched(routes: []const Route, req: *const Request) ?*const Route {
    const i = matchedIndex(routes, req) orelse return null;
    return &routes[i];
}

/// The INDEX of the matching route, or null. The index is the identity the
/// per-route lock histogram keys on (see http/lock_stats.zig) — a pointer would
/// work too, but an index is what a fixed-size table can be sized against.
pub fn matchedIndex(routes: []const Route, req: *const Request) ?usize {
    const path = stripQuery(req.head.target);
    var params: Params = .{};
    for (routes, 0..) |*r, i| {
        if (req.head.method == r.method and match(r.path, path, &params)) return i;
    }
    return null;
}

/// True if any route in the table matches `req`'s method + path. Lets the
/// passthrough capture decide "real handler vs. capture stub" without dispatching.
pub fn matches(routes: []const Route, req: *const Request) bool {
    return matched(routes, req) != null;
}

/// True if `path` matches `pattern`, filling `params` with any `:name` captures.
fn match(pattern: []const u8, path: []const u8, params: *Params) bool {
    params.len = 0;
    var pit = std.mem.splitScalar(u8, std.mem.trim(u8, pattern, "/"), '/');
    var sit = std.mem.splitScalar(u8, std.mem.trim(u8, path, "/"), '/');
    while (true) {
        const p = pit.next();
        const s = sit.next();
        if (p == null and s == null) return true;
        if (p == null or s == null) return false;
        const pseg = p.?;
        const sseg = s.?;
        if (pseg.len > 0 and pseg[0] == ':') {
            if (sseg.len == 0) return false;
            params.put(pseg[1..], sseg);
        } else if (!std.mem.eql(u8, pseg, sseg)) {
            return false;
        }
    }
}

pub fn stripQuery(target: []const u8) []const u8 {
    return if (std.mem.indexOfScalar(u8, target, '?')) |i| target[0..i] else target;
}

/// Copies the request header `name` (matched case-insensitively) into `buf` and
/// returns the filled prefix; `""` if the header is absent. Truncates to `buf`.
///
/// COPYING IS THE POINT, not an implementation detail. `iterateHeaders` yields
/// slices into the connection's request-head buffer, and `json.readBody`
/// overwrites that buffer — so a borrowed header value read after the body is a
/// use-after-free on live memory (which is exactly how a device's echoed
/// `equipmentNo` once came back as clobbered bytes). Every caller here needs the
/// value to outlive the body read, so the helper never hands back a borrow.
pub fn headerCopy(req: *Request, name: []const u8, buf: []u8) []const u8 {
    var it = req.iterateHeaders();
    while (it.next()) |h| {
        if (std.ascii.eqlIgnoreCase(h.name, name)) {
            const n = @min(h.value.len, buf.len);
            @memcpy(buf[0..n], h.value[0..n]);
            return buf[0..n];
        }
    }
    return "";
}

test "stripQuery" {
    try std.testing.expectEqualStrings("/api/version", stripQuery("/api/version?x=1"));
    try std.testing.expectEqualStrings("/api/version", stripQuery("/api/version"));
}

test "match: exact path" {
    var p: Params = .{};
    try std.testing.expect(match("/api/version", "/api/version", &p));
    try std.testing.expect(!match("/api/version", "/api/other", &p));
    try std.testing.expect(!match("/api/version", "/api/version/extra", &p));
}

test "match: captures :params" {
    var p: Params = .{};
    try std.testing.expect(match("/api/equipment/query/by/:userId", "/api/equipment/query/by/123", &p));
    try std.testing.expectEqualStrings("123", p.get("userId").?);
    try std.testing.expect(p.get("missing") == null);
}

test "match: param segment must be non-empty" {
    var p: Params = .{};
    try std.testing.expect(!match("/file/:id", "/file/", &p));
}
