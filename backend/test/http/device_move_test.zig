//! Device move and copy, and upload-session reclaim, over HTTP.

const std = @import("std");
const transport = @import("../../http/transport.zig");
const password = @import("../../services/auth/password.zig");
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const buildRequest = harness.buildRequest;
const roundtrip = harness.roundtrip;
const onboardWeb = harness.onboardWeb;
const Fixture = harness.Fixture;
const countRows = harness.countRows;
const deviceRequest = harness.deviceRequest;
const deviceLogin = harness.deviceLogin;
const putSeed = harness.putSeed;
const searchHits = harness.searchHits;
const seedRecognizedNote = harness.seedRecognizedNote;
const expectStatusWithCookie = harness.expectStatusWithCookie;
const shared = @import("device_helpers.zig");
const countNamed = shared.countNamed;

test "device move_v3: renames + relocates a note, provisioning the destination parent, and it stays searchable" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const id = try seedRecognizedNote(f, alice, "note.note", &.{ "Zebra", "Quokka" });
    try std.testing.expectEqual(@as(usize, 1), try searchHits(f, alice, "Zebra"));

    // Captured shape: full destination path including the new filename, into a
    // parent that does not exist yet, autorename false.
    var body_buf: [256]u8 = undefined;
    const body = try std.fmt.bufPrint(
        &body_buf,
        "{{\"id\":\"{d}\",\"to_path\":\"/NOTE/Note/corpus/note/custom_template.note\",\"autorename\":false,\"equipmentNo\":\"SN1\"}}",
        .{id},
    );
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/move_v3", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        const p = try std.json.parseFromSlice(struct {
            success: bool,
            equipmentNo: []const u8,
            entriesVO: struct { tag: []const u8, id: []const u8, name: []const u8, path_display: []const u8, parent_path: []const u8 },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings("SN1", p.value.equipmentNo);
        try std.testing.expectEqualStrings("file", p.value.entriesVO.tag);
        try std.testing.expectEqualStrings("custom_template.note", p.value.entriesVO.name);
        try std.testing.expectEqualStrings("/NOTE/Note/corpus/note/custom_template.note", p.value.entriesVO.path_display);
        try std.testing.expectEqualStrings("/NOTE/Note/corpus/note", p.value.entriesVO.parent_path);
        try std.testing.expectEqual(id, try std.fmt.parseInt(u64, p.value.entriesVO.id, 10));
    }

    try std.testing.expect((try f.files.resolvePath(alice, "/NOTE/Note/corpus/note")) != null);
    try std.testing.expectEqual(@as(?u64, id), try f.files.resolvePath(alice, "/NOTE/Note/corpus/note/custom_template.note"));
    try std.testing.expectEqual(@as(?u64, null), try f.files.resolvePath(alice, "/note.note"));
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/2/files/list_folder", &dev_tok, "SN1", "{\"path\":\"/\",\"recursive\":true}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "/NOTE/Note/corpus/note/custom_template.note") != null);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "\"name\":\"note.note\"") == null);
    }

    try std.testing.expectEqual(@as(usize, 1), try searchHits(f, alice, "Zebra"));
}

test "device move_v3 NEVER 404s: unknown and foreign ids settle as idempotent success, byte-for-byte" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));
    const bob = (try f.svc.createUser(admin, "bob", false)).id;

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const bob_id = try putSeed(f, bob, null, "bob.note", "bob bytes");

    // Same settled body for unknown and foreign ids: a 404 aborts the device's
    // sync, and a difference is an oracle.
    var mbuf: [200]u8 = undefined;
    var fbuf: [200]u8 = undefined;
    const missing = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/move_v3", &dev_tok, "SN1", try std.fmt.bufPrint(&mbuf, "{{\"id\":\"{d}\",\"to_path\":\"/x/y.note\",\"autorename\":false,\"equipmentNo\":\"SN1\"}}", .{@as(u64, 999999)}));
    try std.testing.expectEqual(@as(u16, 200), missing.status);
    try std.testing.expectEqualStrings("{\"success\":true,\"equipmentNo\":\"SN1\"}", missing.body);

    const foreign = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/move_v3", &dev_tok, "SN1", try std.fmt.bufPrint(&fbuf, "{{\"id\":\"{d}\",\"to_path\":\"/x/y.note\",\"autorename\":false,\"equipmentNo\":\"SN1\"}}", .{bob_id}));
    try std.testing.expectEqual(@as(u16, 200), foreign.status);
    try std.testing.expectEqualStrings(missing.body, foreign.body);

    {
        const still = (try f.files.get(bob, bob_id)).?;
        defer gpa.free(still.name);
        defer if (still.md5) |m| gpa.free(m);
        try std.testing.expectEqualStrings("bob.note", still.name);
        try std.testing.expectEqual(@as(?u64, null), still.parent_id);
    }
    try std.testing.expectEqual(@as(?u64, null), try f.files.resolvePath(bob, "/x"));

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/file/3/files/move_v3", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"id\":\"1\",\"to_path\":\"/a.note\"}"), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const web_tok = try onboardWeb(ctx, "admin", "temp0000", "adminpw1");
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/move_v3", &web_tok, "{\"id\":\"1\",\"to_path\":\"/a.note\"}", 403);
    }
}

