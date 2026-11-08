//! The tablet's Digest sync: `/api/file/…/summary…`, the calls the Digest app
//! makes (decompiled `KnowledgeApiService`, com.ratta.supernote.knowledge
//! 1.00.133), with the wire shapes of its Gson classes and the envelope of the
//! July capture of the official server. Storage and the rules that keep it
//! safe are `services/digest.zig`.
//!
//! OFF unless `config.digest_sync`: every call is then refused with
//! `success: false` at HTTP 200, which ends the app's sync before it compares
//! anything. An empty listing would instead make it delete every digest it
//! once synced (`processKnowledgeHash`: "server has no data, delete local").
//!
//! The manifest (`query/summary/hash`) and the categories (`query/summary/
//! group`) come as one call with page 0, size 0 and are answered whole,
//! whatever they ask: a digest left out is deleted on the tablet.
//! `query/summary` is paged by the app (1-based, 1000 a page, until a page
//! comes back short) and honours page and size. Deletes always succeed.

const std = @import("std");
const router = @import("../../http/router.zig");
const context = @import("../../http/context.zig");
const json = @import("../../http/json.zig");
const reply = @import("../../http/reply.zig");
const digest = @import("../../services/digest.zig");

const Context = context.Context;
const Request = router.Request;
const Params = router.Params;

const fail = reply.fail;
const serverError = reply.serverError;

pub const unsupported = "DIGEST_SYNC_UNSUPPORTED";
const unsupported_msg = "Digest sync is not supported by this server yet";

/// The app pages `query/summary` 1000 at a time and stops at a short page: a
/// cap below what it asks would end its listing early. This only bounds junk.
const max_page = 5000;

// ---- wire shapes (the app's request classes) ----

/// `AddKnowledgeRequest` / `UpdateKnowledgeRequest` (`id` only on update).
/// `uniqueIdentifier`, `fileId` and `author` are the phone app's and the
/// official spec's; the tablet keeps its uid and author in `metadata`.
const DigestWire = struct {
    id: ?i64 = null,
    uniqueIdentifier: ?[]const u8 = null,
    parentUniqueIdentifier: ?[]const u8 = null,
    content: ?[]const u8 = null,
    dataSource: ?[]const u8 = null,
    sourcePath: ?[]const u8 = null,
    sourceType: ?i64 = null,
    tags: ?[]const u8 = null,
    md5Hash: ?[]const u8 = null,
    metadata: ?[]const u8 = null,
    commentStr: ?[]const u8 = null,
    commentHandwriteName: ?[]const u8 = null,
    handwriteInnerName: ?[]const u8 = null,
    handwriteMD5: ?[]const u8 = null,
    creationTime: ?i64 = null,
    lastModifiedTime: ?i64 = null,
    author: ?[]const u8 = null,
    fileId: ?i64 = null,
};

/// `AddKnowledgeGroupRequest` / `UpdateKnowledgeGroupRequest`.
const GroupWire = struct {
    id: ?i64 = null,
    uniqueIdentifier: ?[]const u8 = null,
    name: ?[]const u8 = null,
    description: ?[]const u8 = null,
    md5Hash: ?[]const u8 = null,
    creationTime: ?i64 = null,
    lastModifiedTime: ?i64 = null,
};

/// `DeleteKnowledge*Request`, `DownloadKnowledgeRequest`.
const IdReq = struct { id: ?i64 = null };
/// `QueryKnowledge*Request`.
const QueryReq = struct {
    page: ?i64 = null,
    size: ?i64 = null,
    parentUniqueIdentifier: ?[]const u8 = null,
    ids: ?[]const i64 = null,
};
const TagReq = struct { id: ?i64 = null, name: ?[]const u8 = null };

// ---- wire shapes (responses) ----

/// `SummaryDO`.
const SummaryOut = struct {
    id: u64,
    userId: u64,
    uniqueIdentifier: ?[]const u8,
    parentUniqueIdentifier: []const u8,
    isSummaryGroup: []const u8,
    name: ?[]const u8,
    description: ?[]const u8,
    content: ?[]const u8,
    sourcePath: ?[]const u8,
    sourceType: ?i64,
    dataSource: ?[]const u8,
    tags: ?[]const u8,
    metadata: ?[]const u8,
    commentStr: ?[]const u8,
    commentHandwriteName: ?[]const u8,
    handwriteInnerName: ?[]const u8,
    handwriteMD5: ?[]const u8,
    md5Hash: []const u8,
    creationTime: i64,
    lastModifiedTime: i64,
    isDeleted: []const u8 = "N",
    createTime: i64,
    updateTime: i64,
};

