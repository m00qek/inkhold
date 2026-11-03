//! Rename and web upload.

const std = @import("std");
const router = @import("../../http/router.zig");
const context = @import("../../http/context.zig");
const json = @import("../../http/json.zig");
const reply = @import("../../http/reply.zig");
const controlplane = @import("../../services/controlplane.zig");
const multipart = @import("../../http/multipart.zig");
const upload_cap = @import("../upload_cap.zig");
const blobstore = @import("../../store/blobs.zig");
const Context = context.Context;
const Request = router.Request;
const Params = router.Params;
const fail = reply.fail;
const badRequest = reply.badRequest;
const serverError = reply.serverError;

/// Fixed category folders the rail navigates by and the device re-provisions.
/// Must match webapp `rail.ts` `CATEGORIES`. Nothing marks them in the DB, so the
/// guard matches exact-case names: roots at `parent_id == null`, anchors as
/// `[root-level parent, entry]`.
const category_roots = [_][]const u8{ "NOTE", "DOCUMENT", "EXPORT", "SCREENSHOT", "INBOX" };

const category_anchors = [_][2][]const u8{
    .{ "NOTE", "Note" },
    .{ "NOTE", "MyStyle" },
    .{ "DOCUMENT", "Document" },
};

fn isCategoryRoot(name: []const u8) bool {
    for (category_roots) |r| if (std.mem.eql(u8, name, r)) return true;
    return false;
}

fn isCategoryAnchor(parent_name: []const u8, name: []const u8) bool {
    for (category_anchors) |a|
        if (std.mem.eql(u8, a[0], parent_name) and std.mem.eql(u8, a[1], name)) return true;
    return false;
}

const RenameReq = struct { name: []const u8 };

/// POST /api/controlplane/entry/{id}/rename `{name}` (the full filename). A `move`
/// to the current parent with `autorename = false`, so a clash is 409 rather than a
/// " (2)" suffix. 400 empty or '/'; 403 category folder; 404 foreign, missing or
/// trashed. Metadata only.
pub fn controlplaneRename(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const id = reply.pathId(params) orelse return badRequest(ctx, req);

    var parsed = json.readBody(RenameReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const new_name = std.mem.trim(u8, parsed.value.name, " \t\r\n");

    // Validate server-side too; '/' is not a legal filename component.
    if (new_name.len == 0)
        return fail(ctx, req, .bad_request, "INVALID_NAME", "a name can't be empty");
    if (std.mem.indexOfScalar(u8, new_name, '/') != null)
        return fail(ctx, req, .bad_request, "INVALID_NAME", "a name can't contain '/'");

    // `get` hardcodes `deleted = 0`: foreign, missing and trashed are one 404.
    const entry = (files.get(caller.user_id, id) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .not_found, "NOT_FOUND", "no such entry");
    defer ctx.gpa.free(entry.name);
    defer if (entry.md5) |m| ctx.gpa.free(m);

    if (entry.is_folder) {
        if (entry.parent_id) |pid| {
            // An anchor's parent must itself be root-level.
            if (files.get(caller.user_id, pid) catch return serverError(ctx, req)) |parent| {
                defer ctx.gpa.free(parent.name);
                defer if (parent.md5) |m| ctx.gpa.free(m);
                if (parent.parent_id == null and isCategoryAnchor(parent.name, entry.name))
                    return fail(ctx, req, .forbidden, "RESERVED_FOLDER", "this system folder can't be renamed");
            }
        } else if (isCategoryRoot(entry.name)) {
            return fail(ctx, req, .forbidden, "RESERVED_FOLDER", "this system folder can't be renamed");
        }
    }

    const moved = files.move(caller.user_id, id, entry.parent_id, new_name, false) catch |err| switch (err) {
        error.NameConflict => return fail(ctx, req, .conflict, "NAME_TAKEN", "that name is already used here"),
        error.NotFound => return fail(ctx, req, .not_found, "NOT_FOUND", "no such entry"),
        else => return serverError(ctx, req),
    };
    defer ctx.gpa.free(moved.name);
    defer if (moved.md5) |m| ctx.gpa.free(m);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);
    const vo = svc.entryVO(arena.allocator(), caller.user_id, moved) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, vo, null);
}

