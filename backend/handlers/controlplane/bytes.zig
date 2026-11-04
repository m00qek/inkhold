//! The byte routes: raw files, thumbnails, templates, page text and links.

const std = @import("std");
const router = @import("../../http/router.zig");
const context = @import("../../http/context.zig");
const json = @import("../../http/json.zig");
const reply = @import("../../http/reply.zig");
const byte_range = @import("../../http/byte_range.zig");
const controlplane = @import("../../services/controlplane.zig");
const blobstore = @import("../../store/blobs.zig");
const thumbnailmod = @import("../../services/thumbnail.zig");
const filesmod = @import("../../services/files.zig");
const config = @import("../../config.zig");
const Context = context.Context;
const Request = router.Request;
const Params = router.Params;
const badRequest = reply.badRequest;
const serverError = reply.serverError;
const read = @import("read.zig");

/// An extension the browser may render inline, and its `Content-Type`.
const InlineType = struct { ext: []const u8, mime: []const u8 };

/// The types `/file/{id}` may serve inline; everything else is `attachment`. This
/// is the endpoint's security boundary: device-authored bytes served same-origin,
/// so inline HTML or SVG would be stored XSS. `svg` is absent on purpose (it can
/// carry script). PDF opens in the browser's sandboxed viewer.
const inline_types = [_]InlineType{
    .{ .ext = "png", .mime = "image/png" },
    .{ .ext = "jpg", .mime = "image/jpeg" },
    .{ .ext = "jpeg", .mime = "image/jpeg" },
    .{ .ext = "webp", .mime = "image/webp" },
    .{ .ext = "gif", .mime = "image/gif" },
    .{ .ext = "pdf", .mime = "application/pdf" },
};

/// Matched on the name's extension alone, never contents; `nosniff` holds the label.
fn inlineTypeOf(name: []const u8) ?InlineType {
    const dot = std.mem.lastIndexOfScalar(u8, name, '.') orelse return null;
    if (dot == 0 or dot + 1 == name.len) return null;
    const ext = name[dot + 1 ..];
    for (inline_types) |t| {
        if (std.ascii.eqlIgnoreCase(ext, t.ext)) return t;
    }
    return null;
}

/// GET /file/{id}?v={md5}[&download=1] -> the file's raw stored bytes, for preview
/// and download alike (including `.note` downloads). Cookie-authed and owner-scoped:
/// a foreign id is a 404, not a 403, so it is no existence oracle. `?v=` must equal
/// the blob md5, which makes `immutable` honest. `manual_db_lock`: one lookup under
/// the lock, then a fixed-buffer stream bounded by `Content-Length`.
pub fn file(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return rawFile(ctx, req, params, .live);
}

/// GET /api/controlplane/bin/file/{id}?v={md5} -> the same raw bytes for a trashed
/// file.
pub fn binFile(ctx: *Context, req: *Request, params: Params) anyerror!void {
    return rawFile(ctx, req, params, .trashed);
}

fn rawFile(ctx: *Context, req: *Request, params: Params, scope: controlplane.ControlPlaneService.ReadScope) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files;
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    // Capture query params BEFORE responding (responding invalidates head strings).
    const v = reply.queryParam(req.head.target, "v");
    const forced_download = if (reply.queryParam(req.head.target, "download")) |d|
        !std.mem.eql(u8, d, "0")
    else
        false;

    // The only DB touch. `rowToEntry` dupes `name` and `md5`, so `entry` is safe
    // after the unlock.
    var svc = controlplane.ControlPlaneService.init(files);
    const got = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        break :blk svc.lookup(scope, caller.user_id, id);
    };
    const entry = (got catch return serverError(ctx, req)) orelse return reply.notFound(req);
    defer entry.deinit(ctx.gpa);
    if (entry.is_folder) return reply.notFound(req);
    const md5 = entry.md5 orelse return reply.notFound(req);
    if (md5.len != blobstore.md5_hex_len) return reply.notFound(req);
    if (v == null or !std.ascii.eqlIgnoreCase(v.?, md5)) return reply.notFound(req);

    return streamRawBlob(ctx, req, entry.name, md5, entry.size, forced_download);
}

