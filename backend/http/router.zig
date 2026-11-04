//! A declarative HTTP router over `std.http.Server`: a flat route table with
//! `:name` segment parameters.

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
        // Traps on more `:name` segments than `max` rather than dropping them;
        // routes.zig also checks at compile time.
        std.debug.assert(self.len < max);
        self.entries[self.len] = .{ .name = name, .value = value };
        self.len += 1;
    }
};

pub const Handler = *const fn (ctx: *Context, req: *Request, params: Params) anyerror!void;

pub const Route = struct {
    method: Method,
    path: []const u8,
    /// Audiences allowed to call this route; no default, so the auth boundary
    /// can't be forgotten.
    scopes: []const Scope,
    handler: Handler,
    /// Also requires an administrator, checked after scope.
    require_admin: bool = false,
    rate_limit: ?RateLimit = null,
    /// Dispatch takes no whole-handler `db_lock`; the handler brackets each DB
    /// touch with `lockDb`/`unlockDb` itself. For the streaming `/oss/get` and
    /// `/oss/put`, so a multi-MB transfer doesn't serialize everything.
    manual_db_lock: bool = false,
    /// Dispatch may run this on a pooled read-only connection instead of the
    /// writer. Leave false when in doubt: a wrong flag makes writes fail, at
    /// worst half-applying a read-modify-write. HTTP method is no guide (device
    /// reads are POSTs). Services are reader-bound copies, so in-memory mutation
    /// is invisible too. `test/http/read_only_audit_test.zig` audits every flagged
    /// route against a real read-only connection.
    read_only: bool = false,
    /// The handler holds the connection for minutes (SSE). It gets a thread of
    /// its own instead of a pool worker, as every connection once did.
    held: bool = false,
};

/// Whether `req` lands on a `held` route; decided before dispatch, since a
/// worker must not be the thread that serves one.
pub fn isHeld(routes: []const Route, req: *const Request) bool {
    const i = matchedIndex(routes, req) orelse return false;
    return routes[i].held;
}

/// Index of the first route combining `read_only` with `manual_db_lock` (its
/// `lockDb` would guard the writer while it reads a reader) or with
/// `require_admin` (elevation renewal is an UPDATE), or null. Comptime-usable.
pub fn readOnlyConflict(rs: []const Route) ?usize {
    for (rs, 0..) |r, i| {
        if (r.read_only and (r.manual_db_lock or r.require_admin)) return i;
    }
    return null;
}

/// Index of the first route both `manual_db_lock` and `require_admin`, or
/// null. Banned because the manual branch of `dispatchLocked` skips
/// `renewElevation`, giving admins a surprise 428.
pub fn manualAdminRoute(rs: []const Route) ?usize {
    for (rs, 0..) |r, i| {
        if (r.manual_db_lock and r.require_admin) return i;
    }
    return null;
}

pub const Decision = enum { ok, unauthorized, forbidden, needs_elevation };

/// Status for a lapsed admin elevation. Not 401 or 403: the SPA maps both to
/// a dead session and signs the admin out instead of showing the re-auth gate.
pub const elevation_required_status: std.http.Status = .precondition_required; // 428
pub const elevation_required_code = "ELEVATION_REQUIRED";

/// Whether `caller` may reach a route with `scopes`/`require_admin`.
pub fn authorize(scopes: []const Scope, require_admin: bool, caller: ?Caller) Decision {
    for (scopes) |s| if (s == .public) return .ok;
    const c = caller orelse return .unauthorized;
    var audience_ok = false;
    for (scopes) |s| if (s == c.audience) {
        audience_ok = true;
        break;
    };
    if (!audience_ok) return .forbidden;
    if (require_admin) {
        // A non-admin gets a plain 403 and learns nothing of the elevation gate.
        if (!c.is_admin) return .forbidden;
        if (!c.elevated) return .needs_elevation;
    }
    return .ok;
}

/// Matches, rate-limits, authorizes and runs the handler; falls back to static
/// files, then 404.
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
    if (try static.serve(ctx, req)) return;
    try req.respond("not found\n", .{ .status = .not_found });
}

/// Retry-after ms if over the route's limit, else null. Keyed per route and
/// identity; the IP dimension applies pre-auth, the user one once known.
/// Limiter errors fail open.
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

/// The re-auth gate's response. Written literally because `reply` imports this.
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
    const secs = @divTrunc(retry_ms, 1000) + 1;
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

    try std.testing.expectEqual(Decision.ok, authorize(&.{.public}, false, null));

    try std.testing.expectEqual(Decision.unauthorized, authorize(&.{.controlplane}, false, null));

    try std.testing.expectEqual(Decision.ok, authorize(&.{.device}, false, dev));
    try std.testing.expectEqual(Decision.ok, authorize(&.{.controlplane}, false, cp));
    try std.testing.expectEqual(Decision.forbidden, authorize(&.{.device}, false, cp)); // control plane -> sync API
    try std.testing.expectEqual(Decision.forbidden, authorize(&.{.controlplane}, false, dev)); // device -> page API

    try std.testing.expectEqual(Decision.forbidden, authorize(&.{.controlplane}, false, pend));
    try std.testing.expectEqual(Decision.ok, authorize(&.{ .controlplane, .pending }, false, pend)); // change-password
    try std.testing.expectEqual(Decision.ok, authorize(&.{ .controlplane, .pending }, false, cp)); // full control plane too

    const any = &[_]Scope{ .controlplane, .device, .pending };
    try std.testing.expectEqual(Decision.ok, authorize(any, false, dev));
    try std.testing.expectEqual(Decision.ok, authorize(any, false, pend));
    try std.testing.expectEqual(Decision.unauthorized, authorize(any, false, null));

    try std.testing.expectEqual(Decision.forbidden, authorize(&.{.controlplane}, true, cp));
    try std.testing.expectEqual(Decision.ok, authorize(&.{.controlplane}, true, admin));
}

