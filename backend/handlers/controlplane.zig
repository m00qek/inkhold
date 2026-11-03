//! Control-plane handlers (the browser face): device-management unlink, the
//! browse/read endpoints for the SPA (tree, note meta, per-page bytes), and the
//! live-freshness SSE channel. Thin HTTP shells over the `ControlPlaneService`.

const std = @import("std");
const router = @import("../http/router.zig");
const context = @import("../http/context.zig");
const json = @import("../http/json.zig");
const reply = @import("../http/reply.zig");
const byte_range = @import("../http/byte_range.zig");
const controlplane = @import("../services/controlplane.zig");
const eventstreams = @import("../http/event_streams.zig");
const multipart = @import("../http/multipart.zig");
const upload_cap = @import("upload_cap.zig");
const blobstore = @import("../store/blobs.zig");
const thumbnailmod = @import("../services/thumbnail.zig");
const filesvc = @import("../services/files.zig");
const config = @import("../config.zig");
const transport = @import("../http/transport.zig");
const authsvc = @import("../services/auth/service.zig");
const pendingsvc = @import("../services/pending.zig");
const index_export = @import("../services/search/index_export.zig");
const indexstream = @import("../services/search/index_stream.zig");
const wantbitmap = @import("../services/search/want_bitmap.zig");
const derived = @import("../store/derived.zig");
const derivesearch = @import("../services/derive_search.zig");
const gzip_stitch = @import("../http/gzip_stitch.zig");
const sqlite = @import("../db/sqlite.zig");

const Context = context.Context;
const Request = router.Request;
const Params = router.Params;
const fail = reply.fail;
const badRequest = reply.badRequest;
const serverError = reply.serverError;

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

// ---- the account screen ----
//
// Everything here is the caller's own: no `:id`, no user id from a body.
// Null optionals are omitted from the JSON, not sent as `null`.

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

// ---- server-info (the onboarding bootstrap fact) ----

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

// ---- the recycle bin ----
//
// No CSRF token: the session cookie is `SameSite=Strict`. Every call is scoped by
// `caller.user_id` and answers a foreign id as `NotFound`, so these routes are not
// an existence oracle.

/// GET /api/controlplane/bin -> the caller's trashed entries, newest deletion
/// first, as a flat list; grouping is the client's.
pub fn controlplaneBin(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);
    const vo = svc.bin(arena.allocator(), caller.user_id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// DELETE /api/controlplane/entry/{id} -> move a live entry and its subtree to the
/// bin. `entries` is the fanout for the undo toast, counted before the trash. No
/// quota refund here; `purge` frees the bytes.
pub fn controlplaneTrash(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    // `get`, not `getAnyState`: an already-trashed row is a 404, like a missing one.
    const entry = (files.get(caller.user_id, id) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .not_found, "NOT_FOUND", "no such entry");
    defer ctx.gpa.free(entry.name);
    defer if (entry.md5) |m| ctx.gpa.free(m);

    const fanout = files.liveSubtreeCount(caller.user_id, id) catch return serverError(ctx, req);
    files.trash(caller.user_id, id) catch |err| switch (err) {
        error.NotFound => return fail(ctx, req, .not_found, "NOT_FOUND", "no such entry"),
        else => return serverError(ctx, req),
    };

    var idbuf: [24]u8 = undefined;
    const id_str = std.fmt.bufPrint(&idbuf, "{d}", .{id}) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, controlplane.TrashedVO{
        .id = id_str,
        .name = entry.name,
        .isFolder = entry.is_folder,
        .entries = @intCast(fanout),
    }, null);
}

/// Fixed category folders the rail navigates by and the device re-provisions.
/// Must match webapp `rail.ts` `CATEGORIES`. Nothing marks them in the DB, so the
/// guard matches exact-case names: roots at `parent_id == null`, anchors as
/// `[root-level parent, entry]`.
const category_roots = [_][]const u8{ "NOTE", "DOCUMENT", "EXPORT", "SCREENSHOT", "INBOX" };
const category_anchors = [_][2][]const u8{
    .{ "NOTE", "Note" },
    .{ "NOTE", "MyStyle" },
    .{ "DOCUMENT", "Document" },
};

fn isCategoryRoot(name: []const u8) bool {
    for (category_roots) |r| if (std.mem.eql(u8, name, r)) return true;
    return false;
}

fn isCategoryAnchor(parent_name: []const u8, name: []const u8) bool {
    for (category_anchors) |a|
        if (std.mem.eql(u8, a[0], parent_name) and std.mem.eql(u8, a[1], name)) return true;
    return false;
}

const RenameReq = struct { name: []const u8 };