/// `QueryKnowledgeHashResponse$SummaryInfoVO`.
const InfoOut = struct {
    id: u64,
    userId: u64,
    md5Hash: []const u8,
    handwriteMd5: ?[]const u8,
    commentHandwriteName: ?[]const u8,
    lastModifiedTime: i64,
};

/// `QueryKnowledgeTagResponse$CreatedAt`: a `java.util.Date` as the official
/// server serialises it, field by field.
const DateOut = struct {
    time: i64,
    year: i64,
    month: i64,
    date: i64,
    day: i64,
    hours: i64,
    minutes: i64,
    seconds: i64,
    nanos: i64 = 0,
    timezoneOffset: i64 = 0,
};
const TagOut = struct { id: u64, userId: u64, name: []const u8, uniqueIdentifier: ?[]const u8 = null, createdAt: DateOut };

/// The official listing envelope: totals first, then the list.
const HashVO = struct {
    success: bool = true,
    errorCode: ?[]const u8 = null,
    errorMsg: ?[]const u8 = null,
    totalRecords: i64 = 0,
    totalPages: i64 = 1,
    currentPage: i64 = 1,
    pageSize: i64 = 0,
    summaryInfoVOList: []const InfoOut,
};
const SummaryListVO = struct {
    success: bool = true,
    errorCode: ?[]const u8 = null,
    errorMsg: ?[]const u8 = null,
    totalRecords: i64 = 0,
    totalPages: i64 = 1,
    currentPage: i64 = 1,
    pageSize: i64 = 0,
    summaryDOList: []const SummaryOut,
};
const IdVO = struct { success: bool = true, errorCode: ?[]const u8 = null, errorMsg: ?[]const u8 = null, id: u64 };
const TagListVO = struct { success: bool = true, errorCode: ?[]const u8 = null, errorMsg: ?[]const u8 = null, summaryTagDOList: []const TagOut };

// ---- digests ----

/// POST /api/file/add/summary
pub fn add(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.digest_sync) return refuse(ctx, req);
    var parsed = json.readBody(DigestWire, ctx.gpa, req) catch return badBody(ctx, req);
    defer parsed.deinit();
    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const d = digestOf(arena.allocator(), parsed.value) orelse return badBody(ctx, req);
    const id = digest.addDigest(ctx.db, ctx.caller.?.user_id, d, nowMs(ctx)) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, IdVO{ .id = id }, null);
}

/// PUT /api/file/update/summary
pub fn update(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.digest_sync) return refuse(ctx, req);
    var parsed = json.readBody(DigestWire, ctx.gpa, req) catch return badBody(ctx, req);
    defer parsed.deinit();
    const id = idOf(parsed.value.id) orelse return badBody(ctx, req);
    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const d = digestOf(arena.allocator(), parsed.value) orelse return badBody(ctx, req);
    // Gone on the server meanwhile: the app's next sync finds it missing from
    // the manifest, and an edited digest is then sent again as new.
    const found = digest.putDigest(ctx.db, ctx.caller.?.user_id, id, d, nowMs(ctx)) catch return serverError(ctx, req);
    if (!found) return notFound(ctx, req);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// DELETE /api/file/delete/summary
pub fn delete(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.digest_sync) return refuse(ctx, req);
    var parsed = json.readBody(IdReq, ctx.gpa, req) catch return badBody(ctx, req);
    defer parsed.deinit();
    const id = idOf(parsed.value.id) orelse return badBody(ctx, req);
    digest.deleteDigest(ctx.db, ctx.caller.?.user_id, id, nowMs(ctx)) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// POST /api/file/query/summary/hash: the manifest, whole.
pub fn hash(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.digest_sync) return refuse(ctx, req);
    const user_id = ctx.caller.?.user_id;
    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const rows = digest.manifest(ctx.db, a, user_id) catch return serverError(ctx, req);
    const out = try a.alloc(InfoOut, rows.len);
    for (rows, out) |r, *o| o.* = .{
        .id = r.id,
        .userId = user_id,
        .md5Hash = r.md5_hash,
        .handwriteMd5 = r.handwrite_md5,
        .commentHandwriteName = r.comment_handwrite_name,
        .lastModifiedTime = r.last_modified_time,
    };
    const n: i64 = @intCast(out.len);
    try json.respond(ctx.gpa, req, .ok, HashVO{ .totalRecords = n, .pageSize = n, .summaryInfoVOList = out }, null);
}

