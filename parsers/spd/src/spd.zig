//! Reader for the Supernote Atelier `.spd` format — a layered-drawing document
//! that is, on disk, an **SQLite database**.
//!
//! ## Trust model (the load-bearing decision)
//!
//! A `.spd` is attacker-supplied: it arrives over the sync API from a device we
//! do not control. It is a *SQLite database*, which is a scripting surface, not
//! an inert blob. So this reader NEVER opens it as a file and NEVER opens it
//! read-write. It:
//!   * copies the bytes into memory we own,
//!   * opens a fresh `:memory:` connection, and
//!   * attaches the image with `sqlite3_deserialize(..., SQLITE_DESERIALIZE_READONLY)`.
//! The connection cannot write, cannot touch the filesystem, and cannot outlive
//! the copy it borrows. The read-only guarantee is asserted by the test suite
//! (a write against the open connection must be refused).
//!
//! ## What it exposes
//!
//! `open` → `metadata` (config values + the z-ordered layer tree) → `thumbnail`
//! (embedded JPEG) and `iterateLayer` (streaming PNG tiles). Tiles are streamed
//! straight out of SQLite; everything else is copied into caller-owned memory so
//! nothing borrows past `deinit`.
//!
//! ## Layout facts (verified against real captures, appVersion 1.1.78 / 1.1.82,
//! fmt_ver 2 — see spd-format.md)
//!
//!   * `config(name TEXT PRIMARY KEY, value BLOB)` — key/value metadata. NOTE the
//!     `thumbnail` value carries TEXT affinity but holds binary JPEG, so it must
//!     be read as a blob (byte count), never as text (which stops at the first
//!     NUL and reports a nonsense length).
//!   * `surface_<id>(tid INTEGER PRIMARY KEY, tile BLOB)` — one table per layer,
//!     each row a 128×128 PNG tile at grid position `tid` (see `unpackTid`).
//!   * `config['ls']` — a protobuf blob describing the layer tree (`parseLayerTree`).

const std = @import("std");
const sqlite = @import("sqlite.zig");
const protobuf = @import("protobuf.zig");

const c = sqlite.c;

/// Layer id the app reserves for the template/background ("Reference Layer").
/// The device hardcodes UI rules around it; a renderer treats an empty one as a
/// solid white background.
pub const reference_layer_id: i32 = 9999;

/// Tiles are 128×128 px. Absolute pixel position is grid coordinate × this.
pub const tile_px: u32 = 128;

pub const Error = error{
    /// The bytes do not begin with the SQLite file magic — not a database at all.
    NotSqlite,
    /// A valid SQLite database, but without a `config` table: not an `.spd`.
    NotSpd,
    /// A query that must succeed did not — a truncated/garbled database whose
    /// header passed but whose pages did not. Distinguished from "field absent"
    /// on purpose: a corrupt file must not read as a blank one.
    Corrupt,
    /// A `tid` decodes to an x-tile beyond `u32` (only reachable with a crafted
    /// oversized `tid`; legitimate files stay far inside the range).
    TileCoordOverflow,
    /// A `tid` column was negative — impossible for a real file.
    BadTid,
} || std.mem.Allocator.Error || protobuf.Error;

/// One layer's metadata, as parsed from `config['ls']`.
pub const LayerInfo = struct {
    /// Internal id; the tile data lives in `surface_<id>`.
    id: i32,
    /// User-facing name (owned by the parent `Metadata.arena`; "" if unnamed).
    name: []const u8,
    /// False only when the file explicitly hides the layer (protobuf field 4 = 0).
    visible: bool,
    /// Raw 0..255 opacity as stored. Use `opacityFraction` for a 0.0..1.0 value.
    opacity: u8,

    pub fn opacityFraction(self: LayerInfo) f32 {
        return @as(f32, @floatFromInt(self.opacity)) / 255.0;
    }
    pub fn isReference(self: LayerInfo) bool {
        return self.id == reference_layer_id;
    }
};

