//! The Digest app's sync over HTTP, with the request bodies the apps send: the
//! digest a Nomad made on 2026-11-08 (its fields as the app's log printed
//! them) and the Partner app's `add/summary` from the July capture.

const std = @import("std");
const password = @import("../../services/auth/password.zig");
const harness = @import("harness.zig");
const Fixture = harness.Fixture;
const deviceRequest = harness.deviceRequest;
const deviceLogin = harness.deviceLogin;
const expectSuccess = harness.expectSuccess;
const expectFailure = harness.expectFailure;
const gpa = std.testing.allocator;

/// The Nomad's highlight in a PDF, as `AddKnowledgeRequest`.
const nomad_add =
    \\{"commentHandwriteName":"6003a8c1725a175c14868baedd7133a1.mark","commentStr":"yeah","content":"La phonétique du français","creationTime":1794175867249,"dataSource":null,"handwriteInnerName":null,"handwriteMD5":"245354713d4c121a2368d9295f6379ca","lastModifiedTime":1794176056052,"md5Hash":"187a8bd48f89d12a78b3198a166d494a","metadata":"{\"document_location_data\":\"[{\\\"chapter\\\":0,\\\"endPosition\\\":50,\\\"page\\\":0,\\\"startPosition\\\":26}]\",\"source_size\":407277,\"unique_identifier\":\"c1ad0a49d44c62dc94b8f71448b3da5a\",\"author\":\"john\"}","parentUniqueIdentifier":"","sourcePath":"MyStyle/Français/La_phonetique_du_francais_Prof_Flavio_Adler.pdf","sourceType":1,"tags":null}
;
const nomad_metadata =
    \\{"document_location_data":"[{\"chapter\":0,\"endPosition\":50,\"page\":0,\"startPosition\":26}]","source_size":407277,"unique_identifier":"c1ad0a49d44c62dc94b8f71448b3da5a","author":"john"}
;

/// The July capture's Partner-app add, byte for byte.
const captured_add =
    \\{"commentHandwriteName":null,"commentStr":null,"content":"ahahahahah","creationTime":1784901369324,"dataSource":null,"handwriteInnerName":null,"handwriteMD5":null,"lastModifiedTime":1784901369324,"md5Hash":"e9863bb8045f0114b07f4bcf510574ad","metadata":"{\"unique_identifier\":\"48e884cb-101b-41c8-bec5-738cb9c34e74\"}","parentUniqueIdentifier":"","sourcePath":"","sourceType":4,"tags":null,"uniqueIdentifier":null}
;

/// The app asks for the manifest and the categories with page 0, size 0.
const whole = "{\"page\":0,\"size\":0}";

const Added = struct { success: bool, id: u64 };
const Hash = struct {
    success: bool,
    totalRecords: i64,
    totalPages: i64,
    summaryInfoVOList: []const struct { id: u64, md5Hash: []const u8, handwriteMd5: ?[]const u8 = null, lastModifiedTime: i64 },
};
const Summaries = struct {
    success: bool,
    totalRecords: i64,
    totalPages: i64,
    currentPage: i64,
    summaryDOList: []const struct {
        id: u64,
        isSummaryGroup: []const u8,
        uniqueIdentifier: ?[]const u8 = null,
        parentUniqueIdentifier: []const u8,
        name: ?[]const u8 = null,
        content: ?[]const u8 = null,
        sourcePath: ?[]const u8 = null,
        sourceType: ?i64 = null,
        metadata: ?[]const u8 = null,
        commentStr: ?[]const u8 = null,
        commentHandwriteName: ?[]const u8 = null,
        handwriteMD5: ?[]const u8 = null,
        md5Hash: []const u8,
        creationTime: i64,
        lastModifiedTime: i64,
        isDeleted: []const u8,
    },
};

fn signedIn(f: *Fixture, obuf: []u8, reqbuf: []u8, who: []const u8, eno: []const u8) ![32]u8 {
    const admin_id = f.svc.userIdByEmail("admin") catch null;
    const admin = admin_id orelse try f.svc.bootstrapAdmin("admin", "temp0000");
    const id = (try f.svc.createUser(admin, who, false)).id;
    _ = try f.svc.changePassword(id, null, &password.md5Hex("apass111"));
    return deviceLogin(&f.ctx, obuf, reqbuf, who, "apass111", eno);
}

