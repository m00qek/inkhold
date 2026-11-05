//! The device upload byte path: apply, /oss/put and finish.

const std = @import("std");
const router = @import("../../http/router.zig");
const context = @import("../../http/context.zig");
const json = @import("../../http/json.zig");
const reply = @import("../../http/reply.zig");
const multipart = @import("../../http/multipart.zig");
const upload_cap = @import("../upload_cap.zig");
const filesmod = @import("../../services/files.zig");
const blobstore = @import("../../store/blobs.zig");
const Context = context.Context;
const Request = router.Request;
const Params = router.Params;
const fail = reply.fail;
const badRequest = reply.badRequest;
const serverError = reply.serverError;
const device = @import("../device.zig");
const device_files = @import("files.zig");
const folderPath = device_files.folderPath;
const max_declared_bytes = device.max_declared_bytes;
const resolveEquipment = device.resolveEquipment;

/// Field names are literal from the capture. `finish.size` is a string and
/// unused; the size bound at apply is authoritative.
const UploadApplyReq = struct { path: []const u8, fileName: []const u8, equipmentNo: ?[]const u8 = null, size: i64 = 0 };

const UploadApplyVO = struct {
    success: bool = true,
    equipmentNo: []const u8,
    bucketName: []const u8 = "ufile",
    innerName: []const u8,
    // Cosmetic S3-style fields the device echoes; placeholders as captured.
    xAmzDate: []const u8 = "20260101T000000Z",
    authorization: []const u8 = "capture",
    fullUploadUrl: []const u8,
    partUploadUrl: []const u8,
};

const UploadFinishReq = struct {
    content_hash: []const u8,
    equipmentNo: ?[]const u8 = null,
    fileName: ?[]const u8 = null,
    innerName: []const u8,
    path: ?[]const u8 = null,
    size: ?[]const u8 = null,
};

const UploadFinishVO = struct {
    success: bool = true,
    equipmentNo: []const u8,
    id: []const u8, // the real created files.id, as a string
    name: []const u8,
    // The file's own path and size, as list_folder gives them: the Nomad
    // records `path_display` as the file's cloud path. A folder here made its
    // conflict rename name the copy after the folder (seen on hardware).
    path_display: []const u8,
    size: u64,
    content_hash: []const u8,
};

// ---- device upload byte-path: apply, /oss/put, finish ----

/// The apply `path` minus its trailing `file_name`, in Dropbox form. Owned by `a`.
fn uploadFolder(a: std.mem.Allocator, path: []const u8, file_name: []const u8) ![]const u8 {
    var p = path;
    if (std.mem.endsWith(u8, p, file_name)) p = p[0 .. p.len - file_name.len];
    return folderPath(a, p);
}

/// POST …/3/files/upload/apply: quota pre-check, mint a 16-hex `inner_name`
/// and record a session for the destination; returns an `/oss/put` URL.
pub fn uploadApply(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files;

    // Capture Host before the body read invalidates head strings.
    var host_buf: [256]u8 = undefined;
    const host = router.headerCopy(req, "host", &host_buf);

    var parsed = json.readBody(UploadApplyReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const in = parsed.value;
    // Reject a negative or absurd size before any quota arithmetic.
    if (in.size < 0 or in.size > max_declared_bytes)
        return fail(ctx, req, .ok, "QUOTA_EXCEEDED", "not enough space");
    const size: u64 = @intCast(in.size);

    const fits = files.wouldFit(caller.user_id, size) catch return serverError(ctx, req);
    if (!fits) return fail(ctx, req, .ok, "QUOTA_EXCEEDED", "not enough space");

    var raw: [8]u8 = undefined;
    ctx.io.random(&raw);
    const inner = std.fmt.bytesToHex(raw, .lower); // [16]u8

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();

    const folder = uploadFolder(a, in.path, in.fileName) catch return serverError(ctx, req);
    files.createUploadSession(caller.user_id, &inner, folder, in.fileName, size) catch return serverError(ctx, req);

    const eno = try a.dupe(u8, resolveEquipment(ctx, in.equipmentNo, &caller));
    const scheme = if (ctx.config.tls.enabled) "https" else "http";
    const url = try std.fmt.allocPrint(a, "{s}://{s}/oss/put/{s}", .{ scheme, host, &inner });
    try json.respond(ctx.gpa, req, .ok, UploadApplyVO{
        .equipmentNo = eno,
        .innerName = &inner,
        .fullUploadUrl = url,
        .partUploadUrl = url,
    }, null);
}

/// The `uploadId` names a temp file, so only `[A-Za-z0-9_-]` within
/// `max_upload_id` is accepted; no `/` or `..` out of `tmp/`.
fn validUploadId(s: []const u8) bool {
    if (s.len == 0 or s.len > blobstore.max_upload_id) return false;
    for (s) |c| {
        const ok = std.ascii.isAlphanumeric(c) or c == '-' or c == '_';
        if (!ok) return false;
    }
    return true;
}

/// Refuses an over-cap `/oss/put` body and deletes its session. The device
/// protocol's failures are HTTP 200 with a coded envelope, matching the
/// `QUOTA_EXCEEDED` apply/finish give; a 413 would read as a network failure.
fn refuseOversize(ctx: *Context, req: *Request, files: *filesmod.Files, inner: []const u8) anyerror!void {
    {
        ctx.lockDb();
        defer ctx.unlockDb();
        // The daily sweep reclaims a session this fails to drop.
        files.deleteUploadSession(inner) catch |e| std.log.warn("upload {s}: session not dropped: {t}", .{ inner, e });
    }
    return fail(ctx, req, .ok, "QUOTA_EXCEEDED", "not enough space");
}

/// Charges a staged part to its session and re-checks the DB total. Returns true
/// if it already answered. The `Capped` sink bounds the filesystem; this catches
/// concurrent parts of one session (the device uploads sequentially, so that is
/// a hostile client). `error.NotFound` (session gone) is refused the same way.
fn chargeSession(
    ctx: *Context,
    req: *Request,
    files: *filesmod.Files,
    user_id: u64,
    inner: []const u8,
    sink: anytype,
    prior_part: u64,
    declared: u64,
) anyerror!bool {
    const delta = @as(i64, @intCast(sink.written)) - @as(i64, @intCast(prior_part));
    const total: ?u64 = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        break :blk files.addUploadReceived(user_id, inner, delta) catch |e| switch (e) {
            error.NotFound => null,
            else => {
                try serverError(ctx, req);
                return true;
            },
        };
    };
    const t = total orelse {
        try refuseOversize(ctx, req, files, inner);
        return true;
    };
    if (t > upload_cap.limitFor(declared)) {
        try refuseOversize(ctx, req, files, inner);
        return true;
    }
    return false;
}

