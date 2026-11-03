//! Reader for the Supernote Atelier `.spd` format, an SQLite database (see
//! `spd-format.md`). The file is untrusted, so it is never opened as a file or
//! read-write: the bytes are copied and attached to a `:memory:` connection
//! with `SQLITE_DESERIALIZE_READONLY`.

const std = @import("std");
const sqlite = @import("sqlite.zig");
const protobuf = @import("protobuf.zig");

const c = sqlite.c;

/// Layer id the app reserves for the template/background ("Reference Layer");
/// an empty one renders as solid white.
pub const reference_layer_id: i32 = 9999;

/// Tiles are 128×128 px.
pub const tile_px: u32 = 128;

pub const Error = error{
    NotSqlite,
    NotSpd,
    /// A required query failed: a corrupt file must not read as a blank one.
    Corrupt,
    /// A crafted `tid` decodes to an x-tile beyond `u32`.
    TileCoordOverflow,
    BadTid,
} || std.mem.Allocator.Error || protobuf.Error;

pub const LayerInfo = struct {
    id: i32,
    /// Owned by `Metadata.arena`; "" if unnamed.
    name: []const u8,
    /// False only when protobuf field 4 is explicitly 0.
    visible: bool,
    /// Raw 0..255 opacity.
    opacity: u8,

    pub fn opacityFraction(self: LayerInfo) f32 {
        return @as(f32, @floatFromInt(self.opacity)) / 255.0;
    }
    pub fn isReference(self: LayerInfo) bool {
        return self.id == reference_layer_id;
    }
};

/// Config scalars plus the layer tree. `null` means the key is absent, kept
/// distinct from `error.Corrupt`. Owns an arena; call `deinit`.
pub const Metadata = struct {
    arena: std.heap.ArenaAllocator,

    fmt_ver: ?[]const u8,
    app_version: ?[]const u8,
    ppi: ?u32,
    width: ?f32,
    height: ?f32,
    vp_x: ?f32,
    vp_y: ?f32,

    /// Z-order: `layers[0]` is topmost, as the protobuf stores them.
    layers: []const LayerInfo,
    /// Informational; `layers.len` is the authority.
    declared_layer_count: ?i32,
    active_layer_id: ?i32,

    pub fn deinit(self: *Metadata) void {
        self.arena.deinit();
    }
};

/// One tile. `png` borrows SQLite's row memory until the next `next`/`deinit`.
pub const Tile = struct {
    tid: i64,
    x: u32,
    y: u16,
    png: []const u8,
};

/// `x_tile = tid >> 12`, `y_tile = tid & 0x0FFF`. The spec prose and the PoC
/// had the axes swapped; only this mapping reconstructs a real drawing.
pub fn unpackTid(tid: i64) Error!struct { x: u32, y: u16 } {
    if (tid < 0) return error.BadTid;
    const t: u64 = @intCast(tid);
    const x64 = t >> 12;
    if (x64 > std.math.maxInt(u32)) return error.TileCoordOverflow;
    return .{ .x = @intCast(x64), .y = @intCast(t & 0x0FFF) };
}

/// Inverse of `unpackTid`.
pub fn packTid(x: u32, y: u12) i64 {
    return (@as(i64, x) << 12) | @as(i64, y);
}

/// Streams a layer's PNG tiles off one prepared statement. A `null` statement
/// (no table) yields zero tiles.
pub const TileIterator = struct {
    stmt: ?*c.sqlite3_stmt,

    pub fn next(self: *TileIterator) Error!?Tile {
        const stmt = self.stmt orelse return null;
        switch (c.sqlite3_step(stmt)) {
            c.SQLITE_ROW => {
                const tid = c.sqlite3_column_int64(stmt, 0);
                const coord = try unpackTid(tid);
                const png = columnBlob(stmt, 1);
                return .{ .tid = tid, .x = coord.x, .y = coord.y, .png = png };
            },
            c.SQLITE_DONE => return null,
            else => return error.Corrupt, // mid-iteration read failure = corrupt db
        }
    }

    pub fn deinit(self: *TileIterator) void {
        if (self.stmt) |stmt| {
            _ = c.sqlite3_finalize(stmt);
            self.stmt = null;
        }
    }
};