/// Streams a resolved raw blob under the `/file/{id}` contract (inline allowlist,
/// `nosniff`, `?download=1`, ranges) with the lock released. The caller resolved
/// `name`, `md5` and `size` and checked ownership.
pub fn streamRawBlob(ctx: *Context, req: *Request, name: []const u8, md5: []const u8, size: u64, forced_download: bool) anyerror!void {
    const files = ctx.files;
    if (md5.len != blobstore.md5_hex_len) return reply.notFound(req);

    const allowed = inlineTypeOf(name);
    const mime = if (allowed) |t| t.mime else "application/octet-stream";
    const disposition = if (allowed != null and !forced_download) "inline" else "attachment";

    var cd_buf: [1024]u8 = undefined;
    const cd = reply.contentDisposition(&cd_buf, disposition, name) catch
        return serverError(ctx, req);

    var etag_buf: [36]u8 = undefined;
    const etag = std.fmt.bufPrint(&etag_buf, "\"{s}\"", .{md5}) catch return serverError(ctx, req);

    // Range support, for the PDF viewer's windowed reads. Blobs are immutable and
    // content-addressed, so there is no `If-Range` to honour.
    var range_buf: [128]u8 = undefined;
    const want = byte_range.parse(router.headerCopy(req, "range", &range_buf), size);
    if (want == .unsatisfiable) {
        var cr_buf: [64]u8 = undefined;
        const cr = std.fmt.bufPrint(&cr_buf, "bytes */{d}", .{size}) catch return serverError(ctx, req);
        return req.respond("", .{
            .status = .range_not_satisfiable,
            .extra_headers = &.{
                .{ .name = "content-range", .value = cr },
                .{ .name = "accept-ranges", .value = "bytes" },
            },
        });
    }

    var blob = files.blobs.open(md5) catch return reply.notFound(req);
    defer blob.close(ctx.io);

    const off: u64 = switch (want) {
        .partial => |p| p.off,
        else => 0,
    };
    const len: u64 = switch (want) {
        .partial => |p| p.len,
        else => size,
    };

    // Built even when unused, because `extra_headers` needs a stable slice.
    var cr_buf: [80]u8 = undefined;
    const content_range = if (want == .partial)
        std.fmt.bufPrint(&cr_buf, "bytes {d}-{d}/{d}", .{ off, off + len - 1, size }) catch
            return serverError(ctx, req)
    else
        "";

    const common = [_]std.http.Header{
        .{ .name = "content-type", .value = mime },
        .{ .name = "content-disposition", .value = cd },
        // The label comes from the name and can be wrong; `nosniff` stops it being
        // sniffed into text/html.
        .{ .name = "x-content-type-options", .value = "nosniff" },
        .{ .name = "cache-control", .value = "public, max-age=31536000, immutable" },
        .{ .name = "etag", .value = etag },
        // On every reply, so a client learns it may ask.
        .{ .name = "accept-ranges", .value = "bytes" },
    };
    const partial_headers = common ++ [_]std.http.Header{.{ .name = "content-range", .value = content_range }};

    var wbuf: [blobstore.chunk_len]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .content_length = len,
        .respond_options = .{
            .status = if (want == .partial) .partial_content else .ok,
            .extra_headers = if (want == .partial) &partial_headers else &common,
        },
    }) catch return;

    // Head already sent: on failure return (closing short of `content_length`),
    // never `body.end()`, which would assert and panic.
    var rbuf: [blobstore.chunk_len]u8 = undefined;
    if (want == .partial) {
        var at: u64 = off;
        var left: u64 = len;
        while (left > 0) {
            const take: usize = @intCast(@min(left, @as(u64, rbuf.len)));
            const chunk = files.blobs.readRange(md5, at, take, rbuf[0..take]) catch return error.StreamTruncated;
            body.writer.writeAll(chunk) catch return error.StreamTruncated;
            at += take;
            left -= take;
        }
    } else {
        var fr = blob.reader(ctx.io, &rbuf);
        fr.interface.streamExact64(&body.writer, size) catch return error.StreamTruncated;
    }
    body.end() catch {};
}

