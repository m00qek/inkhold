//! Container parser: an eager full parse whose cost is the metadata, never the
//! file size.
//!
//! Parse order mirrors the format; the stages cut it at its natural joints:
//!
//!   1. first 24 bytes           -> signature            \  Tier 0: signature.detect
//!   2. last 4 bytes             -> footer address        \
//!   3. footer block             -> index of everything    | file-level metadata
//!   4. footer.FILE_FEATURE      -> header block          /  (`metadataInto`)
//!   5. footer.PAGE*             -> page blocks           \  per-page metadata
//!   6. page.{MAINLAYER,...}     -> layer blocks          /  (`parsePageInto`)
//!   7. layer.LAYERBITMAP etc.   -> content blocks           Tier 3: decoder / render /
//!                                                            recognition / page_payload
//!
//! - **Tier 0** (`signature.detect` over the first `signature.probe_len` bytes)
//!   answers "is this a `.note`, which family, which version" and nothing else,
//!   and is the one public stage below `parse`.
//! - **`parse`/`parseSource`** read the footer address, the footer block, the
//!   FILE_FEATURE header block, then every page block plus its layer metadata
//!   blocks — all over ONE arena, via the `metadataInto` + `parsePageInto`
//!   internals. Bitmap BODIES are never read here: only their addresses are
//!   captured, so peak memory is the parsed metadata plus the single largest
//!   metadata block, never the file. Over a `.ranged` source these are small,
//!   absolutely-addressed reads on demand.
//! - **Tier 3** is explicit and heavy: `decoder` (RLE), `render` (compositing),
//!   `recognition` (OCR blob), `page_payload` (SNPG flattening).
//!
//! Every step is a small, absolutely-addressed read from a `source.Source`
//! (a slice the caller holds, or a positional reader over a blob on disk), and
//! everything a result exposes is **copied into its arena**, so no result ever
//! borrows from the input.

const std = @import("std");
const keyblock = @import("keyblock.zig");
const decoder = @import("decoder.zig");
const layerinfo = @import("layerinfo.zig");
const signature = @import("signature.zig");
const source = @import("source.zig");
const types = @import("types.zig");

pub const Source = source.Source;

/// Distinct error facts, `.spd`-style. The old implementation's sprawl maps in
/// as follows (documented so no test-relied-on information is lost):
///
///   old fact                          new fact
///   --------------------------------  -----------------------------------------
///   signature.BadSignature            NotNote
///   parser.Truncated (< 4 bytes)      Truncated
///   source/reader.OutOfBounds         Truncated — an address or length points
///                                     past EOF; from the parser's seat a
///                                     cut-short file and a garbage pointer are
///                                     indistinguishable, and both mean "the
///                                     source ended before the structure did"
///   parser.MissingField               Corrupt — footer without FILE_FEATURE, or
///                                     a PAGE* value that is not an address
///   recognition base64/json errors    Corrupt (see recognition.zig)
///   source.ReadFailed                 ReadFailed — backing-store I/O trouble,
///                                     kept separate because it is not a fact
///                                     about the file at all
///   render/page_payload PageOutOfRange PageOutOfRange (caller-level, unchanged)
///   decoder.SizeMismatch              stays a decoder-level fact (decoder.zig)
///   page_payload.BadPayload           stays a payload-level fact (page_payload.zig)
pub const Error = error{
    /// The leading bytes carry no known `.note` signature.
    NotNote,
    /// The source ends before data the structure references (including a
    /// too-short file and any block address/length pointing past EOF).
    Truncated,
    /// The structure is invalid: a footer without FILE_FEATURE, a page address
    /// that is not a number, an undecodable recognition blob.
    Corrupt,
    /// The backing store failed to produce bytes for an in-bounds range.
    ReadFailed,
    /// A page index at or past `pageCount()`.
    PageOutOfRange,
} || std.mem.Allocator.Error;

/// Lifts a raw source error into the tier taxonomy. See `Error` for why
/// OutOfBounds reads as Truncated. Public so the Tier-3 modules
/// (`render`/`recognition`/`page_payload`, which already import this one) share
/// the one mapping for their `source.Error`-returning block reads.
pub fn lift(e: source.Error) Error {
    return switch (e) {
        error.OutOfBounds => error.Truncated,
        error.ReadFailed => error.ReadFailed,
    };
}

