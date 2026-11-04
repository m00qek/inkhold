//! Household administration over HTTP: users, devices, quota, retention.

const std = @import("std");
const app = @import("../../routes.zig");
const password = @import("../../services/auth/password.zig");
const filesmod = @import("../../services/files.zig");
const blobstore = @import("../../store/blobs.zig");
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const onboardWeb = harness.onboardWeb;
const elevate = harness.elevate;
const Fixture = harness.Fixture;
const countRows = harness.countRows;
const putSeed = harness.putSeed;
const usedBytes = harness.usedBytes;
const requestWithCookie = harness.requestWithCookie;
const expectStatusWithCookie = harness.expectStatusWithCookie;
const expectFailure = harness.expectFailure;

test "admin manages household users over HTTP; non-admins are forbidden (require_admin)" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    _ = try f.svc.bootstrapAdmin("admin", "admtemp00"); // is_admin, must_change

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    const admin_tok = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");
    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &admin_tok);

    var bob_id: u64 = undefined;
    var bob_temp_buf: [password.max_temp_len]u8 = undefined;
    var bob_temp_len: usize = 0;
    {
        const body = "{\"email\":\"bob\"}";
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/users", &admin_tok, body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var parsed = try std.json.parseFromSlice(
            struct { userId: u64, temporaryPassword: []const u8 },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        bob_id = parsed.value.userId;
        try std.testing.expect(parsed.value.temporaryPassword.len > 0 and parsed.value.temporaryPassword.len <= password.max_temp_len);
        bob_temp_len = parsed.value.temporaryPassword.len;
        @memcpy(bob_temp_buf[0..bob_temp_len], parsed.value.temporaryPassword);

        const dup = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/admin/users", &admin_tok, body);
        try expectFailure(dup.body, "EMAIL_EXISTS");
    }

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var parsed = try std.json.parseFromSlice(
            struct { users: []struct { email: []const u8 } },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        try std.testing.expectEqual(@as(usize, 2), parsed.value.users.len);
    }

    // A non-admin gets a plain 403 on admin routes, never the elevation gate.
    const bob_temp = bob_temp_buf[0..bob_temp_len];
    const bob_tok = try onboardWeb(ctx, "bob", bob_temp, "bobpw123");
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &bob_tok, "", 403);

    {
        var pbuf: [64]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}/reset", .{bob_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var parsed = try std.json.parseFromSlice(
            struct { temporaryPassword: []const u8 },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        try std.testing.expect(parsed.value.temporaryPassword.len > 0 and parsed.value.temporaryPassword.len <= password.max_temp_len);
        try std.testing.expect(!std.mem.eql(u8, bob_temp, parsed.value.temporaryPassword)); // a fresh one
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &bob_tok, "", 401);

    {
        var pbuf: [64]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}", .{bob_id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users", &admin_tok, "");
        var parsed = try std.json.parseFromSlice(
            struct { users: []struct { email: []const u8 } },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        try std.testing.expectEqual(@as(usize, 1), parsed.value.users.len); // only admin remains
    }
}

