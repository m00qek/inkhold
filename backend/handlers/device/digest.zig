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
const filesmod = @import("../../services/files.zig");
const blobstore = @import("../../store/blobs.zig");

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
    return store(ctx, req, parsed.value, null);
}

/// PUT /api/file/update/summary
pub fn update(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.digest_sync) return refuse(ctx, req);
    var parsed = json.readBody(DigestWire, ctx.gpa, req) catch return badBody(ctx, req);
    defer parsed.deinit();
    const id = idOf(parsed.value.id) orelse return badBody(ctx, req);
    return store(ctx, req, parsed.value, id);
}

/// An add (`id` null) or an update, with its handwritten note, in one
/// transaction: the note's upload is claimed (or the digest's current note
/// kept) and a replaced note's reference released together with the row.
fn store(ctx: *Context, req: *Request, w: DigestWire, update_id: ?u64) anyerror!void {
    const user_id = ctx.caller.?.user_id;
    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    var d = digestOf(a, w) orelse return badBody(ctx, req);
    const now = nowMs(ctx);

    ctx.db.exec("BEGIN IMMEDIATE;") catch return serverError(ctx, req);
    var committed = false;
    defer if (!committed) ctx.db.exec("ROLLBACK;") catch {};

    // The digest this lands on, if it exists: the updated one, or the live one
    // a resent add (same uid) folds into.
    const target: ?u64 = update_id orelse if (d.uid) |uid|
        (digest.liveDigestId(ctx.db, user_id, uid) catch return serverError(ctx, req))
    else
        null;
    const old: ?digest.Handwriting = if (target) |t|
        (digest.handwriting(ctx.db, a, user_id, t) catch return serverError(ctx, req))
    else
        null;
    if (update_id != null and old == null) return notFound(ctx, req);

    switch (resolveHandwriting(ctx, a, user_id, &d, w, old) catch return serverError(ctx, req)) {
        .ok => {},
        .upload_missing => return fail(ctx, req, .ok, "NO_CONTENT", "the handwritten note was not uploaded"),
        .mismatch => return fail(ctx, req, .ok, "HASH_MISMATCH", "the handwritten note does not match its md5"),
    }
    var remove: ?[]const u8 = null;
    if (old) |o| if (o.inner_name != null) if (o.md5) |old_md5| {
        const kept = d.handwrite_inner_name != null and d.handwrite_md5 != null and std.mem.eql(u8, d.handwrite_md5.?, old_md5);
        if (!kept) {
            if (ctx.files.releaseBlob(old_md5) catch return serverError(ctx, req)) remove = old_md5;
        }
    };

    var id: u64 = undefined;
    if (update_id) |uid| {
        if (!(digest.putDigest(ctx.db, user_id, uid, d, now) catch return serverError(ctx, req))) return notFound(ctx, req);
        id = uid;
    } else {
        id = digest.addDigest(ctx.db, user_id, d, now) catch return serverError(ctx, req);
    }
    ctx.db.exec("COMMIT;") catch return serverError(ctx, req);
    committed = true;
    if (remove) |m| ctx.files.removeBlobFiles(m);

    if (update_id == null)
        return json.respond(ctx.gpa, req, .ok, IdVO{ .id = id }, null);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

const HandwritingOutcome = enum { ok, upload_missing, mismatch };

/// Decides what `d` stores for its handwritten note. A row holds a reference
/// to the note's blob exactly when `handwrite_inner_name` is set, which only a
/// claimed upload does; anything else is the md5 as the app sent it.
fn resolveHandwriting(ctx: *Context, a: std.mem.Allocator, user_id: u64, d: *digest.Digest, w: DigestWire, old: ?digest.Handwriting) !HandwritingOutcome {
    const sent_md5 = w.handwriteMD5;
    const held = if (old) |o| (if (o.inner_name != null) o else null) else null;
    const keeps_held = held != null and sent_md5 != null and held.?.md5 != null and std.ascii.eqlIgnoreCase(held.?.md5.?, sent_md5.?);

    const inner = w.handwriteInnerName orelse "";
    if (inner.len > 0) {
        if (try ctx.files.claimUploadedBlob(a, user_id, inner)) |md5| {
            if (sent_md5) |m| if (!std.ascii.eqlIgnoreCase(m, md5)) return .mismatch;
            d.handwrite_md5 = md5;
            d.handwrite_inner_name = inner;
            return .ok;
        }
        // No such upload: a resend after the claim, when the digest already
        // holds exactly this note; otherwise the upload never arrived.
        if (!keeps_held) return .upload_missing;
    }
    if (keeps_held) {
        d.handwrite_md5 = held.?.md5;
        d.handwrite_inner_name = held.?.inner_name;
    } else {
        d.handwrite_inner_name = null;
    }
    return .ok;
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
/// note, as a short-lived token URL (as `download_v3` gives for files).
pub fn download(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.digest_sync) return refuse(ctx, req);
    const user_id = ctx.caller.?.user_id;
    var host_buf: [256]u8 = undefined;
    const host = router.headerCopy(req, "host", &host_buf);
    var parsed = json.readBody(IdReq, ctx.gpa, req) catch return badBody(ctx, req);
    defer parsed.deinit();
    const id = idOf(parsed.value.id) orelse return badBody(ctx, req);
    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const hw = (digest.handwriting(ctx.db, a, user_id, id) catch return serverError(ctx, req)) orelse return notFound(ctx, req);
    if (hw.inner_name == null or hw.md5 == null) return notFound(ctx, req);
    const tokens = ctx.download_tokens orelse return serverError(ctx, req);
    const tok = tokens.mint(ctx.io, id | token_kind_digest, user_id, nowMs(ctx)) catch return serverError(ctx, req);
    const scheme = if (ctx.config.tls.enabled) "https" else "http";
    const url = try std.fmt.allocPrint(a, "{s}://{s}/api/oss/summary/{d}?t={s}", .{ scheme, host, id, &tok });
    try json.respond(ctx.gpa, req, .ok, struct { success: bool = true, url: []const u8 }{ .url = url }, null);
}

/// A download token for digest `id` is minted for `id | token_kind_digest`,
/// so it can never fetch the file with the same number, nor a file's token
/// a digest's note (`download_tokens` matches the id exactly).
const token_kind_digest: u64 = 1 << 62;

/// GET /api/oss/summary/:id?t=<token>: a digest's handwritten note. `.public`,
/// authorized by the token `download` minted; any failure is 403 (a 401 logs
/// the device out).
pub fn serveNote(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const id = reply.pathId(params) orelse return reply.notFound(req);
    const tokens = ctx.download_tokens orelse return reply.forbidden(req);
    const t = reply.queryParam(req.head.target, "t") orelse return reply.forbidden(req);
    const user_id = tokens.lookup(ctx.io, t, id | token_kind_digest, nowMs(ctx)) orelse return reply.forbidden(req);

    var md5_buf: [64]u8 = undefined;
    const md5: []const u8 = blk: {
        var arena = std.heap.ArenaAllocator.init(ctx.gpa);
        defer arena.deinit();
        ctx.lockDb();
        defer ctx.unlockDb();
        const hw = (digest.handwriting(ctx.db, arena.allocator(), user_id, id) catch return serverError(ctx, req)) orelse
            return reply.notFound(req);
        const m = hw.md5 orelse return reply.notFound(req);
        if (hw.inner_name == null or m.len > md5_buf.len) return reply.notFound(req);
        @memcpy(md5_buf[0..m.len], m);
        break :blk md5_buf[0..m.len];
    };

    var file = ctx.files.blobs.open(md5) catch return reply.notFound(req);
    defer file.close(ctx.io);
    const size = ctx.files.blobs.sizeOf(md5) catch return reply.notFound(req);
    var cd_buf: [96]u8 = undefined;
    const cd = std.fmt.bufPrint(&cd_buf, "attachment; filename=\"{s}.mark\"", .{md5}) catch return serverError(ctx, req);

    var wbuf: [blobstore.chunk_len]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .content_length = size,
        .respond_options = .{ .extra_headers = &.{
            .{ .name = "content-type", .value = "application/octet-stream" },
            .{ .name = "content-disposition", .value = cd },
        } },
    }) catch return;
    var rbuf: [blobstore.chunk_len]u8 = undefined;
    var fr = file.reader(ctx.io, &rbuf);
    fr.interface.streamExact64(&body.writer, size) catch return error.StreamTruncated;
    body.end() catch {};
}

