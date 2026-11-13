//! The browser's Digest: `/api/controlplane/digests…`, the signed-in person's
//! own digests and categories, as their tablet's app synced them
//! (`services/digest_web.zig`). The browser changes a digest's typed comment
//! and its category, deletes it to the bin and restores it, and makes,
//! renames and deletes categories; the tablet takes each at its next sync
//! (`digest.applyWebEdit`, `digest/web_categories.zig` and `digest/bin.zig`
//! say why). Everything else, the handwritten note included, is the tablet's
//! alone. Off with `config.digest_sync`, like the tablet's side: the listings
//! then say `enabled: false` and a change is refused.

const std = @import("std");
const router = @import("../http/router.zig");
const context = @import("../http/context.zig");
const json = @import("../http/json.zig");
const reply = @import("../http/reply.zig");
const digest = @import("../services/digest.zig");
const digestweb = @import("../services/digest_web.zig");
const digest_purge = @import("../services/digest_purge.zig");
const tablet_path = @import("../services/tablet_path.zig");
const controlplane = @import("../services/controlplane.zig");
const read = @import("controlplane/read.zig");

const Context = context.Context;
const Request = router.Request;
const Params = router.Params;
const fail = reply.fail;
const badRequest = reply.badRequest;
const serverError = reply.serverError;

/// The app's own limit on a comment (`KnowledgeFieldNameConstants`), in characters.
const max_comment_chars = 2_000;
/// The app's own limit on a category name (`CreateKnowledgeBaseDialog`), in characters.
const max_name_chars = 150;

// ---- bodies ----

const CategoryVO = struct { uid: []const u8, name: []const u8 };

const SourceVO = struct {
    kind: digestweb.Kind,
    /// The file's path under the tablet's storage, as the app sent it.
    path: ?[]const u8 = null,
    /// That file in the library, when it is found there.
    fileId: ?u64 = null,
    /// 1-based.
    page: ?i64 = null,
    /// The library's file is not the size it was when the passage was taken:
    /// it has changed since, and the page may no longer hold the passage.
    changed: bool = false,
};

const DigestVO = struct {
    id: u64,
    text: []const u8,
    comment: ?[]const u8,
    /// '' is Uncategorized.
    categoryUid: []const u8,
    author: ?[]const u8,
    /// Epoch ms, the tablet's clock.
    createdAt: i64,
    modifiedAt: i64,
    source: SourceVO,
    /// The handwritten note's md5, which names its page; absent: none.
    note: ?[]const u8,
    /// Its comment or category changed here and no tablet has fetched it yet.
    waiting: bool,
};

const DigestsVO = struct {
    success: bool = true,
    enabled: bool,
    categories: []const CategoryVO = &.{},
    digests: []const DigestVO = &.{},
    /// Epoch ms; absent until a tablet has asked for these digests.
    tabletSyncedAt: ?i64 = null,
    /// Something changed here that no tablet has fetched yet: a digest or a
    /// category, made, edited, deleted or restored.
    waiting: bool = false,
};

const BinDigestVO = struct {
    id: u64,
    text: []const u8,
    /// The category it was in; '' Uncategorized.
    categoryUid: []const u8,
    /// That category's name, live or deleted; absent: Uncategorized, or gone
    /// for good. A restore puts the digest back there, bringing a deleted one back.
    categoryName: ?[]const u8,
    /// Epoch ms.
    deletedAt: i64,
    /// The tablet brought it back already, as a new digest: no restore.
    back: bool,
};

const BinVO = struct {
    success: bool = true,
    enabled: bool,
    digests: []const BinDigestVO = &.{},
    /// How long the bin keeps a digest, set for the files' bin too.
    retentionDays: i64 = 0,
};

const NameReq = struct { name: []const u8 };
const CategoryCreatedVO = struct { success: bool = true, uid: []const u8, name: []const u8 };
const CategoryDeletedVO = struct { success: bool = true, digests: u64 };

/// Absent fields stay; at least one is given. `comment` "" removes the
/// comment; `categoryUid` "" is Uncategorized.
const EditReq = struct { comment: ?[]const u8 = null, categoryUid: ?[]const u8 = null };

// ---- handlers ----