/// An open read-only `.spd`, owning the connection and the image it borrows.
pub const Spd = struct {
    db: *c.sqlite3,
    /// Our copy of the database. `sqlite3_deserialize` borrows it for the
    /// connection's life (no FREEONCLOSE/RESIZEABLE), so free it only after
    /// closing.
    image: []u8,
    gpa: std.mem.Allocator,

    const sqlite_magic = "SQLite format 3\x00";

    /// Rewrites header bytes 18/19 (write/read format version) from WAL (2) to
    /// rollback-journal (1).
    fn neutralizeWalMode(image: []u8) void {
        if (image.len < 20) return; // header is 100 bytes; a real db has these
        if (image[18] == 2) image[18] = 1;
        if (image[19] == 2) image[19] = 1;
    }

    /// Opens `bytes` (copied) as a read-only `.spd`.
    pub fn open(gpa: std.mem.Allocator, bytes: []const u8) Error!Spd {
        if (bytes.len < sqlite_magic.len or !std.mem.startsWith(u8, bytes, sqlite_magic)) {
            return error.NotSqlite;
        }

        const image = try gpa.dupe(u8, bytes);
        errdefer gpa.free(image);

        // Device `.spd`s are WAL-mode, which a deserialized `:memory:` db cannot
        // run. The file at rest is checkpointed, so marking our copy legacy-mode
        // reads the committed state.
        neutralizeWalMode(image);

        var db: ?*c.sqlite3 = null;
        if (c.sqlite3_open(":memory:", &db) != c.SQLITE_OK) {
            if (db) |h| _ = c.sqlite3_close(h);
            return error.OutOfMemory; // opening :memory: only fails on allocation
        }
        errdefer _ = c.sqlite3_close(db);

        const rc = c.sqlite3_deserialize(
            db,
            "main",
            image.ptr,
            @intCast(image.len),
            @intCast(image.len),
            c.SQLITE_DESERIALIZE_READONLY,
        );
        if (rc != c.SQLITE_OK) return error.Corrupt;

        var self: Spd = .{ .db = db.?, .image = image, .gpa = gpa };

        // Also forces a page read, catching a body-corrupt image here.
        if (!try self.hasTable("config")) return error.NotSpd;

        return self;
    }

    pub fn deinit(self: *Spd) void {
        _ = c.sqlite3_close(self.db); // must precede the free of the image it borrowed
        self.gpa.free(self.image);
        self.* = undefined;
    }

    pub fn metadata(self: *Spd, gpa: std.mem.Allocator) Error!Metadata {
        var arena = std.heap.ArenaAllocator.init(gpa);
        errdefer arena.deinit();
        const a = arena.allocator();

        // All `a` allocations must precede moving `arena` into the result:
        // `allocator()` binds to this local's address.
        const fmt_ver = try self.configText(a, "fmt_ver");
        const app_version = try self.configText(a, "appVersion");
        const ppi = try self.configUint(a, "ppi");
        const width = try self.configFloat(a, "surface.width");
        const height = try self.configFloat(a, "surface.height");
        const vp_x = try self.configFloat(a, "vp.x");
        const vp_y = try self.configFloat(a, "vp.y");

        // A malformed `ls` is surfaced, never a silent empty tree.
        var tree: LayerTree = .{ .layers = &.{}, .count = null, .active = null };
        if (try self.readConfigBlobDup(a, "ls")) |ls| {
            tree = try parseLayerTree(a, ls);
        }

        return .{
            .arena = arena, // moved last: no more `a` allocations after this point
            .fmt_ver = fmt_ver,
            .app_version = app_version,
            .ppi = ppi,
            .width = width,
            .height = height,
            .vp_x = vp_x,
            .vp_y = vp_y,
            .layers = tree.layers,
            .declared_layer_count = tree.count,
            .active_layer_id = tree.active,
        };
    }

    /// The embedded JPEG copied into `gpa`, or `null`. `thumbnail` has TEXT
    /// affinity but binary content, so it is read by byte count.
    pub fn thumbnail(self: *Spd, gpa: std.mem.Allocator) Error!?[]u8 {
        const stmt = try self.prepareConfig("thumbnail");
        defer _ = c.sqlite3_finalize(stmt);
        switch (c.sqlite3_step(stmt)) {
            c.SQLITE_ROW => {
                const blob = columnBlob(stmt, 0);
                if (blob.len == 0) return null;
                return try gpa.dupe(u8, blob);
            },
            c.SQLITE_DONE => return null,
            else => return error.Corrupt,
        }
    }

    /// Streams `surface_<layer_id>`; a missing table yields zero tiles. The name
    /// is built from an integer, so there is no injection surface.
    pub fn iterateLayer(self: *Spd, layer_id: i32) Error!TileIterator {
        var buf: [64]u8 = undefined;
        const sql = std.fmt.bufPrintZ(&buf, "SELECT tid, tile FROM surface_{d} ORDER BY tid", .{layer_id}) catch unreachable;
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.db, sql.ptr, -1, &stmt, null) != c.SQLITE_OK) {
            return .{ .stmt = null }; // table absent → empty iterator
        }
        return .{ .stmt = stmt };
    }

    // ---- internals ----

    fn hasTable(self: *Spd, name: []const u8) Error!bool {
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1", -1, &stmt, null) != c.SQLITE_OK) {
            return error.Corrupt;
        }
        defer _ = c.sqlite3_finalize(stmt);
        _ = c.sqlite3_bind_text(stmt, 1, name.ptr, @intCast(name.len), sqlite.transient());
        return switch (c.sqlite3_step(stmt)) {
            c.SQLITE_ROW => true,
            c.SQLITE_DONE => false,
            else => error.Corrupt,
        };
    }

    /// A prepare failure is `Corrupt`: `open` already proved `config` exists.
    fn prepareConfig(self: *Spd, key: []const u8) Error!*c.sqlite3_stmt {
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.db, "SELECT value FROM config WHERE name = ?1", -1, &stmt, null) != c.SQLITE_OK) {
            return error.Corrupt;
        }
        _ = c.sqlite3_bind_text(stmt, 1, key.ptr, @intCast(key.len), sqlite.transient());
        return stmt.?;
    }

    fn configText(self: *Spd, a: std.mem.Allocator, key: []const u8) Error!?[]const u8 {
        const stmt = try self.prepareConfig(key);
        defer _ = c.sqlite3_finalize(stmt);
        switch (c.sqlite3_step(stmt)) {
            c.SQLITE_ROW => {
                const ptr = c.sqlite3_column_text(stmt, 0);
                const len = c.sqlite3_column_bytes(stmt, 0);
                if (ptr == null or len <= 0) return null;
                return try a.dupe(u8, @as([*]const u8, @ptrCast(ptr))[0..@intCast(len)]);
            },
            c.SQLITE_DONE => return null,
            else => return error.Corrupt,
        }
    }

    /// A config value as `f32`; absent or unparseable is `null`.
    fn configFloat(self: *Spd, a: std.mem.Allocator, key: []const u8) Error!?f32 {
        const text = (try self.configText(a, key)) orelse return null;
        return std.fmt.parseFloat(f32, text) catch null;
    }

    fn configUint(self: *Spd, a: std.mem.Allocator, key: []const u8) Error!?u32 {
        const text = (try self.configText(a, key)) orelse return null;
        // `ppi` is an integer string ("72"); parsing as f32 also accepts "72.0".
        const f = std.fmt.parseFloat(f32, text) catch return null;
        // 2^32 as an exact f32 (maxInt(u32) has no exact f32).
        if (f < 0 or f >= 4294967296.0) return null;
        return @intFromFloat(f);
    }

    fn readConfigBlobDup(self: *Spd, a: std.mem.Allocator, key: []const u8) Error!?[]const u8 {
        const stmt = try self.prepareConfig(key);
        defer _ = c.sqlite3_finalize(stmt);
        switch (c.sqlite3_step(stmt)) {
            c.SQLITE_ROW => {
                const blob = columnBlob(stmt, 0);
                if (blob.len == 0) return null;
                return try a.dupe(u8, blob);
            },
            c.SQLITE_DONE => return null,
            else => return error.Corrupt,
        }
    }
};