/// Document metadata: config scalars plus the layer tree. Every field is
/// optional because a `.spd` may legitimately omit any given config key — a
/// `null` here means "absent", which the read path keeps distinct from the
/// `error.Corrupt` it returns when a query itself fails.
///
/// Owns an arena that backs `layers` and their names; call `deinit`.
pub const Metadata = struct {
    arena: std.heap.ArenaAllocator,

    fmt_ver: ?[]const u8,
    app_version: ?[]const u8,
    ppi: ?u32,
    width: ?f32,
    height: ?f32,
    vp_x: ?f32,
    vp_y: ?f32,

    /// Layers in Z-order: `layers[0]` is the topmost, `layers[len-1]` bottommost
    /// — the order the protobuf stores them (see `parseLayerTree`).
    layers: []const LayerInfo,
    /// The count/active-layer the header declares, if present (informational;
    /// `layers.len` is the authority on how many were actually parsed).
    declared_layer_count: ?i32,
    active_layer_id: ?i32,

    pub fn deinit(self: *Metadata) void {
        self.arena.deinit();
    }
};

/// One decoded tile. `png` borrows SQLite's row memory and is valid only until
/// the next `TileIterator.next`/`deinit` — copy it if you need to keep it.
pub const Tile = struct {
    tid: i64,
    /// Horizontal grid coordinate (high bits of `tid`). Absolute x px = `x*128`.
    x: u32,
    /// Vertical grid coordinate (low 12 bits of `tid`, 0..4095). Abs y px = `y*128`.
    y: u16,
    png: []const u8,
};

/// `tid` packs the two tile-grid coordinates into one integer. VERIFIED against
/// a real drawing (only this mapping reconstructs a coherent, correctly-oriented
/// image; the transpose scrambles it — see spd-format.md §tid):
///
///   x_tile = tid >> 12      (the high bits — horizontal)
///   y_tile = tid & 0x0FFF   (the low 12 bits — vertical, 0..4095)
///
/// This is the OPPOSITE axis assignment to the one the human-readable spec prose
/// and the PoC parser used; they had x and y swapped.
pub fn unpackTid(tid: i64) Error!struct { x: u32, y: u16 } {
    if (tid < 0) return error.BadTid;
    const t: u64 = @intCast(tid);
    const x64 = t >> 12;
    if (x64 > std.math.maxInt(u32)) return error.TileCoordOverflow;
    return .{ .x = @intCast(x64), .y = @intCast(t & 0x0FFF) };
}

/// Inverse of `unpackTid`. `y` is a `u12` because that is the field's real range.
pub fn packTid(x: u32, y: u12) i64 {
    return (@as(i64, x) << 12) | @as(i64, y);
}

/// Streams a layer's PNG tiles, one prepared SQLite statement, zero buffering.
/// A `null` statement means the layer has no table (an absent or empty layer),
/// which yields zero tiles rather than an error.
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