/// GET /api/controlplane/digests
pub fn list(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.digest_sync) return json.respond(ctx.gpa, req, .ok, DigestsVO{ .enabled = false }, null);
    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const user_id = ctx.caller.?.user_id;

    const groups = digest.groups(ctx.db, a, user_id) catch return serverError(ctx, req);
    var categories: std.ArrayList(CategoryVO) = .empty;
    // A category without an id can hold no digest (v24 gave every stored one an id).
    // Nor one whose id is empty, which would pose as Uncategorized.
    for (groups) |g| if (g.uid) |uid| if (uid.len > 0) try categories.append(a, .{ .uid = uid, .name = g.name orelse "" });

    const rows = digest.digestsPage(ctx.db, a, user_id, null, 1, std.math.maxInt(u32)) catch return serverError(ctx, req);
    const listed = digest.tabletListedAt(ctx.db, user_id) catch return serverError(ctx, req);
    const changed = digest.changedSince(ctx.db, a, user_id, listed) catch return serverError(ctx, req);
    const pending = digest.webChangedSince(ctx.db, user_id, listed) catch return serverError(ctx, req);
    const digests = try a.alloc(DigestVO, rows.len);
    var files: LibraryFiles = .{ .ctx = ctx, .a = a, .user_id = user_id };
    for (rows, digests) |d, *o| {
        const src = digestweb.sourceOf(a, d);
        o.* = .{
            .id = d.id,
            .text = d.content orelse "",
            .comment = listedComment(d.comment_str),
            .categoryUid = d.parent_uid,
            .author = digestweb.authorOf(a, d),
            .createdAt = if (d.creation_time > 0) d.creation_time else d.created_at,
            .modifiedAt = if (d.last_modified_time > 0) d.last_modified_time else d.updated_at,
            .source = sourceVO(src, try files.of(src.path)),
            .note = digestweb.servableNote(d),
            .waiting = std.mem.indexOfScalar(u64, changed, d.id) != null,
        };
    }
    try json.respond(ctx.gpa, req, .ok, DigestsVO{
        .enabled = true,
        .categories = categories.items,
        .digests = digests,
        .tabletSyncedAt = listed,
        .waiting = pending,
    }, null);
}