/// GET /thumbnail/{hash} -> the embedded thumbnail of blob `{hash}` (a `.spd`'s
/// `config.thumbnail` or a `.note`'s cover). 404 when there is none or the caller
/// does not hold the blob, indistinguishably. Heals on demand: if
/// `thumbNeedsRepair`, re-derive with the db lock released (lock order is
/// repair-mutex then db-lock, see `Files.thumb_repair`); the row memoizes "no
/// thumbnail" so a bad file is parsed once. Immutable, ETag = hash, `nosniff`.
pub fn thumbnail(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files;
    const hash = params.get("hash") orelse return badRequest(ctx, req);

    // The only handler-held lock window: ownership and the repair gate.
    var svc = controlplane.ControlPlaneService.init(files);
    const gate: struct { allowed: bool, repair: bool } = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        const allowed = svc.thumbnailAllowed(caller.user_id, hash) catch
            break :blk .{ .allowed = false, .repair = false };
        if (!allowed) break :blk .{ .allowed = false, .repair = false };
        break :blk .{ .allowed = true, .repair = files.thumbNeedsRepair(hash) };
    };
    if (!gate.allowed) return reply.notFound(req);

    // Best-effort; a failed repair just 404s below.
    if (gate.repair) files.repairDerivedThumb(ctx, hash);

    // A `.note` cover streams from the blob itself; a `.spd` thumbnail from `thumbs/`.
    switch (files.thumbnailSourceKind(hash)) {
        .note => return streamNoteCover(ctx, req, files, hash),
        .spd => {}, // the stored-thumbnail path below
        .none => return reply.notFound(req),
    }

    var thumb = files.thumbs.open(hash) catch return reply.notFound(req);
    defer thumb.close(ctx.io);
    const size = (thumb.stat(ctx.io) catch return reply.notFound(req)).size;
    if (size == 0) return reply.notFound(req); // defensive: a torn file must not serve

    // Ingest only wrote bytes that pass `sniffMime`, so a failure here is corruption.
    var magic: [16]u8 = undefined;
    const head_len: usize = @intCast(@min(size, magic.len));
    const got = thumb.readPositionalAll(ctx.io, magic[0..head_len], 0) catch return reply.notFound(req);
    if (got != head_len) return reply.notFound(req);
    const mime = thumbnailmod.sniffMime(magic[0..head_len]) orelse return reply.notFound(req);

    // `hash` is 32 hex here (the ownership check passed), so the ETag fits.
    var etag_buf: [36]u8 = undefined;
    const etag = std.fmt.bufPrint(&etag_buf, "\"{s}\"", .{hash}) catch return serverError(ctx, req);

    var wbuf: [blobstore.chunk_len]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .content_length = size,
        .respond_options = .{
            .extra_headers = &.{
                .{ .name = "content-type", .value = mime },
                .{ .name = "x-content-type-options", .value = "nosniff" },
                .{ .name = "cache-control", .value = "public, max-age=31536000, immutable" },
                .{ .name = "etag", .value = etag },
            },
        },
    }) catch return;

    // On failure return short of `content_length`, never `body.end()` (see `rawFile`).
    var rbuf: [blobstore.chunk_len]u8 = undefined;
    var fr = thumb.reader(ctx.io, &rbuf);
    fr.interface.streamExact64(&body.writer, size) catch return error.StreamTruncated;
    body.end() catch {};
}

/// Streams a `.note` cover from the immutable blob at the index-recorded range, a
/// chunk at a time; 404 when the note has none.
fn streamNoteCover(ctx: *Context, req: *Request, files: *filesmod.Files, hash: []const u8) anyerror!void {
    const loc = (files.noteCover(hash) catch return reply.notFound(req)) orelse return reply.notFound(req);
    // The cover's own hash is its blob key.
    return streamBlobRange(ctx, req, files, hash, hash, loc.offset, loc.length, loc.mime());
}

/// Stream a byte range of an immutable blob under the thumbnail/template contract.
/// `etag_hash` equals `blob_key` for a cover but is the URL's `PAGESTYLEMD5` for a
/// template. `readRange` re-validates each window against the real blob size,
/// since the range came from device metadata. On failure return short of
/// `content_length`; `end()` runs only on a full stream.
fn streamBlobRange(
    ctx: *Context,
    req: *Request,
    files: *filesmod.Files,
    blob_key: []const u8,
    etag_hash: []const u8,
    offset: u64,
    length: u64,
    mime: []const u8,
) anyerror!void {
    // `max_template_hash_len` (64) also fits a cover's 32-hex hash.
    var etag_buf: [controlplane.max_template_hash_len + 2]u8 = undefined;
    const etag = std.fmt.bufPrint(&etag_buf, "\"{s}\"", .{etag_hash}) catch return serverError(ctx, req);

    var wbuf: [blobstore.chunk_len]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .content_length = length,
        .respond_options = .{
            .extra_headers = &.{
                .{ .name = "content-type", .value = mime },
                .{ .name = "x-content-type-options", .value = "nosniff" },
                .{ .name = "cache-control", .value = "public, max-age=31536000, immutable" },
                .{ .name = "etag", .value = etag },
            },
        },
    }) catch return;

    var rbuf: [blobstore.chunk_len]u8 = undefined;
    var off: u64 = offset;
    var left: u64 = length;
    while (left > 0) {
        const take: usize = @intCast(@min(left, @as(u64, rbuf.len)));
        const chunk = files.blobs.readRange(blob_key, off, take, rbuf[0..take]) catch return error.StreamTruncated;
        body.writer.writeAll(chunk) catch return error.StreamTruncated;
        off += take;
        left -= take;
    }
    body.end() catch {};
}