/// POST /api/controlplane/entry/{id}/rename `{name}` (the full filename). A `move`
/// to the current parent with `autorename = false`, so a clash is 409 rather than a
/// " (2)" suffix. 400 empty or '/'; 403 category folder; 404 foreign, missing or
/// trashed. Metadata only.
pub fn controlplaneRename(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    var parsed = json.readBody(RenameReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const new_name = std.mem.trim(u8, parsed.value.name, " \t\r\n");

    // Validate server-side too; '/' is not a legal filename component.
    if (new_name.len == 0)
        return fail(ctx, req, .bad_request, "INVALID_NAME", "a name can't be empty");
    if (std.mem.indexOfScalar(u8, new_name, '/') != null)
        return fail(ctx, req, .bad_request, "INVALID_NAME", "a name can't contain '/'");

    // `get` hardcodes `deleted = 0`: foreign, missing and trashed are one 404.
    const entry = (files.get(caller.user_id, id) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .not_found, "NOT_FOUND", "no such entry");
    defer ctx.gpa.free(entry.name);
    defer if (entry.md5) |m| ctx.gpa.free(m);

    if (entry.is_folder) {
        if (entry.parent_id) |pid| {
            // An anchor's parent must itself be root-level.
            if (files.get(caller.user_id, pid) catch return serverError(ctx, req)) |parent| {
                defer ctx.gpa.free(parent.name);
                defer if (parent.md5) |m| ctx.gpa.free(m);
                if (parent.parent_id == null and isCategoryAnchor(parent.name, entry.name))
                    return fail(ctx, req, .forbidden, "RESERVED_FOLDER", "this system folder can't be renamed");
            }
        } else if (isCategoryRoot(entry.name)) {
            return fail(ctx, req, .forbidden, "RESERVED_FOLDER", "this system folder can't be renamed");
        }
    }

    const moved = files.move(caller.user_id, id, entry.parent_id, new_name, false) catch |err| switch (err) {
        error.NameConflict => return fail(ctx, req, .conflict, "NAME_TAKEN", "that name is already used here"),
        error.NotFound => return fail(ctx, req, .not_found, "NOT_FOUND", "no such entry"),
        else => return serverError(ctx, req),
    };
    defer ctx.gpa.free(moved.name);
    defer if (moved.md5) |m| ctx.gpa.free(m);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);
    const vo = svc.entryVO(arena.allocator(), caller.user_id, moved) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

// ---- web upload (POST /api/controlplane/folder/{id}/upload) -------------------

/// Extensions a web upload accepts: what the device can open, plus `.spd`
/// (device-authored, so absent from Ratta's import list, but restorable from a
/// backup) and the MOBI family (read via the bundled Kindle app). Else 415.
const upload_extensions = [_][]const u8{
    ".note", ".spd",
    ".pdf",  ".epub",
    ".doc",  ".docx",
    ".txt",  ".png",
    ".jpg",  ".jpeg",
    ".webp", ".cbz",
    ".fb2",  ".xps",
    ".mobi", ".azw",
    ".azw3",
};

/// `>` not `>=`: a bare `.pdf` is a dotfile, not a PDF.
fn acceptedUploadExt(name: []const u8) bool {
    for (upload_extensions) |ext| {
        if (name.len > ext.len and std.ascii.endsWithIgnoreCase(name, ext)) return true;
    }
    return false;
}

/// True if `name` is safe as a tree path component; a second gate after
/// `multipart.Prologue`'s basename. Rejects separators, any `..`, control chars
/// (they break the device's path-based protocol) and invalid UTF-8.
fn validUploadName(name: []const u8) bool {
    if (name.len == 0 or name.len > multipart.max_filename) return false;
    if (std.mem.indexOfScalar(u8, name, '/') != null) return false;
    if (std.mem.indexOfScalar(u8, name, '\\') != null) return false;
    if (std.mem.indexOf(u8, name, "..") != null) return false;
    for (name) |c| if (c < 0x20 or c == 0x7F) return false;
    if (!std.unicode.utf8ValidateSlice(name)) return false;
    return true;
}

/// What an upload does when a live file already holds the name. `rename` (the
/// default) keeps both with a ` (n)` suffix; `replace` supersedes via `linkBlob`,
/// so the old file stays a restorable version. Unknown values mean `rename`, so an
/// old or mistyped client never overwrites.
const OnConflict = enum { rename, replace };

/// Read before the body: reading the body invalidates head strings.
fn onConflictFromTarget(target: []const u8) OnConflict {
    const v = reply.queryParam(target, "onConflict") orelse return .rename;
    if (std.ascii.eqlIgnoreCase(v, "replace")) return .replace;
    return .rename; // absent, misspelled, or anything else: never overwrite by accident
}

/// POST /api/controlplane/folder/{id}/upload -> store one multipart file part into
/// the caller's tree (`{id}` may be `root`). No device protocol needed: the Nomad
/// pulls whatever the server holds, so this shares `upload/finish`'s tree-link.
/// `manual_db_lock`: the ingest runs unlocked; the lock covers only the destination
/// lookup, the quota read and the link. Name and type are refused before any byte
/// is stored, and the ingest is capped at remaining quota as bytes arrive.
/// 200 `EntryVO`; 413 quota; 415 type; 400 name; 404 bad destination; 409 when a
/// folder holds the name.
pub fn controlplaneUpload(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);

    // Copy what we need out of the head first; reading the body invalidates it.
    const id_raw = params.get("id") orelse return badRequest(ctx, req);
    var id_buf: [24]u8 = undefined;
    if (id_raw.len == 0 or id_raw.len > id_buf.len) return badRequest(ctx, req);
    @memcpy(id_buf[0..id_raw.len], id_raw);
    const id_str = id_buf[0..id_raw.len];

    const on_conflict = onConflictFromTarget(req.head.target);

    var ct_buf: [256]u8 = undefined;
    const ct = router.headerCopy(req, "content-type", &ct_buf);
    var bnd_buf: [multipart.max_term]u8 = undefined;
    const boundary = multipart.boundaryFromContentType(ct, &bnd_buf) orelse return badRequest(ctx, req);

    // `root` is the library root; anything else must be a live folder this caller
    // owns (`Files.get`: foreign, missing and trashed are one 404).
    var parent: ?u64 = null;
    if (!std.mem.eql(u8, id_str, "root")) {
        const id = std.fmt.parseInt(u64, id_str, 10) catch return badRequest(ctx, req);
        ctx.lockDb();
        const got = files.get(caller.user_id, id);
        ctx.unlockDb();
        const dest = (got catch return serverError(ctx, req)) orelse
            return fail(ctx, req, .not_found, "NOT_FOUND", "no such folder");
        defer ctx.gpa.free(dest.name);
        defer if (dest.md5) |m| ctx.gpa.free(m);
        if (!dest.is_folder) return fail(ctx, req, .not_found, "NOT_FOUND", "no such folder");
        parent = id;
    }

    // There is no declared size to hold the body to, so cap it at the remaining
    // quota `linkBlob` will enforce anyway (see `upload_cap.slack_bytes`).
    const limit = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        const cap = files.capacity(caller.user_id) catch return serverError(ctx, req);
        const remaining: u64 = if (cap.total <= cap.used) 0 else @intCast(cap.total - cap.used);
        break :blk upload_cap.limitFor(remaining);
    };

    var rbuf: [blobstore.chunk_len]u8 = undefined;
    const reader = req.readerExpectContinue(&rbuf) catch return badRequest(ctx, req);

    var pro: multipart.Prologue = .{};
    multipart.readPrologue(reader, &pro) catch return badRequest(ctx, req);
    const name = std.mem.trim(u8, pro.filename(), " \t\r\n");
    if (!validUploadName(name))
        return fail(ctx, req, .bad_request, "INVALID_NAME", "that filename can't be used");
    if (!acceptedUploadExt(name))
        return fail(ctx, req, .unsupported_media_type, "UNSUPPORTED_TYPE", "the Nomad can't open that file type");

    // Stream unlocked into a new blob, never whole in RAM.
    var wbuf: [blobstore.chunk_len]u8 = undefined;
    var ing = files.blobs.beginIngest(&wbuf) catch return serverError(ctx, req);
    var sink = upload_cap.Capped(blobstore.Ingest).init(&ing, limit);
    multipart.streamPart(reader, boundary, &pro, &sink) catch |err| {
        // `abort` drops the temp file, so a refused body leaves nothing on disk.
        ing.abort();
        if (err == error.UploadTooLarge)
            return fail(ctx, req, .payload_too_large, "QUOTA_EXCEEDED", "not enough space");
        return badRequest(ctx, req);
    };
    const res = ing.finish(null) catch {
        ing.abort();
        return serverError(ctx, req);
    };
    ing.deinit();

    // Link it in under the lock. A dedup hit charges zero: quota is per distinct
    // blob per user.
    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);

    var vo: controlplane.EntryVO = undefined;
    {
        ctx.lockDb();
        defer ctx.unlockDb();
        // `replace` is `linkBlob` unmodified, the call `upload/finish` makes.
        const linked = switch (on_conflict) {
            .rename => files.placeUpload(caller.user_id, parent, name, &res.md5, res.size),
            .replace => files.linkBlob(caller.user_id, parent, name, &res.md5, res.size),
        };
        const entry = linked catch |err| {
            // The blob is unreferenced now; drop it unless it deduped (the `putFile` rule).
            if (!res.deduped) files.blobs.remove(&res.md5);
            return switch (err) {
                error.QuotaExceeded => fail(ctx, req, .payload_too_large, "QUOTA_EXCEEDED", "not enough space"),
                error.NameConflict => fail(ctx, req, .conflict, "NAME_TAKEN", "that name is already used here"),
                error.NotAFolder, error.NotFound => fail(ctx, req, .not_found, "NOT_FOUND", "no such folder"),
                else => serverError(ctx, req),
            };
        };
        defer ctx.gpa.free(entry.name);
        defer if (entry.md5) |m| ctx.gpa.free(m);
        // Under the same lock: `entryVO` reads the DB.
        vo = svc.entryVO(arena.allocator(), caller.user_id, entry) catch return serverError(ctx, req);
    }
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// POST /api/controlplane/bin/{id}/restore -> bring a trashed entry back. Reports
/// what happened: restore also revives the ancestor chain and descendants, and
/// auto-renames when a live entry took the name.
pub fn controlplaneRestore(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    const done = files.restore(caller.user_id, id) catch |err| switch (err) {
        error.NotFound => return fail(ctx, req, .not_found, "NOT_FOUND", "no such entry"),
        else => return serverError(ctx, req),
    };
    defer done.deinit(ctx.gpa);

    try json.respond(ctx.gpa, req, .ok, controlplane.RestoredVO{
        .name = done.name,
        .renamed = done.renamed,
        .ancestors = @intCast(done.ancestors),
        .descendants = @intCast(done.descendants),
    }, null);
}

