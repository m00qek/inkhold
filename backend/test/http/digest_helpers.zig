//! Helpers shared by the Digest tests: the tablet's side of the sync, as the
//! app sends it, so the browser's tests start from what a tablet stored.

const std = @import("std");
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const Fixture = harness.Fixture;
const buildMultipart = @import("device_helpers.zig").buildMultipart;

/// The Nomad's highlight in a PDF, as `AddKnowledgeRequest`.
pub const nomad_add =
    \\{"commentHandwriteName":"6003a8c1725a175c14868baedd7133a1.mark","commentStr":"yeah","content":"La phonétique du français","creationTime":1794175867249,"dataSource":null,"handwriteInnerName":null,"handwriteMD5":"245354713d4c121a2368d9295f6379ca","lastModifiedTime":1794176056052,"md5Hash":"187a8bd48f89d12a78b3198a166d494a","metadata":"{\"document_location_data\":\"[{\\\"chapter\\\":0,\\\"endPosition\\\":50,\\\"page\\\":0,\\\"startPosition\\\":26}]\",\"source_size\":407277,\"unique_identifier\":\"c1ad0a49d44c62dc94b8f71448b3da5a\",\"author\":\"john\"}","parentUniqueIdentifier":"","sourcePath":"MyStyle/Français/La_phonetique_du_francais_Prof_Flavio_Adler.pdf","sourceType":1,"tags":null}
;

/// A device call that must answer 200.
pub fn call(f: *Fixture, obuf: []u8, reqbuf: []u8, tok: *const [32]u8, method: []const u8, path: []const u8, body: []const u8) !harness.Response {
    const resp = try harness.deviceRequest(&f.ctx, obuf, reqbuf, method, path, tok, "SN1", body);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    return resp;
}

/// An `add/…` call; returns the id the server gave.
pub fn addId(f: *Fixture, obuf: []u8, reqbuf: []u8, tok: *const [32]u8, path: []const u8, body: []const u8) !u64 {
    const resp = try call(f, obuf, reqbuf, tok, "POST", path, body);
    var p = try std.json.parseFromSlice(struct { success: bool, id: u64 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    try std.testing.expect(p.value.success);
    return p.value.id;
}

pub fn md5Hex(bytes: []const u8) [32]u8 {
    var d: [16]u8 = undefined;
    std.crypto.hash.Md5.hash(bytes, &d, .{});
    return std.fmt.bytesToHex(d, .lower);
}

/// `upload/apply/summary`, then the multipart POST to the URL it gives, as
/// the app does; returns the upload's inner name.
pub fn uploadNote(f: *Fixture, obuf: []u8, reqbuf: []u8, tok: *const [32]u8, bytes: []const u8) ![16]u8 {
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
    const req = try harness.buildRequest(reqbuf, "POST", path, &.{
        .{ .name = "content-type", .value = ct },
        .{ .name = "x-access-token", .value = tok },
        .{ .name = "equipmentNo", .value = "SN1" },
    }, wire);
    const resp = try harness.roundtrip(&f.ctx, req, obuf);
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    return inner;
}

/// An add for a digest holding the uploaded note `inner` (md5 `md5`).
/// Caller frees.
pub fn noteAdd(alloc: std.mem.Allocator, inner: []const u8, md5: []const u8, uid: []const u8) ![]u8 {
    return std.fmt.allocPrint(alloc,
        \\{{"commentHandwriteName":"6003a8c1725a175c14868baedd7133a1.mark","commentStr":"yeah","content":"x","handwriteInnerName":"{s}","handwriteMD5":"{s}","md5Hash":"m1","metadata":"{{\"unique_identifier\":\"{s}\"}}","parentUniqueIdentifier":"","sourceType":1}}
    , .{ inner, md5, uid });
}