/// POST /api/file/upload/apply/summary: a place to upload a handwritten note.
/// The app then POSTs it (multipart) to the returned URL, `/oss/put` under
/// `/api/`, and names the upload in its add or update. The prefix matters: the
/// app's `replaceHost` moves only `/api/oss/` URLs onto its configured address.
pub fn uploadApply(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.digest_sync) return refuse(ctx, req);
    const user_id = ctx.caller.?.user_id;
    var host_buf: [256]u8 = undefined;
    const host = router.headerCopy(req, "host", &host_buf);
    var parsed = json.readBody(struct { fileName: ?[]const u8 = null, equipmentNo: ?[]const u8 = null }, ctx.gpa, req) catch
        return badBody(ctx, req);
    defer parsed.deinit();
    const name = parsed.value.fileName orelse "note.mark";
    if (name.len == 0 or name.len > 255) return badBody(ctx, req);

    var raw: [8]u8 = undefined;
    ctx.io.random(&raw);
    const inner = std.fmt.bytesToHex(raw, .lower);
    ctx.files.createUploadSession(user_id, &inner, filesmod.Files.digest_upload_path, name, max_note_bytes) catch
        return serverError(ctx, req);
    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const scheme = if (ctx.config.tls.enabled) "https" else "http";
    const url = try std.fmt.allocPrint(arena.allocator(), "{s}://{s}/api/oss/put/{s}", .{ scheme, host, &inner });
    try json.respond(ctx.gpa, req, .ok, struct {
        success: bool = true,
        innerName: []const u8,
        fullUploadUrl: []const u8,
        partUploadUrl: []const u8,
    }{ .innerName = &inner, .fullUploadUrl = url, .partUploadUrl = url }, null);
}

