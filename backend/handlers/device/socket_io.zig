//! The packets of the tablet's auto-sync channel: Socket.IO 2 over Engine.IO 3
//! (`EIO=3`), websocket transport only. Pure: the handler in `socket.zig`
//! owns the connection.
//!
//! What the Nomad does with it (decompiled, firmware Chauvet.E103.2606141001;
//! docs/content/contributor/device-protocol.md): while the channel is up, the launcher uploads each local
//! change as it happens and runs a full sync on connect. The server pushes
//! `ServerMessage` events (`{"code":"200","data":[...]}`); the tablet answers
//! each with a `ClientMessage` "Received", acked. A `ratta_ping` event gets a
//! `ratta_ping` back, and that is the only heartbeat: the tablet sends no
//! Engine.IO pings of its own (seen on hardware), so the server drives it.
//!
//! Engine.IO 3 text packets: `0` open (server), `1` close, `2` ping (client),
//! `3` pong (server), `4` message. Inside `4`, Socket.IO 2: `0` connect, `1`
//! disconnect, `2` event, `3` ack, each optionally followed by an ack id, then
//! a JSON array (`421["ClientMessage","Received"]`).

const std = @import("std");

/// The client pings every `ping_interval_ms`; silence for that plus
/// `ping_timeout_ms` means the peer is gone. Socket.IO 2's defaults.
pub const ping_interval_ms: i64 = 25_000;
pub const ping_timeout_ms: i64 = 60_000;

/// How often the server sends `ratta_ping`; the tablet's answer is what shows
/// it is still there.
pub const ratta_ping_ms: i64 = 20_000;
pub const ratta_ping_packet = "42[\"ratta_ping\"]";

/// Socket.IO "connected to the default namespace".
pub const connect_packet = "40";
pub const pong_packet = "3";

/// The Engine.IO open packet: the session id and the ping timing. `upgrades`
/// is empty: the tablet starts on the websocket and stays there.
pub fn openPacket(buf: []u8, sid: []const u8) ![]const u8 {
    return std.fmt.bufPrint(buf, "0{{\"sid\":\"{s}\",\"upgrades\":[],\"pingInterval\":{d},\"pingTimeout\":{d}}}", .{ sid, ping_interval_ms, ping_timeout_ms });
}

pub const Incoming = union(enum) {
    ping,
    close,
    /// An event; `ack` is its id when the sender wants an acknowledgement.
    event: struct { name: []const u8, ack: ?u64 },
    other,
};

/// Classifies one text message from the client. Slices point into `data`.
pub fn parse(data: []const u8) Incoming {
    if (data.len == 0) return .other;
    switch (data[0]) {
        '2' => return .ping,
        '1' => return .close,
        '4' => {},
        else => return .other,
    }
    if (data.len < 2) return .other;
    switch (data[1]) {
        '1' => return .close,
        '2' => {},
        else => return .other,
    }
    var i: usize = 2;
    while (i < data.len and std.ascii.isDigit(data[i])) i += 1;
    const ack: ?u64 = if (i > 2) std.fmt.parseInt(u64, data[2..i], 10) catch return .other else null;
    return .{ .event = .{ .name = eventName(data[i..]) orelse return .other, .ack = ack } };
}

/// The first element of an event's JSON array, when it is a plain string.
fn eventName(array: []const u8) ?[]const u8 {
    if (!std.mem.startsWith(u8, array, "[\"")) return null;
    const rest = array[2..];
    const end = std.mem.indexOfScalar(u8, rest, '"') orelse return null;
    return rest[0..end];
}

/// One change, as the tablet's `MessageBean` has it. The tablet re-reads the
/// file by `id` and reconciles it, so the type only has to be one it acts on;
/// the paths only have to land in a synced folder.
pub const Bean = struct {
    id: u64,
    messageType: []const u8,
    originalPath: []const u8,
    originalName: []const u8,
    newPath: []const u8,
    newName: []const u8,
    equipmentNo: []const u8 = "",
    timestamp: i64,
};

/// `ServerMessage`'s payload: the envelope the tablet parses (`code` "200").
pub const Envelope = struct {
    code: []const u8 = "200",
    msg: []const u8 = "",
    data: []const Bean,
};

/// The message type for a change the tablet should re-read.
pub fn messageType(is_folder: bool, deleted: bool) []const u8 {
    if (deleted) return if (is_folder) "DELETEFOLDER" else "DELETEFILE";
    return if (is_folder) "MODIFYFOLDER" else "MODIFYFILE";
}