test "authorize: an un-elevated admin is gated, distinguishably from every other refusal" {
    const cp: Caller = .{ .user_id = 1, .audience = .controlplane };
    const stale: Caller = .{ .user_id = 1, .audience = .controlplane, .is_admin = true }; // admin, elevation lapsed
    const fresh: Caller = .{ .user_id = 1, .audience = .controlplane, .is_admin = true, .elevated = true };

    try std.testing.expectEqual(Decision.needs_elevation, authorize(&.{.controlplane}, true, stale));
    try std.testing.expect(Decision.needs_elevation != Decision.unauthorized);
    try std.testing.expect(Decision.needs_elevation != Decision.forbidden);
    try std.testing.expect(elevation_required_status != .unauthorized);
    try std.testing.expect(elevation_required_status != .forbidden);

    try std.testing.expectEqual(Decision.forbidden, authorize(&.{.controlplane}, true, cp));

    try std.testing.expectEqual(Decision.ok, authorize(&.{.controlplane}, false, stale));
    try std.testing.expectEqual(Decision.ok, authorize(&.{.controlplane}, false, cp));

    const elevated_device: Caller = .{ .user_id = 1, .audience = .device, .is_admin = true, .elevated = true };
    try std.testing.expectEqual(Decision.forbidden, authorize(&.{.controlplane}, true, elevated_device));
    try std.testing.expectEqual(Decision.ok, authorize(&.{.controlplane}, true, fresh));
}

/// The matching route, or null, so a caller can read its flags before dispatch.
pub fn matched(routes: []const Route, req: *const Request) ?*const Route {
    const i = matchedIndex(routes, req) orelse return null;
    return &routes[i];
}

/// The matching route's index (the lock histogram's key), or null.
pub fn matchedIndex(routes: []const Route, req: *const Request) ?usize {
    const path = stripQuery(req.head.target);
    var params: Params = .{};
    for (routes, 0..) |*r, i| {
        if (req.head.method == r.method and match(r.path, path, &params)) return i;
    }
    return null;
}

pub fn matches(routes: []const Route, req: *const Request) bool {
    return matched(routes, req) != null;
}

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

/// Copies header `name` into `buf` (truncating); "" if absent. Copies because
/// `json.readBody` overwrites the head buffer, which once garbled a device's
/// echoed `equipmentNo`.
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

test "manualAdminRoute finds the flag pair that would silently stop renewing elevation" {
    const h = struct {
        fn f(_: *Context, _: *Request, _: Params) anyerror!void {}
    }.f;

    const legal = [_]Route{
        .{ .method = .GET, .path = "/oss/get/:id", .scopes = &.{.public}, .handler = h, .manual_db_lock = true },
        .{ .method = .GET, .path = "/api/admin/health", .scopes = &.{.controlplane}, .handler = h, .require_admin = true },
        .{ .method = .GET, .path = "/api/version", .scopes = &.{.public}, .handler = h },
    };
    try std.testing.expect(manualAdminRoute(&legal) == null);

    const banned = [_]Route{
        .{ .method = .GET, .path = "/api/version", .scopes = &.{.public}, .handler = h },
        .{
            .method = .POST,
            .path = "/api/admin/export",
            .scopes = &.{.controlplane},
            .handler = h,
            .require_admin = true,
            .manual_db_lock = true,
        },
    };
    try std.testing.expectEqual(@as(?usize, 1), manualAdminRoute(&banned));

    try std.testing.expect(manualAdminRoute(&[_]Route{}) == null);
}

test "readOnlyConflict refuses the two pairings that would make the lock a lie" {
    const h = struct {
        fn f(_: *Context, _: *Request, _: Params) anyerror!void {}
    }.f;

    const legal = [_]Route{
        .{ .method = .GET, .path = "/api/controlplane/tree", .scopes = &.{.controlplane}, .handler = h, .read_only = true },
        .{ .method = .GET, .path = "/oss/get/:id", .scopes = &.{.public}, .handler = h, .manual_db_lock = true },
        .{ .method = .GET, .path = "/api/admin/health", .scopes = &.{.controlplane}, .handler = h, .require_admin = true },
    };
    try std.testing.expect(readOnlyConflict(&legal) == null);

    const manual = [_]Route{
        .{ .method = .GET, .path = "/api/version", .scopes = &.{.public}, .handler = h },
        .{ .method = .GET, .path = "/file/:id", .scopes = &.{.controlplane}, .handler = h, .manual_db_lock = true, .read_only = true },
    };
    try std.testing.expectEqual(@as(?usize, 1), readOnlyConflict(&manual));

    const admin = [_]Route{
        .{ .method = .GET, .path = "/api/admin/users", .scopes = &.{.controlplane}, .handler = h, .require_admin = true, .read_only = true },
    };
    try std.testing.expectEqual(@as(?usize, 0), readOnlyConflict(&admin));

    try std.testing.expect(readOnlyConflict(&[_]Route{}) == null);
}