/// A BLOB/TEXT column by byte count, safe for embedded NULs. Valid until the
/// next step/reset/finalize.
fn columnBlob(stmt: *c.sqlite3_stmt, col: c_int) []const u8 {
    const ptr = c.sqlite3_column_blob(stmt, col);
    const len = c.sqlite3_column_bytes(stmt, col);
    if (ptr == null or len <= 0) return "";
    return @as([*]const u8, @ptrCast(ptr))[0..@intCast(len)];
}

pub const LayerTree = struct {
    layers: []const LayerInfo,
    count: ?i32,
    active: ?i32,
};

/// Parses `config['ls']`, duping names into `a`. Malformed bytes return a
/// `protobuf.Error`. See `spd-format.md` for the field layout.
pub fn parseLayerTree(a: std.mem.Allocator, blob: []const u8) Error!LayerTree {
    var layers: std.ArrayList(LayerInfo) = .empty;

    var r = protobuf.Reader{ .data = blob };
    var count: ?i32 = null;
    var active: ?i32 = null;

    while (!r.atEnd()) {
        const tag = try protobuf.Tag.read(&r);
        if (tag.field == 1 and tag.wire == 2) {
            const sub = try r.readLengthDelimited();
            if (try parseLayer(a, sub)) |layer| try layers.append(a, layer);
        } else if (tag.field == 2 and tag.wire == 0) {
            count = varintToI32(try r.readVarint());
        } else if (tag.field == 3 and tag.wire == 0) {
            active = varintToI32(try r.readVarint());
        } else {
            try r.skip(tag.wire);
        }
    }

    return .{ .layers = try layers.toOwnedSlice(a), .count = count, .active = active };
}