/// DELETE /api/controlplane/bin/{id} -> destroy one trashed entry and its subtree.
/// A live id is a 404 (`Files.purge` refuses anything outside the bin).
pub fn controlplanePurge(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    files.purge(caller.user_id, id) catch |err| switch (err) {
        error.NotFound => return fail(ctx, req, .not_found, "NOT_FOUND", "no such entry"),
        else => return serverError(ctx, req),
    };
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// DELETE /api/controlplane/bin -> destroy everything in the caller's bin.
pub fn controlplaneEmptyBin(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);

    const n = files.emptyBin(caller.user_id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, controlplane.EmptiedVO{ .entries = @intCast(n) }, null);
}

/// GET /api/controlplane/bin/file/metadata/{id} -> the page list of a trashed item.
/// The bin routes read through `Files.getTrashed`, which sees only trashed rows;
/// `Files.get` stays live-only.
pub fn controlplaneBinNote(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);
    const vo = (svc.binNoteMeta(arena.allocator(), caller.user_id, id) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .not_found, "NOT_FOUND", "no such note");
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// GET /api/controlplane/bin/note/{id}/page/{n}/text -> a trashed note's page
/// transcript (retained md5-keyed after trash). A live id is a 404. `no-cache`,
/// never `immutable`: nothing in the URL pins the JSON shape.
pub fn controlplaneBinPageText(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const n = std.fmt.parseInt(u64, params.get("n") orelse return badRequest(ctx, req), 10) catch
        return badRequest(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);

    const pt = (svc.binPageText(arena.allocator(), caller.user_id, id, n) catch return serverError(ctx, req)) orelse
        return reply.notFound(req);

    try json.respondWith(ctx.gpa, req, .ok, pt.vo, &.{
        .{ .name = "cache-control", .value = "no-cache" },
    });
}

/// GET /api/controlplane/tree?parent={id} -> a folder's children, breadcrumb and
/// syncVersion (`parent` omitted or `root` = the root). A pure index read under the
/// global lock; only a cold blob is backfilled (parsed) in-flight, once.
pub fn controlplaneTree(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);

    const parent = reply.queryParam(req.head.target, "parent");
    var parent_id: ?u64 = null;
    if (parent) |p| {
        if (p.len != 0 and !std.mem.eql(u8, p, "root")) {
            parent_id = std.fmt.parseInt(u64, p, 10) catch return badRequest(ctx, req);
        }
    }

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);
    const vo = svc.listing(arena.allocator(), caller.user_id, parent_id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// GET /api/controlplane/file/metadata/{id} -> the full page list (per-page content
/// hash and dims), for every previewable kind. A pure index read.
pub fn controlplaneNote(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);
    const vo = (svc.noteMeta(arena.allocator(), caller.user_id, id) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .not_found, "NOT_FOUND", "no such note");
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// GET /note/{id}/page/{n}?v={hash} -> the immutable per-page payload. A missing
/// page or stale `?v=` is a 404, prompting a metadata refetch. `immutable` is honest
/// because the body is opaque layer bitmaps whose md5 is `?v=`; the 20-byte SNPG
/// envelope is versioned in band, so bumping `page_payload.VERSION` must also turn
/// over the `?v=` domain (`note_index.pageContentHash`). `manual_db_lock`: plan
/// under the lock, then stream unlocked with a computed `Content-Length`.
pub fn controlplanePage(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return pageBytes(ctx, req, params, .live);
}

/// GET /api/controlplane/bin/note/{id}/page/{n}?v={hash} -> the same for a trashed
/// note; `.trashed` can never serve a live note, nor the live route a trashed one.
pub fn controlplaneBinPage(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return pageBytes(ctx, req, params, .trashed);
}

fn pageBytes(ctx: *Context, req: *Request, params: Params, scope: controlplane.ControlPlaneService.ReadScope) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const n = std.fmt.parseInt(u64, params.get("n") orelse return badRequest(ctx, req), 10) catch
        return badRequest(ctx, req);
    // Capture `?v=` before responding (responding invalidates the head strings).
    const v = reply.queryParam(req.head.target, "v");

    var svc = controlplane.ControlPlaneService.init(files);

    // The only DB touches. `pagePlanOf` needs the lock; `writePage` is DB-free. The
    // plan is inline storage with no borrow of statement memory, so it outlives the unlock.
    const planned = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        const entry = (svc.lookup(scope, caller.user_id, id) catch return serverError(ctx, req)) orelse
            break :blk null;
        defer ctx.gpa.free(entry.name);
        defer if (entry.md5) |m| ctx.gpa.free(m);
        break :blk svc.pagePlanOf(entry, n) catch return serverError(ctx, req);
    } orelse return reply.notFound(req);

    // Checked against the stored hash, so a stale `?v=` costs no file I/O.
    if (v == null or !std.ascii.eqlIgnoreCase(v.?, &planned.plan.content_hash))
        return reply.notFound(req);

    return writePageResponse(ctx, req, svc, planned);
}

/// Streams a resolved page's SNPG payload with ETag = content hash and `immutable`.
/// The caller resolved `planned` under the lock and validated `?v=` where needed.
fn writePageResponse(ctx: *Context, req: *Request, svc: controlplane.ControlPlaneService, planned: controlplane.PagePlan) anyerror!void {
    var etag_buf: [36]u8 = undefined;
    const etag = std.fmt.bufPrint(&etag_buf, "\"{s}\"", .{planned.plan.content_hash}) catch
        return serverError(ctx, req);

    var wbuf: [blobstore.chunk_len]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .content_length = planned.plan.content_length,
        .respond_options = .{ .extra_headers = &.{
            .{ .name = "content-type", .value = "application/octet-stream" },
            .{ .name = "cache-control", .value = "public, max-age=31536000, immutable" },
            .{ .name = "etag", .value = etag },
        } },
    }) catch return;

    // The head is already sent, so a mid-stream failure must close the connection
    // (truncation signal). Never call `body.end()` on a short body: it asserts the
    // `Content-Length` was reached and panics in safe builds.
    svc.writePage(planned, &body.writer) catch return error.StreamTruncated;
    body.end() catch {};
}

// ---- history of this file ----
//
// Per-version routes are gated on `{md5}` being a retained version of that file
// (`Files.historyVersion`), so a stranger's or unknown md5 is one 404.

/// GET /api/controlplane/note/{id}/history -> the file's versions, newest first,
/// current one flagged.
pub fn controlplaneHistory(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return historyList(ctx, req, params, .live);
}

/// GET /api/controlplane/bin/note/{id}/history -> the version list of a trashed
/// file, view-only; restore the file first to restore a version.
pub fn controlplaneBinHistory(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return historyList(ctx, req, params, .trashed);
}

fn historyList(ctx: *Context, req: *Request, params: Params, scope: controlplane.ControlPlaneService.ReadScope) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);
    const vo = (svc.historyIn(arena.allocator(), caller.user_id, id, scope) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .not_found, "NOT_FOUND", "no such note");
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// GET /api/controlplane/note/{id}/history/{md5}/meta -> a retained version's page
/// list and geometry from its own `note_index`, as `NoteMetaVO`. `fileHash` and
/// `size` are the version's; `id` and `name` stay the file's.
pub fn controlplaneHistoryMeta(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const md5 = params.get("md5") orelse return badRequest(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);
    const vo = (svc.historyNoteMeta(arena.allocator(), caller.user_id, id, md5) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .not_found, "NOT_FOUND", "no such version");
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// GET /api/controlplane/note/{id}/history/{md5}/page/{n} -> page `n` of a retained
/// version. No `?v=`: `{md5}` already pins the blob. `manual_db_lock`.
pub fn controlplaneHistoryPage(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return historyPage(ctx, req, params, .live);
}

/// GET /api/controlplane/bin/note/{id}/history/{md5}/page/{n} -> the same for a
/// trashed file.
pub fn controlplaneBinHistoryPage(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return historyPage(ctx, req, params, .trashed);
}

fn historyPage(ctx: *Context, req: *Request, params: Params, scope: controlplane.ControlPlaneService.ReadScope) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const md5 = params.get("md5") orelse return badRequest(ctx, req);
    const n = std.fmt.parseInt(u64, params.get("n") orelse return badRequest(ctx, req), 10) catch
        return badRequest(ctx, req);

    var svc = controlplane.ControlPlaneService.init(files);

    // The only DB touches (gate and plan), then stream unlocked, as in `pageBytes`.
    const planned = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        if ((files.historyVersionIn(scope, caller.user_id, id, md5) catch return serverError(ctx, req)) == null)
            break :blk null;
        break :blk svc.pagePlanForMd5(md5, n) catch return serverError(ctx, req);
    } orelse return reply.notFound(req);

    return writePageResponse(ctx, req, svc, planned);
}