/// POST /api/file/query/summary/id: full records for the asked ids; unknown
/// ones are left out.
pub fn byIds(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.digest_sync) return refuse(ctx, req);
    const user_id = ctx.caller.?.user_id;
    var parsed = json.readBody(QueryReq, ctx.gpa, req) catch return badBody(ctx, req);
    defer parsed.deinit();
    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const asked = parsed.value.ids orelse &.{};
    const ids = try a.alloc(u64, asked.len);
    var n: usize = 0;
    for (asked) |i| if (idOf(i)) |id| {
        ids[n] = id;
        n += 1;
    };
    const rows = digest.digestsByIds(ctx.db, a, user_id, ids[0..n]) catch return serverError(ctx, req);
    return respondList(ctx, req, a, user_id, rows, @intCast(rows.len), 1, @intCast(rows.len));
}

/// POST /api/file/query/summary: one page (1-based) of a category, or of all.
pub fn query(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.digest_sync) return refuse(ctx, req);
    const user_id = ctx.caller.?.user_id;
    var parsed = json.readBody(QueryReq, ctx.gpa, req) catch return badBody(ctx, req);
    defer parsed.deinit();
    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const parent = parsed.value.parentUniqueIdentifier;
    const total = digest.digestCount(ctx.db, user_id, parent) catch return serverError(ctx, req);
    // Size 0 (or none): everything, in one page.
    const size: u32 = if (parsed.value.size) |s| (if (s <= 0) max_page else @intCast(@min(s, max_page))) else max_page;
    const page: u32 = if (parsed.value.page) |p| @intCast(std.math.clamp(p, 1, std.math.maxInt(u31))) else 1;
    const rows = digest.digestsPage(ctx.db, a, user_id, parent, page, size) catch return serverError(ctx, req);
    const pages = @max(1, @divFloor(total + size - 1, size));
    return respondListPaged(ctx, req, a, user_id, rows, total, pages, page, size);
}

/// POST /api/file/download/summary: where to fetch a digest's handwritten
/// note. Phase 1 stores none, so there is nothing to fetch yet.
pub fn download(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.digest_sync) return refuse(ctx, req);
    return notFound(ctx, req);
}

// ---- categories ----

/// POST /api/file/add/summary/group
pub fn groupAdd(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.digest_sync) return refuse(ctx, req);
    var parsed = json.readBody(GroupWire, ctx.gpa, req) catch return badBody(ctx, req);
    defer parsed.deinit();
    const g = groupOf(parsed.value) orelse return badBody(ctx, req);
    const id = digest.addGroup(ctx.db, ctx.caller.?.user_id, g, nowMs(ctx)) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, IdVO{ .id = id }, null);
}

/// PUT /api/file/update/summary/group
pub fn groupUpdate(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.digest_sync) return refuse(ctx, req);
    var parsed = json.readBody(GroupWire, ctx.gpa, req) catch return badBody(ctx, req);
    defer parsed.deinit();
    const id = idOf(parsed.value.id) orelse return badBody(ctx, req);
    const g = groupOf(parsed.value) orelse return badBody(ctx, req);
    const found = digest.putGroup(ctx.db, ctx.caller.?.user_id, id, g, nowMs(ctx)) catch return serverError(ctx, req);
    if (!found) return notFound(ctx, req);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// DELETE /api/file/delete/summary/group: the category and its digests.
pub fn groupDelete(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.digest_sync) return refuse(ctx, req);
    var parsed = json.readBody(IdReq, ctx.gpa, req) catch return badBody(ctx, req);
    defer parsed.deinit();
    const id = idOf(parsed.value.id) orelse return badBody(ctx, req);
    digest.deleteGroup(ctx.db, ctx.caller.?.user_id, id, nowMs(ctx)) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// POST /api/file/query/summary/group: every category, whole.
pub fn groupQuery(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.digest_sync) return refuse(ctx, req);
    const user_id = ctx.caller.?.user_id;
    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const rows = digest.groups(ctx.db, a, user_id) catch return serverError(ctx, req);
    return respondList(ctx, req, a, user_id, rows, @intCast(rows.len), 1, @intCast(rows.len));
}

// ---- tags ----

