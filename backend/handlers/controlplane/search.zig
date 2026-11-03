//! The search index, per-document text and the held events stream.

const std = @import("std");
const router = @import("../../http/router.zig");
const context = @import("../../http/context.zig");
const reply = @import("../../http/reply.zig");
const controlplane = @import("../../services/controlplane.zig");
const eventstreams = @import("../../http/event_streams.zig");
const pendingsvc = @import("../../services/pending.zig");
const index_export = @import("../../services/search/index_export.zig");
const indexstream = @import("../../services/search/index_stream.zig");
const wantbitmap = @import("../../services/search/want_bitmap.zig");
const derived = @import("../../store/derived.zig");
const derivesearch = @import("../../services/derive_search.zig");
const gzip_stitch = @import("../../http/gzip_stitch.zig");
const sqlite = @import("../../db/sqlite.zig");
const Context = context.Context;
const Request = router.Request;
const Params = router.Params;
const fail = reply.fail;
const badRequest = reply.badRequest;
const serverError = reply.serverError;

/// `x-accel-buffering: no` matters: a buffering reverse proxy would hold back a
/// stream that emits ~20 bytes a minute indefinitely.
const sse_headers = [_]std.http.Header{
    .{ .name = "content-type", .value = "text/event-stream" },
    .{ .name = "cache-control", .value = "no-store" },
    .{ .name = "x-content-type-options", .value = "nosniff" },
    .{ .name = "x-accel-buffering", .value = "no" },
};

/// The `event: index` frame: how much of the library is still being derived, and a
/// version that moves when a derive lands. One frame serves both the UI's
/// "N still indexing" and a client index's "re-sync".
fn writeIndexFrame(w: *std.Io.Writer, snap: pendingsvc.Snapshot) !void {
    try w.print("event: index\ndata: {{\"pending\":{d},\"version\":{d}}}\n\n", .{ snap.pending, snap.version });
}

/// The caller's index state, or null with no `Pulse`. Must not be called under
/// `lockDb`: `Pulse` takes `db_lock` itself and the mutex is non-reentrant.
fn indexSnapshot(ctx: *Context, user_id: u64) ?pendingsvc.Snapshot {
    const pulse = ctx.pending orelse return null;
    return pulse.forUser(user_id);
}

/// GET /api/controlplane/search-index/manifest -> the caller's complete live
/// document set (`SMAN`). `private, no-cache` with an ETag hashed from the body
/// (`index_export.bodyEtag`), so an unchanged library costs a 304 and the client
/// may refetch on every visit.
pub fn controlplaneSearchIndexManifest(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);

    // Read the header before responding; responding invalidates head strings.
    var inm_buf: [64]u8 = undefined;
    const if_none_match = router.headerCopy(req, "if-none-match", &inm_buf);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();

    const m = index_export.manifest(a, files.db, caller.user_id, files.terms) catch return serverError(ctx, req);
    var body: std.ArrayList(u8) = .empty;
    index_export.writeManifest(a, &body, m) catch return serverError(ctx, req);

    var etag_buf: [34]u8 = undefined;
    const hex = index_export.bodyEtag(body.items);
    const etag = std.fmt.bufPrint(&etag_buf, "\"{s}\"", .{hex}) catch return serverError(ctx, req);

    // The ETag rides on the 304 too, so the client keeps the validator.
    const headers = [_]std.http.Header{
        .{ .name = "content-type", .value = "application/octet-stream" },
        .{ .name = "cache-control", .value = "private, no-cache" },
        .{ .name = "etag", .value = etag },
        .{ .name = "x-content-type-options", .value = "nosniff" },
    };

    // Byte equality: this server mints exactly one form of this validator.
    if (std.mem.eql(u8, if_none_match, etag)) {
        return req.respond("", .{ .status = .not_modified, .extra_headers = &headers });
    }
    try req.respond(body.items, .{ .status = .ok, .extra_headers = &headers });
}

/// The manifest as one request sees it: rows in order, and the body's ETag.
const ManifestGate = struct {
    rows: []const index_export.Row,
    etag: [32]u8,
};