/// POST /api/controlplane/note/{id}/history/{md5}/restore -> re-point the file at a
/// retained version through `linkBlobIndexed`, never a raw `UPDATE`, so it is
/// re-derived and the displaced current is retained (undoable). 507 over quota.
pub fn controlplaneHistoryRestore(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const md5 = params.get("md5") orelse return badRequest(ctx, req);

    const entry = files.restoreVersion(caller.user_id, id, md5) catch |err| switch (err) {
        error.NotFound => return fail(ctx, req, .not_found, "NOT_FOUND", "no such version"),
        error.QuotaExceeded => return fail(ctx, req, .insufficient_storage, "QUOTA_EXCEEDED", "restoring this version would exceed your storage"),
        else => return serverError(ctx, req),
    };
    defer ctx.gpa.free(entry.name);
    defer if (entry.md5) |m| ctx.gpa.free(m);

    try json.respond(ctx.gpa, req, .ok, controlplane.RestoredVersionVO{
        .md5 = entry.md5 orelse "",
        .size = @intCast(entry.size),
        .createdAt = entry.updated_at * 1000, // epoch s → ms
    }, null);
}

/// GET /api/controlplane/note/{id}/history/{md5}/raw[?download=1] -> a retained
/// version's raw bytes, for the whole-blob viewers (`.spd`, `.txt`, images). Same
/// headers as `/file/{id}` for the file's name; `{md5}` pins the blob, so no `?v=`.
/// `manual_db_lock`, streamed unlocked.
pub fn controlplaneHistoryRaw(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return historyRaw(ctx, req, params, .live);
}

/// GET /api/controlplane/bin/note/{id}/history/{md5}/raw[?download=1] -> the same
/// for a trashed file.
pub fn controlplaneBinHistoryRaw(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return historyRaw(ctx, req, params, .trashed);
}

fn historyRaw(ctx: *Context, req: *Request, params: Params, scope: controlplane.ControlPlaneService.ReadScope) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const md5 = params.get("md5") orelse return badRequest(ctx, req);
    // Capture query params BEFORE responding (responding invalidates head strings).
    const forced_download = if (reply.queryParam(req.head.target, "download")) |d|
        !std.mem.eql(u8, d, "0")
    else
        false;

    var svc = controlplane.ControlPlaneService.init(files);

    // The only DB touches (gate and name lookup). `name` is duped by `rowToEntry`,
    // so it is no borrow of statement memory.
    const resolved = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        const v = (files.historyVersionIn(scope, caller.user_id, id, md5) catch return serverError(ctx, req)) orelse
            break :blk null;
        // The version shares the file's name (hence its disposition); the current
        // md5 is irrelevant here.
        const entry = (svc.lookup(scope, caller.user_id, id) catch return serverError(ctx, req)) orelse
            break :blk null;
        if (entry.md5) |m| ctx.gpa.free(m);
        break :blk .{ .name = entry.name, .md5_hex = v.md5, .size = v.size };
    } orelse return reply.notFound(req);
    defer ctx.gpa.free(resolved.name);

    return streamRawBlob(ctx, req, resolved.name, &resolved.md5_hex, resolved.size, forced_download);
}

/// GET /api/controlplane/note/{id}/history/{md5}/page/{n}/text -> a retained
/// version's page transcript and word boxes from its own `note_page_index`, never a
/// re-parse. Same `PageTextVO` and `no-cache` policy as the live text route: `{md5}`
/// pins the content, not the JSON shape. No finished recognition is a 404.
pub fn controlplaneHistoryPageText(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return historyPageText(ctx, req, params, .live);
}

/// GET /api/controlplane/bin/note/{id}/history/{md5}/page/{n}/text -> the same for
/// a trashed file.
pub fn controlplaneBinHistoryPageText(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return historyPageText(ctx, req, params, .trashed);
}

fn historyPageText(ctx: *Context, req: *Request, params: Params, scope: controlplane.ControlPlaneService.ReadScope) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const md5 = params.get("md5") orelse return badRequest(ctx, req);
    const n = std.fmt.parseInt(u64, params.get("n") orelse return badRequest(ctx, req), 10) catch
        return badRequest(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);

    const version = (files.historyVersionIn(scope, caller.user_id, id, md5) catch return serverError(ctx, req)) orelse
        return reply.notFound(req);

    // Keyed by the version's md5, so it reads that version's own transcript.
    const pt = (svc.pageTextForMd5(arena.allocator(), &version.md5, n) catch return serverError(ctx, req)) orelse
        return reply.notFound(req);

    try json.respondWith(ctx.gpa, req, .ok, pt.vo, &.{
        .{ .name = "cache-control", .value = "no-cache" },
    });
}

/// An extension the browser may render inline, and its `Content-Type`.
const InlineType = struct { ext: []const u8, mime: []const u8 };

/// The types `/file/{id}` may serve inline; everything else is `attachment`. This
/// is the endpoint's security boundary: device-authored bytes served same-origin,
/// so inline HTML or SVG would be stored XSS. `svg` is absent on purpose (it can
/// carry script). PDF opens in the browser's sandboxed viewer.
const inline_types = [_]InlineType{
    .{ .ext = "png", .mime = "image/png" },
    .{ .ext = "jpg", .mime = "image/jpeg" },
    .{ .ext = "jpeg", .mime = "image/jpeg" },
    .{ .ext = "webp", .mime = "image/webp" },
    .{ .ext = "gif", .mime = "image/gif" },
    .{ .ext = "pdf", .mime = "application/pdf" },
};

/// Matched on the name's extension alone, never contents; `nosniff` holds the label.
fn inlineTypeOf(name: []const u8) ?InlineType {
    const dot = std.mem.lastIndexOfScalar(u8, name, '.') orelse return null;
    if (dot == 0 or dot + 1 == name.len) return null;
    const ext = name[dot + 1 ..];
    for (inline_types) |t| {
        if (std.ascii.eqlIgnoreCase(ext, t.ext)) return t;
    }
    return null;
}

/// GET /file/{id}?v={md5}[&download=1] -> the file's raw stored bytes, for preview
/// and download alike (including `.note` downloads). Cookie-authed and owner-scoped:
/// a foreign id is a 404, not a 403, so it is no existence oracle. `?v=` must equal
/// the blob md5, which makes `immutable` honest. `manual_db_lock`: one lookup under
/// the lock, then a fixed-buffer stream bounded by `Content-Length`.
pub fn controlplaneFile(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return rawFile(ctx, req, params, .live);
}

/// GET /api/controlplane/bin/file/{id}?v={md5} -> the same raw bytes for a trashed
/// file.
pub fn controlplaneBinFile(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return rawFile(ctx, req, params, .trashed);
}

