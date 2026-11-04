//! The backup notice and the admin backups panel over HTTP: who hears what,
//! and when.

const std = @import("std");
const testing = std.testing;
const gpa = testing.allocator;
const harness = @import("harness.zig");
const backupstatus = @import("../../services/backup/status.zig");
const onboardWeb = harness.onboardWeb;
const elevate = harness.elevate;
const Fixture = harness.Fixture;
const requestWithCookie = harness.requestWithCookie;
const expectFailure = harness.expectFailure;

const Notice = struct { kind: []const u8, dir: ?[]const u8 = null, at: ?i64 = null, message: ?[]const u8 = null };

fn notice(ctx: anytype, tok: []const u8) !std.json.Parsed(Notice) {
    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/backup-notice", tok, "");
    try testing.expectEqual(@as(u16, 200), resp.status);
    return std.json.parseFromSlice(Notice, gpa, resp.body, .{ .ignore_unknown_fields = true });
}

fn expectKind(ctx: anytype, tok: []const u8, kind: []const u8) !void {
    var n = try notice(ctx, tok);
    defer n.deinit();
    try testing.expectEqualStrings(kind, n.value.kind);
}

fn now() i64 {
    return std.Io.Clock.real.now(testing.io).toSeconds();
}

test "an admin hears about backups in the library: none yet, dismissed, failed, late" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    _ = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    // No elevation needed for the library's notice.
    try expectKind(ctx, &tok, "never");

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &tok);
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "PUT", "/api/admin/backups/dismissed", &tok, "{\"dismissed\":true}");
        try testing.expectEqual(@as(u16, 200), resp.status);
    }
    try expectKind(ctx, &tok, "none");

    // A failing run shows even though "no backup yet" was dismissed.
    try backupstatus.recordCreate(f.db, "/mnt/nas", now(), .{ .failed = "No backup directory at: /mnt/nas" });
    {
        var n = try notice(ctx, &tok);
        defer n.deinit();
        try testing.expectEqualStrings("failed", n.value.kind);
        try testing.expectEqualStrings("/mnt/nas", n.value.dir.?);
        try testing.expectEqualStrings("No backup directory at: /mnt/nas", n.value.message.?);
    }

    // It works again, but three days ago: late.
    try backupstatus.recordCreate(f.db, "/mnt/nas", now() - 3 * 86400, .{ .ok = .{ .snapshot = "2026-11-01T030000Z", .blobs = 3, .bytes = 30 } });
    try expectKind(ctx, &tok, "late");

    // The panel lists the record, and forgetting the directory silences it.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/backups", &tok, "");
        try testing.expectEqual(@as(u16, 200), resp.status);
        var parsed = try std.json.parseFromSlice(struct {
            warnAfterHours: u32,
            neverDismissed: bool,
            notice: Notice,
            runs: []struct { dir: []const u8, snapshot: ?[]const u8 = null, lastError: ?[]const u8 = null },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer parsed.deinit();
        try testing.expectEqual(@as(u32, 48), parsed.value.warnAfterHours);
        try testing.expect(parsed.value.neverDismissed);
        try testing.expectEqualStrings("late", parsed.value.notice.kind);
        try testing.expectEqual(@as(usize, 1), parsed.value.runs.len);
        try testing.expectEqualStrings("2026-11-01T030000Z", parsed.value.runs[0].snapshot.?);
        try testing.expect(parsed.value.runs[0].lastError == null);
    }
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/backups/forget", &tok, "{\"dir\":\"/mnt/nas\"}");
        try testing.expectEqual(@as(u16, 200), resp.status);
        const again = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/backups/forget", &tok, "{\"dir\":\"/mnt/nas\"}");
        try expectFailure(again.body, "NO_SUCH_BACKUP_DIR");
    }
    try expectKind(ctx, &tok, "none"); // forgotten, and "never" stays dismissed
}

test "only an admin hears about backups, and only an elevated one opens the panel" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin_id = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const bob = try f.svc.createUser(admin_id, "bob", false);
    const bob_tok = try onboardWeb(ctx, "bob", bob.temp_password.slice(), "bobpw123");
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    try backupstatus.recordCreate(f.db, "/mnt/nas", now(), .{ .failed = "disk full" });

    try expectKind(ctx, &bob_tok, "none");
    try expectKind(ctx, &admin_tok, "failed");

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const as_bob = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/backups", &bob_tok, "");
    try testing.expectEqual(@as(u16, 403), as_bob.status);
    const unelevated = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/backups", &admin_tok, "");
    try testing.expectEqual(@as(u16, 428), unelevated.status);
}
