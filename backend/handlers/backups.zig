//! The backup notice and its admin panel: what `inkhold backup` last did, as
//! recorded in `backup_runs` and judged by `services/backup/status.zig`.
//!
//! `GET /api/backup-notice` is for the library: any signed-in caller may ask,
//! but only an admin gets an answer other than `none` (admins only, and no
//! elevation needed, or the warning would hide behind a password prompt). The
//! `/api/admin/backups` routes are the Server panel's detail, under
//! `require_admin` like every other admin route.

const std = @import("std");
const router = @import("../http/router.zig");
const context = @import("../http/context.zig");
const json = @import("../http/json.zig");
const reply = @import("../http/reply.zig");
const backupstatus = @import("../services/backup/status.zig");
const settingsmod = @import("../services/settings.zig");
const clock = @import("../util/clock.zig");

const Context = context.Context;
const Request = router.Request;
const Params = router.Params;
const fail = reply.fail;
const badRequest = reply.badRequest;
const serverError = reply.serverError;

// ---- bodies ----

const NoticeVO = struct {
    success: bool = true,
    /// `none`, `never`, `late` or `failed`.
    kind: []const u8,
    dir: ?[]const u8 = null,
    /// Epoch seconds: when it failed, or the newest success (`late`).
    at: ?i64 = null,
    message: ?[]const u8 = null,
};

const RunVO = struct {
    dir: []const u8,
    lastRunAt: ?i64,
    lastOkAt: ?i64,
    lastError: ?[]const u8,
    snapshot: ?[]const u8,
    files: ?i64,
    bytes: ?i64,
    verifiedAt: ?i64,
    verifyError: ?[]const u8,
};

const BackupsVO = struct {
    success: bool = true,
    warnAfterHours: u32,
    neverDismissed: bool,
    notice: NoticeVO,
    runs: []const RunVO,
};

const DismissReq = struct { dismissed: bool };
const ForgetReq = struct { dir: []const u8 };

// ---- handlers ----

/// GET /api/backup-notice. `none` for anyone but an admin.
pub fn notice(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?;
    if (!caller.is_admin) return json.respond(ctx.gpa, req, .ok, NoticeVO{ .kind = "none" }, null);

    var runs = backupstatus.list(ctx.gpa, ctx.db) catch return serverError(ctx, req);
    defer runs.deinit();
    const dismissed = settingsmod.Settings.init(ctx.io, ctx.db).backupNeverDismissed() catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, noticeVO(judge(ctx, runs.items, dismissed)), null);
}

/// GET /api/admin/backups: every directory's record, and the notice.
pub fn list(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    try respondBackups(ctx, req);
}

/// PUT /api/admin/backups/dismissed: "I back up another way", or take it back.
pub fn setDismissed(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    var parsed = json.readBody(DismissReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    settingsmod.Settings.init(ctx.io, ctx.db).setBackupNeverDismissed(parsed.value.dismissed) catch return serverError(ctx, req);
    try respondBackups(ctx, req);
}

/// POST /api/admin/backups/forget: drops a destination no longer in use, so
/// its last failure stops warning.
pub fn forget(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    var parsed = json.readBody(ForgetReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const gone = backupstatus.forget(ctx.db, parsed.value.dir) catch return serverError(ctx, req);
    if (!gone) return fail(ctx, req, .not_found, "NO_SUCH_BACKUP_DIR", "no backup has been recorded for that directory");
    try respondBackups(ctx, req);
}

// ---- shared ----

fn judge(ctx: *Context, runs: []const backupstatus.Run, dismissed: bool) backupstatus.Notice {
    const warn_s = @as(i64, ctx.config.backup_warn_after_hours) * 3600;
    return backupstatus.assess(runs, clock.nowSeconds(ctx.io), warn_s, dismissed);
}

fn noticeVO(n: backupstatus.Notice) NoticeVO {
    return .{ .kind = @tagName(n.kind), .dir = n.dir, .at = n.at, .message = n.message };
}

fn respondBackups(ctx: *Context, req: *Request) !void {
    var runs = backupstatus.list(ctx.gpa, ctx.db) catch return serverError(ctx, req);
    defer runs.deinit();
    const dismissed = settingsmod.Settings.init(ctx.io, ctx.db).backupNeverDismissed() catch return serverError(ctx, req);

    const vos = try ctx.gpa.alloc(RunVO, runs.items.len);
    defer ctx.gpa.free(vos);
    for (runs.items, vos) |r, *v| v.* = .{
        .dir = r.dir,
        .lastRunAt = r.last_run_at,
        .lastOkAt = r.last_ok_at,
        .lastError = r.last_error,
        .snapshot = r.snapshot,
        .files = r.blobs,
        .bytes = r.bytes,
        .verifiedAt = r.verified_at,
        .verifyError = r.verify_error,
    };
    try json.respond(ctx.gpa, req, .ok, BackupsVO{
        .warnAfterHours = ctx.config.backup_warn_after_hours,
        .neverDismissed = dismissed,
        .notice = noticeVO(judge(ctx, runs.items, dismissed)),
        .runs = vos,
    }, null);
}