fn rawFile(ctx: *Context, req: *Request, params: Params, scope: controlplane.ControlPlaneService.ReadScope) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    // Capture query params BEFORE responding (responding invalidates head strings).
    const v = reply.queryParam(req.head.target, "v");
    const forced_download = if (reply.queryParam(req.head.target, "download")) |d|
        !std.mem.eql(u8, d, "0")
    else
        false;

    // The only DB touch. `rowToEntry` dupes `name` and `md5`, so `entry` is safe
    // after the unlock.
    var svc = controlplane.ControlPlaneService.init(files);
    const got = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        break :blk svc.lookup(scope, caller.user_id, id);
    };
    const entry = (got catch return serverError(ctx, req)) orelse return reply.notFound(req);
    defer ctx.gpa.free(entry.name);
    defer if (entry.md5) |m| ctx.gpa.free(m);
    if (entry.is_folder) return reply.notFound(req);
    const md5 = entry.md5 orelse return reply.notFound(req);
    if (md5.len != blobstore.md5_hex_len) return reply.notFound(req);
    if (v == null or !std.ascii.eqlIgnoreCase(v.?, md5)) return reply.notFound(req);

    return streamRawBlob(ctx, req, entry.name, md5, entry.size, forced_download);
}

/// Streams a resolved raw blob under the `/file/{id}` contract (inline allowlist,
/// `nosniff`, `?download=1`, ranges) with the lock released. The caller resolved
/// `name`, `md5` and `size` and checked ownership.
fn streamRawBlob(ctx: *Context, req: *Request, name: []const u8, md5: []const u8, size: u64, forced_download: bool) anyerror!void {
    const files = ctx.files orelse return serverError(ctx, req);
    if (md5.len != blobstore.md5_hex_len) return reply.notFound(req);

    const allowed = inlineTypeOf(name);
    const mime = if (allowed) |t| t.mime else "application/octet-stream";
    const disposition = if (allowed != null and !forced_download) "inline" else "attachment";

    var cd_buf: [1024]u8 = undefined;
    const cd = reply.contentDisposition(&cd_buf, disposition, name) catch
        return serverError(ctx, req);

    var etag_buf: [36]u8 = undefined;
    const etag = std.fmt.bufPrint(&etag_buf, "\"{s}\"", .{md5}) catch return serverError(ctx, req);

    // Range support, for the PDF viewer's windowed reads. Blobs are immutable and
    // content-addressed, so there is no `If-Range` to honour.
    var range_buf: [128]u8 = undefined;
    const want = byte_range.parse(router.headerCopy(req, "range", &range_buf), size);
    if (want == .unsatisfiable) {
        var cr_buf: [64]u8 = undefined;
        const cr = std.fmt.bufPrint(&cr_buf, "bytes */{d}", .{size}) catch return serverError(ctx, req);
        return req.respond("", .{
            .status = .range_not_satisfiable,
            .extra_headers = &.{
                .{ .name = "content-range", .value = cr },
                .{ .name = "accept-ranges", .value = "bytes" },
            },
        });
    }

    var file = files.blobs.open(md5) catch return reply.notFound(req);
    defer file.close(ctx.io);

    const off: u64 = switch (want) {
        .partial => |p| p.off,
        else => 0,
    };
    const len: u64 = switch (want) {
        .partial => |p| p.len,
        else => size,
    };

    // Built even when unused, because `extra_headers` needs a stable slice.
    var cr_buf: [80]u8 = undefined;
    const content_range = if (want == .partial)
        std.fmt.bufPrint(&cr_buf, "bytes {d}-{d}/{d}", .{ off, off + len - 1, size }) catch
            return serverError(ctx, req)
    else
        "";

    const common = [_]std.http.Header{
        .{ .name = "content-type", .value = mime },
        .{ .name = "content-disposition", .value = cd },
        // The label comes from the name and can be wrong; `nosniff` stops it being
        // sniffed into text/html.
        .{ .name = "x-content-type-options", .value = "nosniff" },
        .{ .name = "cache-control", .value = "public, max-age=31536000, immutable" },
        .{ .name = "etag", .value = etag },
        // On every reply, so a client learns it may ask.
        .{ .name = "accept-ranges", .value = "bytes" },
    };
    const partial_headers = common ++ [_]std.http.Header{.{ .name = "content-range", .value = content_range }};

    var wbuf: [blobstore.chunk_len]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .content_length = len,
        .respond_options = .{
            .status = if (want == .partial) .partial_content else .ok,
            .extra_headers = if (want == .partial) &partial_headers else &common,
        },
    }) catch return;

    // Head already sent: on failure return (closing short of `content_length`),
    // never `body.end()`, which would assert and panic.
    var rbuf: [blobstore.chunk_len]u8 = undefined;
    if (want == .partial) {
        var at: u64 = off;
        var left: u64 = len;
        while (left > 0) {
            const take: usize = @intCast(@min(left, @as(u64, rbuf.len)));
            const chunk = files.blobs.readRange(md5, at, take, rbuf[0..take]) catch return error.StreamTruncated;
            body.writer.writeAll(chunk) catch return error.StreamTruncated;
            at += take;
            left -= take;
        }
    } else {
        var fr = file.reader(ctx.io, &rbuf);
        fr.interface.streamExact64(&body.writer, size) catch return error.StreamTruncated;
    }
    body.end() catch {};
}

/// GET /thumbnail/{hash} -> the embedded thumbnail of blob `{hash}` (a `.spd`'s
/// `config.thumbnail` or a `.note`'s cover). 404 when there is none or the caller
/// does not hold the blob, indistinguishably. Heals on demand: if
/// `thumbNeedsRepair`, re-derive with the db lock released (lock order is
/// repair-mutex then db-lock, see `Files.thumb_repair`); the row memoizes "no
/// thumbnail" so a bad file is parsed once. Immutable, ETag = hash, `nosniff`.
pub fn controlplaneThumbnail(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const hash = params.get("hash") orelse return badRequest(ctx, req);

    // The only handler-held lock window: ownership and the repair gate.
    var svc = controlplane.ControlPlaneService.init(files);
    const gate: struct { allowed: bool, repair: bool } = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        const allowed = svc.thumbnailAllowed(caller.user_id, hash) catch
            break :blk .{ .allowed = false, .repair = false };
        if (!allowed) break :blk .{ .allowed = false, .repair = false };
        break :blk .{ .allowed = true, .repair = files.thumbNeedsRepair(hash) };
    };
    if (!gate.allowed) return reply.notFound(req);

    // Best-effort; a failed repair just 404s below.
    if (gate.repair) files.repairDerivedThumb(ctx, hash);

    // A `.note` cover streams from the blob itself; a `.spd` thumbnail from `thumbs/`.
    switch (files.thumbnailSourceKind(hash)) {
        .note => return streamNoteCover(ctx, req, files, hash),
        .spd => {}, // the stored-thumbnail path below
        .none => return reply.notFound(req),
    }

    var file = files.thumbs.open(hash) catch return reply.notFound(req);
    defer file.close(ctx.io);
    const size = (file.stat(ctx.io) catch return reply.notFound(req)).size;
    if (size == 0) return reply.notFound(req); // defensive: a torn file must not serve

    // Ingest only wrote bytes that pass `sniffMime`, so a failure here is corruption.
    var magic: [16]u8 = undefined;
    const head_len: usize = @intCast(@min(size, magic.len));
    const got = file.readPositionalAll(ctx.io, magic[0..head_len], 0) catch return reply.notFound(req);
    if (got != head_len) return reply.notFound(req);
    const mime = thumbnailmod.sniffMime(magic[0..head_len]) orelse return reply.notFound(req);

    // `hash` is 32 hex here (the ownership check passed), so the ETag fits.
    var etag_buf: [36]u8 = undefined;
    const etag = std.fmt.bufPrint(&etag_buf, "\"{s}\"", .{hash}) catch return serverError(ctx, req);

    var wbuf: [blobstore.chunk_len]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .content_length = size,
        .respond_options = .{
            .extra_headers = &.{
                .{ .name = "content-type", .value = mime },
                .{ .name = "x-content-type-options", .value = "nosniff" },
                .{ .name = "cache-control", .value = "public, max-age=31536000, immutable" },
                .{ .name = "etag", .value = etag },
            },
        },
    }) catch return;

    // On failure return short of `content_length`, never `body.end()` (see `rawFile`).
    var rbuf: [blobstore.chunk_len]u8 = undefined;
    var fr = file.reader(ctx.io, &rbuf);
    fr.interface.streamExact64(&body.writer, size) catch return error.StreamTruncated;
    body.end() catch {};
}

