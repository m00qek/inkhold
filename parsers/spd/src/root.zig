//! Public entry point for the standalone `.spd` (Supernote Atelier) parser:
//! opens the SQLite drawing read-only in memory and exposes metadata, layers,
//! tiles and thumbnail.

const spd = @import("spd.zig");

pub const Spd = spd.Spd;
pub const Metadata = spd.Metadata;
pub const LayerInfo = spd.LayerInfo;
pub const LayerTree = spd.LayerTree;
pub const Tile = spd.Tile;
pub const TileIterator = spd.TileIterator;
pub const Error = spd.Error;

pub const reference_layer_id = spd.reference_layer_id;
pub const tile_px = spd.tile_px;

pub const unpackTid = spd.unpackTid;
pub const packTid = spd.packTid;
pub const parseLayerTree = spd.parseLayerTree;

/// Opens `bytes` as a read-only `.spd`. `bytes` is copied and need not outlive
/// the result. See `Spd.open` for the error taxonomy.
pub fn open(gpa: @import("std").mem.Allocator, bytes: []const u8) Error!Spd {
    return Spd.open(gpa, bytes);
}

/// Re-exported so consumers share this package's single vendored SQLite.
pub const sqlite = @import("sqlite.zig");

test {
    @import("std").testing.refAllDecls(@This());
    _ = @import("protobuf.zig");
    _ = @import("spd.zig");
}
