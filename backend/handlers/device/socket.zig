//! GET /socket.io/ — the tablet's auto-sync channel (packets: `socket_io.zig`).
//! A held route: the connection gets its own thread for as long as the tablet
//! stays connected, and takes `db_lock` only to check the token.
//!
//! The tablet authenticates with its device token in the query (`token=`);
//! the `sign=` HMAC uses a key baked into the firmware and is not checked.
//! While the channel is up the tablet uploads its own changes as they happen;
//! that needs nothing from the server but a live connection, which the
//! server's `ratta_ping` keeps: the tablet answers it, and sends nothing else
//! unprompted.
//!
//! Changes made elsewhere (the browser, another tablet) are pushed: when the
//! in-memory change counter moves, the account's rows changed since the last
//! check go out as one `ServerMessage`, and the tablet re-reads each by id.
//! Its own uploads come back too; re-reading those finds nothing to do.

const std = @import("std");
const router = @import("../../http/router.zig");
const context = @import("../../http/context.zig");
const reply = @import("../../http/reply.zig");
const sio = @import("socket_io.zig");
const clock = @import("../../util/clock.zig");
const filesmod = @import("../../services/files.zig");

const Context = context.Context;
const Request = router.Request;
const Params = router.Params;
const WebSocket = std.http.Server.WebSocket;

/// How long one wait for the tablet lasts before the loop looks around.
const tick_ms: i32 = 1000;

/// Rows per `ServerMessage`; more go out in further messages.
const push_page = 100;

pub fn socketIo(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    const target = req.head.target;
    const transport = reply.queryParam(target, "transport") orelse "";
    if (!std.mem.eql(u8, transport, "websocket")) return reply.badRequest(ctx, req);
    const token = reply.queryParam(target, "token") orelse return reply.forbidden(req);

    const caller = blk: {
        ctx.lockDb();
        defer ctx.unlockDb();
        break :blk ctx.service.caller(token) catch return reply.serverError(ctx, req);
    } orelse return reply.forbidden(req);
    if (caller.audience != .device) return reply.forbidden(req);

    const key = switch (req.upgradeRequested()) {
        .websocket => |k| k orelse return reply.badRequest(ctx, req),
        else => return reply.badRequest(ctx, req),
    };
    var ws = req.respondWebSocket(.{ .key = key }) catch return;
    serve(ctx, &ws, caller.user_id) catch |err| switch (err) {
        error.Gone => {},
        else => std.log.info("socket.io: user {d} closed: {t}", .{ caller.user_id, err }),
    };
}

/// Opens the session, then answers the tablet until it leaves or goes quiet.
fn serve(ctx: *Context, ws: *WebSocket, user_id: u64) !void {
    var buf: [256]u8 = undefined;
    var sid_bytes: [10]u8 = undefined;
    ctx.io.random(&sid_bytes);
    const sid = std.fmt.bytesToHex(sid_bytes, .lower);
    try ws.writeMessage(try sio.openPacket(&buf, &sid), .text);
    try ws.writeMessage(sio.connect_packet, .text);

    var last_heard = nowMs(ctx);
    var last_ping = last_heard;
    // The tablet runs a full sync on connect, so the push starts from now.
    var since_s = clock.nowSeconds(ctx.io);
    var seen_changes: ?u32 = if (ctx.files.changes) |c| c.load(.acquire) else null;
    while (true) {
        if (ctx.files.changes) |c| {
            const n = c.load(.acquire);
            if (n != seen_changes.?) {
                seen_changes = n;
                since_s = try push(ctx, ws, user_id, since_s);
            }
        }
        const now = nowMs(ctx);
        if (now - last_heard > sio.ping_interval_ms + sio.ping_timeout_ms) return error.Gone;
        if (now - last_ping >= sio.ratta_ping_ms) {
            last_ping = now;
            try ws.writeMessage(sio.ratta_ping_packet, .text);
        }
        if (!try readable(ctx, ws)) continue;
        const msg = ws.readSmallMessage() catch |err| switch (err) {
            error.ConnectionClose, error.EndOfStream => return error.Gone,
            else => return err,
        };
        last_heard = nowMs(ctx);
        if (msg.opcode == .ping) {
            try ws.writeMessage(msg.data, .pong);
            continue;
        }
        switch (sio.parse(msg.data)) {
            .ping => try ws.writeMessage(sio.pong_packet, .text),
            .close => return error.Gone,
            // "Received" and `ratta_ping` need nothing but the ack.
            .event => |e| if (e.ack) |id| try ws.writeMessage(try sio.ackPacket(&buf, id), .text),
            .other => {},
        }
    }
}

/// Sends what changed in the account in `since_s` or later; returns where the
/// next check starts: the second this one began, so a change within it is
/// sent again rather than missed (`ChangeCursor.since`).
fn push(ctx: *Context, ws: *WebSocket, user_id: u64, since_s: i64) !i64 {
    const started = clock.nowSeconds(ctx.io);
    var cursor: filesmod.Files.ChangeCursor = .since(since_s);
    while (true) {
        const page = blk: {
            ctx.lockDb();
            defer ctx.unlockDb();
            break :blk try ctx.files.changedAfter(ctx.gpa, user_id, cursor, push_page);
        };
        defer page.deinit(ctx.gpa);
        if (std.meta.eql(page.next, cursor)) break; // nothing more
        cursor = page.next;
        if (page.changes.len == 0) continue; // only rows without a path
        try sendChanges(ctx, ws, page.changes);
    }
    return started;
}

fn sendChanges(ctx: *Context, ws: *WebSocket, changes: []const filesmod.Files.FileChange) !void {
    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const beans = try a.alloc(sio.Bean, changes.len);
    const ts = std.Io.Clock.real.now(ctx.io).toMilliseconds();
    for (changes, beans) |c, *b| {
        const at = sio.splitPath(c.path);
        b.* = .{
            .id = c.id,
            .messageType = sio.messageType(c.is_folder, c.deleted),
            .originalPath = at.dir,
            .originalName = at.name,
            .newPath = at.dir,
            .newName = at.name,
            .timestamp = ts,
        };
    }
    const json = try std.json.Stringify.valueAlloc(a, sio.Envelope{ .data = beans }, .{});
    try ws.writeMessage(try std.fmt.allocPrint(a, "42[\"ServerMessage\",{s}]", .{json}), .text);
}

/// Whether a message is waiting, after at most `tick_ms`. Bytes already
/// buffered count: under TLS a whole record may sit decrypted in the reader
/// while the socket itself has nothing more to read.
fn readable(ctx: *Context, ws: *WebSocket) !bool {
    if (ws.input.bufferedLen() > 0) return true;
    const fd = ctx.conn_fd orelse return true; // no socket to wait on: block in the read
    var fds = [_]std.posix.pollfd{.{ .fd = fd, .events = std.posix.POLL.IN, .revents = 0 }};
    const rc = std.os.linux.poll(&fds, 1, tick_ms);
    switch (std.os.linux.errno(rc)) {
        .SUCCESS => {},
        .INTR => return false,
        else => return error.PollFailed,
    }
    if (rc == 0) return false;
    if (fds[0].revents & (std.posix.POLL.ERR | std.posix.POLL.NVAL) != 0) return error.Gone;
    return true; // readable, or hung up: the read then ends the session
}

fn nowMs(ctx: *Context) i64 {
    return std.Io.Clock.awake.now(ctx.io).toMilliseconds();
}

test {
    _ = sio;
}