/// An open, read-only `.spd`. Owns both the SQLite connection and the in-memory
/// image the connection borrows — `deinit` tears down both, in order.
pub const Spd = struct {
    db: *c.sqlite3,
    /// The database image, owned by us. `sqlite3_deserialize` borrows this
    /// pointer for the connection's whole life (we pass neither FREEONCLOSE nor
    /// RESIZEABLE), so it must be freed only AFTER the connection is closed, and
    /// the caller's original slice is never referenced — we copied it. This is
    /// the deliberate answer to the PoC's zero-copy-borrow lifetime footgun.
    image: []u8,
    gpa: std.mem.Allocator,

    /// The 16-byte magic every SQLite file starts with. Checking it first turns a
    /// non-database blob into a fast, specific `error.NotSqlite` instead of a
    /// deserialize that half-succeeds.
    const sqlite_magic = "SQLite format 3\x00";

    /// Rewrites the two SQLite header format-version bytes (offsets 18 = write,
    /// 19 = read) from WAL (2) to legacy rollback-journal (1). See the call site
    /// in `open` for why. A no-op for a file that is already legacy-mode.
    fn neutralizeWalMode(image: []u8) void {
        if (image.len < 20) return; // header is 100 bytes; a real db has these
        if (image[18] == 2) image[18] = 1;
        if (image[19] == 2) image[19] = 1;
    }

    /// Opens `bytes` as a read-only `.spd`. `bytes` need NOT outlive the return
    /// value — it is copied. Fails with `NotSqlite` for a non-database blob,
    /// `NotSpd` for a database that isn't an `.spd`, `Corrupt` for a broken one.
    pub fn open(gpa: std.mem.Allocator, bytes: []const u8) Error!Spd {
        if (bytes.len < sqlite_magic.len or !std.mem.startsWith(u8, bytes, sqlite_magic)) {
            return error.NotSqlite;
        }

        // Own the image. Freed by deinit, after the connection that borrows it.
        const image = try gpa.dupe(u8, bytes);
        errdefer gpa.free(image);

        // Every real `.spd` the device writes is a WAL-mode database (header
        // bytes 18/19 == 2). `sqlite3_deserialize` into `:memory:` cannot run
        // WAL — there is no companion `-wal` file and an in-memory db has no
        // journal — so it would fail outright. We hold a fresh, read-only copy
        // and the file at rest is checkpointed, so its main image already holds
        // the committed state; rewriting the two format-version bytes to 1
        // (legacy rollback-journal) makes SQLite read exactly that state. This
        // is a read-time reinterpretation of OUR copy only, before any
        // connection touches it — the original bytes are untouched.
        neutralizeWalMode(image);

        var db: ?*c.sqlite3 = null;
        if (c.sqlite3_open(":memory:", &db) != c.SQLITE_OK) {
            if (db) |h| _ = c.sqlite3_close(h);
            return error.OutOfMemory; // opening :memory: only fails on allocation
        }
        errdefer _ = c.sqlite3_close(db);

        // Read-only, in place. No FREEONCLOSE: we free `image` ourselves. No
        // RESIZEABLE: a read-only db never grows.
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

        // A database is only an `.spd` if it has the `config` table. This also
        // forces SQLite to actually read a page, catching a header-valid but
        // body-corrupt image here rather than on first metadata read.
        if (!try self.hasTable("config")) return error.NotSpd;

        return self;
    }

    pub fn deinit(self: *Spd) void {
        _ = c.sqlite3_close(self.db); // must precede the free of the image it borrowed
        self.gpa.free(self.image);
        self.* = undefined;
    }

    /// Reads config scalars and the layer tree into a caller-owned `Metadata`.
    pub fn metadata(self: *Spd, gpa: std.mem.Allocator) Error!Metadata {
        var arena = std.heap.ArenaAllocator.init(gpa);
        errdefer arena.deinit();
        const a = arena.allocator();

        // EVERY allocation via `a` must happen BEFORE `arena` is moved into the
        // returned struct: `ArenaAllocator.allocator()` binds to this local's
        // address, so allocating through `a` after the move would grow a
        // different arena than the one the caller deinits (a leak). Same
        // discipline as src/note/parser.zig.
        const fmt_ver = try self.configText(a, "fmt_ver");
        const app_version = try self.configText(a, "appVersion");
        const ppi = try self.configUint(a, "ppi");
        const width = try self.configFloat(a, "surface.width");
        const height = try self.configFloat(a, "surface.height");
        const vp_x = try self.configFloat(a, "vp.x");
        const vp_y = try self.configFloat(a, "vp.y");

        // The layer tree. A malformed `ls` is corruption we surface (never a
        // silent empty tree) — parseLayerTree returns a protobuf error, which
        // this propagates.
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

    /// Returns the embedded JPEG thumbnail, copied into `gpa`, or `null` when the
    /// file has none. Read as a blob by byte count — see the type-level note on
    /// `thumbnail`'s TEXT affinity.
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

    /// Streams the tiles of `surface_<layer_id>`. A layer with no table (absent,
    /// or an empty reference layer) yields an iterator over zero tiles rather
    /// than an error — "no tiles" is a normal, expected state.
    ///
    /// The table name is built from an integer, so there is no SQL-injection
    /// surface; a bogus id simply names a table that does not exist.
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

    /// True if a table named `name` exists. Prepared with a bound parameter, so
    /// `name` is never interpolated into SQL.
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

    /// Prepares `SELECT value FROM config WHERE name = <key>` with `key` bound.
    /// A prepare failure here is `Corrupt`: `open` already proved `config` exists.
    fn prepareConfig(self: *Spd, key: []const u8) Error!*c.sqlite3_stmt {
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.db, "SELECT value FROM config WHERE name = ?1", -1, &stmt, null) != c.SQLITE_OK) {
            return error.Corrupt;
        }
        _ = c.sqlite3_bind_text(stmt, 1, key.ptr, @intCast(key.len), sqlite.transient());
        return stmt.?;
    }

    /// A config value as text copied into `a`, or `null` if the key is absent.
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

    /// A config value as `f32`. `null` when the key is absent; a present-but-
    /// unparseable value is also `null` (a stored non-number is data, not a
    /// broken database).
    fn configFloat(self: *Spd, a: std.mem.Allocator, key: []const u8) Error!?f32 {
        const text = (try self.configText(a, key)) orelse return null;
        return std.fmt.parseFloat(f32, text) catch null;
    }

    fn configUint(self: *Spd, a: std.mem.Allocator, key: []const u8) Error!?u32 {
        const text = (try self.configText(a, key)) orelse return null;
        // `ppi` is stored as an integer-valued string ("72"); parse leniently
        // through f32 so a "72.0" would still read.
        const f = std.fmt.parseFloat(f32, text) catch return null;
        // 2^32 as an exact f32 — comparing against maxInt(u32) directly is
        // rejected because that integer has no exact f32 representation.
        if (f < 0 or f >= 4294967296.0) return null;
        return @intFromFloat(f);
    }

    /// A config value's raw bytes copied into `a`, or `null` if absent. Used for
    /// the `ls` protobuf, which must be read as bytes.
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