// ---------------------------------------------------------------------------
// Tier internals — the single implementation the public tiers and the eager
// parse both compose. Everything allocates into the caller's arena allocator.
// ---------------------------------------------------------------------------

/// The file-level facts `metadataInto` reads, before the per-page loop.
const RawMetadata = struct {
    signature: signature.Signature,
    header: keyblock.Block,
    footer: keyblock.Block,
    page_addresses: []const u32,
};

/// Tier 1: footer address -> footer block -> header block. Never reads a page
/// block; the page ADDRESSES come straight out of the footer.
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
        .page_addresses = try pageAddresses(a, footer),
    };
}

/// Tier 2: one page block plus its layer metadata blocks. Captures each layer's
/// bitmap ADDRESS; never touches bitmap bodies.
fn parsePageInto(a: std.mem.Allocator, src: Source, address: u32) Error!types.Page {
    const block = try parseBlockInto(a, src, address);

    // Collect the layers that are actually present (non-zero address).
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

    // The layer-panel state, typed. The value lives inside the page block that
    // is already in hand, so this costs allocation only — no extra reads (the
    // read-accounting tests pin that). Malformed LAYERINFO is null: a recorded
    // fact, not an error (see layerinfo.zig).
    const info = if (block.get("LAYERINFO")) |raw| try layerinfo.parse(a, raw) else null;

    return .{ .block = block, .layers = layers, .layer_info = info };
}

/// Reads the leading bytes into `a` and detects the signature over the copy, so
/// `Signature.raw` / `.filetype` are owned like everything else.
fn detectSignatureInto(a: std.mem.Allocator, src: Source) Error!signature.Signature {
    const n: usize = @intCast(@min(src.size(), signature.probe_len));
    const head = try a.alloc(u8, n);
    src.read(0, head) catch |e| return lift(e);
    return signature.detect(head);
}

/// Reads the metadata block at `address` into `a` and parses it. The payload
/// copy stays in the arena, which is what the returned entries point into.
fn parseBlockInto(a: std.mem.Allocator, src: Source, address: u64) Error!keyblock.Block {
    const payload = src.blockAlloc(a, address) catch |e| return switch (e) {
        error.OutOfMemory => error.OutOfMemory,
        error.OutOfBounds => error.Truncated,
        error.ReadFailed => error.ReadFailed,
    };
    return keyblock.parse(a, payload);
}

/// The cover image's content-block address out of a footer, or null when the
/// note has no cover. The `COVER_n` suffix is a TYPE, not a page number:
/// `COVER_3` and `COVER_2` are both user-set covers (`COVER_3` is the newer
/// key a current-firmware "set as cover" writes), `COVER_1` an automatic one.
/// The preference is newest-wins — `COVER_3`, then `COVER_2`, then `COVER_1`
/// — which extends the reference implementation's `COVER_2`-over-`COVER_1`
/// order (supernote-tool `parser.py`) to the key later devices emit. A value
/// of `0` (the device writes an explicit `<COVER_0:0>` placeholder while no
/// cover is chosen, and would treat a zeroed `COVER_n` the same way) and an
/// absent key both mean "no cover". See note-format.md §5.
fn coverAddressIn(footer: keyblock.Block) ?u64 {
    for ([_][]const u8{ "COVER_3", "COVER_2", "COVER_1" }) |key| {
        const addr = footer.getInt(key) orelse continue;
        if (addr != 0) return addr;
    }
    return null;
}

/// Every footer entry whose key starts with "PAGE", as an address, preserving
/// footer order. A PAGE value that is not a number is `Corrupt` — a footer that
/// indexes a page it cannot point at is not "a file with fewer pages".
fn pageAddresses(a: std.mem.Allocator, footer: keyblock.Block) Error![]const u32 {
    var n: usize = 0;
    for (footer.entries) |e| {
        if (std.mem.startsWith(u8, e.key, "PAGE")) n += 1;
    }
    const addrs = try a.alloc(u32, n);

    var i: usize = 0;
    for (footer.entries) |e| {
        if (!std.mem.startsWith(u8, e.key, "PAGE")) continue;
        addrs[i] = std.fmt.parseInt(u32, e.value, 10) catch return error.Corrupt;
        i += 1;
    }
    return addrs;
}