fn call(f: *Fixture, obuf: []u8, reqbuf: []u8, tok: *const [32]u8, method: []const u8, path: []const u8, body: []const u8) !harness.Response {
    const resp = try deviceRequest(&f.ctx, obuf, reqbuf, method, path, tok, "SN1", body);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    return resp;
}

fn addId(f: *Fixture, obuf: []u8, reqbuf: []u8, tok: *const [32]u8, path: []const u8, body: []const u8) !u64 {
    const resp = try call(f, obuf, reqbuf, tok, "POST", path, body);
    var p = try std.json.parseFromSlice(Added, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    try std.testing.expect(p.value.success);
    return p.value.id;
}

test "Digest sync is refused, touching nothing, until digest_sync is on" {
    const f = try Fixture.init();
    defer f.deinit();
    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const tok = try signedIn(f, &obuf, &reqbuf, "alice", "SN1");

    const calls = [_][3][]const u8{
        .{ "POST", "/api/file/query/summary/hash", whole },
        .{ "POST", "/api/file/query/summary/group", whole },
        .{ "POST", "/api/file/query/summary/id", "{\"ids\":[1]}" },
        .{ "POST", "/api/file/query/summary", "{\"page\":1,\"size\":1000}" },
        .{ "POST", "/api/file/add/summary", nomad_add },
        .{ "PUT", "/api/file/update/summary", "{\"id\":1}" },
        .{ "DELETE", "/api/file/delete/summary", "{\"id\":1}" },
        .{ "POST", "/api/file/download/summary", "{\"id\":1}" },
        .{ "POST", "/api/file/add/summary/group", "{\"uniqueIdentifier\":\"g\",\"name\":\"x\"}" },
        .{ "PUT", "/api/file/update/summary/group", "{\"id\":1,\"name\":\"x\"}" },
        .{ "DELETE", "/api/file/delete/summary/group", "{\"id\":1}" },
        .{ "GET", "/api/file/query/summary/tag", "" },
        .{ "POST", "/api/file/add/summary/tag", "{\"name\":\"t\"}" },
        .{ "PUT", "/api/file/update/summary/tag", "{\"id\":1,\"name\":\"t\"}" },
        .{ "DELETE", "/api/file/delete/summary/tag", "{\"id\":1}" },
    };
    for (calls) |c| {
        const resp = try call(f, &obuf, &reqbuf, &tok, c[0], c[1], c[2]);
        try expectFailure(resp.body, "DIGEST_SYNC_UNSUPPORTED");
    }
    var r = (try f.ctx.db.row("SELECT (SELECT COUNT(*) FROM digests) + (SELECT COUNT(*) FROM digest_tags);", &.{})).?;
    defer r.finalize();
    try std.testing.expectEqual(@as(i64, 0), r.int(0));
}

test "the Nomad's digest round-trips: added, listed in the manifest, read back exactly, moved, deleted twice" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.digest_sync = true;
    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const tok = try signedIn(f, &obuf, &reqbuf, "alice", "SN1");

    const id = try addId(f, &obuf, &reqbuf, &tok, "/api/file/add/summary", nomad_add);
    // A resend (the reply was lost) is the same digest, not a second one.
    try std.testing.expectEqual(id, try addId(f, &obuf, &reqbuf, &tok, "/api/file/add/summary", nomad_add));

    {
        const resp = try call(f, &obuf, &reqbuf, &tok, "POST", "/api/file/query/summary/hash", whole);
        var p = try std.json.parseFromSlice(Hash, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expectEqual(@as(usize, 1), p.value.summaryInfoVOList.len);
        try std.testing.expectEqual(@as(i64, 1), p.value.totalRecords);
        const row = p.value.summaryInfoVOList[0];
        try std.testing.expectEqual(id, row.id);
        try std.testing.expectEqualStrings("187a8bd48f89d12a78b3198a166d494a", row.md5Hash);
        try std.testing.expectEqualStrings("245354713d4c121a2368d9295f6379ca", row.handwriteMd5.?);
        try std.testing.expectEqual(@as(i64, 1794176056052), row.lastModifiedTime);
    }
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"ids\":[{d},{d},999999]}}", .{ id, id });
        defer gpa.free(body);
        const resp = try call(f, &obuf, &reqbuf, &tok, "POST", "/api/file/query/summary/id", body);
        var p = try std.json.parseFromSlice(Summaries, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 1), p.value.summaryDOList.len); // the unknown id is left out
        const d = p.value.summaryDOList[0];
        try std.testing.expectEqualStrings("N", d.isSummaryGroup);
        try std.testing.expectEqualStrings("N", d.isDeleted);
        try std.testing.expectEqualStrings("", d.parentUniqueIdentifier); // Uncategorized
        try std.testing.expectEqualStrings("La phonétique du français", d.content.?);
        try std.testing.expectEqualStrings("MyStyle/Français/La_phonetique_du_francais_Prof_Flavio_Adler.pdf", d.sourcePath.?);
        try std.testing.expectEqual(@as(?i64, 1), d.sourceType);
        try std.testing.expectEqualStrings(nomad_metadata, d.metadata.?);
        try std.testing.expectEqualStrings("yeah", d.commentStr.?);
        try std.testing.expectEqualStrings("6003a8c1725a175c14868baedd7133a1.mark", d.commentHandwriteName.?);
        try std.testing.expectEqual(@as(i64, 1794175867249), d.creationTime);
    }
    {
        // Moved into a category on the tablet: the same id, a new md5.
        const body = try std.fmt.allocPrint(gpa,
            \\{{"id":{d},"parentUniqueIdentifier":"kb-french","content":"La phonétique du français","md5Hash":"0000000000000000000000000000000a","lastModifiedTime":1794176999999,"metadata":"{{\"unique_identifier\":\"c1ad0a49d44c62dc94b8f71448b3da5a\"}}","sourceType":1}}
        , .{id});
        defer gpa.free(body);
        const resp = try call(f, &obuf, &reqbuf, &tok, "PUT", "/api/file/update/summary", body);
        try expectSuccess(resp.body);
    }
    {
        const resp = try call(f, &obuf, &reqbuf, &tok, "POST", "/api/file/query/summary", "{\"page\":1,\"size\":1000,\"parentUniqueIdentifier\":\"kb-french\"}");
        var p = try std.json.parseFromSlice(Summaries, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 1), p.value.summaryDOList.len);
        try std.testing.expectEqualStrings("0000000000000000000000000000000a", p.value.summaryDOList[0].md5Hash);
        try std.testing.expectEqual(@as(i64, 1794175867249), p.value.summaryDOList[0].creationTime); // kept
    }
    // A delete of what is already gone still succeeds.
    for (0..2) |_| {
        const body = try std.fmt.allocPrint(gpa, "{{\"id\":{d}}}", .{id});
        defer gpa.free(body);
        try expectSuccess((try call(f, &obuf, &reqbuf, &tok, "DELETE", "/api/file/delete/summary", body)).body);
    }
    {
        const resp = try call(f, &obuf, &reqbuf, &tok, "POST", "/api/file/query/summary/hash", whole);
        var p = try std.json.parseFromSlice(Hash, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success); // empty and successful: it really is empty now
        try std.testing.expectEqual(@as(usize, 0), p.value.summaryInfoVOList.len);
    }
    // An update of a digest that is gone says so instead of resurrecting it.
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"id\":{d},\"md5Hash\":\"x\"}}", .{id});
        defer gpa.free(body);
        try expectFailure((try call(f, &obuf, &reqbuf, &tok, "PUT", "/api/file/update/summary", body)).body, "SUMMARY_NOT_FOUND");
    }
}

