//! Web upload and its onConflict modes.

const std = @import("std");
const repeat = @import("../../repeat.zig").repeat;
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

const upload_boundary = "----InkholdWebUploadBoundary";

/// `payload` as the one file part of a browser upload. Caller frees.
fn buildUploadBody(filename: []const u8, payload: []const u8) ![]u8 {
    const head = try std.fmt.allocPrint(
        gpa,
        "--{s}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{s}\"\r\nContent-Type: application/octet-stream\r\n\r\n",
        .{ upload_boundary, filename },
    );
    defer gpa.free(head);
    const tail = try std.fmt.allocPrint(gpa, "\r\n--{s}--\r\n", .{upload_boundary});
    defer gpa.free(tail);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try out.appendSlice(gpa, head);
    try out.appendSlice(gpa, payload);
    try out.appendSlice(gpa, tail);
    return out.toOwnedSlice(gpa);
}

fn uploadFile(
    ctx: *Context,
    obuf: []u8,
    reqbuf: []u8,
    tok: []const u8,
    dest: []const u8,
    filename: []const u8,
    payload: []const u8,
) !Response {
    return uploadFileQuery(ctx, obuf, reqbuf, tok, dest, filename, payload, "");
}

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

fn uploadFileQuery(
    ctx: *Context,
    obuf: []u8,
    reqbuf: []u8,
    tok: []const u8,
    dest: []const u8,
    filename: []const u8,
    payload: []const u8,
    query: []const u8,
) !Response {
    const req = try buildUploadRequest(reqbuf, tok, dest, filename, payload, query);
    return roundtrip(ctx, req, obuf);
}

fn buildUploadRequest(
    reqbuf: []u8,
    tok: []const u8,
    dest: []const u8,
    filename: []const u8,
    payload: []const u8,
    query: []const u8,
) ![]const u8 {
    const wire = try buildUploadBody(filename, payload);
    defer gpa.free(wire);
    var pbuf: [128]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/folder/{s}/upload{s}", .{ dest, query });
    var cbuf: [64]u8 = undefined;
    const cookie = try std.fmt.bufPrint(&cbuf, "sn_session={s}", .{tok});
    return buildRequest(reqbuf, "POST", path, &.{
        .{ .name = "content-type", .value = "multipart/form-data; boundary=" ++ upload_boundary },
        .{ .name = "cookie", .value = cookie },
    }, wire);
}

fn destOf(buf: []u8, id: u64) ![]const u8 {
    return std.fmt.bufPrint(buf, "{d}", .{id});
}

/// The listing-shaped `EntryVO` fields an upload returns (same as `rename`).
const UploadedBody = struct {
    kind: []const u8,
    id: []const u8,
    name: []const u8,
    fileType: ?[]const u8 = null,
    fileHash: ?[]const u8 = null,
};

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
        defer gpa.free(entry.name);
        defer if (entry.md5) |m| gpa.free(m);
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
        defer gpa.free(at_root.name);
        defer if (at_root.md5) |m| gpa.free(m);
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
        defer gpa.free(kept.name);
        defer if (kept.md5) |m| gpa.free(m);
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
        var s = try f.db.prepare("INSERT OR REPLACE INTO capacity(user_id, used_bytes, total_bytes) VALUES(?1, 0, 8);");
        defer s.finalize();
        s.bindInt(1, @intCast(admin));
        _ = try s.step();
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
        var s = try f.db.prepare("INSERT OR REPLACE INTO capacity(user_id, used_bytes, total_bytes) VALUES(?1, 0, 8);");
        defer s.finalize();
        s.bindInt(1, @intCast(admin));
        _ = try s.step();
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
        var s = try f.db.prepare("UPDATE capacity SET total_bytes = ?1 WHERE user_id = ?2;");
        defer s.finalize();
        s.bindInt(1, @intCast(payload.len * 2));
        s.bindInt(2, @intCast(admin));
        _ = try s.step();
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
        defer gpa.free(e.name);
        defer if (e.md5) |m| gpa.free(m);
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

const UploadHistVersion = struct { md5: []const u8, size: i64, current: bool = false };

