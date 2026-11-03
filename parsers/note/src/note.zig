//! Container parser: an eager full parse whose cost is the metadata, never the
//! file size. Footer address (last 4 bytes) -> footer -> header -> page blocks
//! -> layer blocks, all copied into one arena; bitmap bodies are only addressed.

const std = @import("std");
const keyblock = @import("keyblock.zig");
const decoder = @import("decoder.zig");
const layerinfo = @import("layerinfo.zig");
const signature = @import("signature.zig");
const source = @import("source.zig");
const types = @import("types.zig");

pub const Source = source.Source;

/// Parse errors. Out-of-bounds reads are `Truncated`: a cut file and a garbage
/// pointer are indistinguishable from here. `ReadFailed` is backing-store I/O,
/// not a fact about the file.
pub const Error = error{
    NotNote,
    Truncated,
    Corrupt,
    ReadFailed,
    PageOutOfRange,
} || std.mem.Allocator.Error;

/// Maps a `source.Error` into this taxonomy; shared by the Tier-3 modules.
pub fn lift(e: source.Error) Error {
    return switch (e) {
        error.OutOfBounds => error.Truncated,
        error.ReadFailed => error.ReadFailed,
    };
}

// ---- tier internals, allocating into the caller's arena ----

const RawMetadata = struct {
    signature: signature.Signature,
    header: keyblock.Block,
    footer: keyblock.Block,
    page_entries: []const PageEntry,
};

/// Footer address -> footer block -> header block; page addresses come from
/// the footer.
fn metadataInto(a: std.mem.Allocator, src: Source) Error!RawMetadata {
    if (src.size() < 4) return error.Truncated;

    const sig = try detectSignatureInto(a, src);

    const footer_addr = src.u32le(src.size() - 4) catch |e| return lift(e);
    const footer = try parseBlockInto(a, src, footer_addr);

    const header_addr = footer.getInt("FILE_FEATURE") orelse return error.Corrupt;
    const header = try parseBlockInto(a, src, header_addr);

    return .{
        .signature = sig,
        .header = header,
        .footer = footer,
        .page_entries = try pageEntries(a, footer),
    };
}

/// One page block plus its layer metadata; captures bitmap addresses only.
fn parsePageInto(a: std.mem.Allocator, src: Source, entry: PageEntry) Error!types.Page {
    const block = try parseBlockInto(a, src, entry.address);

    var present: usize = 0;
    for (types.LayerSlot.all) |slot| {
        const addr = block.getInt(slot.key()) orelse 0;
        if (addr != 0) present += 1;
    }
    const layers = try a.alloc(types.Layer, present);

    var i: usize = 0;
    for (types.LayerSlot.all) |slot| {
        const addr = block.getInt(slot.key()) orelse 0;
        if (addr == 0) continue;
        const layer_block = try parseBlockInto(a, src, addr);
        layers[i] = .{ .slot = slot, .block = layer_block };
        i += 1;
    }

    // LAYERINFO is already in the page block: no extra reads. Malformed is null.
    const info = if (block.get("LAYERINFO")) |raw| try layerinfo.parse(a, raw) else null;

    return .{ .block = block, .layers = layers, .layer_info = info, .number = entry.number };
}

/// Detects the signature over an arena copy, so its slices are owned.
fn detectSignatureInto(a: std.mem.Allocator, src: Source) Error!signature.Signature {
    const n: usize = @intCast(@min(src.size(), signature.probe_len));
    const head = try a.alloc(u8, n);
    src.read(0, head) catch |e| return lift(e);
    return signature.detect(head);
}

fn parseBlockInto(a: std.mem.Allocator, src: Source, address: u64) Error!keyblock.Block {
    const payload = src.blockAlloc(a, address) catch |e| return switch (e) {
        error.OutOfMemory => error.OutOfMemory,
        error.OutOfBounds => error.Truncated,
        error.ReadFailed => error.ReadFailed,
    };
    return keyblock.parse(a, payload);
}

/// The cover's content-block address: `COVER_3`, then `COVER_2`, then
/// `COVER_1`; `0` (incl. `<COVER_0:0>`) or absent is none (`note-format.md` §5).
fn coverAddressIn(footer: keyblock.Block) ?u64 {
    for ([_][]const u8{ "COVER_3", "COVER_2", "COVER_1" }) |key| {
        const addr = footer.getInt(key) orelse continue;
        if (addr != 0) return addr;
    }
    return null;
}