/// Re-run the manifest query and hash what it would serialize to. The bytes come
/// from `gpa` and are freed here; the rows live in the request arena.
fn manifestGate(
    arena: std.mem.Allocator,
    gpa: std.mem.Allocator,
    db: sqlite.Db,
    user_id: u64,
    terms: ?derived.DerivedStore,
) !ManifestGate {
    // Must be the same store the manifest route passes, or the ETags differ.
    const m = try index_export.manifest(arena, db, user_id, terms);
    var body: std.ArrayList(u8) = .empty;
    defer body.deinit(gpa);
    try index_export.writeManifest(gpa, &body, m);
    return .{ .rows = m.rows, .etag = index_export.bodyEtag(body.items) };
}

/// GET /api/controlplane/search-index/stream?m=<manifest etag>&want=<base64url>
/// -> the wanted documents' terms as one gzip stream stitched from stored
/// raw-deflate fragments (`http/gzip_stitch.zig`). Not concatenated gzip members:
/// browsers decode only the first member and report success. Always
/// `Content-Encoding: gzip`, since no identity form exists. Chunked, because a
/// fragment GC'd mid-walk would break a promised `Content-Length`.
/// `manual_db_lock`, not `read_only`: the reader is borrowed only around the
/// manifest query, so a slow download never parks a pooled reader or the writer.
pub fn controlplaneSearchIndexStream(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    // No terms store: an empty-but-valid stream would make the client record
    // every document as arrived and stop asking.
    const terms = files.terms orelse return serverError(ctx, req);

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();

    // Copy the params: the walk reads them after the response head has gone out.
    const m_param = a.dupe(u8, reply.queryParam(req.head.target, "m") orelse return badRequest(ctx, req)) catch
        return serverError(ctx, req);
    // An absent `want` is the empty set, not an error.
    const want_param = a.dupe(u8, reply.queryParam(req.head.target, "want") orelse "") catch
        return serverError(ctx, req);

    // The ETag gate runs before the bitmap is parsed: positions mean nothing
    // until we know the manifest ordering they index.
    const gate = blk: {
        if (ctx.borrowReader()) |lease| {
            defer ctx.returnReader(lease);
            break :blk manifestGate(a, ctx.gpa, lease.db, caller.user_id, files.terms) catch
                return serverError(ctx, req);
        }
        ctx.lockDb();
        defer ctx.unlockDb();
        break :blk manifestGate(a, ctx.gpa, files.db, caller.user_id, files.terms) catch
            return serverError(ctx, req);
    };

    // The bare hex, not the quoted entity-tag; byte equality.
    if (!std.mem.eql(u8, m_param, &gate.etag)) {
        return fail(ctx, req, .precondition_failed, "MANIFEST_MOVED", "manifest changed; refetch it");
    }

    const want = wantbitmap.parse(want_param, gate.rows.len) catch |err| switch (err) {
        // No encoder of ours produces this; refetching would not help.
        error.MalformedWant => return badRequest(ctx, req),
        // The ordering disagrees despite the ETag matching; treat as moved.
        error.WantLongerThanManifest, error.WantBitPastManifest => return fail(
            ctx,
            req,
            .precondition_failed,
            "MANIFEST_MOVED",
            "want bitmap does not fit this manifest",
        ),
    };

    const headers = [_]std.http.Header{
        // The decoded body is JSONL, one document per fragment.
        .{ .name = "content-type", .value = "application/x-ndjson" },
        .{ .name = "content-encoding", .value = "gzip" },
        // `no-store`: a document still deriving on the first request may arrive by
        // the second, and a cached copy would hide it.
        .{ .name = "cache-control", .value = "private, no-store" },
        .{ .name = "x-content-type-options", .value = "nosniff" },
    };

    // Two 16 KB buffers are the whole per-request cost besides the manifest arena.
    var wbuf: [16 * 1024]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .respond_options = .{ .extra_headers = &headers },
    }) catch return;

    // Head already sent: a mid-fragment failure returns without `end()`, so
    // decoders see a truncated gzip (loud) rather than a quietly short stream.
    var rbuf: [16 * 1024]u8 = undefined;
    _ = indexstream.write(ctx.io, terms, gate.rows, want, &body.writer, &rbuf) catch
        return error.StreamTruncated;
    body.end() catch {};
}