/// Streams a `.note` cover from the immutable blob at the index-recorded range, a
/// chunk at a time; 404 when the note has none.
fn streamNoteCover(ctx: *Context, req: *Request, files: *filesvc.Files, hash: []const u8) anyerror!void {
    const loc = (files.noteCover(hash) catch return reply.notFound(req)) orelse return reply.notFound(req);
    // The cover's own hash is its blob key.
    return streamBlobRange(ctx, req, files, hash, hash, loc.offset, loc.length, loc.mime());
}

/// Stream a byte range of an immutable blob under the thumbnail/template contract.
/// `etag_hash` equals `blob_key` for a cover but is the URL's `PAGESTYLEMD5` for a
/// template. `readRange` re-validates each window against the real blob size,
/// since the range came from device metadata. On failure return short of
/// `content_length`; `end()` runs only on a full stream.
fn streamBlobRange(
    ctx: *Context,
    req: *Request,
    files: *filesvc.Files,
    blob_key: []const u8,
    etag_hash: []const u8,
    offset: u64,
    length: u64,
    mime: []const u8,
) anyerror!void {
    // `max_template_hash_len` (64) also fits a cover's 32-hex hash.
    var etag_buf: [controlplane.max_template_hash_len + 2]u8 = undefined;
    const etag = std.fmt.bufPrint(&etag_buf, "\"{s}\"", .{etag_hash}) catch return serverError(ctx, req);

    var wbuf: [blobstore.chunk_len]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .content_length = length,
        .respond_options = .{
            .extra_headers = &.{
                .{ .name = "content-type", .value = mime },
                .{ .name = "x-content-type-options", .value = "nosniff" },
                .{ .name = "cache-control", .value = "public, max-age=31536000, immutable" },
                .{ .name = "etag", .value = etag },
            },
        },
    }) catch return;

    var rbuf: [blobstore.chunk_len]u8 = undefined;
    var off: u64 = offset;
    var left: u64 = length;
    while (left > 0) {
        const take: usize = @intCast(@min(left, @as(u64, rbuf.len)));
        const chunk = files.blobs.readRange(blob_key, off, take, rbuf[0..take]) catch return error.StreamTruncated;
        body.writer.writeAll(chunk) catch return error.StreamTruncated;
        off += take;
        left -= take;
    }
    body.end() catch {};
}

/// GET /note/{id}/template/{hash} -> the page's custom image template, streamed from
/// the blob. Note-scoped, content-addressed (immutable, ETag = hash),
/// `manual_db_lock`, and no `.note` parse: the range is read from the page's
/// recorded `layers`. 404 for anything unowned, absent or over the size cap.
pub fn controlplaneTemplate(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const hash = params.get("hash") orelse return badRequest(ctx, req);
    // A template hash is PAGESTYLEMD5; an implausible length is a 404.
    if (hash.len == 0 or hash.len > controlplane.max_template_hash_len) return reply.notFound(req);

    var svc = controlplane.ControlPlaneService.init(files);

    // The only DB touches; the plan has no borrow of statement memory.
    const planned = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        const entry = (svc.lookup(.live, caller.user_id, id) catch return serverError(ctx, req)) orelse
            break :blk null;
        defer ctx.gpa.free(entry.name);
        defer if (entry.md5) |m| ctx.gpa.free(m);
        break :blk svc.templatePlanOf(entry, hash) catch return serverError(ctx, req);
    } orelse return reply.notFound(req);

    return streamNoteTemplate(ctx, req, files, planned, hash);
}

/// Streams a resolved template's range, MIME sniffed from its own bytes, capped at
/// `thumbnail.max_cover_bytes`.
fn streamNoteTemplate(
    ctx: *Context,
    req: *Request,
    files: *filesvc.Files,
    plan: controlplane.TemplatePlan,
    hash: []const u8,
) anyerror!void {
    // The cover's 20 MB cap (Ratta removed the device-side limit).
    if (plan.length == 0 or plan.length > thumbnailmod.max_cover_bytes) return reply.notFound(req);

    var magic: [16]u8 = undefined;
    const head_len: usize = @intCast(@min(plan.length, @as(u64, magic.len)));
    const got = files.blobs.readRange(&plan.md5, plan.offset, head_len, magic[0..head_len]) catch
        return reply.notFound(req);
    const mime = thumbnailmod.sniffMime(got) orelse return reply.notFound(req);

    // The blob key is the plan's md5; the ETag uses the URL's `PAGESTYLEMD5`.
    return streamBlobRange(ctx, req, files, &plan.md5, hash, plan.offset, plan.length, mime);
}

/// GET /note/{id}/page/{n}/text?v={textHash} -> one page's on-device OCR transcript,
/// versioned by the md5 of its `RECOGNTEXT` block. `no-cache`, not `immutable`:
/// `?v=` covers the content, not the JSON shape, and an immutable cache once froze
/// the pre-`words` shape for a year. 404 means "refetch metadata" (no such page,
/// stale `?v=`, or no recognition). The text is device-authored; the client sets
/// it via `textContent`.
pub fn controlplanePageText(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const n = std.fmt.parseInt(u64, params.get("n") orelse return badRequest(ctx, req), 10) catch
        return badRequest(ctx, req);
    // Capture `?v=` before responding (responding invalidates the head strings).
    const v = reply.queryParam(req.head.target, "v");

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);

    const pt = (svc.pageText(arena.allocator(), caller.user_id, id, n) catch return serverError(ctx, req)) orelse
        return reply.notFound(req);
    if (v == null or !std.ascii.eqlIgnoreCase(v.?, &pt.hash)) return reply.notFound(req);

    // Not `immutable`: `?v=` versions the transcript, not the JSON shape.
    try json.respondWith(ctx.gpa, req, .ok, pt.vo, &.{
        .{ .name = "cache-control", .value = "no-cache" },
    });
}

/// GET /note/{id}/page/{n}/links?v={linksHash} -> the links a PDF template brought
/// to this page. Same contract as the text route: versioned by the md5 of
/// `EXTERNALLINKINFO`, `no-cache`, 404 means stale. Decoded per request from one
/// ranged read. The scheme allowlist (`allowedLinkScheme`) runs here too, because
/// the PDF exporter reads this endpoint.
pub fn controlplanePageLinks(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const n = std.fmt.parseInt(u64, params.get("n") orelse return badRequest(ctx, req), 10) catch
        return badRequest(ctx, req);
    // Capture `?v=` before responding (responding invalidates the head strings).
    const v = reply.queryParam(req.head.target, "v");

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);

    const pl = (svc.pageLinks(arena.allocator(), caller.user_id, id, n) catch return serverError(ctx, req)) orelse
        return reply.notFound(req);
    if (v == null or !std.ascii.eqlIgnoreCase(v.?, &pl.hash)) return reply.notFound(req);

    try json.respondWith(ctx.gpa, req, .ok, pl.vo, &.{
        .{ .name = "cache-control", .value = "no-cache" },
    });
}