pub const PageEntry = struct {
    number: u32,
    address: u32,
};

/// Every footer `PAGE<n>` entry in footer order. The key's `<n>` is data: a
/// `.mark` stores only annotated pages (`note-format.md` §13.2). A non-numeric
/// key or value is `Corrupt`.
fn pageEntries(a: std.mem.Allocator, footer: keyblock.Block) Error![]const PageEntry {
    var n: usize = 0;
    for (footer.entries) |e| {
        if (std.mem.startsWith(u8, e.key, "PAGE")) n += 1;
    }
    const out = try a.alloc(PageEntry, n);

    var i: usize = 0;
    for (footer.entries) |e| {
        if (!std.mem.startsWith(u8, e.key, "PAGE")) continue;
        out[i] = .{
            .number = std.fmt.parseInt(u32, e.key["PAGE".len..], 10) catch return error.Corrupt,
            .address = std.fmt.parseInt(u32, e.value, 10) catch return error.Corrupt,
        };
        i += 1;
    }
    return out;
}

// ---- eager full parse ----

/// A fully parsed `.note`. Everything it exposes is copied into `arena`, so
/// slice and ranged sources behave identically. `source` is kept for content
/// blocks; a ranged source's blob must stay readable for the Note's lifetime.
pub const Note = struct {
    arena: std.heap.ArenaAllocator,
    source: Source,
    signature: signature.Signature,
    header: keyblock.Block,
    footer: keyblock.Block,
    pages: []const types.Page,

    pub fn deinit(self: *Note) void {
        self.arena.deinit();
    }

    pub fn applyEquipment(self: Note) ?[]const u8 {
        return self.header.get("APPLY_EQUIPMENT");
    }
    pub fn fileId(self: Note) ?[]const u8 {
        return self.header.get("FILE_ID");
    }
    /// Base (portrait) dims; a page's are `.oriented(pages[i].orientation())`.
    pub fn dimensions(self: Note) types.Dimensions {
        return types.Dimensions.forEquipment(self.applyEquipment());
    }
    pub fn pageCount(self: Note) usize {
        return self.pages.len;
    }
    pub fn rleVariant(self: Note) decoder.Variant {
        return decoder.variantForHighres(self.signature.supportsHighresGrayscale());
    }
    /// See `coverAddressIn`. Length is `source.blockRange(addr).len`.
    pub fn coverAddress(self: Note) ?u64 {
        return coverAddressIn(self.footer);
    }
};

/// Parses a whole-file slice. The Note owns its strings, but content reads
/// still address into `bytes`; keep it alive to render.
pub fn parse(gpa: std.mem.Allocator, bytes: []const u8) Error!Note {
    return parseSource(gpa, Source.fromSlice(bytes));
}

/// Tier 1 plus every page over one arena.
pub fn parseSource(gpa: std.mem.Allocator, src: Source) Error!Note {
    var arena = std.heap.ArenaAllocator.init(gpa);
    errdefer arena.deinit();
    const a = arena.allocator();

    const raw = try metadataInto(a, src);

    const pages = try a.alloc(types.Page, raw.page_entries.len);
    for (raw.page_entries, pages) |entry, *p| {
        p.* = try parsePageInto(a, src, entry);
    }

    return .{
        .arena = arena, // moved last — see `metadata` for the discipline
        .source = src,
        .signature = raw.signature,
        .header = raw.header,
        .footer = raw.footer,
        .pages = pages,
    };
}

// ---- tests (fixture-driven ones are in tests/note_test.zig) ----

test "parse rejects a too-short buffer" {
    try std.testing.expectError(error.Truncated, parse(std.testing.allocator, "ab"));
}

test "parse rejects a buffer without a valid signature" {
    try std.testing.expectError(error.NotNote, parse(std.testing.allocator, "xxxxxxxx"));
}

test "a signature whose footer address points past EOF is Truncated" {
    const bytes = "noteSN_FILE_VER_20260016" ++ "\xFF\xFF\xFF\xFF";
    try std.testing.expectError(error.Truncated, parse(std.testing.allocator, bytes));
}