test "the Partner app's captured add lands, uncategorized, typed by hand" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.digest_sync = true;
    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const tok = try signedIn(f, &obuf, &reqbuf, "alice", "SN1");
    const id = try addId(f, &obuf, &reqbuf, &tok, "/api/file/add/summary", captured_add);
    try std.testing.expect(id > 0);
    const resp = try call(f, &obuf, &reqbuf, &tok, "POST", "/api/file/query/summary", "{\"page\":1,\"size\":1000}");
    var p = try std.json.parseFromSlice(Summaries, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    try std.testing.expectEqual(@as(usize, 1), p.value.summaryDOList.len);
    try std.testing.expectEqualStrings("ahahahahah", p.value.summaryDOList[0].content.?);
    try std.testing.expectEqual(@as(?i64, 4), p.value.summaryDOList[0].sourceType);
    try std.testing.expectEqualStrings("48e884cb-101b-41c8-bec5-738cb9c34e74", p.value.summaryDOList[0].uniqueIdentifier.?);
}

test "categories: listed whole; deleting one deletes its digests; Uncategorized and other accounts stay" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.digest_sync = true;
    var obuf: [65536]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const alice = try signedIn(f, &obuf, &reqbuf, "alice", "SN1");

    const french = try addId(f, &obuf, &reqbuf, &alice, "/api/file/add/summary/group",
        \\{"uniqueIdentifier":"kb-french","name":"Français","description":"","md5Hash":"g1","creationTime":1,"lastModifiedTime":1}
    );
    _ = try addId(f, &obuf, &reqbuf, &alice, "/api/file/add/summary/group",
        \\{"uniqueIdentifier":"kb-work","name":"Work","md5Hash":"g2","creationTime":1,"lastModifiedTime":1}
    );
    for (0..3) |_| _ = try addId(f, &obuf, &reqbuf, &alice, "/api/file/add/summary",
        \\{"parentUniqueIdentifier":"kb-french","content":"a","md5Hash":"m","sourceType":4}
    );
    _ = try addId(f, &obuf, &reqbuf, &alice, "/api/file/add/summary", captured_add); // Uncategorized

    {
        const resp = try call(f, &obuf, &reqbuf, &alice, "POST", "/api/file/query/summary/group", whole);
        var p = try std.json.parseFromSlice(Summaries, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 2), p.value.summaryDOList.len);
        try std.testing.expectEqualStrings("Y", p.value.summaryDOList[0].isSummaryGroup);
        try std.testing.expectEqualStrings("Français", p.value.summaryDOList[0].name.?);
        try std.testing.expectEqualStrings("kb-french", p.value.summaryDOList[0].uniqueIdentifier.?);
    }
    // The app's paging of a category: 1-based, until a page comes back short.
    {
        const resp = try call(f, &obuf, &reqbuf, &alice, "POST", "/api/file/query/summary", "{\"page\":2,\"size\":2,\"parentUniqueIdentifier\":\"kb-french\"}");
        var p = try std.json.parseFromSlice(Summaries, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 1), p.value.summaryDOList.len);
        try std.testing.expectEqual(@as(i64, 3), p.value.totalRecords);
        try std.testing.expectEqual(@as(i64, 2), p.value.totalPages);
        try std.testing.expectEqual(@as(i64, 2), p.value.currentPage);
    }

    // Another account sees none of it.
    const rui = try signedIn(f, &obuf, &reqbuf, "rui", "SN2");
    {
        const resp = try deviceRequest(&f.ctx, &obuf, &reqbuf, "POST", "/api/file/query/summary/hash", &rui, "SN2", whole);
        var p = try std.json.parseFromSlice(Hash, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 0), p.value.summaryInfoVOList.len);
    }

    {
        const body = try std.fmt.allocPrint(gpa, "{{\"id\":{d}}}", .{french});
        defer gpa.free(body);
        try expectSuccess((try call(f, &obuf, &reqbuf, &alice, "DELETE", "/api/file/delete/summary/group", body)).body);
        try expectSuccess((try call(f, &obuf, &reqbuf, &alice, "DELETE", "/api/file/delete/summary/group", body)).body);
    }
    {
        const resp = try call(f, &obuf, &reqbuf, &alice, "POST", "/api/file/query/summary/hash", whole);
        var p = try std.json.parseFromSlice(Hash, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 1), p.value.summaryInfoVOList.len); // only the uncategorized one
    }
}