/// `x-accel-buffering: no` matters: a buffering reverse proxy would hold back a
/// stream that emits ~20 bytes a minute indefinitely.
const sse_headers = [_]std.http.Header{
    .{ .name = "content-type", .value = "text/event-stream" },
    .{ .name = "cache-control", .value = "no-store" },
    .{ .name = "x-content-type-options", .value = "nosniff" },
    .{ .name = "x-accel-buffering", .value = "no" },
};

/// The `event: index` frame: how much of the library is still being derived, and a
/// version that moves when a derive lands. One frame serves both the UI's
/// "N still indexing" and a client index's "re-sync".
fn writeIndexFrame(w: *std.Io.Writer, snap: pendingsvc.Snapshot) !void {
    try w.print("event: index\ndata: {{\"pending\":{d},\"version\":{d}}}\n\n", .{ snap.pending, snap.version });
}

/// The caller's index state, or null with no `Pulse`. Must not be called under
/// `lockDb`: `Pulse` takes `db_lock` itself and the mutex is non-reentrant.
fn indexSnapshot(ctx: *Context, user_id: u64) ?pendingsvc.Snapshot {
    const pulse = ctx.pending orelse return null;
    return pulse.forUser(user_id);
}

// ---- the client-side search index ----
//
// HTTP shells over `services/search/index_export.zig`. Both bodies are binary, not
// JSON: md5s dominate the payload and do not compress, and API responses are not
// content-encoded.

/// GET /api/controlplane/search-index/manifest -> the caller's complete live
/// document set (`SMAN`). `private, no-cache` with an ETag hashed from the body
/// (`index_export.bodyEtag`), so an unchanged library costs a 304 and the client
/// may refetch on every visit.
pub fn controlplaneSearchIndexManifest(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);

    // Read the header before responding; responding invalidates head strings.
    var inm_buf: [64]u8 = undefined;
    const if_none_match = router.headerCopy(req, "if-none-match", &inm_buf);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();

    const m = index_export.manifest(a, files.db, caller.user_id, files.terms) catch return serverError(ctx, req);
    var body: std.ArrayList(u8) = .empty;
    index_export.writeManifest(a, &body, m) catch return serverError(ctx, req);

    var etag_buf: [34]u8 = undefined;
    const hex = index_export.bodyEtag(body.items);
    const etag = std.fmt.bufPrint(&etag_buf, "\"{s}\"", .{hex}) catch return serverError(ctx, req);

    // The ETag rides on the 304 too, so the client keeps the validator.
    const headers = [_]std.http.Header{
        .{ .name = "content-type", .value = "application/octet-stream" },
        .{ .name = "cache-control", .value = "private, no-cache" },
        .{ .name = "etag", .value = etag },
        .{ .name = "x-content-type-options", .value = "nosniff" },
    };

    // Byte equality: this server mints exactly one form of this validator.
    if (std.mem.eql(u8, if_none_match, etag)) {
        return req.respond("", .{ .status = .not_modified, .extra_headers = &headers });
    }
    try req.respond(body.items, .{ .status = .ok, .extra_headers = &headers });
}

// ---- the stitched stream ----

/// The manifest as one request sees it: rows in order, and the body's ETag.
const ManifestGate = struct {
    rows: []const index_export.Row,
    etag: [32]u8,
};

/// Re-run the manifest query and hash what it would serialize to. The bytes come
/// from `gpa` and are freed here; the rows live in the request arena.
fn manifestGate(
    arena: std.mem.Allocator,
    gpa: std.mem.Allocator,
    db: sqlite.Db,
    user_id: u64,
    terms: ?derived.DerivedStore,
) !ManifestGate {
    // Must be the same store the manifest route passes, or the ETags differ.
    const m = try index_export.manifest(arena, db, user_id, terms);
    var body: std.ArrayList(u8) = .empty;
    defer body.deinit(gpa);
    try index_export.writeManifest(gpa, &body, m);
    return .{ .rows = m.rows, .etag = index_export.bodyEtag(body.items) };
}

/// GET /api/controlplane/search-index/stream?m=<manifest etag>&want=<base64url>
/// -> the wanted documents' terms as one gzip stream stitched from stored
/// raw-deflate fragments (`http/gzip_stitch.zig`). Not concatenated gzip members:
/// browsers decode only the first member and report success. Always
/// `Content-Encoding: gzip`, since no identity form exists. Chunked, because a
/// fragment GC'd mid-walk would break a promised `Content-Length`.
/// `manual_db_lock`, not `read_only`: the reader is borrowed only around the
/// manifest query, so a slow download never parks a pooled reader or the writer.
pub fn controlplaneSearchIndexStream(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    // No terms store: an empty-but-valid stream would make the client record
    // every document as arrived and stop asking.
    const terms = files.terms orelse return serverError(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();

    // Copy the params: the walk reads them after the response head has gone out.
    const m_param = a.dupe(u8, reply.queryParam(req.head.target, "m") orelse return badRequest(ctx, req)) catch
        return serverError(ctx, req);
    // An absent `want` is the empty set, not an error.
    const want_param = a.dupe(u8, reply.queryParam(req.head.target, "want") orelse "") catch
        return serverError(ctx, req);

    // The ETag gate runs before the bitmap is parsed: positions mean nothing
    // until we know the manifest ordering they index.
    const gate = blk: {
        if (ctx.borrowReader()) |lease| {
            defer ctx.returnReader(lease);
            break :blk manifestGate(a, ctx.gpa, lease.db, caller.user_id, files.terms) catch
                return serverError(ctx, req);
        }
        ctx.lockDb();
        defer ctx.unlockDb();
        break :blk manifestGate(a, ctx.gpa, files.db, caller.user_id, files.terms) catch
            return serverError(ctx, req);
    };

    // The bare hex, not the quoted entity-tag; byte equality.
    if (!std.mem.eql(u8, m_param, &gate.etag)) {
        return fail(ctx, req, .precondition_failed, "MANIFEST_MOVED", "manifest changed; refetch it");
    }

    const want = wantbitmap.parse(want_param, gate.rows.len) catch |err| switch (err) {
        // No encoder of ours produces this; refetching would not help.
        error.MalformedWant => return badRequest(ctx, req),
        // The ordering disagrees despite the ETag matching; treat as moved.
        error.WantLongerThanManifest, error.WantBitPastManifest => return fail(
            ctx,
            req,
            .precondition_failed,
            "MANIFEST_MOVED",
            "want bitmap does not fit this manifest",
        ),
    };

    const headers = [_]std.http.Header{
        // The decoded body is JSONL, one document per fragment.
        .{ .name = "content-type", .value = "application/x-ndjson" },
        .{ .name = "content-encoding", .value = "gzip" },
        // `no-store`: a document still deriving on the first request may arrive by
        // the second, and a cached copy would hide it.
        .{ .name = "cache-control", .value = "private, no-store" },
        .{ .name = "x-content-type-options", .value = "nosniff" },
    };

    // Two 16 KB buffers are the whole per-request cost besides the manifest arena.
    var wbuf: [16 * 1024]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .respond_options = .{ .extra_headers = &headers },
    }) catch return;

    // Head already sent: a mid-fragment failure returns without `end()`, so
    // decoders see a truncated gzip (loud) rather than a quietly short stream.
    var rbuf: [16 * 1024]u8 = undefined;
    _ = indexstream.write(ctx.io, terms, gate.rows, want, &body.writer, &rbuf) catch
        return error.StreamTruncated;
    body.end() catch {};
}

/// The degraded shape of `/api/controlplane/events`: one `event: sync` frame (plus
/// `event: index` when available), then close. `EventSource` reconnects after
/// `retry:`, so an over-cap or non-serve-mode caller becomes a correct poller.
fn eventsOneShot(ctx: *Context, req: *Request, sync_version: i64, index: ?pendingsvc.Snapshot) anyerror!void {
    var buf: [192]u8 = undefined;
    var w = std.Io.Writer.fixed(&buf);
    w.print("retry: {d}\nevent: sync\ndata: {d}\n\n", .{ eventstreams.retry_ms, sync_version }) catch
        return serverError(ctx, req);
    if (index) |snap| writeIndexFrame(&w, snap) catch return serverError(ctx, req);
    try req.respond(w.buffered(), .{
        .keep_alive = false,
        .extra_headers = &sse_headers,
    });
}