/// Extensions a web upload accepts: what the device can open, plus `.spd`
/// (device-authored, so absent from Ratta's import list, but restorable from a
/// backup) and the MOBI family (read via the bundled Kindle app). Else 415.
const upload_extensions = [_][]const u8{
    ".note", ".spd",
    ".pdf",  ".epub",
    ".doc",  ".docx",
    ".txt",  ".png",
    ".jpg",  ".jpeg",
    ".webp", ".cbz",
    ".fb2",  ".xps",
    ".mobi", ".azw",
    ".azw3",
};

/// `>` not `>=`: a bare `.pdf` is a dotfile, not a PDF.
fn acceptedUploadExt(name: []const u8) bool {
    for (upload_extensions) |ext| {
        if (name.len > ext.len and std.ascii.endsWithIgnoreCase(name, ext)) return true;
    }
    return false;
}

/// True if `name` is safe as a tree path component; a second gate after
/// `multipart.Prologue`'s basename. Rejects separators, any `..`, control chars
/// (they break the device's path-based protocol) and invalid UTF-8.
fn validUploadName(name: []const u8) bool {
    if (name.len == 0 or name.len > multipart.max_filename) return false;
    if (std.mem.indexOfScalar(u8, name, '/') != null) return false;
    if (std.mem.indexOfScalar(u8, name, '\\') != null) return false;
    if (std.mem.indexOf(u8, name, "..") != null) return false;
    for (name) |c| if (c < 0x20 or c == 0x7F) return false;
    if (!std.unicode.utf8ValidateSlice(name)) return false;
    return true;
}

/// What an upload does when a live file already holds the name. `rename` (the
/// default) keeps both with a ` (n)` suffix; `replace` supersedes via `linkBlob`,
/// so the old file stays a restorable version. Unknown values mean `rename`, so an
/// old or mistyped client never overwrites.
const OnConflict = enum { rename, replace };

/// Read before the body: reading the body invalidates head strings.
fn onConflictFromTarget(target: []const u8) OnConflict {
    const v = reply.queryParam(target, "onConflict") orelse return .rename;
    if (std.ascii.eqlIgnoreCase(v, "replace")) return .replace;
    return .rename; // absent, misspelled, or anything else: never overwrite by accident
}