test "tags: added, renamed, listed with their date the way the app reads it, deleted twice" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.digest_sync = true;
    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const tok = try signedIn(f, &obuf, &reqbuf, "alice", "SN1");

    const id = try addId(f, &obuf, &reqbuf, &tok, "/api/file/add/summary/tag", "{\"name\":\"phonetics\"}");
    {
        const body = try std.fmt.allocPrint(gpa, "{{\"id\":{d},\"name\":\"phonétique\"}}", .{id});
        defer gpa.free(body);
        try expectSuccess((try call(f, &obuf, &reqbuf, &tok, "PUT", "/api/file/update/summary/tag", body)).body);
    }
    {
        const resp = try call(f, &obuf, &reqbuf, &tok, "GET", "/api/file/query/summary/tag", "");
        const Tags = struct {
            success: bool,
            summaryTagDOList: []const struct { id: u64, name: []const u8, createdAt: struct { time: i64, year: i64, month: i64, date: i64 } },
        };
        var p = try std.json.parseFromSlice(Tags, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 1), p.value.summaryTagDOList.len);
        try std.testing.expectEqualStrings("phonétique", p.value.summaryTagDOList[0].name);
        try std.testing.expect(p.value.summaryTagDOList[0].createdAt.time > 0);
        try std.testing.expect(p.value.summaryTagDOList[0].createdAt.year > 100); // years since 1900
    }
    for (0..2) |_| {
        const body = try std.fmt.allocPrint(gpa, "{{\"id\":{d}}}", .{id});
        defer gpa.free(body);
        try expectSuccess((try call(f, &obuf, &reqbuf, &tok, "DELETE", "/api/file/delete/summary/tag", body)).body);
    }
}