/// GET /note/{id}/template/{hash} -> the page's custom image template, streamed from
/// the blob. Note-scoped, content-addressed (immutable, ETag = hash),
/// `manual_db_lock`, and no `.note` parse: the range is read from the page's
/// recorded `layers`. 404 for anything unowned, absent or over the size cap.
pub fn template(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files;
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const hash = params.get("hash") orelse return badRequest(ctx, req);
    // A template hash is PAGESTYLEMD5; an implausible length is a 404.
    if (hash.len == 0 or hash.len > controlplane.max_template_hash_len) return reply.notFound(req);

    var svc = controlplane.ControlPlaneService.init(files);

    // The only DB touches; the plan has no borrow of statement memory.
    const planned = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        const entry = (svc.lookup(.live, caller.user_id, id) catch return serverError(ctx, req)) orelse
            break :blk null;
        defer entry.deinit(ctx.gpa);
        break :blk svc.templatePlanOf(entry, hash) catch return serverError(ctx, req);
    } orelse return reply.notFound(req);

    return streamNoteTemplate(ctx, req, files, planned, hash);
}

/// Streams a resolved template's range, MIME sniffed from its own bytes, capped at
/// `thumbnail.max_cover_bytes`.
fn streamNoteTemplate(
    ctx: *Context,
    req: *Request,
    files: *filesmod.Files,
    plan: controlplane.TemplatePlan,
    hash: []const u8,
) anyerror!void {
    // The cover's 20 MB cap (Ratta removed the device-side limit).
    if (plan.length == 0 or plan.length > thumbnailmod.max_cover_bytes) return reply.notFound(req);

    var magic: [16]u8 = undefined;
    const head_len: usize = @intCast(@min(plan.length, @as(u64, magic.len)));
    const got = files.blobs.readRange(&plan.md5, plan.offset, head_len, magic[0..head_len]) catch
        return reply.notFound(req);
    const mime = thumbnailmod.sniffMime(got) orelse return reply.notFound(req);

    // The blob key is the plan's md5; the ETag uses the URL's `PAGESTYLEMD5`.
    return streamBlobRange(ctx, req, files, &plan.md5, hash, plan.offset, plan.length, mime);
}

/// GET /note/{id}/page/{n}/text?v={textHash} -> one page's on-device OCR transcript,
/// versioned by the md5 of its `RECOGNTEXT` block. `no-cache`, not `immutable`:
/// `?v=` covers the content, not the JSON shape, and an immutable cache once froze
/// the pre-`words` shape for a year. 404 means "refetch metadata" (no such page,
/// stale `?v=`, or no recognition). The text is device-authored; the client sets
/// it via `textContent`.
pub fn pageText(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files;
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const n = std.fmt.parseInt(u64, params.get("n") orelse return badRequest(ctx, req), 10) catch
        return badRequest(ctx, req);
    // Capture `?v=` before responding (responding invalidates the head strings).
    const v = reply.queryParam(req.head.target, "v");

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);

    const pt = (svc.pageText(arena.allocator(), caller.user_id, id, n) catch return serverError(ctx, req)) orelse
        return reply.notFound(req);
    if (v == null or !std.ascii.eqlIgnoreCase(v.?, &pt.hash)) return reply.notFound(req);

    // Not `immutable`: `?v=` versions the transcript, not the JSON shape.
    try json.respondWith(ctx.gpa, req, .ok, pt.vo, &.{
        .{ .name = "cache-control", .value = "no-cache" },
    });
}

/// GET /note/{id}/page/{n}/links?v={linksHash} -> the links a PDF template brought
/// to this page. Same contract as the text route: versioned by the md5 of
/// `EXTERNALLINKINFO`, `no-cache`, 404 means stale. Decoded per request from one
/// ranged read. The scheme allowlist (`allowedLinkScheme`) runs here too, because
/// the PDF exporter reads this endpoint.
pub fn pageLinks(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files;
    const id = reply.pathId(params) orelse return badRequest(ctx, req);
    const n = std.fmt.parseInt(u64, params.get("n") orelse return badRequest(ctx, req), 10) catch
        return badRequest(ctx, req);
    // Capture `?v=` before responding (responding invalidates the head strings).
    const v = reply.queryParam(req.head.target, "v");

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    var svc = controlplane.ControlPlaneService.init(files);

    const pl = (svc.pageLinks(arena.allocator(), caller.user_id, id, n) catch return serverError(ctx, req)) orelse
        return reply.notFound(req);
    if (v == null or !std.ascii.eqlIgnoreCase(v.?, &pl.hash)) return reply.notFound(req);

    try json.respondWith(ctx.gpa, req, .ok, pl.vo, &.{
        .{ .name = "cache-control", .value = "no-cache" },
    });
}