/// The degraded shape of `/api/controlplane/events`: one `event: sync` frame (plus
/// `event: index` when available), then close. `EventSource` reconnects after
/// `retry:`, so an over-cap or non-serve-mode caller becomes a correct poller.
fn eventsOneShot(ctx: *Context, req: *Request, sync_version: i64, index: ?pendingsvc.Snapshot) anyerror!void {
    var buf: [192]u8 = undefined;
    var w = std.Io.Writer.fixed(&buf);
    w.print("retry: {d}\nevent: sync\ndata: {d}\n\n", .{ eventstreams.retry_ms, sync_version }) catch
        return serverError(ctx, req);
    if (index) |snap| writeIndexFrame(&w, snap) catch return serverError(ctx, req);
    try req.respond(w.buffered(), .{
        .keep_alive = false,
        .extra_headers = &sse_headers,
    });
}

/// GET /api/controlplane/text/{md5} -> one document's `text/{md5}.{v}` record as a
/// gzip stream (header line plus one line per segment), for in-document search of
/// every kind. Gated by `Files.reachesBlob` (live, trashed or retained version);
/// unreachable and underived are one 404, so no existence oracle. The stored
/// raw-deflate fragment is wrapped verbatim in a gzip header and trailer.
/// Unlike the stitched stream this sends `Content-Length`: one open fd cannot be
/// shortened by GC (the store publishes by rename), and it avoids a Zig 0.16
/// `chunkedSendFile` panic (see `index_stream.zig`). Caching: `private, immutable`
/// with no `max-age` unless `?v=` names the current `index_version`, because a
/// parser bump re-derives the same md5. `manual_db_lock` with a borrowed reader,
/// as in the stitched stream.
pub fn controlplaneDocumentText(ctx: *Context, req: *Request, params: Params) anyerror!void {
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);
    const md5 = params.get("md5") orelse return badRequest(ctx, req);

    // No text store: a 404 ("nothing to load") is the truth here, unlike the
    // stream route's missing terms store.
    const text = files.text orelse return reply.notFound(req);

    const reachable = blk: {
        if (ctx.borrowReader()) |lease| {
            defer ctx.returnReader(lease);
            const ro = files.readerView(lease.db);
            break :blk ro.reachesBlob(caller.user_id, md5) catch return serverError(ctx, req);
        }
        ctx.lockDb();
        defer ctx.unlockDb();
        break :blk files.reachesBlob(caller.user_id, md5) catch return serverError(ctx, req);
    };
    if (!reachable) return reply.notFound(req);

    // The DB is done. Each failure below is a 404 indistinguishable from the gate.
    var file = text.open(md5, derivesearch.index_version) catch return reply.notFound(req);
    defer file.close(ctx.io);
    const size = (file.stat(ctx.io) catch return reply.notFound(req)).size;
    // Also the format check: a truncated or foreign file is refused, not streamed.
    const h = derived.readHeader(ctx.io, file) catch return reply.notFound(req);
    if (size <= derived.header_len) return reply.notFound(req); // a header and no fragment

    // `?v=` carries the `index_version`, the other half of the store key. Only when
    // it matches does the response get a year's `max-age`.
    var vbuf: [24]u8 = undefined;
    const named = if (reply.queryParam(req.head.target, "v")) |v|
        std.mem.eql(u8, v, std.fmt.bufPrint(&vbuf, "{d}", .{derivesearch.index_version}) catch "")
    else
        false;

    var trailer: gzip_stitch.Trailer = .{};
    trailer.append(h.crc, h.len);

    // Gzip header, the fragment past the stored 12-byte header, terminator, trailer.
    const content_length = gzip_stitch.header.len +
        (size - derived.header_len) +
        gzip_stitch.terminator.len + 8;

    var wbuf: [16 * 1024]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .content_length = content_length,
        .respond_options = .{
            .extra_headers = &.{
                .{ .name = "content-type", .value = "application/x-ndjson" },
                .{ .name = "content-encoding", .value = "gzip" },
                .{ .name = "cache-control", .value = if (named) "private, max-age=31536000, immutable" else "private, immutable" },
                .{ .name = "x-content-type-options", .value = "nosniff" },
            },
        },
    }) catch return;

    // Head sent: on failure return short of `content_length`, never `end()`.
    body.writer.writeAll(gzip_stitch.header) catch return error.StreamTruncated;

    // Positional reads into one buffer, bounded by `size`.
    var rbuf: [16 * 1024]u8 = undefined;
    var off: u64 = derived.header_len;
    while (off < size) {
        const want: usize = @intCast(@min(rbuf.len, size - off));
        const n = file.readPositionalAll(ctx.io, rbuf[0..want], off) catch return error.StreamTruncated;
        if (n == 0) return error.StreamTruncated; // the file ended short of its own stat
        body.writer.writeAll(rbuf[0..n]) catch return error.StreamTruncated;
        off += n;
    }

    trailer.finish(&body.writer) catch return error.StreamTruncated;
    body.end() catch {};
}