test "a body the app would never send is refused, never stored" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.digest_sync = true;
    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const tok = try signedIn(f, &obuf, &reqbuf, "alice", "SN1");
    try expectFailure((try call(f, &obuf, &reqbuf, &tok, "POST", "/api/file/add/summary", "not json")).body, "BAD_REQUEST");
    try expectFailure((try call(f, &obuf, &reqbuf, &tok, "PUT", "/api/file/update/summary", "{\"md5Hash\":\"x\"}")).body, "BAD_REQUEST");
    try expectFailure((try call(f, &obuf, &reqbuf, &tok, "DELETE", "/api/file/delete/summary", "{\"id\":0}")).body, "BAD_REQUEST");
    var r = (try f.ctx.db.row("SELECT COUNT(*) FROM digests;", &.{})).?;
    defer r.finalize();
    try std.testing.expectEqual(@as(i64, 0), r.int(0));
}

// ---- handwritten notes ----

const buildRequest = harness.buildRequest;
const roundtrip = harness.roundtrip;
const buildMultipart = @import("device_helpers.zig").buildMultipart;

fn md5Hex(bytes: []const u8) [32]u8 {
    var d: [16]u8 = undefined;
    std.crypto.hash.Md5.hash(bytes, &d, .{});
    return std.fmt.bytesToHex(d, .lower);
}