test "admin devices + quota over HTTP: the gate, the 403, and the cross-user unlink that must not land" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp0");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    const bob = (try f.svc.createUser(admin, "bob", false)).id;
    try f.svc.bindDevice(alice, "SN-ALICE-1", "Alice's Nomad");
    try f.svc.bindDevice(bob, "SN-BOB-1", "Bob's Manta");

    var obuf: [8192]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    // One buffer per path: these are held across later requests.
    var devbuf: [96]u8 = undefined;
    var quotabuf: [96]u8 = undefined;
    var pbuf: [96]u8 = undefined;

    const devices_path = try std.fmt.bufPrint(&devbuf, "/api/admin/users/{d}/devices", .{alice});
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp0", "adminpw1");

    // Unelevated admin gets 428, never 401 (which would sign them out).
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", devices_path, &admin_tok, "", 428);
    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &admin_tok);

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", devices_path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var parsed = try std.json.parseFromSlice(
            struct { devices: []struct { equipment_no: []const u8, name: []const u8, active: bool, created_at: i64 } },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        try std.testing.expectEqual(@as(usize, 1), parsed.value.devices.len);
        try std.testing.expectEqualStrings("SN-ALICE-1", parsed.value.devices[0].equipment_no);
        try std.testing.expect(parsed.value.devices[0].active);
    }

    // Alice's id with Bob's serial must 404 and leave Bob's binding active.
    {
        const unlink_path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}/devices/unlink", .{alice});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", unlink_path, &admin_tok, "{\"equipmentNo\":\"SN-BOB-1\"}");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "DEVICE_NOT_FOUND") != null);
    }
    try std.testing.expectEqual(@as(i64, 1), try f.svc.deviceCount(bob));

    // An unheld serial answers identically, so ownership cannot be probed.
    {
        const unlink_path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}/devices/unlink", .{alice});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", unlink_path, &admin_tok, "{\"equipmentNo\":\"SN-NOBODY\"}");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "DEVICE_NOT_FOUND") != null);
    }

    {
        const unlink_path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}/devices/unlink", .{bob});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", unlink_path, &admin_tok, "{\"equipmentNo\":\"SN-BOB-1\"}", 200);
    }
    try std.testing.expectEqual(@as(i64, 0), try f.svc.deviceCount(bob));

    // Quota below usage is accepted and reports used > total.
    const quota_path = try std.fmt.bufPrint(&quotabuf, "/api/admin/users/{d}/quota", .{alice});
    // An account with no capacity row yet: the write path would create it, this seeds it directly.
    try f.files.ensureCapacity(alice);
    {
        var s = try f.db.prepare("UPDATE capacity SET used_bytes = 5000 WHERE user_id = ?1;");
        defer s.finalize();
        s.bindInt(1, @intCast(alice));
        _ = try s.step();
    }
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "PUT", quota_path, &admin_tok, "{\"totalBytes\":100}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var parsed = try std.json.parseFromSlice(
            struct { used_bytes: i64, total_bytes: i64 },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer parsed.deinit();
        try std.testing.expectEqual(@as(i64, 100), parsed.value.total_bytes);
        try std.testing.expectEqual(@as(i64, 5000), parsed.value.used_bytes);
    }
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "PUT", quota_path, &admin_tok, "{\"totalBytes\":-1}");
        try std.testing.expectEqual(@as(u16, 400), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "INVALID_QUOTA") != null);
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users/9999/quota", &admin_tok, "", 404);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/users/9999/devices", &admin_tok, "", 404);

    const bob_temp = (try f.svc.resetPassword(admin, bob));
    const bob_tok = try onboardWeb(ctx, "bob", bob_temp.slice(), "bobpw123");
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", devices_path, &bob_tok, "", 403);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", quota_path, &bob_tok, "", 403);
    {
        const unlink_path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}/devices/unlink", .{bob});
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", unlink_path, &bob_tok, "{\"equipmentNo\":\"SN-BOB-1\"}", 403);
    }
}

test "admin retention and health over HTTP: the window round-trips and health names no one" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    _ = try f.svc.bootstrapAdmin("admin", "admtemp0");

    var obuf: [8192]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;

    const admin_tok = try onboardWeb(ctx, "admin", "admtemp0", "adminpw1");
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/settings/retention", &admin_tok, "", 428);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/health", &admin_tok, "", 428);
    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &admin_tok);

    const Retention = struct { retentionDays: i64, defaultDays: i64, minDays: i64, maxDays: i64, changedAt: i64 };

    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/settings/retention", &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(Retention, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(i64, 30), p.value.retentionDays);
        try std.testing.expectEqual(@as(i64, 30), p.value.defaultDays);
        try std.testing.expectEqual(@as(i64, 1), p.value.minDays);
        try std.testing.expectEqual(@as(i64, 365), p.value.maxDays);
        try std.testing.expectEqual(@as(i64, 0), p.value.changedAt);
    }

    // `changedAt` starts the grace that stops a shortened window purging the
    // bin retroactively.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "PUT", "/api/admin/settings/retention", &admin_tok, "{\"retentionDays\":7}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(Retention, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(i64, 7), p.value.retentionDays);
        try std.testing.expect(p.value.changedAt > 0);
    }
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "PUT", "/api/admin/settings/retention", &admin_tok, "{\"retentionDays\":0}", 400);
    try expectStatusWithCookie(ctx, &obuf, &reqbuf, "PUT", "/api/admin/settings/retention", &admin_tok, "{\"retentionDays\":9999}", 400);

    // The bin quotes the configured window, not the constant.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/bin", &admin_tok, "");
        var p = try std.json.parseFromSlice(struct { retentionDays: i64 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(i64, 7), p.value.retentionDays);
    }

    // Household-wide totals only; the absence assertions guard against
    // per-person fields.
    {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/admin/health", &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(
            struct { health: struct { version: []const u8, memory_budget_bytes: i64, blob_bytes: i64, blob_count: i64 } },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer p.deinit();
        try std.testing.expectEqualStrings(app.api_version, p.value.health.version);
        try std.testing.expectEqual(@as(i64, 50 * 1024 * 1024), p.value.health.memory_budget_bytes);
        try std.testing.expectEqual(@as(i64, 0), p.value.health.blob_count);
        for ([_][]const u8{ "lastSync", "last_sync", "noteCount", "note_count", "user", "email" }) |leak| {
            if (std.mem.indexOf(u8, resp.body, leak) != null) {
                std.debug.print("health response leaked per-person field: {s}\n", .{leak});
                return error.HealthLeaksActivity;
            }
        }
    }
}