// ---------------------------------------------------------------------------
// Eager full parse — the tier internals composed over one arena.
// ---------------------------------------------------------------------------

/// A fully parsed `.note` container.
///
/// **The Note owns everything it exposes.** Every string it hands out —
/// signature, header/footer/page/layer metadata — is copied into `arena` at
/// parse time, so nothing borrows from the input. That is not merely tidier
/// than a borrow-from-`bytes` contract: a ranged source has no persistent
/// buffer to borrow from, so owning unconditionally is what makes the two
/// backings behave identically instead of subtly differently. The cost is
/// nothing that matters — a Note holds only metadata, never bitmaps.
///
/// `source` is retained to read *content* blocks (bitmaps, recognition text) on
/// demand. For a `.ranged` source the caller must keep the underlying object
/// (the blob) readable for the Note's lifetime.
pub const Note = struct {
    arena: std.heap.ArenaAllocator,
    /// Where content blocks are read from, by address.
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
    /// The note's BASE (portrait) dims. A page's effective dims are
    /// `dimensions().oriented(pages[i].orientation())` — see `types.Orientation`.
    pub fn dimensions(self: Note) types.Dimensions {
        return types.Dimensions.forEquipment(self.applyEquipment());
    }
    pub fn pageCount(self: Note) usize {
        return self.pages.len;
    }
    /// The RLE variant this file's bitmaps use.
    pub fn rleVariant(self: Note) decoder.Variant {
        return decoder.variantForHighres(self.signature.supportsHighresGrayscale());
    }
    /// The cover image's content-block address (newest-wins: `COVER_3` over
    /// `COVER_2` over `COVER_1`; `0`/absent — including the device's
    /// `<COVER_0:0>` "no cover set" placeholder — is null). The footer is part
    /// of the eager parse, so this costs nothing; the block's LENGTH is equally
    /// cheap via `source.blockRange(addr).len` (the 4-byte prefix only), and its
    /// BYTES are one `source.blockAlloc(gpa, addr)` — what a budgeted indexer
    /// streams. See note-format.md §5 for the `COVER_n` key semantics.
    pub fn coverAddress(self: Note) ?u64 {
        return coverAddressIn(self.footer);
    }
};

/// Parses `bytes` into a `Note`. Thin wrapper over `parseSource` for callers
/// that already hold the whole file; the resulting `Note` owns its strings, so
/// `bytes` need NOT outlive it (though content-block reads via `note.source`
/// still address into it — keep it alive to render).
pub fn parse(gpa: std.mem.Allocator, bytes: []const u8) Error!Note {
    return parseSource(gpa, Source.fromSlice(bytes));
}

/// Parses whatever `src` addresses into a `Note` — Tier 1 plus a Tier-2 loop
/// over every page, sharing one arena. Peak memory is the parsed metadata plus
/// the single largest metadata block — never the file size.
pub fn parseSource(gpa: std.mem.Allocator, src: Source) Error!Note {
    var arena = std.heap.ArenaAllocator.init(gpa);
    errdefer arena.deinit();
    const a = arena.allocator();

    const raw = try metadataInto(a, src);

    const pages = try a.alloc(types.Page, raw.page_addresses.len);
    for (raw.page_addresses, pages) |addr, *p| {
        p.* = try parsePageInto(a, src, addr);
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

// ---------------------------------------------------------------------------
// Tests (fixture-driven tests live in tests/note_test.zig)
// ---------------------------------------------------------------------------

test "parse rejects a too-short buffer" {
    try std.testing.expectError(error.Truncated, parse(std.testing.allocator, "ab"));
}

test "parse rejects a buffer without a valid signature" {
    // 8 bytes so the footer-address read itself doesn't fail first.
    try std.testing.expectError(error.NotNote, parse(std.testing.allocator, "xxxxxxxx"));
}

test "a signature whose footer address points past EOF is Truncated" {
    // Valid X-series head, then a footer address of 0xFFFFFFFF.
    const bytes = "noteSN_FILE_VER_20260016" ++ "\xFF\xFF\xFF\xFF";
    try std.testing.expectError(error.Truncated, parse(std.testing.allocator, bytes));
}
