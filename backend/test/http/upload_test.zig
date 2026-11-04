//! Web upload and its onConflict modes.

const std = @import("std");
const repeat = @import("../../util/repeat.zig").repeat;
const blobstore = @import("../../store/blobs.zig");
const uploadcap = @import("../../handlers/upload_cap.zig");
const context = @import("../../http/context.zig");
const Context = context.Context;
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const Response = harness.Response;
const buildRequest = harness.buildRequest;
const roundtrip = harness.roundtrip;
const Sent = harness.Sent;
const roundtripCounting = harness.roundtripCounting;
const onboardWeb = harness.onboardWeb;
const Fixture = harness.Fixture;
const soleHistoryMd5 = harness.soleHistoryMd5;
const currentFileMd5 = harness.currentFileMd5;
const countRows = harness.countRows;
const putSeed = harness.putSeed;
const usedBytes = harness.usedBytes;
const blobTempCount = harness.blobTempCount;
const filler = harness.filler;
const cappedReadCeiling = harness.cappedReadCeiling;
const requestWithCookie = harness.requestWithCookie;
const expectFailure = harness.expectFailure;

/// `uploadFile`, reporting how much of the request the server read (see `Sent`).
fn uploadFileCounting(
    ctx: *Context,
    obuf: []u8,
    reqbuf: []u8,
    tok: []const u8,
    dest: []const u8,
    filename: []const u8,
    payload: []const u8,
) !Sent {
    const req = try buildUploadRequest(reqbuf, tok, dest, filename, payload, "");
    return roundtripCounting(ctx, req, obuf);
}

fn destOf(buf: []u8, id: u64) ![]const u8 {
    return std.fmt.bufPrint(buf, "{d}", .{id});
}

test "web upload: stores the blob, links the row, charges quota, bumps syncVersion, and answers a listing-shaped entry" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const dir = try f.files.createFolder(admin, null, "Papers");
    defer gpa.free(dir.name);

    const bytes = "%PDF-1.7\n… pretend pdf bytes …\r\n--not-a-boundary\x00\xff";
    const md5 = blobstore.md5HexOf(bytes);
    const v0 = try f.files.syncVersion(admin);

    var dbuf: [24]u8 = undefined;
    var file_id: u64 = undefined;
    {
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, try destOf(&dbuf, dir.id), "Ozymandias.pdf", bytes);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(UploadedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("note", p.value.kind); // the listing's file kind
        try std.testing.expectEqualStrings("Ozymandias.pdf", p.value.name);
        try std.testing.expectEqualStrings("pdf", p.value.fileType.?);
        try std.testing.expectEqualStrings(&md5, p.value.fileHash.?);
        file_id = try std.fmt.parseInt(u64, p.value.id, 10);
    }

    try std.testing.expect(f.files.blobs.has(&md5));

    {
        const entry = (try f.files.get(admin, file_id)).?;
        defer entry.deinit(gpa);
        try std.testing.expectEqualStrings("Ozymandias.pdf", entry.name);
        try std.testing.expect(!entry.is_folder);
        try std.testing.expectEqual(dir.id, entry.parent_id.?);
        try std.testing.expectEqual(@as(u64, bytes.len), entry.size);
        try std.testing.expectEqualStrings(&md5, entry.md5.?);
    }
    try std.testing.expectEqual(@as(i64, @intCast(bytes.len)), try usedBytes(f, admin));
    try std.testing.expect(try f.files.syncVersion(admin) > v0);

    {
        var pbuf: [64]u8 = undefined;
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/tree?parent={d}", .{dir.id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "Ozymandias.pdf") != null);
    }

    {
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", "loose.epub", "EPUB at the root");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(UploadedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        const at_root = (try f.files.get(admin, try std.fmt.parseInt(u64, p.value.id, 10))).?;
        defer at_root.deinit(gpa);
        try std.testing.expect(at_root.parent_id == null);
    }
}

