//! Public entry point for the standalone `.spd` (Supernote Atelier) parser.
//!
//! A `.spd` is an SQLite database of a layered drawing. This library opens one
//! **read-only, in memory** (attacker-supplied — see `spd.zig`), and exposes its
//! metadata, layer tree, tiles, and thumbnail. It has no consumer wired in yet;
//! import it as the `spd` module (this file is the module root).
//!
//! ```zig
//! var doc = try spd.open(gpa, bytes);   // bytes may be freed immediately after
//! defer doc.deinit();
//! var meta = try doc.metadata(gpa);
//! defer meta.deinit();
//! for (meta.layers) |layer| { ... }     // Z-ordered, topmost first
//! var it = try doc.iterateLayer(meta.layers[0].id);
//! defer it.deinit();
//! while (try it.next()) |tile| { ... }   // tile.png borrows until next()
//! ```

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

/// Re-exported so a test or consumer that needs the raw handle shares this
/// package's single (vendored) SQLite rather than linking a second one.
pub const sqlite = @import("sqlite.zig");

test {
    // Pull in the unit tests that live next to the code.
    @import("std").testing.refAllDecls(@This());
    _ = @import("protobuf.zig");
    _ = @import("spd.zig");
}