test "web upload onConflict=replace: supersedes the same-named file, keeps the row id, and the old bytes stay a restorable version" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    var pbuf: [128]u8 = undefined;

    const v1 = "the first draft of the paper";
    const v2 = "the SECOND draft, materially different";
    const v1md5 = blobstore.md5HexOf(v1);
    const v2md5 = blobstore.md5HexOf(v2);

    const id = try putSeed(f, admin, null, "paper.pdf", v1);

    {
        const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "paper.pdf", v2, "?onConflict=replace");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(UploadedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("paper.pdf", p.value.name); // no " (2)"
        try std.testing.expectEqual(id, try std.fmt.parseInt(u64, p.value.id, 10)); // the SAME row
        try std.testing.expectEqualStrings(&v2md5, p.value.fileHash.?);
    }
    try std.testing.expectEqualSlices(u8, &v2md5, &(try currentFileMd5(f, id)));

    try std.testing.expectEqual(
        @as(i64, 1),
        try countRows(f, "SELECT COUNT(*) FROM files WHERE name = 'paper.pdf' AND deleted = 0;"),
    );

    // The superseded bytes are retained, which is why `replace` is offered.
    try std.testing.expectEqualSlices(u8, &v1md5, &(try soleHistoryMd5(f, id)));
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history", .{id});
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", path, &web, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(
            struct { id: []const u8, versions: []UploadHistVersion },
            gpa,
            resp.body,
            .{ .ignore_unknown_fields = true },
        );
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 2), p.value.versions.len);
        try std.testing.expect(p.value.versions[0].current);
        try std.testing.expectEqualStrings(&v2md5, p.value.versions[0].md5);
        try std.testing.expect(!p.value.versions[1].current);
        try std.testing.expectEqualStrings(&v1md5, p.value.versions[1].md5);
    }
    {
        const path = try std.fmt.bufPrint(&pbuf, "/api/controlplane/note/{d}/history/{s}/restore", .{ id, v1md5 });
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "POST", path, &web, "{}");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try std.testing.expectEqualSlices(u8, &v1md5, &(try currentFileMd5(f, id)));
}

test "web upload onConflict=replace: with nothing of that name it is just a create" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const bytes = "nothing to supersede";
    const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "fresh.pdf", bytes, "?onConflict=replace");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    var p = try std.json.parseFromSlice(UploadedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    try std.testing.expectEqualStrings("fresh.pdf", p.value.name);

    const id = try std.fmt.parseInt(u64, p.value.id, 10);
    try std.testing.expectEqualSlices(u8, &blobstore.md5HexOf(bytes), &(try currentFileMd5(f, id)));
    try std.testing.expectEqual(@as(i64, @intCast(bytes.len)), try usedBytes(f, admin));
    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM file_history;"));
}

test "web upload: the DEFAULT and an unrecognised onConflict both auto-rename — an old or confused client can never overwrite" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const occupant = "the file already there";
    const id = try putSeed(f, admin, null, "notes.pdf", occupant);

    const queries = [_][]const u8{
        "",
        "?onConflict=",
        "?onConflict=Rename",
        "?onConflict=overwrite",
        "?onConflict=replace%20", // not a literal match, so not a replace
        "?other=replace",
    };
    var expected_suffix: usize = 2;
    for (queries) |q| {
        const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "notes.pdf", "a different document", q);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        var p = try std.json.parseFromSlice(UploadedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        var want: [32]u8 = undefined;
        try std.testing.expectEqualStrings(
            try std.fmt.bufPrint(&want, "notes ({d}).pdf", .{expected_suffix}),
            p.value.name,
        );
        expected_suffix += 1;
    }

    {
        const kept = (try f.files.get(admin, id)).?;
        defer gpa.free(kept.name);
        defer if (kept.md5) |m| gpa.free(m);
        try std.testing.expectEqualStrings("notes.pdf", kept.name);
        try std.testing.expectEqualStrings(&blobstore.md5HexOf(occupant), kept.md5.?);
    }
    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM file_history;"));
}