test "DELETE /api/admin/users releases the account's blobs, but only decrements one shared with another user" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp0");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    const bob = (try f.svc.createUser(admin, "bob", false)).id;

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const admin_tok = try onboardWeb(ctx, "admin", "admtemp0", "adminpw1");
    try elevate(ctx, &obuf, &reqbuf, "admin", "adminpw1", &admin_tok);

    // Identical bytes dedup to one blob at refcount 2; deleting Alice must not
    // destroy Bob's copy.
    _ = try putSeed(f, alice, null, "solo.note", "alice private bytes");
    _ = try putSeed(f, alice, null, "shared.note", "bytes both of them have");
    const bob_shared = try putSeed(f, bob, null, "shared.note", "bytes both of them have");

    try std.testing.expectEqual(@as(i64, 2), try countRows(f, "SELECT COUNT(*) FROM blobs;"));
    const shared_md5 = try soleMd5(f, bob_shared);

    {
        var pbuf: [64]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/admin/users/{d}", .{alice});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "DELETE", path, &admin_tok, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }

    try std.testing.expectEqual(@as(i64, 1), try countRows(f, "SELECT COUNT(*) FROM blobs;"));
    try std.testing.expectEqual(@as(i64, 1), try countRows(f, "SELECT refcount FROM blobs;"));
    try std.testing.expect(f.files.blobs.has(&shared_md5));

    try std.testing.expectEqual(@as(usize, 0), (try f.files.list(alice, null)).len);
    const listing = try f.files.list(bob, null);
    defer filesmod.Files.freeEntries(gpa, listing);
    try std.testing.expectEqual(@as(usize, 1), listing.len);
    try std.testing.expectEqualStrings("shared.note", listing[0].name);
    try std.testing.expectEqualSlices(u8, &shared_md5, listing[0].md5.?);
}

test "sync supersede RETAINS the prior version: history row, old blob kept, and BOTH are charged" {
    const f = try Fixture.init();
    defer f.deinit();

    const admin = try f.svc.bootstrapAdmin("admin", "admtemp0");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;

    // Default fixture keeps history (keep = 5); an edit under the same path.
    const dir = try f.files.ensureFolderPath(alice, "NOTE/Note");
    const v1 = "first-version-of-the-note";
    const v2 = "second-version-of-the-note-that-is-a-bit-longer";
    const old_md5 = blobstore.md5HexOf(v1);

    const v1_id = try putSeed(f, alice, dir, "up.note", v1);
    try std.testing.expect(f.files.blobs.has(&old_md5));
    try std.testing.expectEqual(@as(i64, @intCast(v1.len)), try usedBytes(f, alice));

    const v2_id = try putSeed(f, alice, dir, "up.note", v2);
    try std.testing.expectEqual(v1_id, v2_id); // superseded the same file row, not a new one

    // v1 is retained: one history row, blob not GC'd.
    try std.testing.expectEqual(@as(i64, 1), try countRows(f, "SELECT COUNT(*) FROM file_history;"));
    try std.testing.expectEqual(@as(i64, @intCast(v1.len)), try countRows(f, "SELECT size FROM file_history;"));
    try std.testing.expect(f.files.blobs.has(&old_md5));
    // The retained version is charged to the owner, like a trashed file.
    try std.testing.expectEqual(@as(i64, @intCast(v1.len + v2.len)), try usedBytes(f, alice));
    // Two blobs coexist; search stays current-only because the manifest only
    // reaches blobs a live row points at.
    try std.testing.expectEqual(@as(i64, 2), try countRows(f, "SELECT COUNT(*) FROM blobs;"));
}

fn soleMd5(f: *Fixture, file_id: u64) ![32]u8 {
    var r = (try f.db.row("SELECT md5 FROM files WHERE id = ?1;", &.{.{ .int = @intCast(file_id) }})) orelse return error.NoSuchFile;
    defer r.finalize();
    var out: [32]u8 = undefined;
    @memcpy(&out, r.text(0));
    return out;
}