/// `/NOTE/Note/a.note` → `/NOTE/Note` and `a.note`.
pub fn splitPath(path: []const u8) struct { dir: []const u8, name: []const u8 } {
    const i = std.mem.lastIndexOfScalar(u8, path, '/') orelse return .{ .dir = "/", .name = path };
    return .{ .dir = if (i == 0) "/" else path[0..i], .name = path[i + 1 ..] };
}

/// The acknowledgement of event `id`, with no arguments.
pub fn ackPacket(buf: []u8, id: u64) ![]const u8 {
    return std.fmt.bufPrint(buf, "43{d}[]", .{id});
}

/// An event with one JSON argument (`json` is written as is).
pub fn eventPacket(buf: []u8, name: []const u8, json: ?[]const u8) ![]const u8 {
    if (json) |j| return std.fmt.bufPrint(buf, "42[\"{s}\",{s}]", .{ name, j });
    return std.fmt.bufPrint(buf, "42[\"{s}\"]", .{name});
}

const testing = std.testing;

test "the open packet carries the session id and the ping timing" {
    var buf: [128]u8 = undefined;
    try testing.expectEqualStrings(
        "0{\"sid\":\"abc\",\"upgrades\":[],\"pingInterval\":25000,\"pingTimeout\":60000}",
        try openPacket(&buf, "abc"),
    );
}

test "client packets: pings, closes, events with and without an ack id" {
    try testing.expectEqual(Incoming.ping, parse("2"));
    try testing.expectEqual(Incoming.ping, parse("2probe"));
    try testing.expectEqual(Incoming.close, parse("1"));
    try testing.expectEqual(Incoming.close, parse("41"));

    const acked = parse("421[\"ClientMessage\",\"Received\"]").event;
    try testing.expectEqualStrings("ClientMessage", acked.name);
    try testing.expectEqual(@as(?u64, 1), acked.ack);

    const plain = parse("42[\"ratta_ping\"]").event;
    try testing.expectEqualStrings("ratta_ping", plain.name);
    try testing.expectEqual(@as(?u64, null), plain.ack);

    try testing.expectEqual(Incoming.other, parse(""));
    try testing.expectEqual(Incoming.other, parse("40"));
    try testing.expectEqual(Incoming.other, parse("42"));
    try testing.expectEqual(Incoming.other, parse("42{}"));
    try testing.expectEqual(Incoming.other, parse("4299999999999999999999[\"x\"]"));
}

test "a change becomes a bean the tablet acts on" {
    try testing.expectEqualStrings("MODIFYFILE", messageType(false, false));
    try testing.expectEqualStrings("DELETEFOLDER", messageType(true, true));
    const s = splitPath("/NOTE/Note/a.note");
    try testing.expectEqualStrings("/NOTE/Note", s.dir);
    try testing.expectEqualStrings("a.note", s.name);
    try testing.expectEqualStrings("/", splitPath("/INBOX").dir);

    const beans = [_]Bean{.{ .id = 7, .messageType = "MODIFYFILE", .originalPath = "/NOTE/Note", .originalName = "a.note", .newPath = "/NOTE/Note", .newName = "a.note", .timestamp = 1 }};
    const json = try std.json.Stringify.valueAlloc(testing.allocator, Envelope{ .data = &beans }, .{});
    defer testing.allocator.free(json);
    try testing.expectEqualStrings(
        "{\"code\":\"200\",\"msg\":\"\",\"data\":[{\"id\":7,\"messageType\":\"MODIFYFILE\",\"originalPath\":\"/NOTE/Note\",\"originalName\":\"a.note\",\"newPath\":\"/NOTE/Note\",\"newName\":\"a.note\",\"equipmentNo\":\"\",\"timestamp\":1}]}",
        json,
    );
}

test "acks and events are framed the Socket.IO 2 way" {
    var buf: [128]u8 = undefined;
    try testing.expectEqualStrings("4312[]", try ackPacket(&buf, 12));
    try testing.expectEqualStrings("42[\"ratta_ping\"]", try eventPacket(&buf, "ratta_ping", null));
    try testing.expectEqualStrings("42[\"ServerMessage\",{\"code\":\"200\"}]", try eventPacket(&buf, "ServerMessage", "{\"code\":\"200\"}"));
}