test "web upload onConflict=replace: a FOLDER holding the name is still 409, and the folder survives" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    // A file may never supersede a folder, under either mode.
    const dir = try f.files.createFolder(admin, null, "archive.pdf");
    defer gpa.free(dir.name);

    const bytes = "trying to become a folder";
    const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "archive.pdf", bytes, "?onConflict=replace");
    try std.testing.expectEqual(@as(u16, 409), resp.status);
    try std.testing.expect(std.mem.indexOf(u8, resp.body, "NAME_TAKEN") != null);

    {
        const kept = (try f.files.get(admin, dir.id)).?;
        defer gpa.free(kept.name);
        defer if (kept.md5) |m| gpa.free(m);
        try std.testing.expect(kept.is_folder);
        try std.testing.expectEqualStrings("archive.pdf", kept.name);
    }
    try std.testing.expectEqual(@as(i64, 0), try usedBytes(f, admin));
    try std.testing.expect(!f.files.blobs.has(&blobstore.md5HexOf(bytes)));

    {
        const ok = try uploadFile(ctx, &obuf, &reqbuf, &web, "root", "archive.pdf", bytes);
        try std.testing.expectEqual(@as(u16, 200), ok.status);
        var p = try std.json.parseFromSlice(UploadedBody, gpa, ok.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("archive (2).pdf", p.value.name);
    }
}

test "web upload onConflict=replace: quota releases the old charge only when nothing live still holds the blob" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    // Different lengths so the arithmetic can't balance by coincidence.
    const old_bytes = "old bytes";
    const new_bytes = "the replacement bytes, rather longer than the old";
    const old_len: i64 = @intCast(old_bytes.len);
    const new_len: i64 = @intCast(new_bytes.len);

    const solo = try putSeed(f, admin, null, "solo.pdf", old_bytes);
    try std.testing.expectEqual(old_len, try usedBytes(f, admin));
    {
        const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "solo.pdf", new_bytes, "?onConflict=replace");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    // The old charge stays: the retained version keeps the bytes on disk.
    try std.testing.expectEqual(old_len + new_len, try usedBytes(f, admin));
    try std.testing.expect(f.files.blobs.has(&blobstore.md5HexOf(old_bytes)));
    try std.testing.expectEqualSlices(u8, &blobstore.md5HexOf(old_bytes), &(try soleHistoryMd5(f, solo)));

    // Two rows on one blob cost one charge; replacing one releases nothing.
    const shared_a = try putSeed(f, admin, null, "shared-a.pdf", old_bytes);
    _ = try putSeed(f, admin, null, "shared-b.pdf", old_bytes);
    _ = shared_a;
    const before = try usedBytes(f, admin);
    // Dedup against your own history is still dedup.
    try std.testing.expectEqual(new_len + old_len, before);
    {
        const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "shared-a.pdf", "third distinct payload", "?onConflict=replace");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }
    try std.testing.expectEqual(before + @as(i64, "third distinct payload".len), try usedBytes(f, admin));
}

test "web upload onConflict=replace: re-uploading identical bytes is a no-op, not a spurious version" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const admin = try f.svc.bootstrapAdmin("admin", "admtemp00");
    const web = try onboardWeb(ctx, "admin", "admtemp00", "adminpw1");

    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;

    const bytes = "unchanged content";
    const id = try putSeed(f, admin, null, "same.pdf", bytes);
    const charged = try usedBytes(f, admin);

    const resp = try uploadFileQuery(ctx, &obuf, &reqbuf, &web, "root", "same.pdf", bytes, "?onConflict=replace");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    var p = try std.json.parseFromSlice(UploadedBody, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    try std.testing.expectEqual(id, try std.fmt.parseInt(u64, p.value.id, 10));

    try std.testing.expectEqual(@as(i64, 0), try countRows(f, "SELECT COUNT(*) FROM file_history;"));
    try std.testing.expectEqual(charged, try usedBytes(f, admin));
    try std.testing.expectEqual(
        @as(i64, 1),
        try countRows(f, "SELECT COUNT(*) FROM files WHERE name = 'same.pdf' AND deleted = 0;"),
    );
}