test "web upload: identical bytes dedup onto one blob and charge zero extra quota" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const bytes = "the very same bytes, twice";
    {
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", "first.pdf", bytes);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    const after_first = try usedBytes(f, admin);
    try std.testing.expectEqual(@as(i64, @intCast(bytes.len)), after_first);

    // Quota is per distinct blob per user: same content, new name, no charge.
    {
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", "second.pdf", bytes);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try std.testing.expectEqual(after_first, try usedBytes(f, admin));
}

test "web upload: a name collision auto-renames instead of replacing the file already there" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const first = try putSeed(f, admin, null, "notes.pdf", "the occupant's bytes");

    // A device re-upload replaces (new version); a browser drop takes " (n)".
    const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", "notes.pdf", "a completely different document");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    var p = try std.json.parseFromSlice(UploadedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    try std.testing.expectEqualStrings("notes (2).pdf", p.value.name);
    try std.testing.expect(try std.fmt.parseInt(u64, p.value.id, 10) != first);

    {
        const kept = (try f.files.get(admin, first)).?;
        defer kept.deinit(gpa);
        try std.testing.expectEqualStrings("notes.pdf", kept.name);
        try std.testing.expectEqualStrings(&blobstore.md5HexOf("the occupant's bytes"), kept.md5.?);
    }
    {
        const third = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", "notes.pdf", "yet another document");
        try std.testing.expectEqual(@as(u16, 200), third.status);
        var q = try std.json.parseFromSlice(UploadedBody, gpa, third.body, .{ .ignore_unknown_fields = true });
        defer q.deinit();
        try std.testing.expectEqualStrings("notes (3).pdf", q.value.name);
    }
}

test "web upload: an over-quota file is 413 and leaves the tree and the charge alone" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    {
        try f.db.run(
            "INSERT OR REPLACE INTO capacity(user_id, used_bytes, total_bytes) VALUES(?1, 0, 8);",
            &.{.{ .int = @intCast(admin) }},
        );
    }

    const v0 = try f.files.syncVersion(admin);
    const bytes = "far more than eight bytes of PDF";
    const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", "big.pdf", bytes);
    try std.testing.expectEqual(@as(u16, 413), resp.status);
    try std.testing.expect(std.mem.indexOf(u8, resp.body, "QUOTA_EXCEEDED") != null);

    try std.testing.expectEqual(@as(i64, 0), try usedBytes(f, admin));
    try std.testing.expectEqual(v0, try f.files.syncVersion(admin));
    try std.testing.expect(!f.files.blobs.has(&blobstore.md5HexOf(bytes)));
    {
        const resp2 = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/tree", &web, "");
        try std.testing.expect(std.mem.indexOf(u8, resp2.body, "big.pdf") == null);
    }
}

test "web upload: a body past the caller's remaining quota is refused MID-STREAM and stores nothing" {
    // No `upload/apply` on the browser face, so the cap is the remaining quota.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;

    {
        try f.db.run(
            "INSERT OR REPLACE INTO capacity(user_id, used_bytes, total_bytes) VALUES(?1, 0, 8);",
            &.{.{ .int = @intCast(admin) }},
        );
    }

    const v0 = try f.files.syncVersion(admin);
    const payload = try filler(8 + 4 * uploadcap.slack_bytes);
    defer gpa.free(payload);
    const reqbuf = try gpa.alloc(u8, payload.len + 1024);
    defer gpa.free(reqbuf);

    const sent = try uploadFileCounting(ctx, &obuf, reqbuf, &web, "root", "flood.pdf", payload);
    const resp = sent.resp;
    // The browser face answers 413, not the device protocol's 200 envelope.
    try std.testing.expectEqual(@as(u16, 413), resp.status);
    try expectFailure(resp.body, "QUOTA_EXCEEDED");

    // The read count is what distinguishes a capped refusal from a late one.
    try std.testing.expect(sent.consumed < cappedReadCeiling(uploadcap.limitFor(8)));

    try std.testing.expect(!f.files.blobs.has(&blobstore.md5HexOf(payload)));
    try std.testing.expectEqual(@as(usize, 0), try blobTempCount(f));
    try std.testing.expectEqual(@as(i64, 0), try usedBytes(f, admin));
    try std.testing.expectEqual(v0, try f.files.syncVersion(admin));
    {
        const tree = try requestWithCookie(ctx, &obuf, reqbuf, "GET", "/api/controlplane/tree", &web, "");
        try std.testing.expect(std.mem.indexOf(u8, tree.body, "flood.pdf") == null);
    }

    {
        try f.db.run(
            "UPDATE capacity SET total_bytes = ?1 WHERE user_id = ?2;",
            &.{ .{ .int = @intCast(payload.len * 2) }, .{ .int = @intCast(admin) } },
        );
    }
    const ok = try uploadFile(ctx, &obuf, reqbuf, &web, "root", "flood.pdf", payload);
    try std.testing.expectEqual(@as(u16, 200), ok.status);
    try std.testing.expect(f.files.blobs.has(&blobstore.md5HexOf(payload)));
    try std.testing.expectEqual(@as(i64, @intCast(payload.len)), try usedBytes(f, admin));
}