/// `upload/apply/summary`, then the multipart POST to the URL it gives, as
/// the app does; returns the upload's inner name.
fn uploadNote(f: *Fixture, obuf: []u8, reqbuf: []u8, tok: *const [32]u8, bytes: []const u8) ![16]u8 {
    var inner: [16]u8 = undefined;
    {
        const resp = try call(f, obuf, reqbuf, tok, "POST", "/api/file/upload/apply/summary", "{\"fileName\":\"6003a8c1725a175c14868baedd7133a1.mark\"}");
        var p = try std.json.parseFromSlice(struct { success: bool, innerName: []const u8, fullUploadUrl: []const u8 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expect(p.value.success);
        try std.testing.expect(std.mem.endsWith(u8, p.value.fullUploadUrl, p.value.innerName));
        // The Digest app rewrites only `/api/oss/` URLs onto its configured address.
        try std.testing.expect(std.mem.indexOf(u8, p.value.fullUploadUrl, "/api/oss/put/") != null);
        @memcpy(&inner, p.value.innerName[0..16]);
    }
    const boundary = "----DigestNoteBoundary";
    const wire = try buildMultipart(boundary, bytes);
    defer gpa.free(wire);
    var ctbuf: [96]u8 = undefined;
    const ct = try std.fmt.bufPrint(&ctbuf, "multipart/form-data; boundary={s}", .{boundary});
    var pbuf: [48]u8 = undefined;
    const path = try std.fmt.bufPrint(&pbuf, "/api/oss/put/{s}", .{&inner});
    const req = try buildRequest(reqbuf, "POST", path, &.{
        .{ .name = "content-type", .value = ct },
        .{ .name = "x-access-token", .value = tok },
        .{ .name = "equipmentNo", .value = "SN1" },
    }, wire);
    const resp = try roundtrip(&f.ctx, req, obuf);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    return inner;
}

fn refcount(f: *Fixture, md5: []const u8) !?i64 {
    var r = (try f.ctx.db.row("SELECT refcount FROM blobs WHERE md5 = ?1;", &.{.{ .text = md5 }})) orelse return null;
    defer r.finalize();
    return r.int(0);
}

fn noteAdd(alloc: std.mem.Allocator, inner: []const u8, md5: []const u8, uid: []const u8) ![]u8 {
    return std.fmt.allocPrint(alloc,
        \\{{"commentHandwriteName":"6003a8c1725a175c14868baedd7133a1.mark","commentStr":"yeah","content":"x","handwriteInnerName":"{s}","handwriteMD5":"{s}","md5Hash":"m1","metadata":"{{\"unique_identifier\":\"{s}\"}}","parentUniqueIdentifier":"","sourceType":1}}
    , .{ inner, md5, uid });
}

/// `download/summary`, then the GET of the URL it gives; returns the body.
fn fetchNote(f: *Fixture, obuf: []u8, reqbuf: []u8, tok: *const [32]u8, id: u64) !harness.Response {
    var path_buf: [256]u8 = undefined;
    const path = blk: {
        const body = try std.fmt.allocPrint(gpa, "{{\"id\":{d}}}", .{id});
        defer gpa.free(body);
        const resp = try call(f, obuf, reqbuf, tok, "POST", "/api/file/download/summary", body);
        var p = try std.json.parseFromSlice(struct { success: bool, url: []const u8 = "" }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        if (!p.value.success) return resp;
        const at = std.mem.indexOf(u8, p.value.url, "/api/oss/summary/").?;
        const rest = p.value.url[at..];
        @memcpy(path_buf[0..rest.len], rest);
        break :blk path_buf[0..rest.len];
    };
    const req = try buildRequest(reqbuf, "GET", path, &.{}, "");
    return roundtrip(&f.ctx, req, obuf);
}

test "a handwritten note: uploaded, claimed by its digest, served back byte for byte" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.digest_sync = true;
    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const tok = try signedIn(f, &obuf, &reqbuf, "alice", "SN1");

    const note = "SUPERNOTE MARK — a page of ink, stand-in bytes";
    const md5 = md5Hex(note);
    const inner = try uploadNote(f, &obuf, &reqbuf, &tok, note);
    const body = try noteAdd(gpa, &inner, &md5, "u-note");
    defer gpa.free(body);
    const id = try addId(f, &obuf, &reqbuf, &tok, "/api/file/add/summary", body);
    try std.testing.expectEqual(@as(?i64, 1), try refcount(f, &md5));

    // Resent after a lost reply: the upload is already claimed, the digest
    // holds exactly that note, so it is the same digest and no second reference.
    try std.testing.expectEqual(id, try addId(f, &obuf, &reqbuf, &tok, "/api/file/add/summary", body));
    try std.testing.expectEqual(@as(?i64, 1), try refcount(f, &md5));

    const resp = try fetchNote(f, &obuf, &reqbuf, &tok, id);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try std.testing.expectEqualStrings(note, resp.body);

    // The manifest carries the note's md5, which is what the app compares.
    const hresp = try call(f, &obuf, &reqbuf, &tok, "POST", "/api/file/query/summary/hash", whole);
    var p = try std.json.parseFromSlice(Hash, gpa, hresp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    try std.testing.expectEqualStrings(&md5, p.value.summaryInfoVOList[0].handwriteMd5.?);
}

test "a replaced note releases the old one; a note that does not match its md5 is refused, storing nothing" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.digest_sync = true;
    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const tok = try signedIn(f, &obuf, &reqbuf, "alice", "SN1");

    const first = "first ink";
    const first_md5 = md5Hex(first);
    const inner1 = try uploadNote(f, &obuf, &reqbuf, &tok, first);
    const body1 = try noteAdd(gpa, &inner1, &first_md5, "u-rep");
    defer gpa.free(body1);
    const id = try addId(f, &obuf, &reqbuf, &tok, "/api/file/add/summary", body1);

    // Redrawn on the tablet: a new upload named in the update.
    const second = "second ink, redrawn";
    const second_md5 = md5Hex(second);
    const inner2 = try uploadNote(f, &obuf, &reqbuf, &tok, second);
    {
        const upd = try std.fmt.allocPrint(gpa,
            \\{{"id":{d},"commentHandwriteName":"6003a8c1725a175c14868baedd7133a1.mark","content":"x","handwriteInnerName":"{s}","handwriteMD5":"{s}","md5Hash":"m2","metadata":"{{\"unique_identifier\":\"u-rep\"}}","sourceType":1}}
        , .{ id, &inner2, &second_md5 });
        defer gpa.free(upd);
        try expectSuccess((try call(f, &obuf, &reqbuf, &tok, "PUT", "/api/file/update/summary", upd)).body);
    }
    try std.testing.expectEqual(@as(?i64, 1), try refcount(f, &second_md5));
    try std.testing.expectEqual(@as(?i64, null), try refcount(f, &first_md5)); // reaped
    try std.testing.expectEqualStrings(second, (try fetchNote(f, &obuf, &reqbuf, &tok, id)).body);

    // An upload that is not what the md5 says: refused, and nothing changes.
    const third = "third ink";
    const inner3 = try uploadNote(f, &obuf, &reqbuf, &tok, third);
    {
        const upd = try std.fmt.allocPrint(gpa,
            \\{{"id":{d},"content":"x","handwriteInnerName":"{s}","handwriteMD5":"{s}","md5Hash":"m3","sourceType":1}}
        , .{ id, &inner3, &first_md5 });
        defer gpa.free(upd);
        try expectFailure((try call(f, &obuf, &reqbuf, &tok, "PUT", "/api/file/update/summary", upd)).body, "HASH_MISMATCH");
    }
    try std.testing.expectEqual(@as(?i64, 1), try refcount(f, &second_md5));
    try std.testing.expectEqualStrings(second, (try fetchNote(f, &obuf, &reqbuf, &tok, id)).body);

    // An update naming an upload that never arrived is refused too.
    {
        const upd = try std.fmt.allocPrint(gpa,
            \\{{"id":{d},"content":"x","handwriteInnerName":"0000000000000000","handwriteMD5":"{s}","md5Hash":"m4","sourceType":1}}
        , .{ id, &first_md5 });
        defer gpa.free(upd);
        try expectFailure((try call(f, &obuf, &reqbuf, &tok, "PUT", "/api/file/update/summary", upd)).body, "NO_CONTENT");
    }
}

test "a note's upload can never be filed as a document, and tokens do not cross between files and notes" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.digest_sync = true;
    var obuf: [16384]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const tok = try signedIn(f, &obuf, &reqbuf, "alice", "SN1");

    const note = "ink";
    const md5 = md5Hex(note);
    const inner = try uploadNote(f, &obuf, &reqbuf, &tok, note);
    {
        const fin = try std.fmt.allocPrint(gpa,
            \\{{"innerName":"{s}","content_hash":"{s}","path":"/Note/","fileName":"x.note","equipmentNo":"SN1","size":"3"}}
        , .{ &inner, &md5 });
        defer gpa.free(fin);
        const resp = try call(f, &obuf, &reqbuf, &tok, "POST", "/api/file/2/files/upload/finish", fin);
        try expectFailure(resp.body, "NOT_FOUND");
    }
    var r = (try f.ctx.db.row("SELECT COUNT(*) FROM files WHERE name = 'x.note';", &.{})).?;
    defer r.finalize();
    try std.testing.expectEqual(@as(i64, 0), r.int(0));

    // A note's token for digest N is refused on the file route for id N.
    const body = try noteAdd(gpa, &inner, &md5, "u-tok");
    defer gpa.free(body);
    const id = try addId(f, &obuf, &reqbuf, &tok, "/api/file/add/summary", body);
    var tbuf: [256]u8 = undefined;
    const t = blk: {
        const b = try std.fmt.allocPrint(gpa, "{{\"id\":{d}}}", .{id});
        defer gpa.free(b);
        const resp = try call(f, &obuf, &reqbuf, &tok, "POST", "/api/file/download/summary", b);
        var p = try std.json.parseFromSlice(struct { url: []const u8 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        const q = std.mem.indexOf(u8, p.value.url, "?t=").?;
        const v = p.value.url[q + 3 ..];
        @memcpy(tbuf[0..v.len], v);
        break :blk tbuf[0..v.len];
    };
    var pbuf: [256]u8 = undefined;
    const file_path = try std.fmt.bufPrint(&pbuf, "/oss/get/{d}?t={s}", .{ id, t });
    const resp = try roundtrip(&f.ctx, try buildRequest(&reqbuf, "GET", file_path, &.{}, ""), &obuf);
    try std.testing.expectEqual(@as(u16, 403), resp.status);
}

test "a category sent without an id gets one, with a md5 the tablet lacks, so its next sync copies the id" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.digest_sync = true;
    var obuf: [65536]u8 = undefined;
    var reqbuf: [8192]u8 = undefined;
    const alice = try signedIn(f, &obuf, &reqbuf, "alice", "SN1");

    // The Nov 2026 shape: a category the tablet itself holds with a null id.
    const id = try addId(f, &obuf, &reqbuf, &alice, "/api/file/add/summary/group",
        \\{"uniqueIdentifier":null,"name":"Français","description":"","md5Hash":"tablet-md5","creationTime":1,"lastModifiedTime":1}
    );
    const Group = struct { uid: []const u8, md5: []const u8 };
    const got: Group = blk: {
        const resp = try call(f, &obuf, &reqbuf, &alice, "POST", "/api/file/query/summary/group", whole);
        var p = try std.json.parseFromSlice(Summaries, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 1), p.value.summaryDOList.len);
        const g = p.value.summaryDOList[0];
        try std.testing.expectEqual(@as(usize, 32), g.uniqueIdentifier.?.len);
        try std.testing.expect(!std.mem.eql(u8, "tablet-md5", g.md5Hash));
        break :blk .{ .uid = try gpa.dupe(u8, g.uniqueIdentifier.?), .md5 = try gpa.dupe(u8, g.md5Hash) };
    };
    defer gpa.free(got.uid);
    defer gpa.free(got.md5);

    // A rename still without an id keeps the server's id, and again a md5 the
    // tablet does not have. An empty id is the app's Uncategorized: the same.
    for ([_][]const u8{ "null", "\"\"" }) |sent| {
        const body = try std.fmt.allocPrint(gpa, "{{\"id\":{d},\"uniqueIdentifier\":{s},\"name\":\"Francês\",\"md5Hash\":\"tablet-md5-2\",\"lastModifiedTime\":2}}", .{ id, sent });
        defer gpa.free(body);
        const r = try call(f, &obuf, &reqbuf, &alice, "PUT", "/api/file/update/summary/group", body);
        try std.testing.expectEqual(@as(u16, 200), r.status);
        const resp = try call(f, &obuf, &reqbuf, &alice, "POST", "/api/file/query/summary/group", whole);
        var p = try std.json.parseFromSlice(Summaries, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        const g = p.value.summaryDOList[0];
        try std.testing.expectEqualStrings(got.uid, g.uniqueIdentifier.?);
        try std.testing.expectEqualStrings("Francês", g.name.?);
        try std.testing.expect(!std.mem.eql(u8, "tablet-md5-2", g.md5Hash));
    }

    // With an id, a category is stored exactly as sent.
    _ = try addId(f, &obuf, &reqbuf, &alice, "/api/file/add/summary/group",
        \\{"uniqueIdentifier":"kb-work","name":"Work","md5Hash":"w1","creationTime":1,"lastModifiedTime":1}
    );
    const resp = try call(f, &obuf, &reqbuf, &alice, "POST", "/api/file/query/summary/group", whole);
    var p = try std.json.parseFromSlice(Summaries, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    try std.testing.expectEqualStrings("kb-work", p.value.summaryDOList[1].uniqueIdentifier.?);
    try std.testing.expectEqualStrings("w1", p.value.summaryDOList[1].md5Hash);
}
