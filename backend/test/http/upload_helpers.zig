//! Helpers shared by the `upload_test` tests.

const std = @import("std");
const context = @import("../../http/context.zig");
const Context = context.Context;
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const Response = harness.Response;
const buildRequest = harness.buildRequest;
const roundtrip = harness.roundtrip;

pub const upload_boundary = "----InkholdWebUploadBoundary";

/// `payload` as the one file part of a browser upload. Caller frees.
pub fn buildUploadBody(filename: []const u8, payload: []const u8) ![]u8 {
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

pub fn uploadFile(
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

pub fn uploadFileQuery(
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

pub fn buildUploadRequest(
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

/// The listing-shaped `EntryVO` fields an upload returns (same as `rename`).
pub const UploadedBody = struct {
    kind: []const u8,
    id: []const u8,
    name: []const u8,
    fileType: ?[]const u8 = null,
    fileHash: ?[]const u8 = null,
};