/// A handwritten note is one page of ink; this only bounds junk.
const max_note_bytes: u64 = 16 * 1024 * 1024;

// ---- categories ----

/// POST /api/file/add/summary/group
pub fn groupAdd(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.digest_sync) return refuse(ctx, req);
    var parsed = json.readBody(GroupWire, ctx.gpa, req) catch return badBody(ctx, req);
    defer parsed.deinit();
    var g = groupOf(parsed.value) orelse return badBody(ctx, req);
    var heal: Heal = undefined;
    heal.apply(ctx, &g);
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
    var g = groupOf(parsed.value) orelse return badBody(ctx, req);
    var heal: Heal = undefined;
    heal.apply(ctx, &g);
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

/// A category the app sends with no id (or `""`, which is its built-in
/// Uncategorized) gets one, and an `md5Hash` the tablet does not have: the
/// app then sees the server's copy as changed and its next sync copies the id
/// onto the tablet. Its category picker crashes on a null id (schema v24).
const Heal = struct {
    uid: [32]u8,
    md5: [32]u8,

    fn apply(self: *Heal, ctx: *Context, g: *digest.Digest) void {
        if (g.uid) |u| if (u.len != 0) return;
        var raw: [16]u8 = undefined;
        ctx.io.random(&raw);
        self.uid = std.fmt.bytesToHex(raw, .lower);
        var h = std.crypto.hash.Md5.init(.{});
        h.update(&self.uid);
        h.update(g.md5_hash);
        var digest_bytes: [std.crypto.hash.Md5.digest_length]u8 = undefined;
        h.final(&digest_bytes);
        self.md5 = std.fmt.bytesToHex(digest_bytes, .lower);
        g.uid = &self.uid;
        g.md5_hash = &self.md5;
    }
};

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