/// PUT /api/controlplane/digests/:id {comment?, categoryUid?}: the digest's
/// typed comment ("" for none) and the category it is in ("" Uncategorized).
/// Only those: the tablet owns every other field.
pub fn edit(ctx: *Context, req: *Request, params: Params) anyerror!void {
    if (!ctx.config.digest_sync) return off(ctx, req);
    const id = reply.pathId(params) orelse return noDigest(ctx, req);
    var parsed = json.readBody(EditReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const v = parsed.value;
    if (v.comment == null and v.categoryUid == null) return badRequest(ctx, req);
    var change: digest.WebEdit = .{};
    if (v.comment) |c| change.comment = cleanComment(c) orelse return badComment(ctx, req);
    if (v.categoryUid) |uid| {
        if (!(digest.categoryExists(ctx.db, ctx.caller.?.user_id, uid) catch return serverError(ctx, req))) return noCategory(ctx, req);
        change.parent_uid = uid;
    }
    const md5 = randomHex(ctx);
    const found = digest.applyWebEdit(ctx.db, ctx.caller.?.user_id, id, change, &md5, nowMs(ctx)) catch return serverError(ctx, req);
    if (!found) return noDigest(ctx, req);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// DELETE /api/controlplane/digests/:id: to the bin. The tablet deletes its
/// copy at its next sync.
pub fn delete(ctx: *Context, req: *Request, params: Params) anyerror!void {
    if (!ctx.config.digest_sync) return off(ctx, req);
    const id = reply.pathId(params) orelse return noDigest(ctx, req);
    const found = digest.deleteFromWeb(ctx.db, ctx.caller.?.user_id, id, nowMs(ctx)) catch return serverError(ctx, req);
    if (!found) return noDigest(ctx, req);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// POST /api/controlplane/digests/categories {name}: a new category, which
/// the tablet adds at its next sync.
pub fn createCategory(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.digest_sync) return off(ctx, req);
    var parsed = json.readBody(NameReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const user_id = ctx.caller.?.user_id;
    const name = cleanName(parsed.value.name) orelse return badName(ctx, req);
    const uid = randomHex(ctx);
    const md5 = randomHex(ctx);
    switch (digest.createCategory(ctx.db, user_id, &uid, name, &md5, nowMs(ctx)) catch return serverError(ctx, req)) {
        .done => {},
        .name_taken => return nameTaken(ctx, req),
    }
    try json.respond(ctx.gpa, req, .ok, CategoryCreatedVO{ .uid = &uid, .name = name }, null);
}

/// PUT /api/controlplane/digests/categories/:uid {name}
pub fn renameCategory(ctx: *Context, req: *Request, params: Params) anyerror!void {
    if (!ctx.config.digest_sync) return off(ctx, req);
    const uid = params.get("uid") orelse return noCategory(ctx, req);
    var parsed = json.readBody(NameReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const user_id = ctx.caller.?.user_id;
    const name = cleanName(parsed.value.name) orelse return badName(ctx, req);
    const md5 = randomHex(ctx);
    switch (digest.renameCategory(ctx.db, user_id, uid, name, &md5, nowMs(ctx)) catch return serverError(ctx, req)) {
        .done => {},
        .name_taken => return nameTaken(ctx, req),
        .not_found => return noCategory(ctx, req),
    }
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// DELETE /api/controlplane/digests/categories/:uid: the category and its
/// digests, which go to the bin, as the tablet's own Delete does.
pub fn deleteCategory(ctx: *Context, req: *Request, params: Params) anyerror!void {
    if (!ctx.config.digest_sync) return off(ctx, req);
    const uid = params.get("uid") orelse return noCategory(ctx, req);
    const n = (digest.deleteGroup(ctx.db, ctx.caller.?.user_id, .{ .uid = uid }, .web, nowMs(ctx)) catch return serverError(ctx, req)) orelse return noCategory(ctx, req);
    try json.respond(ctx.gpa, req, .ok, CategoryDeletedVO{ .digests = n }, null);
}

/// GET /api/controlplane/digests/bin: the deleted digests, the latest first.
pub fn bin(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.digest_sync) return json.respond(ctx.gpa, req, .ok, BinVO{ .enabled = false }, null);
    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const user_id = ctx.caller.?.user_id;
    const rows = digest.binned(ctx.db, a, user_id) catch return serverError(ctx, req);
    const retention_days = controlplane.ControlPlaneService.init(ctx.files).binRetentionDays() catch return serverError(ctx, req);
    const out = try a.alloc(BinDigestVO, rows.len);
    for (rows, out) |r, *o| o.* = .{
        .id = r.digest.id,
        .text = r.digest.content orelse "",
        .categoryUid = r.digest.parent_uid,
        .categoryName = r.category_name,
        .deletedAt = r.deleted_at,
        .back = r.back,
    };
    try json.respond(ctx.gpa, req, .ok, BinVO{ .enabled = true, .digests = out, .retentionDays = retention_days }, null);
}

/// POST /api/controlplane/digests/bin/:id/restore: back where it was, its
/// category too when that was deleted; the tablet fetches it at its next sync.
pub fn restore(ctx: *Context, req: *Request, params: Params) anyerror!void {
    if (!ctx.config.digest_sync) return off(ctx, req);
    const id = reply.pathId(params) orelse return notInBin(ctx, req);
    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const md5 = randomHex(ctx);
    switch (digest.restoreDigest(ctx.db, arena.allocator(), ctx.caller.?.user_id, id, &md5, nowMs(ctx)) catch return serverError(ctx, req)) {
        .restored => try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null),
        .not_in_bin => return notInBin(ctx, req),
        .back_already => return backAlready(ctx, req),
    }
}

/// DELETE /api/controlplane/digests/bin/:id: gone for good, its handwritten
/// note's blob released with it.
pub fn purge(ctx: *Context, req: *Request, params: Params) anyerror!void {
    if (!ctx.config.digest_sync) return off(ctx, req);
    const id = reply.pathId(params) orelse return notInBin(ctx, req);
    if (!(digest_purge.purgeOne(ctx.db, ctx.files.*, ctx.caller.?.user_id, id) catch return serverError(ctx, req))) return notInBin(ctx, req);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

fn sourceVO(src: digestweb.Source, file: ?LibraryFile) SourceVO {
    return .{
        .kind = src.kind,
        .path = src.path,
        .page = src.page,
        .fileId = if (file) |f| f.id else null,
        .changed = if (file) |f| (if (src.size) |s| s != f.size else false) else false,
    };
}

/// GET /api/controlplane/digests/:id/note/:md5 -> the handwritten note's page,
/// as SNPG bytes like any note page. `{md5}` pins the note, so the page is
/// immutable; a replaced note is a new md5 and so a new URL. `manual_db_lock`,
/// streamed unlocked.
pub fn note(ctx: *Context, req: *Request, params: Params) anyerror!void {
    // An id that is not a number names no digest, as on the other routes.
    const id = reply.pathId(params) orelse return reply.notFound(req);
    const md5 = params.get("md5") orelse return reply.notFound(req);
    if (!ctx.config.digest_sync) return reply.notFound(req);
    var svc = controlplane.ControlPlaneService.init(ctx.files);

    const planned = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        var arena = std.heap.ArenaAllocator.init(ctx.gpa);
        defer arena.deinit();
        const rows = digest.digestsByIds(ctx.db, arena.allocator(), ctx.caller.?.user_id, &.{id}) catch return serverError(ctx, req);
        if (rows.len == 0) break :blk null;
        const held = digestweb.servableNote(rows[0]) orelse break :blk null;
        if (!std.mem.eql(u8, held, md5)) break :blk null;
        // A digest's note is a one-page `.mark`.
        break :blk svc.pagePlanForMd5(held, 0) catch return serverError(ctx, req);
    } orelse return reply.notFound(req);

    return read.writePageResponse(ctx, req, svc, planned);
}

// ---- helpers ----

fn off(ctx: *Context, req: *Request) anyerror!void {
    return fail(ctx, req, .conflict, "DIGEST_SYNC_OFF", "Digest sync is off on this server");
}
fn noDigest(ctx: *Context, req: *Request) anyerror!void {
    return fail(ctx, req, .not_found, "NO_SUCH_DIGEST", "there is no such digest");
}
fn noCategory(ctx: *Context, req: *Request) anyerror!void {
    return fail(ctx, req, .not_found, "NO_SUCH_CATEGORY", "there is no such category");
}
fn notInBin(ctx: *Context, req: *Request) anyerror!void {
    return fail(ctx, req, .not_found, "NOT_IN_BIN", "there is no such digest in the bin");
}
fn backAlready(ctx: *Context, req: *Request) anyerror!void {
    return fail(ctx, req, .conflict, "BACK_ALREADY", "the tablet brought this digest back already");
}
fn badName(ctx: *Context, req: *Request) anyerror!void {
    return fail(ctx, req, .bad_request, "BAD_NAME", "a category name holds 1 to 150 characters, does not start with a dot, and has no control character and none of / < > * ? | \\ : \"");
}
fn nameTaken(ctx: *Context, req: *Request) anyerror!void {
    return fail(ctx, req, .conflict, "NAME_TAKEN", "a category with that name exists");
}
fn badComment(ctx: *Context, req: *Request) anyerror!void {
    return fail(ctx, req, .bad_request, "BAD_COMMENT", "a comment holds at most 2000 characters of text");
}

/// A comment without the blank space around it: what is listed and what an
/// edit keeps, the one rule for both (the browser's `trimComment` is its copy).
fn trimmed(c: []const u8) []const u8 {
    return std.mem.trim(u8, c, " \t\r\n");
}

/// A comment as listed, without the blank space the tablet may have left
/// around it; null when there is none.
fn listedComment(c: ?[]const u8) ?[]const u8 {
    const t = trimmed(c orelse return null);
    return if (t.len == 0) null else t;
}

/// The comment as an edit keeps it; null when it is not text or longer than
/// the app holds.
fn cleanComment(v: []const u8) ?[]const u8 {
    const t = trimmed(v);
    const n = std.unicode.utf8CountCodepoints(t) catch return null;
    return if (n > max_comment_chars) null else t;
}

/// A category name as the app takes one (`CreateKnowledgeBaseDialog`):
/// trimmed, 1 to 150 characters, not starting with a dot, and none of the
/// characters a file name may not hold. Nor a control character, which the
/// tablet's keyboard cannot type and a one-line name cannot show. Null when
/// it is not one.
fn cleanName(v: []const u8) ?[]const u8 {
    const t = trimmed(v);
    const n = std.unicode.utf8CountCodepoints(t) catch return null;
    if (n == 0 or n > max_name_chars or t[0] == '.') return null;
    if (std.mem.indexOfAny(u8, t, "/<>*?|\\:\"") != null) return null;
    for (t) |c| if (c < 0x20 or c == 0x7f) return null;
    return t;
}

/// 32 random hex digits: a new uid, or an md5 the tablet has not seen.
fn randomHex(ctx: *Context) [32]u8 {
    var raw: [16]u8 = undefined;
    ctx.io.random(&raw);
    return std.fmt.bytesToHex(raw, .lower);
}

fn nowMs(ctx: *Context) i64 {
    return std.Io.Clock.real.now(ctx.io).toMilliseconds();
}

const LibraryFile = struct { id: u64, size: u64 };

/// The library's files that digests name by their tablet path, each looked
/// up once per listing: a document's many digests share one.
const LibraryFiles = struct {
    ctx: *Context,
    a: std.mem.Allocator,
    user_id: u64,
    seen: std.StringHashMapUnmanaged(?LibraryFile) = .empty,

    /// Null when the file is not in the library (not synced, or moved since).
    fn of(self: *LibraryFiles, path: ?[]const u8) std.mem.Allocator.Error!?LibraryFile {
        const p = path orelse return null;
        const got = try self.seen.getOrPut(self.a, p);
        if (!got.found_existing) got.value_ptr.* = self.find(p);
        return got.value_ptr.*;
    }

    fn find(self: *LibraryFiles, path: []const u8) ?LibraryFile {
        const p = tablet_path.fromStorage(self.a, path) orelse return null;
        const id = (self.ctx.files.resolvePath(self.user_id, p) catch return null) orelse return null;
        const entry = (self.ctx.files.get(self.user_id, id) catch return null) orelse return null;
        defer entry.deinit(self.ctx.gpa);
        return .{ .id = id, .size = entry.size };
    }
};