test "device move_v3: autorename settles a destination-name conflict and reports the chosen name" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const keep = try putSeed(f, alice, null, "keep.note", "kkkk");
    const mover = try putSeed(f, alice, null, "mover.note", "mmmm");
    _ = keep;

    var body_buf: [200]u8 = undefined;
    const body = try std.fmt.bufPrint(&body_buf, "{{\"id\":\"{d}\",\"to_path\":\"/keep.note\",\"autorename\":true,\"equipmentNo\":\"SN1\"}}", .{mover});
    const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/move_v3", &dev_tok, "SN1", body);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    const p = try std.json.parseFromSlice(struct {
        success: bool,
        entriesVO: struct { name: []const u8, path_display: []const u8 },
    }, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    try std.testing.expectEqualStrings("keep (2).note", p.value.entriesVO.name);
    try std.testing.expectEqualStrings("/keep (2).note", p.value.entriesVO.path_display);
    try std.testing.expectEqual(@as(?u64, mover), try f.files.resolvePath(alice, "/keep (2).note"));
    try std.testing.expectEqual(@as(i64, 1), try countNamed(f, alice, "keep.note")); // the occupant intact
}

test "device copy_v3: duplicates a note sharing its blob (no extra quota), both stay searchable" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const id = try seedRecognizedNote(f, alice, "note.note", &.{ "Zebra", "Quokka" });
    try std.testing.expectEqual(@as(usize, 1), try searchHits(f, alice, "Zebra"));
    const used_before = (try f.files.capacity(alice)).used;

    var body_buf: [256]u8 = undefined;
    const body = try std.fmt.bufPrint(
        &body_buf,
        "{{\"to_path\":\"/NOTE/Note/note_CONFLICT_20260726151728080.note\",\"equipmentNo\":\"SN1\",\"id\":\"{d}\",\"autorename\":false}}",
        .{id},
    );
    {
        const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/copy_v3", &dev_tok, "SN1", body);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        const p = try std.json.parseFromSlice(struct {
            success: bool,
            equipmentNo: []const u8,
            entriesVO: struct { tag: []const u8, id: []const u8, name: []const u8, path_display: []const u8, parent_path: []const u8 },
        }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqualStrings("SN1", p.value.equipmentNo);
        try std.testing.expectEqualStrings("file", p.value.entriesVO.tag);
        try std.testing.expectEqualStrings("note_CONFLICT_20260726151728080.note", p.value.entriesVO.name);
        try std.testing.expectEqualStrings("/NOTE/Note/note_CONFLICT_20260726151728080.note", p.value.entriesVO.path_display);
        try std.testing.expect(id != try std.fmt.parseInt(u64, p.value.entriesVO.id, 10));
    }

    try std.testing.expectEqual(@as(?u64, id), try f.files.resolvePath(alice, "/note.note"));
    const copy_id = (try f.files.resolvePath(alice, "/NOTE/Note/note_CONFLICT_20260726151728080.note")).?;
    try std.testing.expect(copy_id != id);

    try std.testing.expectEqual(used_before, (try f.files.capacity(alice)).used);

    try std.testing.expectEqual(@as(usize, 2), try searchHits(f, alice, "Zebra"));
}