/// POST /api/controlplane/folder/{id}/upload -> store one multipart file part into
/// the caller's tree (`{id}` may be `root`). No device protocol needed: the Nomad
/// pulls whatever the server holds, so this shares `upload/finish`'s tree-link.
/// `manual_db_lock`: the ingest runs unlocked; the lock covers only the destination
/// lookup, the quota read and the link. Name and type are refused before any byte
/// is stored, and the ingest is capped at remaining quota as bytes arrive.
/// 200 `EntryVO`; 413 quota; 415 type; 400 name; 404 bad destination; 409 when a
/// folder holds the name.
pub fn controlplaneUpload(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);

    // Copy what we need out of the head first; reading the body invalidates it.
    const id_raw = params.get("id") orelse return badRequest(ctx, req);
    var id_buf: [24]u8 = undefined;
    if (id_raw.len == 0 or id_raw.len > id_buf.len) return badRequest(ctx, req);
    @memcpy(id_buf[0..id_raw.len], id_raw);
    const id_str = id_buf[0..id_raw.len];

    const on_conflict = onConflictFromTarget(req.head.target);

    var ct_buf: [256]u8 = undefined;
    const ct = router.headerCopy(req, "content-type", &ct_buf);
    var bnd_buf: [multipart.max_term]u8 = undefined;
    const boundary = multipart.boundaryFromContentType(ct, &bnd_buf) orelse return badRequest(ctx, req);

    // `root` is the library root; anything else must be a live folder this caller
    // owns (`Files.get`: foreign, missing and trashed are one 404).
    var parent: ?u64 = null;
    if (!std.mem.eql(u8, id_str, "root")) {
        const id = std.fmt.parseInt(u64, id_str, 10) catch return badRequest(ctx, req);
        ctx.lockDb();
        const got = files.get(caller.user_id, id);
        ctx.unlockDb();
        const dest = (got catch return serverError(ctx, req)) orelse
            return fail(ctx, req, .not_found, "NOT_FOUND", "no such folder");
        defer ctx.gpa.free(dest.name);
        defer if (dest.md5) |m| ctx.gpa.free(m);
        if (!dest.is_folder) return fail(ctx, req, .not_found, "NOT_FOUND", "no such folder");
        parent = id;
    }

    // There is no declared size to hold the body to, so cap it at the remaining
    // quota `linkBlob` will enforce anyway (see `upload_cap.slack_bytes`).
    const limit = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        const cap = files.capacity(caller.user_id) catch return serverError(ctx, req);
        const remaining: u64 = if (cap.total <= cap.used) 0 else @intCast(cap.total - cap.used);
        break :blk upload_cap.limitFor(remaining);
    };

    var rbuf: [blobstore.chunk_len]u8 = undefined;
    const reader = req.readerExpectContinue(&rbuf) catch return badRequest(ctx, req);

    var pro: multipart.Prologue = .{};
    multipart.readPrologue(reader, &pro) catch return badRequest(ctx, req);
    const name = std.mem.trim(u8, pro.filename(), " \t\r\n");
    if (!validUploadName(name))
        return fail(ctx, req, .bad_request, "INVALID_NAME", "that filename can't be used");
    if (!acceptedUploadExt(name))
        return fail(ctx, req, .unsupported_media_type, "UNSUPPORTED_TYPE", "the Nomad can't open that file type");

    // Stream unlocked into a new blob, never whole in RAM.
    var wbuf: [blobstore.chunk_len]u8 = undefined;
    var ing = files.blobs.beginIngest(&wbuf) catch return serverError(ctx, req);
    var sink = upload_cap.Capped(blobstore.Ingest).init(&ing, limit);
    multipart.streamPart(reader, boundary, &pro, &sink) catch |err| {
        // `abort` drops the temp file, so a refused body leaves nothing on disk.
        ing.abort();
        if (err == error.UploadTooLarge)
            return fail(ctx, req, .payload_too_large, "QUOTA_EXCEEDED", "not enough space");
        return badRequest(ctx, req);
    };
    const res = ing.finish(null) catch {
        ing.abort();
        return serverError(ctx, req);
    };
    ing.deinit();

    // Link it in under the lock. A dedup hit charges zero: quota is per distinct
    // blob per user.
    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);

    var vo: controlplane.EntryVO = undefined;
    {
        ctx.lockDb();
        defer ctx.unlockDb();
        // `replace` is `linkBlob` unmodified, the call `upload/finish` makes.
        const linked = switch (on_conflict) {
            .rename => files.placeUpload(caller.user_id, parent, name, &res.md5, res.size),
            .replace => files.linkBlob(caller.user_id, parent, name, &res.md5, res.size),
        };
        const entry = linked catch |err| {
            // The blob is unreferenced now; drop it unless it deduped (the `putFile` rule).
            if (!res.deduped) files.blobs.remove(&res.md5);
            return switch (err) {
                error.QuotaExceeded => fail(ctx, req, .payload_too_large, "QUOTA_EXCEEDED", "not enough space"),
                error.NameConflict => fail(ctx, req, .conflict, "NAME_TAKEN", "that name is already used here"),
                error.NotAFolder, error.NotFound => fail(ctx, req, .not_found, "NOT_FOUND", "no such folder"),
                else => serverError(ctx, req),
            };
        };
        defer ctx.gpa.free(entry.name);
        defer if (entry.md5) |m| ctx.gpa.free(m);
        // Under the same lock: `entryVO` reads the DB.
        vo = svc.entryVO(arena.allocator(), caller.user_id, entry) catch return serverError(ctx, req);
    }
    try json.respond(ctx.gpa, req, .ok, vo, null);
}