/// POST /oss/put/:innerName: streams the one `name="file"` multipart part into
/// the blob store and records its md5 on the session; the device expects an
/// empty 200. Capped at the session's `declared_size` plus
/// `upload_cap.slack_bytes`.
pub fn ossPut(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // device scope
    const files = ctx.files;

    // Copy the param out; the body read invalidates head strings.
    const inner_raw = params.get("innerName") orelse return reply.notFound(req);
    var inner_buf: [64]u8 = undefined;
    if (inner_raw.len == 0 or inner_raw.len > inner_buf.len) return reply.notFound(req);
    @memcpy(inner_buf[0..inner_raw.len], inner_raw);
    const inner = inner_buf[0..inner_raw.len];

    var ct_buf: [256]u8 = undefined;
    const ct = router.headerCopy(req, "content-type", &ct_buf);
    var bnd_buf: [multipart.max_term]u8 = undefined;
    const boundary = multipart.boundaryFromContentType(ct, &bnd_buf) orelse return badRequest(ctx, req);

    // Chunk parameters (large files come in parts), read before the body.
    const total_chunks = if (reply.queryParam(req.head.target, "totalChunks")) |s|
        std.fmt.parseInt(u32, s, 10) catch 0
    else
        0;
    const part_number = if (reply.queryParam(req.head.target, "partNumber")) |s|
        std.fmt.parseInt(u32, s, 10) catch 0
    else
        0;

    var uid_buf: [blobstore.max_upload_id]u8 = undefined;
    const upload_id: ?[]const u8 = if (reply.queryParam(req.head.target, "uploadId")) |raw| uid: {
        if (!validUploadId(raw)) return badRequest(ctx, req);
        @memcpy(uid_buf[0..raw.len], raw);
        break :uid uid_buf[0..raw.len];
    } else null;

    // A multi-chunk upload needs a valid id and part number, or one chunk would
    // be stored as the whole file.
    const chunked = total_chunks > 1;
    if (chunked and (upload_id == null or part_number == 0 or part_number > total_chunks))
        return badRequest(ctx, req);

    // The session must belong to this device; DB touch 1 of 3.
    var declared: u64 = 0;
    var received: u64 = 0;
    {
        ctx.lockDb();
        defer ctx.unlockDb();
        var arena = std.heap.ArenaAllocator.init(ctx.gpa);
        defer arena.deinit();
        const session = (files.uploadSession(arena.allocator(), caller.user_id, inner) catch return serverError(ctx, req)) orelse
            return reply.notFound(req);
        declared = session.declared_size;
        received = session.received_bytes;
    }

    // A retried part replaces its deterministic temp file, so its earlier bytes
    // are credited back instead of charged twice.
    const prior_part: u64 = if (chunked) files.blobs.stagedPartSize(upload_id.?, part_number) else received;

    // The cap: bytes are held to what is left of the session's declared size as
    // they arrive, per session not per part. Quota checked only at finish would
    // let one request fill the disk (and on a Pi take the database with it).
    const limit = upload_cap.remainingFor(declared, received -| prior_part);

    // The ingest is unlocked: blob storage never touches the DB.
    var rbuf: [blobstore.chunk_len]u8 = undefined;
    const reader = req.readerExpectContinue(&rbuf) catch return badRequest(ctx, req);

    var wbuf: [blobstore.chunk_len]u8 = undefined;

    if (chunked) {
        var ing = files.blobs.beginChunkIngest(upload_id.?, part_number, &wbuf) catch return serverError(ctx, req);
        var sink = upload_cap.Capped(blobstore.ChunkIngest).init(&ing, limit);
        multipart.extract(reader, boundary, &sink) catch |err| {
            // `ChunkIngest.abort` leaves the part on disk; startup `sweepTmp` reclaims it.
            ing.abort();
            if (err == error.UploadTooLarge) return refuseOversize(ctx, req, files, inner);
            return badRequest(ctx, req);
        };
        ing.finish() catch {
            ing.abort();
            return serverError(ctx, req);
        };
        ing.deinit();

        // Charge net of a retried part. DB touch 2.
        if (try chargeSession(ctx, req, files, caller.user_id, inner, &sink, prior_part, declared)) return;

        if (part_number == total_chunks) {
            // Implicitly merge chunks on the final part
            const res = files.blobs.mergeChunks(upload_id.?, total_chunks, &wbuf) catch return serverError(ctx, req);
            {
                ctx.lockDb();
                defer ctx.unlockDb();
                files.setUploadBlob(caller.user_id, inner, &res.md5) catch return serverError(ctx, req);
            }
        }
    } else {
        var ing = files.blobs.beginIngest(&wbuf) catch return serverError(ctx, req);
        var sink = upload_cap.Capped(blobstore.Ingest).init(&ing, limit);
        multipart.extract(reader, boundary, &sink) catch |err| {
            // `abort` drops the temp file; `refuseOversize` drops the session.
            ing.abort();
            if (err == error.UploadTooLarge) return refuseOversize(ctx, req, files, inner);
            return badRequest(ctx, req);
        };
        const res = ing.finish(null) catch {
            ing.abort();
            return serverError(ctx, req);
        };
        ing.deinit();

        // The single-shot body replaces whatever the session had received.
        if (try chargeSession(ctx, req, files, caller.user_id, inner, &sink, prior_part, declared)) return;

        // finish verifies this md5; an unfinished blob is an orphan for the sweep.
        {
            ctx.lockDb();
            defer ctx.unlockDb();
            files.setUploadBlob(caller.user_id, inner, &res.md5) catch return serverError(ctx, req);
        }
    }

    // The capture's accepted response: empty 200.
    try req.respond("", .{ .status = .ok });
}