/// A borrowed view of a BLOB/TEXT column as raw bytes. Uses the byte count, not
/// C-string semantics, so it is correct for binary values with embedded NULs
/// (the thumbnail, the `ls` blob). Valid until the next step/reset/finalize.
fn columnBlob(stmt: *c.sqlite3_stmt, col: c_int) []const u8 {
    const ptr = c.sqlite3_column_blob(stmt, col);
    const len = c.sqlite3_column_bytes(stmt, col);
    if (ptr == null or len <= 0) return "";
    return @as([*]const u8, @ptrCast(ptr))[0..@intCast(len)];
}

/// The parsed layer tree: layers in Z-order plus the two root scalars.
pub const LayerTree = struct {
    layers: []const LayerInfo,
    count: ?i32,
    active: ?i32,
};

/// Parses `config['ls']` — the layer-tree protobuf. Layer names are duped into
/// `a`. Structure (reverse-engineered, confirmed against real files):
///   root:  field 1 = repeated Layer (Z-order: first = topmost)
///          field 2 = total layer count, field 3 = active layer id
///   Layer: field 1 = id, field 2 = name, field 4 = visibility (0 ⇒ hidden,
///          field absent ⇒ visible), field 8 = opacity (0..255)
///
/// Any malformed byte sequence returns a `protobuf.Error` — deliberately, so a
/// corrupt layer tree is reported, not silently flattened to "no layers".
pub fn parseLayerTree(a: std.mem.Allocator, blob: []const u8) Error!LayerTree {
    var layers: std.ArrayList(LayerInfo) = .empty;
    // Names are arena-owned; on error the arena the caller passes is torn down
    // wholesale, so there is nothing to free element-by-element here.

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

/// Parses one Layer submessage. Returns `null` for a submessage that carried no
/// id (nothing addressable), so callers do not append a phantom layer.
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

/// Truncates a protobuf varint to the format's `int32` field width without
/// panicking on an out-of-range value (attacker input may exceed 32 bits).
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

    // root field1 (Layer): {id=1, name="Top", opacity=128}
    // root field1 (Layer): {id=9999, name="Ref", vis=0}
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
    // A layer submessage claiming a 20-byte length inside a 4-byte body.
    const blob = [_]u8{ 0x0a, 0x14, 0x08, 0x01 };
    try std.testing.expectError(error.Malformed, parseLayerTree(a, &blob));
}