test "device copy_v3 NEVER 404s: unknown and foreign ids settle as idempotent success, byte-for-byte" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));
    const bob = (try f.svc.createUser(admin, "bob", false)).id;

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const bob_id = try putSeed(f, bob, null, "bob.note", "bob bytes");

    var mbuf: [200]u8 = undefined;
    var fbuf: [200]u8 = undefined;
    const missing = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/copy_v3", &dev_tok, "SN1", try std.fmt.bufPrint(&mbuf, "{{\"id\":\"{d}\",\"to_path\":\"/x/y.note\",\"autorename\":false,\"equipmentNo\":\"SN1\"}}", .{@as(u64, 999999)}));
    try std.testing.expectEqual(@as(u16, 200), missing.status);
    try std.testing.expectEqualStrings("{\"success\":true,\"equipmentNo\":\"SN1\"}", missing.body);

    const foreign = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/copy_v3", &dev_tok, "SN1", try std.fmt.bufPrint(&fbuf, "{{\"id\":\"{d}\",\"to_path\":\"/x/y.note\",\"autorename\":false,\"equipmentNo\":\"SN1\"}}", .{bob_id}));
    try std.testing.expectEqual(@as(u16, 200), foreign.status);
    try std.testing.expectEqualStrings(missing.body, foreign.body);

    try std.testing.expectEqual(@as(i64, 1), try countNamed(f, bob, "bob.note"));
    try std.testing.expectEqual(@as(?u64, null), try f.files.resolvePath(bob, "/x"));

    {
        const resp = try roundtrip(ctx, try buildRequest(&reqbuf, "POST", "/api/file/3/files/copy_v3", &.{.{ .name = "content-type", .value = "application/json" }}, "{\"id\":\"1\",\"to_path\":\"/a.note\"}"), &obuf);
        try std.testing.expectEqual(@as(u16, 401), resp.status);
    }
    {
        const web_tok = try onboardWeb(ctx, "admin", "temp0000", "adminpw1");
        try expectStatusWithCookie(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/copy_v3", &web_tok, "{\"id\":\"1\",\"to_path\":\"/a.note\"}", 403);
    }
}

test "device copy_v3: autorename settles a destination-name conflict and reports the chosen name" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [16384]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const keep = try putSeed(f, alice, null, "keep.note", "kkkk");
    const src = try putSeed(f, alice, null, "src.note", "ssss");
    _ = keep;

    var body_buf: [200]u8 = undefined;
    const body = try std.fmt.bufPrint(&body_buf, "{{\"id\":\"{d}\",\"to_path\":\"/keep.note\",\"autorename\":true,\"equipmentNo\":\"SN1\"}}", .{src});
    const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/copy_v3", &dev_tok, "SN1", body);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    const p = try std.json.parseFromSlice(struct {
        success: bool,
        entriesVO: struct { name: []const u8, path_display: []const u8 },
    }, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    try std.testing.expectEqualStrings("keep (2).note", p.value.entriesVO.name);
    try std.testing.expectEqualStrings("/keep (2).note", p.value.entriesVO.path_display);
    try std.testing.expect((try f.files.resolvePath(alice, "/keep (2).note")) != null);
    try std.testing.expectEqual(@as(i64, 1), try countNamed(f, alice, "keep.note"));
    try std.testing.expectEqual(@as(?u64, src), try f.files.resolvePath(alice, "/src.note"));
}

test "device copy_v3: a name conflict under autorename:false never clobbers the occupant" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    const admin = try f.svc.bootstrapAdmin("admin", "temp0000");
    const alice = (try f.svc.createUser(admin, "alice", false)).id;
    _ = try f.svc.changePassword(alice, null, &password.md5Hex("apass111"));

    var obuf: [8192]u8 = undefined;
    var reqbuf: [2048]u8 = undefined;
    const dev_tok = try deviceLogin(ctx, &obuf, &reqbuf, "alice", "apass111", "SN1");

    const keep = try putSeed(f, alice, null, "keep.note", "original");
    const src = try putSeed(f, alice, null, "src.note", "different");

    var body_buf: [200]u8 = undefined;
    const body = try std.fmt.bufPrint(&body_buf, "{{\"id\":\"{d}\",\"to_path\":\"/keep.note\",\"autorename\":false,\"equipmentNo\":\"SN1\"}}", .{src});
    const resp = try deviceRequest(ctx, &obuf, &reqbuf, "POST", "/api/file/3/files/copy_v3", &dev_tok, "SN1", body);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try std.testing.expectEqualStrings("{\"success\":true,\"equipmentNo\":\"SN1\"}", resp.body);
    _ = keep;
    try std.testing.expectEqual(@as(i64, 1), try countNamed(f, alice, "keep.note"));
    try std.testing.expectEqual(@as(?u64, src), try f.files.resolvePath(alice, "/src.note"));
}

test "abandoned upload sessions are reclaimed at startup, not left for ever" {
    // Upload failures strand staged blobs for the sweep; assert the sweep
    // actually reclaims them, not merely that it runs.
    const f = try Fixture.init();
    defer f.deinit();
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    _ = admin;

    try f.db.exec(
        "INSERT INTO upload_sessions(inner_name, user_id, path, file_name, declared_size, blob_md5, created_at) " ++
            "VALUES('stale-inner-name', 1, '/Note', 'abandoned.note', 12, '0123456789abcdef0123456789abcdef', 0);",
    );
    try std.testing.expectEqual(@as(i64, 1), try countRows(f, "SELECT COUNT(*) FROM upload_sessions;"));

    // A day's window, as `transport.run` uses.
    const swept = try f.files.sweepUploadSessions(24 * 60 * 60);
    try std.testing.expectEqual(@as(usize, 1), swept);
    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM upload_sessions;"));
}
