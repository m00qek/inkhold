//! The account screen, device unlink, usage and server-info.

const std = @import("std");
const router = @import("../../http/router.zig");
const context = @import("../../http/context.zig");
const json = @import("../../http/json.zig");
const reply = @import("../../http/reply.zig");
const controlplane = @import("../../services/controlplane.zig");
const config = @import("../../config.zig");
const transport = @import("../../http/transport.zig");
const authsvc = @import("../../services/auth/service.zig");
const Context = context.Context;
const Request = router.Request;
const Params = router.Params;
const fail = reply.fail;
const badRequest = reply.badRequest;
const serverError = reply.serverError;
const read = @import("read.zig");

const UnbindReq = struct { equipmentNo: []const u8 };

/// POST /api/controlplane/equipment/unlink -> revoke a device.
pub fn controlplaneUnlink(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    const caller = ctx.caller.?; // controlplane scope
    var parsed = json.readBody(UnbindReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    svc.unlinkDevice(caller.user_id, parsed.value.equipmentNo) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// GET /api/controlplane/usage -> the caller's own storage usage.
const UsageVO = struct { used_bytes: i64, total_bytes: i64 };

pub fn controlplaneUsage(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const cap = files.capacity(caller.user_id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, UsageVO{ .used_bytes = cap.used, .total_bytes = cap.total }, null);
}

/// One device binding; the same struct as the admin console's `DevicesVO` rows.
const MyDeviceVO = authsvc.DeviceInfo;

/// `maxKeep` is the admin ceiling and the default; `keep == 0` is versioning off.
/// `retainedPerFile` lets the control predict what a lower `keep` removes.
const VersionPolicyVO = struct {
    keep: u32,
    maxKeep: u32,
    retainedPerFile: []const u32,
};

/// GET /api/controlplane/account -> identity, sessions and devices in one read.
/// `passwordChangedAt` absent means never changed (accounts before schema v3).
/// `otherBrowsers` counts the caller's other live sessions, this one excluded.
const AccountVO = struct {
    success: bool = true,
    email: []const u8,
    name: []const u8,
    isAdmin: bool,
    createdAt: i64,
    passwordChangedAt: ?i64 = null,
    thisSessionSince: ?i64 = null,
    otherBrowsers: i64,
    devices: []const MyDeviceVO,
    versions: VersionPolicyVO,
};

pub fn controlplaneAccount(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const token = transport.presentedToken(req) orelse return serverError(ctx, req);

    const account = (svc.accountInfo(ctx.gpa, caller.user_id) catch return serverError(ctx, req)) orelse
        return serverError(ctx, req); // the session resolved off this row moments ago
    defer authsvc.Service.freeAccount(ctx.gpa, account);

    const sessions = svc.sessionSummary(caller.user_id, token) catch return serverError(ctx, req);

    // The admin listing with the target fixed to the caller.
    const devices = svc.listUserDevices(ctx.gpa, caller.user_id, caller.user_id) catch return serverError(ctx, req);
    defer authsvc.Service.freeDevices(ctx.gpa, devices);

    const policy = files.versionPolicy(caller.user_id) catch return serverError(ctx, req);
    const retained = files.retainedPerFile(ctx.gpa, caller.user_id) catch return serverError(ctx, req);
    defer ctx.gpa.free(retained);
    try json.respond(ctx.gpa, req, .ok, AccountVO{
        .email = account.email,
        .name = account.name,
        .isAdmin = account.is_admin,
        .createdAt = account.created_at,
        .passwordChangedAt = account.password_changed_at,
        .thisSessionSince = sessions.this_since,
        .otherBrowsers = sessions.other_browsers,
        .devices = devices,
        .versions = .{
            .keep = policy.keep,
            .maxKeep = policy.max_keep,
            .retainedPerFile = retained,
        },
    }, null);
}

/// PUT /api/controlplane/account/versions -> set the per-file version count,
/// evicting now. Values above the ceiling are clamped. Dropped versions skip the
/// bin, so the response reports what was removed.
pub fn controlplaneSetVersions(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);

    var parsed = json.readBody(SetVersionsReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    if (parsed.value.keep < 0) return badRequest(ctx, req);

    const changed = files.setVersionPolicy(caller.user_id, @intCast(parsed.value.keep)) catch
        return serverError(ctx, req);

    const retained = files.retainedPerFile(ctx.gpa, caller.user_id) catch return serverError(ctx, req);
    defer ctx.gpa.free(retained);
    try json.respond(ctx.gpa, req, .ok, SetVersionsVO{
        .policy = .{
            .keep = changed.policy.keep,
            .maxKeep = changed.policy.max_keep,
            .retainedPerFile = retained,
        },
        .removedVersions = changed.removed_versions,
        .freedBytes = changed.freed_bytes,
    }, null);
}

/// Signed so a negative is a 400, not a huge `keep` clamped to the ceiling.
const SetVersionsReq = struct { keep: i64 };

const SetVersionsVO = struct {
    success: bool = true,
    policy: VersionPolicyVO,
    removedVersions: u32,
    freedBytes: i64,
};

/// GET /api/controlplane/account/storage. The five figures partition `used_bytes`
/// exactly (`Files.storageBreakdown` owns the precedence).
const StorageVO = struct {
    success: bool = true,
    used_bytes: i64,
    total_bytes: i64,
    notebooks: i64,
    sketches: i64,
    documents: i64,
    recycle_bin: i64,
    versions: i64,
};

pub fn controlplaneAccountStorage(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const cap = files.capacity(caller.user_id) catch return serverError(ctx, req);
    const b = files.storageBreakdown(caller.user_id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, StorageVO{
        .used_bytes = cap.used,
        .total_bytes = cap.total,
        .notebooks = b.notebooks,
        .sketches = b.sketches,
        .documents = b.documents,
        .recycle_bin = b.recycle_bin,
        .versions = b.versions,
    }, null);
}

/// POST /api/controlplane/account/devices/unlink `{equipmentNo}`. Goes through
/// `adminUnlinkDevice` so another user's serial is `DEVICE_NOT_FOUND`, like an
/// unknown one; `/equipment/unlink` instead answers 200 when nothing matched.
pub fn controlplaneUnlinkMyDevice(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    const caller = ctx.caller.?; // controlplane scope
    var parsed = json.readBody(UnbindReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();

    svc.adminUnlinkDevice(caller.user_id, caller.user_id, parsed.value.equipmentNo) catch |err| switch (err) {
        error.DeviceNotFound => return fail(ctx, req, .not_found, "DEVICE_NOT_FOUND", "you have no such device"),
        else => return serverError(ctx, req),
    };
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// POST /api/controlplane/account/sign-out-others -> drop every session but this
/// request's; `revoked` is the row count.
const SignedOutVO = struct { success: bool = true, revoked: i64 };

pub fn controlplaneSignOutOthers(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?;
    const caller = ctx.caller.?; // controlplane scope
    const token = transport.presentedToken(req) orelse return serverError(ctx, req);
    const revoked = svc.signOutOtherSessions(caller.user_id, token) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, SignedOutVO{ .revoked = revoked }, null);
}

/// Serialized raw (no `{success}` envelope), like the other control-plane reads.
const ServerInfoVO = struct { address: []const u8, firstRun: bool };

/// libc `struct ifaddrs`, read fields only. std has no portable interface
/// enumerator, and onboarding needs the host's LAN IPv4.
const ifaddrs = extern struct {
    next: ?*ifaddrs,
    name: ?[*:0]u8,
    flags: c_uint,
    addr: ?*std.posix.sockaddr,
    netmask: ?*std.posix.sockaddr,
    ifu: ?*std.posix.sockaddr,
    data: ?*anyopaque,
};
extern "c" fn getifaddrs(ifap: *?*ifaddrs) c_int;
extern "c" fn freeifaddrs(ifa: ?*ifaddrs) void;

fn isLoopback(o: [4]u8) bool {
    return o[0] == 127; // 127.0.0.0/8
}

fn isLinkLocal(o: [4]u8) bool {
    return o[0] == 169 and o[1] == 254; // 169.254.0.0/16
}

fn isPrivate(o: [4]u8) bool {
    return (o[0] == 10) or // 10.0.0.0/8
        (o[0] == 172 and o[1] >= 16 and o[1] <= 31) or // 172.16.0.0/12
        (o[0] == 192 and o[1] == 168); // 192.168.0.0/16
}

/// Virtual, bridge and tunnel interfaces that carry private IPv4 but are not the
/// LAN (e.g. `docker0`'s 172.17.0.1, which the Supernote cannot reach).
fn isVirtualIface(name_z: [*:0]const u8) bool {
    const name = std.mem.span(name_z);
    const skip = [_][]const u8{
        "lo",      "docker", "br-",       "veth", "virbr",
        "vboxnet", "vmnet",  "tailscale", "wg",   "zt",
        "tun",     "tap",
    };
    for (skip) |p| if (std.mem.startsWith(u8, name, p)) return true;
    return false;
}

/// The host's primary IPv4, skipping virtual interfaces and preferring a
/// private-range address over any other non-loopback, non-link-local one.
fn primaryIpv4() ?[4]u8 {
    var list: ?*ifaddrs = null;
    if (getifaddrs(&list) != 0) return null;
    defer freeifaddrs(list);

    var fallback: ?[4]u8 = null;
    var it = list;
    while (it) |ifa| : (it = ifa.next) {
        const sa = ifa.addr orelse continue;
        if (sa.family != std.posix.AF.INET) continue;
        if (ifa.name) |n| if (isVirtualIface(n)) continue;
        const sin: *const std.posix.sockaddr.in = @ptrCast(@alignCast(sa));
        // `sin.addr` holds the address in network byte order; a bitcast to bytes
        // recovers the octets in a.b.c.d order on any host endianness.
        const octets: [4]u8 = @bitCast(sin.addr);
        if (isLoopback(octets) or isLinkLocal(octets)) continue;
        if (isPrivate(octets)) return octets;
        if (fallback == null) fallback = octets;
    }
    return fallback;
}

/// `host:port` for the connect step; falls back to the bind host, then `""`
/// (the frontend then uses `window.location`).
fn serverAddress(buf: []u8, cfg: config.Config) []const u8 {
    if (primaryIpv4()) |o|
        return std.fmt.bufPrint(buf, "{d}.{d}.{d}.{d}:{d}", .{ o[0], o[1], o[2], o[3], cfg.port }) catch "";
    return std.fmt.bufPrint(buf, "{s}:{d}", .{ cfg.host, cfg.port }) catch "";
}

/// GET /api/controlplane/server-info -> `{ address, firstRun }`. Public on purpose:
/// the login page needs first-run state and the LAN address before sign-in.
pub fn controlplaneServerInfo(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const svc = ctx.service.?; // set at startup, present on every route incl. public
    const first_run = svc.isFirstRun() catch return serverError(ctx, req);

    var addr_buf: [64]u8 = undefined;
    try json.respond(ctx.gpa, req, .ok, ServerInfoVO{
        .address = serverAddress(&addr_buf, ctx.config),
        .firstRun = first_run,
    }, null);
}