/// One Layer submessage, or `null` if it carried no id.
fn parseLayer(a: std.mem.Allocator, blob: []const u8) Error!?LayerInfo {
    var r = protobuf.Reader{ .data = blob };
    var id: ?i32 = null;
    var name: []const u8 = "";
    var visible: bool = true; // absent visibility field ⇒ visible
    var opacity: u8 = 255; // absent opacity ⇒ fully opaque

    while (!r.atEnd()) {
        const tag = try protobuf.Tag.read(&r);
        if (tag.field == 1 and tag.wire == 0) {
            id = varintToI32(try r.readVarint());
        } else if (tag.field == 2 and tag.wire == 2) {
            name = try r.readLengthDelimited(); // borrows blob; duped below
        } else if (tag.field == 4 and tag.wire == 0) {
            visible = (try r.readVarint()) != 0;
        } else if (tag.field == 8 and tag.wire == 0) {
            const raw = try r.readVarint();
            opacity = @intCast(@min(raw, 255));
        } else {
            try r.skip(tag.wire);
        }
    }

    const layer_id = id orelse return null;
    return .{
        .id = layer_id,
        .name = try a.dupe(u8, name),
        .visible = visible,
        .opacity = opacity,
    };
}

/// Truncates a varint to `int32` without panicking on untrusted input.
fn varintToI32(v: u64) i32 {
    return @bitCast(@as(u32, @truncate(v)));
}

test "unpackTid uses the verified high=x / low12=y mapping" {
    const coord = try unpackTid(packTid(1953, 42));
    try std.testing.expectEqual(@as(u32, 1953), coord.x);
    try std.testing.expectEqual(@as(u16, 42), coord.y);
}

test "unpackTid rejects a negative tid rather than panicking" {
    try std.testing.expectError(error.BadTid, unpackTid(-1));
}

test "unpackTid rejects an oversized tid rather than truncating into a panic" {
    // tid whose high bits exceed u32 once shifted right by 12.
    const hostile: i64 = @as(i64, std.math.maxInt(u32)) << 12 | 1 << 60;
    try std.testing.expectError(error.TileCoordOverflow, unpackTid(hostile));
}

test "packTid round-trips the low-12/high split" {
    try std.testing.expectEqual(@as(i64, (7 << 12) | 3), packTid(7, 3));
}

test "parseLayerTree reads a hand-built two-layer tree" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    // Layer A body: 08 01  12 03 "Top"  40 80 01(=128)
    const layer_a = [_]u8{ 0x08, 0x01, 0x12, 0x03, 'T', 'o', 'p', 0x40, 0x80, 0x01 };
    // Layer B body: 08 8F 4E(=9999)  12 03 "Ref"  20 00(vis=0)
    const layer_b = [_]u8{ 0x08, 0x8F, 0x4E, 0x12, 0x03, 'R', 'e', 'f', 0x20, 0x00 };
    var blob: std.ArrayList(u8) = .empty;
    defer blob.deinit(a);
    try blob.append(a, 0x0a); // root field1, wire2
    try blob.append(a, @intCast(layer_a.len));
    try blob.appendSlice(a, &layer_a);
    try blob.append(a, 0x0a);
    try blob.append(a, @intCast(layer_b.len));
    try blob.appendSlice(a, &layer_b);

    const tree = try parseLayerTree(a, blob.items);
    try std.testing.expectEqual(@as(usize, 2), tree.layers.len);

    try std.testing.expectEqual(@as(i32, 1), tree.layers[0].id);
    try std.testing.expectEqualStrings("Top", tree.layers[0].name);
    try std.testing.expect(tree.layers[0].visible);
    try std.testing.expectEqual(@as(u8, 128), tree.layers[0].opacity);

    try std.testing.expectEqual(@as(i32, 9999), tree.layers[1].id);
    try std.testing.expect(tree.layers[1].isReference());
    try std.testing.expect(!tree.layers[1].visible); // field 4 = 0 ⇒ hidden
    try std.testing.expectEqual(@as(u8, 255), tree.layers[1].opacity); // absent ⇒ opaque
}

test "parseLayerTree surfaces a malformed blob as an error, never a panic" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const blob = [_]u8{ 0x0a, 0x14, 0x08, 0x01 };
    try std.testing.expectError(error.Malformed, parseLayerTree(a, &blob));
}