/// POST /api/file/add/summary/tag
pub fn tagAdd(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.digest_sync) return refuse(ctx, req);
    var parsed = json.readBody(TagReq, ctx.gpa, req) catch return badBody(ctx, req);
    defer parsed.deinit();
    const name = parsed.value.name orelse return badBody(ctx, req);
    if (name.len == 0 or name.len > digest.max_field_bytes) return badBody(ctx, req);
    const id = digest.addTag(ctx.db, ctx.caller.?.user_id, name, nowMs(ctx)) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, IdVO{ .id = id }, null);
}

/// PUT /api/file/update/summary/tag
pub fn tagUpdate(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.digest_sync) return refuse(ctx, req);
    var parsed = json.readBody(TagReq, ctx.gpa, req) catch return badBody(ctx, req);
    defer parsed.deinit();
    const id = idOf(parsed.value.id) orelse return badBody(ctx, req);
    const name = parsed.value.name orelse return badBody(ctx, req);
    if (name.len == 0 or name.len > digest.max_field_bytes) return badBody(ctx, req);
    const found = digest.renameTag(ctx.db, ctx.caller.?.user_id, id, name) catch return serverError(ctx, req);
    if (!found) return notFound(ctx, req);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// DELETE /api/file/delete/summary/tag
pub fn tagDelete(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.digest_sync) return refuse(ctx, req);
    var parsed = json.readBody(IdReq, ctx.gpa, req) catch return badBody(ctx, req);
    defer parsed.deinit();
    const id = idOf(parsed.value.id) orelse return badBody(ctx, req);
    digest.deleteTag(ctx.db, ctx.caller.?.user_id, id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// GET /api/file/query/summary/tag
pub fn tagQuery(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.digest_sync) return refuse(ctx, req);
    const user_id = ctx.caller.?.user_id;
    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const rows = digest.tags(ctx.db, a, user_id) catch return serverError(ctx, req);
    const out = try a.alloc(TagOut, rows.len);
    for (rows, out) |t, *o| o.* = .{ .id = t.id, .userId = user_id, .name = t.name, .createdAt = dateOut(t.created_at) };
    try json.respond(ctx.gpa, req, .ok, TagListVO{ .summaryTagDOList = out }, null);
}

// ---- helpers ----

fn refuse(ctx: *Context, req: *Request) anyerror!void {
    return fail(ctx, req, .ok, unsupported, unsupported_msg);
}

/// A body the app would never send: `success: false` at 200, like every
/// refusal here, so its sync stops instead of misreading a status code.
fn badBody(ctx: *Context, req: *Request) anyerror!void {
    return fail(ctx, req, .ok, "BAD_REQUEST", "not a Digest request this server understands");
}

fn notFound(ctx: *Context, req: *Request) anyerror!void {
    return fail(ctx, req, .ok, "SUMMARY_NOT_FOUND", "there is no such digest");
}

fn nowMs(ctx: *Context) i64 {
    return std.Io.Clock.real.now(ctx.io).toMilliseconds();
}

fn idOf(v: ?i64) ?u64 {
    const i = v orelse return null;
    return if (i > 0) @intCast(i) else null;
}

fn fits(s: ?[]const u8, max: usize) bool {
    const v = s orelse return true;
    return v.len <= max;
}

fn digestOf(a: std.mem.Allocator, w: DigestWire) ?digest.Digest {
    if (!fits(w.content, digest.max_content_bytes)) return null;
    if (!fits(w.commentStr, digest.max_comment_bytes)) return null;
    inline for (.{ w.parentUniqueIdentifier, w.dataSource, w.sourcePath, w.tags, w.md5Hash, w.metadata, w.commentHandwriteName, w.handwriteInnerName, w.handwriteMD5, w.uniqueIdentifier, w.author }) |f|
        if (!fits(f, digest.max_field_bytes)) return null;
    return .{
        .uid = w.uniqueIdentifier orelse digest.uidOfMetadata(a, w.metadata),
        .parent_uid = w.parentUniqueIdentifier orelse "",
        .content = w.content,
        .source_path = w.sourcePath,
        .source_type = w.sourceType,
        .data_source = w.dataSource,
        .author = w.author,
        .tags = w.tags,
        .metadata = w.metadata,
        .comment_str = w.commentStr,
        .comment_handwrite_name = w.commentHandwriteName,
        .handwrite_inner_name = w.handwriteInnerName,
        .handwrite_md5 = w.handwriteMD5,
        .md5_hash = w.md5Hash orelse "",
        .creation_time = w.creationTime orelse 0,
        .last_modified_time = w.lastModifiedTime orelse 0,
    };
}