/// GET /api/controlplane/events -> the live-freshness SSE channel: `syncVersion`
/// pushed on change over a held connection. Without `ctx.event_streams` (the test
/// harness) it answers one-shot. `manual_db_lock` is mandatory: the default lock
/// held for a minutes-long stream would stall device sync. Each tick takes the lock
/// only around `files.syncVersion`; `indexSnapshot` runs outside every bracket.
/// A `: ping` every `heartbeat_ms` surfaces dead peers as write errors.
pub fn controlplaneEvents(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const caller = ctx.caller.?; // controlplane scope
    const files = ctx.files orelse return serverError(ctx, req);

    // The only DB touch before the head is sent.
    const initial: i64 = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        break :blk files.syncVersion(caller.user_id) catch 0;
    };

    // Outside the bracket above: `Pulse` takes `db_lock` itself.
    const initial_index = indexSnapshot(ctx, caller.user_id);

    const streams = ctx.event_streams orelse return eventsOneShot(ctx, req, initial, initial_index);
    if (!streams.tryAcquire(ctx.io, caller.user_id)) return eventsOneShot(ctx, req, initial, initial_index);
    // One release per successful acquire, on every path out.
    defer streams.release(ctx.io, caller.user_id);

    // No `content_length` -> chunked. Write failures end the stream; `EventSource`
    // reconnects.
    var wbuf: [256]u8 = undefined;
    var body = req.respondStreaming(&wbuf, .{
        .respond_options = .{ .keep_alive = false, .extra_headers = &sse_headers },
    }) catch return;

    body.writer.print("retry: {d}\nevent: sync\ndata: {d}\n\n", .{ eventstreams.retry_ms, initial }) catch return;
    if (initial_index) |snap| writeIndexFrame(&body.writer, snap) catch return;
    body.flush() catch return;

    var last = initial;
    var last_index = initial_index;
    var since_write_ms: i64 = 0;
    var lived_ms: i64 = 0;

    while (lived_ms < streams.max_lifetime_ms) {
        // Unlocked wait. Cancellation (shutdown) ends the stream cleanly.
        ctx.io.sleep(.fromMilliseconds(streams.poll_interval_ms), .awake) catch break; // .awake = CLOCK_MONOTONIC
        lived_ms += streams.poll_interval_ms;
        since_write_ms += streams.poll_interval_ms;

        // Narrow bracket each tick. A read error counts as "no change", so a
        // transient failure never fabricates a refetch.
        const current: i64 = blk: {
            ctx.lockDb();
            defer ctx.unlockDb();
            break :blk files.syncVersion(caller.user_id) catch last;
        };

        // Outside the lock, as above.
        const index_now = indexSnapshot(ctx, caller.user_id);

        var wrote = false;
        if (current != last) {
            last = current;
            body.writer.print("event: sync\ndata: {d}\n\n", .{current}) catch break;
            wrote = true;
        }
        // On change only, like `event: sync`.
        if (index_now) |now| {
            const moved = last_index == null or
                now.pending != last_index.?.pending or now.version != last_index.?.version;
            if (moved) {
                last_index = now;
                writeIndexFrame(&body.writer, now) catch break;
                wrote = true;
            }
        }
        if (wrote) {
            since_write_ms = 0;
            body.flush() catch break;
        } else if (since_write_ms >= streams.heartbeat_ms) {
            since_write_ms = 0;
            // `EventSource` ignores comments; the bytes surface a dead peer.
            body.writer.writeAll(": ping\n\n") catch break;
            body.flush() catch break;
        }
    }

    body.end() catch {};
}