test "web upload: an off-list extension is 415 and an unsafe filename is 400, both before a byte is stored" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const bytes = "payload the server must never store";
    const md5 = blobstore.md5HexOf(bytes);

    for ([_][]const u8{ "trojan.exe", "vector.svg", "README" }) |name| {
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", name, bytes);
        try std.testing.expectEqual(@as(u16, 415), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "UNSUPPORTED_TYPE") != null);
    }
    {
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", ".pdf", bytes);
        try std.testing.expectEqual(@as(u16, 415), resp.status);
    }

    // The multipart parser already strips directory prefixes; these survive it.
    for ([_][]const u8{ "", "..", "..pdf", "a\x00b.pdf", "line\nbreak.pdf", "\xff\xfe.pdf" }) |name| {
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", name, bytes);
        try std.testing.expectEqual(@as(u16, 400), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "INVALID_NAME") != null);
    }

    try std.testing.expect(!f.files.blobs.has(&md5));
    try std.testing.expectEqual(@as(i64, 0), try usedBytes(f, admin));

    // Traversal is neutralised: the file lands under its basename.
    {
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", "../../../etc/passwd.txt", "innocent");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(UploadedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("passwd.txt", p.value.name);
        const e = (try f.files.get(admin, try std.fmt.parseInt(u64, p.value.id, 10))).?;
        defer e.deinit(gpa);
        try std.testing.expect(e.parent_id == null);
    }

    const accepted = [_][]const u8{
        "a.note", "b.SPD", "c.pdf",  "d.EPUB", "e.doc",  "f.docx",
        "g.txt",  "h.PNG", "i.jpg",  "j.jpeg", "k.webp", "l.cbz",
        "m.fb2",  "n.xps", "o.mobi", "p.azw",  "q.AZW3",
    };
    for (accepted, 0..) |name, i| {
        var pbuf: [64]u8 = undefined;
        const payload = try std.fmt.bufPrint(&pbuf, "accepted payload number {d}", .{i});
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", name, payload);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
}

test "web upload: a missing, foreign, non-folder or trashed destination is one indistinguishable 404" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const bob = (try f.svc.createUser(admin, "bob", false)).id;
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    var dbuf: [24]u8 = undefined;

    const bobs_dir = try f.files.createFolder(bob, null, "BobsPapers");
    defer gpa.free(bobs_dir.name);
    const a_file = try putSeed(f, admin, null, "not-a-folder.pdf", "just a file");
    const trashed = try f.files.createFolder(admin, null, "Doomed");
    defer gpa.free(trashed.name);
    try f.files.trash(admin, trashed.id);

    const cases = [_]u64{ 999999, bobs_dir.id, a_file, trashed.id };
    for (cases) |dest| {
        const resp = try uploadFile(ctx, &obuf, &reqbuf, &web, try destOf(&dbuf, dest), "drop.pdf", "bytes");
        try std.testing.expectEqual(@as(u16, 404), resp.status);
        try std.testing.expect(std.mem.indexOf(u8, resp.body, "NOT_FOUND") != null);
    }

    try std.testing.expectEqual(@as(i64, 0), try usedBytes(f, bob));
}

test "web upload: requires a control-plane session" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    _ = try f.svc.bootstrapAdmin("admin", "admtemp00");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const resp = try uploadFile(ctx, &obuf, &reqbuf, repeat(u8, "0", 32), "root", "sneaky.pdf", "bytes");
    try std.testing.expectEqual(@as(u16, 401), resp.status);
}

const shared = @import("upload_helpers.zig");
const uploadFile = shared.uploadFile;
const buildUploadRequest = shared.buildUploadRequest;
const UploadedBody = shared.UploadedBody;