fn groupOf(w: GroupWire) ?digest.Digest {
    inline for (.{ w.uniqueIdentifier, w.name, w.description, w.md5Hash }) |f|
        if (!fits(f, digest.max_field_bytes)) return null;
    return .{
        .is_group = true,
        .uid = w.uniqueIdentifier,
        .name = w.name,
        .description = w.description,
        .md5_hash = w.md5Hash orelse "",
        .creation_time = w.creationTime orelse 0,
        .last_modified_time = w.lastModifiedTime orelse 0,
    };
}

fn summaryOut(user_id: u64, d: digest.Digest) SummaryOut {
    return .{
        .id = d.id,
        .userId = user_id,
        .uniqueIdentifier = d.uid,
        .parentUniqueIdentifier = d.parent_uid,
        .isSummaryGroup = if (d.is_group) "Y" else "N",
        .name = d.name,
        .description = d.description,
        .content = d.content,
        .sourcePath = d.source_path,
        .sourceType = d.source_type,
        .dataSource = d.data_source,
        .tags = d.tags,
        .metadata = d.metadata,
        .commentStr = d.comment_str,
        .commentHandwriteName = d.comment_handwrite_name,
        .handwriteInnerName = d.handwrite_inner_name,
        .handwriteMD5 = d.handwrite_md5,
        .md5Hash = d.md5_hash,
        .creationTime = d.creation_time,
        .lastModifiedTime = d.last_modified_time,
        .createTime = d.created_at,
        .updateTime = d.updated_at,
    };
}

fn respondList(ctx: *Context, req: *Request, a: std.mem.Allocator, user_id: u64, rows: []const digest.Digest, total: i64, page: u32, size: i64) anyerror!void {
    return respondListPaged(ctx, req, a, user_id, rows, total, 1, page, @intCast(@max(size, 0)));
}

fn respondListPaged(ctx: *Context, req: *Request, a: std.mem.Allocator, user_id: u64, rows: []const digest.Digest, total: i64, pages: i64, page: u32, size: u32) anyerror!void {
    const out = try a.alloc(SummaryOut, rows.len);
    for (rows, out) |d, *o| o.* = summaryOut(user_id, d);
    try json.respond(ctx.gpa, req, .ok, SummaryListVO{
        .totalRecords = total,
        .totalPages = pages,
        .currentPage = page,
        .pageSize = size,
        .summaryDOList = out,
    }, null);
}

/// A `java.util.Date` field by field (UTC): year since 1900, month from 0,
/// `day` the weekday from Sunday.
fn dateOut(ms: i64) DateOut {
    const secs: u64 = @intCast(@max(@divFloor(ms, 1000), 0));
    const es = std.time.epoch.EpochSeconds{ .secs = secs };
    const yd = es.getEpochDay().calculateYearDay();
    const md = yd.calculateMonthDay();
    const ds = es.getDaySeconds();
    const days: i64 = @intCast(es.getEpochDay().day);
    return .{
        .time = ms,
        .year = @as(i64, yd.year) - 1900,
        .month = @as(i64, md.month.numeric()) - 1,
        .date = @as(i64, md.day_index) + 1,
        .day = @mod(days + 4, 7), // 1970-01-01 was a Thursday
        .hours = ds.getHoursIntoDay(),
        .minutes = ds.getMinutesIntoHour(),
        .seconds = ds.getSecondsIntoMinute(),
    };
}

test "a Date the way the app's CreatedAt reads it" {
    // 2026-11-08 19:14:27.249 UTC, a Sunday.
    const d = dateOut(1794165267249);
    try std.testing.expectEqual(@as(i64, 126), d.year);
    try std.testing.expectEqual(@as(i64, 10), d.month);
    try std.testing.expectEqual(@as(i64, 8), d.date);
    try std.testing.expectEqual(@as(i64, 0), d.day);
    try std.testing.expectEqual(@as(i64, 1794165267249), d.time);
}

test "ids: positive only" {
    try std.testing.expectEqual(@as(?u64, null), idOf(null));
    try std.testing.expectEqual(@as(?u64, null), idOf(0));
    try std.testing.expectEqual(@as(?u64, null), idOf(-3));
    try std.testing.expectEqual(@as(?u64, 9), idOf(9));
}