// ---- the per-document text route ----

/// GET /api/controlplane/text/{md5} -> one document's `text/{md5}.{v}` record as a
/// gzip stream (header line plus one line per segment), for in-document search of
/// every kind. Gated by `Files.reachesBlob` (live, trashed or retained version);
/// unreachable and underived are one 404, so no existence oracle. The stored
/// raw-deflate fragment is wrapped verbatim in a gzip header and trailer.
/// Unlike the stitched stream this sends `Content-Length`: one open fd cannot be
/// shortened by GC (the store publishes by rename), and it avoids a Zig 0.16
/// `chunkedSendFile` panic (see `index_stream.zig`). Caching: `private, immutable`
/// with no `max-age` unless `?v=` names the current `index_version`, because a
/// parser bump re-derives the same md5. `manual_db_lock` with a borrowed reader,
/// as in the stitched stream.
pub fn controlplaneDocumentText(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const md5 = params.get("md5") orelse return badRequest(ctx, req);

    // No text store: a 404 ("nothing to load") is the truth here, unlike the
    // stream route's missing terms store.
    const text = files.text orelse return reply.notFound(req);

    const reachable = blk: {
        if (ctx.borrowReader()) |lease| {
            defer ctx.returnReader(lease);
            const ro = files.readerView(lease.db);
            break :blk ro.reachesBlob(caller.user_id, md5) catch return serverError(ctx, req);
        }
        ctx.lockDb();
        defer ctx.unlockDb();
        break :blk files.reachesBlob(caller.user_id, md5) catch return serverError(ctx, req);
    };
    if (!reachable) return reply.notFound(req);

    // The DB is done. Each failure below is a 404 indistinguishable from the gate.
    var file = text.open(md5, derivesearch.index_version) catch return reply.notFound(req);
    defer file.close(ctx.io);
    const size = (file.stat(ctx.io) catch return reply.notFound(req)).size;
    // Also the format check: a truncated or foreign file is refused, not streamed.
    const h = derived.readHeader(ctx.io, file) catch return reply.notFound(req);
    if (size <= derived.header_len) return reply.notFound(req); // a header and no fragment

    // `?v=` carries the `index_version`, the other half of the store key. Only when
    // it matches does the response get a year's `max-age`.
    var vbuf: [24]u8 = undefined;
    const named = if (reply.queryParam(req.head.target, "v")) |v|
        std.mem.eql(u8, v, std.fmt.bufPrint(&vbuf, "{d}", .{derivesearch.index_version}) catch "")
    else
        false;

    var trailer: gzip_stitch.Trailer = .{};
    trailer.append(h.crc, h.len);

    // Gzip header, the fragment past the stored 12-byte header, terminator, trailer.
    const content_length = gzip_stitch.header.len +
        (size - derived.header_len) +
        gzip_stitch.terminator.len + 8;

    var wbuf: [16 * 1024]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .content_length = content_length,
        .respond_options = .{
            .extra_headers = &.{
                .{ .name = "content-type", .value = "application/x-ndjson" },
                .{ .name = "content-encoding", .value = "gzip" },
                .{ .name = "cache-control", .value = if (named) "private, max-age=31536000, immutable" else "private, immutable" },
                .{ .name = "x-content-type-options", .value = "nosniff" },
            },
        },
    }) catch return;

    // Head sent: on failure return short of `content_length`, never `end()`.
    body.writer.writeAll(gzip_stitch.header) catch return error.StreamTruncated;

    // Positional reads into one buffer, bounded by `size`.
    var rbuf: [16 * 1024]u8 = undefined;
    var off: u64 = derived.header_len;
    while (off < size) {
        const want: usize = @intCast(@min(rbuf.len, size - off));
        const n = file.readPositionalAll(ctx.io, rbuf[0..want], off) catch return error.StreamTruncated;
        if (n == 0) return error.StreamTruncated; // the file ended short of its own stat
        body.writer.writeAll(rbuf[0..n]) catch return error.StreamTruncated;
        off += n;
    }

    trailer.finish(&body.writer) catch return error.StreamTruncated;
    body.end() catch {};
}

/// GET /api/controlplane/events -> the live-freshness SSE channel: `syncVersion`
/// pushed on change over a held connection. Without `ctx.event_streams` (the test
/// harness) it answers one-shot. `manual_db_lock` is mandatory: the default lock
/// held for a minutes-long stream would stall device sync. Each tick takes the lock
/// only around `files.syncVersion`; `indexSnapshot` runs outside every bracket.
/// A `: ping` every `heartbeat_ms` surfaces dead peers as write errors.
pub fn controlplaneEvents(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);

    // The only DB touch before the head is sent.
    const initial: i64 = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        break :blk files.syncVersion(caller.user_id) catch 0;
    };

    // Outside the bracket above: `Pulse` takes `db_lock` itself.
    const initial_index = indexSnapshot(ctx, caller.user_id);

    const streams = ctx.event_streams orelse return eventsOneShot(ctx, req, initial, initial_index);
    if (!streams.tryAcquire(ctx.io, caller.user_id)) return eventsOneShot(ctx, req, initial, initial_index);
    // One release per successful acquire, on every path out.
    defer streams.release(ctx.io, caller.user_id);

    // No `content_length` -> chunked. Write failures end the stream; `EventSource`
    // reconnects.
    var wbuf: [256]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .respond_options = .{ .keep_alive = false, .extra_headers = &sse_headers },
    }) catch return;

    body.writer.print("retry: {d}\nevent: sync\ndata: {d}\n\n", .{ eventstreams.retry_ms, initial }) catch return;
    if (initial_index) |snap| writeIndexFrame(&body.writer, snap) catch return;
    body.flush() catch return;

    var last = initial;
    var last_index = initial_index;
    var since_write_ms: i64 = 0;
    var lived_ms: i64 = 0;

    while (lived_ms < streams.max_lifetime_ms) {
        // Unlocked wait. Cancellation (shutdown) ends the stream cleanly.
        ctx.io.sleep(.fromMilliseconds(streams.poll_interval_ms), .awake) catch break; // .awake = CLOCK_MONOTONIC
        lived_ms += streams.poll_interval_ms;
        since_write_ms += streams.poll_interval_ms;

        // Narrow bracket each tick. A read error counts as "no change", so a
        // transient failure never fabricates a refetch.
        const current: i64 = blk: {
            ctx.lockDb();
            defer ctx.unlockDb();
            break :blk files.syncVersion(caller.user_id) catch last;
        };

        // Outside the lock, as above.
        const index_now = indexSnapshot(ctx, caller.user_id);

        var wrote = false;
        if (current != last) {
            last = current;
            body.writer.print("event: sync\ndata: {d}\n\n", .{current}) catch break;
            wrote = true;
        }
        // On change only, like `event: sync`.
        if (index_now) |now| {
            const moved = last_index == null or
                now.pending != last_index.?.pending or now.version != last_index.?.version;
            if (moved) {
                last_index = now;
                writeIndexFrame(&body.writer, now) catch break;
                wrote = true;
            }
        }
        if (wrote) {
            since_write_ms = 0;
            body.flush() catch break;
        } else if (since_write_ms >= streams.heartbeat_ms) {
            since_write_ms = 0;
            // `EventSource` ignores comments; the bytes surface a dead peer.
            body.writer.writeAll(": ping\n\n") catch break;
            body.flush() catch break;
        }
    }

    body.end() catch {};
}