/// POST …/2/files/upload/finish: verify the stored md5 against `content_hash`,
/// link the blob under the session's bound path (not finish's echoed one),
/// charge quota and delete the session.
pub fn uploadFinish(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // device scope
    const files = ctx.files;

    var parsed = json.readBody(UploadFinishReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const in = parsed.value;

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const eno = try a.dupe(u8, resolveEquipment(ctx, in.equipmentNo, &caller));

    const session = (files.uploadSession(a, caller.user_id, in.innerName) catch return serverError(ctx, req)) orelse
        return fail(ctx, req, .ok, "NOT_FOUND", "no such upload");
    const blob_md5 = session.blob_md5 orelse return fail(ctx, req, .ok, "NO_CONTENT", "upload not received");

    // On mismatch, commit nothing; the orphan blob goes to the sweep.
    if (!std.ascii.eqlIgnoreCase(blob_md5, in.content_hash))
        return fail(ctx, req, .ok, "HASH_MISMATCH", "content hash mismatch");

    const parent: ?u64 = if (std.mem.eql(u8, session.path, "/"))
        null
    else
        files.ensureFolderPath(caller.user_id, session.path) catch return serverError(ctx, req);

    // Commit the ingested size, not the declared one: a device could declare
    // 10 GiB for 100 bytes and make readers allocate accordingly.
    const real_size = files.blobs.sizeOf(blob_md5) catch return serverError(ctx, req);
    const entry = files.linkBlob(caller.user_id, parent, session.file_name, blob_md5, real_size) catch |e| switch (e) {
        error.QuotaExceeded => return fail(ctx, req, .ok, "QUOTA_EXCEEDED", "not enough space"),
        error.NameConflict => return fail(ctx, req, .ok, "NAME_CONFLICT", "name already used by a folder"),
        else => return serverError(ctx, req),
    };
    entry.deinit(ctx.gpa);

    // The blob is linked; a session this fails to drop is reclaimed by the daily sweep.
    files.deleteUploadSession(in.innerName) catch |e| std.log.warn("upload {s}: session not dropped: {t}", .{ in.innerName, e });

    const id_str = try std.fmt.allocPrint(a, "{d}", .{entry.id});
    const display = files.pathOf(a, caller.user_id, entry.id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, UploadFinishVO{
        .equipmentNo = eno,
        .id = id_str,
        .name = session.file_name,
        .path_display = display,
        .size = real_size,
        .content_hash = blob_md5,
    }, null);
}
