//! Tier 3 — self-describing single-page payload: the wire contract between a
//! server's page-range endpoint and a browser-side WASM decoder.
//!
//! A `.note` container is address-based: a page's pixel data lives in scattered
//! layer bitmap content blocks reachable only via the footer offset table. The
//! browser must NOT re-parse the whole container to draw one page. So the server
//! (which already parses the footer at sync time) flattens one page into this
//! compact, contiguous, self-describing blob:
//!
//!     GET /note/{id}/page/{n}?v={page_content_md5}  ->  an "SNPG" payload
//!
//! The WASM side consumes it with `decodeRgba` and stays dumb about the
//! container. This module holds BOTH sides so they can never drift: `serialize`
//! (native, server-side producer) and `decodeRgba` (the consumer, also
//! compiled into a freestanding wasm build).
//!
//! ## SNPG v2 binary layout (all integers little-endian)
//! ```
//! off  size  field
//! 0    4     magic  = "SNPG"
//! 4    1     version = 2
//! 5    1     variant: 0 = RATTA_RLE (X-series), 1 = RATTA_RLE X2 (highres)
//! 6    2     reserved (0)
//! 8    4     width  (pixels) — the page's EFFECTIVE width: the note's base
//!            width with the page's ORIENTATION applied (a 1090 page's raster
//!            is stored natively landscape, so its rows are base-height wide;
//!            see types.Dimensions.oriented)
//! 12   4     height (pixels) — effective height, same rule
//! 16   4     layer_count
//! 20   ...   layer_count records, in BOTTOM-TO-TOP order:
//!              1  flags: bit0 = all_blank (the blank-background RLE shortcut)
//!                        bit1 = hidden (excluded from the default composite;
//!                               shipped so a layer panel can toggle it ON)
//!                        bit2 = raster image: the (background) record's `data`
//!                               is the asset HASH of a browser-native image
//!                               template, NOT RLE — the RLE decoders skip it
//!                               and the browser underlays the image itself
//!                               (see `FLAG_RASTER_IMAGE`)
//!              1  slot:  the layer's identity — 0 = MAINLAYER, 1..3 = LAYERn,
//!                        4 = BGLAYER (`types.LayerSlot.wireId`; LAYERINFO's
//!                        `-1` background id rides as 4 — the head is one
//!                        unsigned byte)
//!              4  data_len
//!              data_len bytes  (one layer's RATTA_RLE stream)
//! ```
//! The v2 emit list is **`LAYERINFO` order minus deleted layers**
//! (`types.bottomUpEmitOrder`): hidden layers' streams ride the wire flagged
//! `hidden`, because their bitmaps persist in the file and a panel must be able
//! to toggle them on. When `LAYERINFO` is absent or malformed the producer
//! degrades to the v1 `LAYERSEQ`-driven list (no hidden layers to ship).
//!
//! The consumer composites the records in order over a white base, **skipping
//! `hidden` records**, so the default composite is exactly the device-authored
//! render — byte-identical to what v1 produced (a decoded pixel equal to the
//! transparent value 0xff lets the layer beneath show through). Output is
//! opaque grayscale mapped to RGBA — see `decodeRgba`. `decodeLayerRgba`
//! decodes ONE record instead, with 0xff mapped to alpha 0 — the stacked-canvas
//! input for a per-layer view.
//!
//! ## v1 (still accepted by the consumer)
//!
//! Identical except `version = 1` and 5-byte record heads: flags (bit0
//! all_blank only) + data_len — no slot byte, no hidden bit. The consumer
//! remains tolerant of v1 because old payloads may live in client-side caches;
//! a v1 record simply carries no identity and is never hidden.

const std = @import("std");
const decoder = @import("decoder.zig");
const note_mod = @import("note.zig");
const source = @import("source.zig");
const types = @import("types.zig");

pub const MAGIC = "SNPG";
pub const VERSION: u8 = 2;
/// The previous version, which `decodeRgba`/`decodeLayerRgba` still accept.
pub const VERSION_1: u8 = 1;
pub const HEADER_SIZE: usize = 20;
/// v2 record head: flags + slot + data_len.
pub const LAYER_HEADER_SIZE: usize = 6;
/// v1 record head: flags + data_len (consumer-side tolerance only).
pub const LAYER_HEADER_SIZE_V1: usize = 5;

pub const FLAG_ALL_BLANK: u8 = 0x01;
pub const FLAG_HIDDEN: u8 = 0x02;
/// bit2 — the background record is a **browser-native raster image** template
/// (PNG/JPG/JPEG/WEBP), not a RATTA_RLE stream. Only the background layer ever
/// carries it. Its `data` is NOT pixel bytes: it is the asset HASH
/// (`PAGESTYLEMD5`), the reference the browser turns into `GET
/// /note/{id}/template/{hash}` and draws with `createImageBitmap`. The RLE
/// decoders (`decodeRgba`/`decodeLayerRgba`) never feed a `bit2` record's data
/// to `decoder.decodeInto` — they skip it, so the browser can underlay the
/// image itself.
pub const FLAG_RASTER_IMAGE: u8 = 0x04;

const TRANSPARENT: u8 = 0xff;
const WHITE: u8 = 0xff;

/// The largest page `decodeRgba` will decode, in pixels (16 Mpx = 64 MiB of
/// RGBA output).
///
/// LOAD-BEARING ON wasm32, where `usize` is 32 bits. `width` and `height` are
/// attacker-controlled u32s straight out of the payload header, and the decoder
/// ships as a `ReleaseSmall` freestanding wasm module — no overflow traps. Left
/// unchecked, `width * height * 4` wraps: e.g. 0x2000_0000 x 2 gives a
/// 1 Gpx `gray` buffer but a `npix * 4` product of exactly 0, so the RGBA
/// allocation is empty and the expansion loop writes a gigabyte past its end.
///
/// The checked multiplies below are the real fix; this ceiling is the second
/// layer, and the one that is testable on a 64-bit host where the wrap cannot
/// be reproduced. It sits far above any real page — the largest Supernote
/// (Manta, 1920x2560) is 4.9 Mpx — and far below the wrap.
const max_pixels: u64 = 1 << 24;

pub const Error = error{
    /// Payload is shorter than the fields it claims, or has a bad magic/version.
    BadPayload,
    /// `decodeLayerRgba` asked for a record at or past `layer_count`.
    LayerOutOfRange,
} || note_mod.Error || decoder.DecodeError;

/// An RGBA8888 image, row-major, `width * height * 4` bytes. Owned by caller.
pub const Rgba = struct {
    width: u32,
    height: u32,
    pixels: []u8,

    pub fn deinit(self: Rgba, gpa: std.mem.Allocator) void {
        gpa.free(self.pixels);
    }
};

// ---------------------------------------------------------------------------
// Producer (server side, native). Flattens one page of a parsed Note.
// ---------------------------------------------------------------------------

/// The maximum number of layer records a page can emit (one per slot).
pub const max_layers = types.LayerSlot.all.len;

/// Where one emitted layer's RLE bytes live inside the `.note` container, plus
/// the blank-background flag that goes in its record head.
///
/// This is the *only* description of "which layers, in what order" — both
/// `serialize` (parse-driven) and a server's blob index (offset-driven)
/// consume `emitLayers`, so the two can never hold differing opinions.
pub const LayerRef = struct {
    /// Absolute offset of the layer's RLE bytes in the `.note` buffer — i.e.
    /// just past the content block's `u32` length prefix, so a ranged read of
    /// `[offset, offset+len)` yields exactly the bytes `serialize` copies.
    offset: u32,
    len: u32,
    /// The record's slot byte: the layer's explicit identity on the wire.
    slot: types.LayerSlot,
    /// bit0 of the record's flags byte: the blank-background RLE shortcut.
    all_blank: bool,
    /// bit1 of the record's flags byte: shipped but excluded from the default
    /// composite (`LAYERINFO` says `isVisible:false`, bitmap persists).
    hidden: bool,
    /// bit2 of the record's flags byte: the background is a browser-native
    /// raster image (`FLAG_RASTER_IMAGE`), not RATTA_RLE. Only ever set on the
    /// background slot. `offset`/`len` still point at the image bytes in the
    /// `.note` blob (what the `/template/{hash}` endpoint ranges), but on the
    /// SNPG WIRE the record carries the asset hash instead of those bytes.
    raster_image: bool = false,
};

/// The layers of page `page_index`, in the exact bottom-to-top order and with
/// the exact flags `serialize` emits them with. Every returned range is already
/// bounds-checked against `note.source` (`Source.blockRange`), so a corrupt or
/// hostile container fails here rather than producing a read past EOF.
///
/// Reads **4 bytes per layer** — the block's length prefix, which is what the
/// blank-background flag turns on (`len == special_white_style_block_size`) —
/// and never the block body. That is why an indexer can build a page's layer
/// table over a ranged source without touching the bitmaps at all.
pub fn emitLayers(note: note_mod.Note, page_index: usize, buf: *[max_layers]LayerRef) Error![]const LayerRef {
    if (page_index >= note.pages.len) return error.PageOutOfRange;
    return emitPageLayers(note.source, note.pages[page_index], buf);
}

/// The bare-page flavour of `emitLayers`: works off one parsed page and a
/// source without needing a full `Note`.
///
/// The order is `types.bottomUpEmitOrder` — `LAYERINFO` order minus deleted
/// layers, hidden ones kept and flagged; `LAYERSEQ`-driven when `LAYERINFO` is
/// absent/malformed (degrade, don't fail). Entries whose slot has no present
/// layer block or no bitmap are skipped either way: there is nothing to ship.
pub fn emitPageLayers(src: source.Source, page: types.Page, buf: *[max_layers]LayerRef) Error![]const LayerRef {
    var order_buf: [max_layers]types.EmitLayer = undefined;
    const order = types.bottomUpEmitOrder(page, &order_buf);

    var n: usize = 0;
    for (order) |emit| {
        if (n >= buf.len) break;
        const layer = page.layer(emit.slot) orelse continue;
        const addr = layer.bitmapAddress();
        if (addr == 0) continue;

        // 4-byte read: the length prefix only.
        const range = src.blockRange(addr) catch |e| return note_mod.lift(e);
        if (range.offset > std.math.maxInt(u32)) return error.Truncated;
        buf[n] = .{
            .offset = @intCast(range.offset), // past the block's length prefix
            .len = range.len,
            .slot = emit.slot,
            .all_blank = emit.slot == .background and page.isWhiteStyle() and
                @as(usize, range.len) == types.special_white_style_block_size,
            .hidden = emit.hidden,
        };
        n += 1;
    }
    return buf[0..n];
}

/// The RLE variant an SNPG header must carry for `note`.
pub fn variantOf(note: note_mod.Note) decoder.Variant {
    return note.rleVariant();
}

/// Serializes page `page_index` of `note` into an SNPG payload owned by `gpa`.
///
/// Only present layers with a non-zero bitmap address are emitted, in the same
/// bottom-to-top order `render.zig` composites them, so a decode of the result
/// reproduces `renderPageGray` exactly (validated in tests/content_test.zig).
pub fn serialize(gpa: std.mem.Allocator, note: note_mod.Note, page_index: usize) Error![]u8 {
    var refs_buf: [max_layers]LayerRef = undefined;
    const refs = try emitLayers(note, page_index, &refs_buf);
    const page = note.pages[page_index];
    // The header's dims are the decode geometry, so they are the page's
    // EFFECTIVE dims — a landscape page's stream is natively landscape.
    const dims = note.dimensions().oriented(page.orientation());
    const expected_px: u64 = @as(u64, dims.width) * dims.height;
    const variant = note.rleVariant();

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);

    try out.appendSlice(gpa, MAGIC);
    try out.append(gpa, VERSION);
    try out.append(gpa, @intFromEnum(variant));
    try out.appendSlice(gpa, &.{ 0, 0 }); // reserved
    try appendU32(&out, gpa, dims.width);
    try appendU32(&out, gpa, dims.height);
    try appendU32(&out, gpa, @intCast(refs.len));

    for (refs) |r| {
        // A custom-style background that does NOT decode as RATTA_RLE is a
        // browser-native image template: the record carries the asset HASH
        // (`PAGESTYLEMD5`), flagged `bit2`, instead of the image bytes — so the
        // page payload stays small and the shared asset is fetched once. Every
        // other layer (and an RLE background, custom-style or not) is emitted
        // byte-identically to before, protecting the golden pins.
        if (r.slot == .background and page.hasCustomStyle()) {
            const scratch = try gpa.alloc(u8, r.len);
            defer gpa.free(scratch);
            note.source.read(r.offset, scratch) catch |e| return note_mod.lift(e);
            if (!decoder.decodesToExactly(scratch, expected_px)) {
                const hash = page.styleMd5() orelse "";
                try out.append(gpa, recordFlags(r) | FLAG_RASTER_IMAGE);
                try out.append(gpa, r.slot.wireId());
                try appendU32(&out, gpa, @intCast(hash.len));
                try out.appendSlice(gpa, hash);
                continue;
            }
            try out.append(gpa, recordFlags(r));
            try out.append(gpa, r.slot.wireId());
            try appendU32(&out, gpa, r.len);
            try out.appendSlice(gpa, scratch);
            continue;
        }
        try out.append(gpa, recordFlags(r));
        try out.append(gpa, r.slot.wireId());
        try appendU32(&out, gpa, r.len);
        // Read the layer's bytes straight into the tail of the payload — no
        // intermediate copy, and it works identically for either source kind.
        const at = out.items.len;
        try out.resize(gpa, at + r.len);
        note.source.read(r.offset, out.items[at..]) catch |e| return note_mod.lift(e);
    }
    return out.toOwnedSlice(gpa);
}

fn appendU32(out: *std.ArrayList(u8), gpa: std.mem.Allocator, v: u32) std.mem.Allocator.Error!void {
    var b: [4]u8 = undefined;
    std.mem.writeInt(u32, &b, v, .little);
    try out.appendSlice(gpa, &b);
}

/// A record's flags byte for `ref` — the one place the bit layout is written.
pub fn recordFlags(ref: LayerRef) u8 {
    var f: u8 = 0;
    if (ref.all_blank) f |= FLAG_ALL_BLANK;
    if (ref.hidden) f |= FLAG_HIDDEN;
    if (ref.raster_image) f |= FLAG_RASTER_IMAGE;
    return f;
}

// ---------------------------------------------------------------------------
// Consumer (also compiled into the freestanding wasm). Payload -> RGBA.
// ---------------------------------------------------------------------------

/// The parsed fixed header plus a cursor positioned at the first record. The
/// single implementation both decoders walk, so they can never disagree about
/// the layout or the version rule (v1 and v2 both accepted — see the module
/// header).
const Header = struct {
    version: u8,
    variant: decoder.Variant,
    width: u32,
    height: u32,
    layer_count: u32,
    /// Pixel count, validated against `max_pixels` (so `npix * 4` cannot wrap
    /// on wasm32 — see `max_pixels`).
    npix: usize,
};

fn readHeader(cur: *Cursor) Error!Header {
    if (!std.mem.eql(u8, try cur.take(4), MAGIC)) return error.BadPayload;
    const version = (try cur.take(1))[0];
    if (version != VERSION and version != VERSION_1) return error.BadPayload;
    const variant: decoder.Variant = switch ((try cur.take(1))[0]) {
        0 => .ratta_rle,
        1 => .ratta_rle_x2,
        else => return error.BadPayload,
    };
    _ = try cur.take(2); // reserved
    const width = try cur.u32le();
    const height = try cur.u32le();
    const layer_count = try cur.u32le();

    // Widen to u64 BEFORE multiplying: on wasm32 `usize` is 32 bits and this
    // product is two attacker-supplied u32s. See `max_pixels`.
    const npix64: u64 = @as(u64, width) * @as(u64, height);
    if (npix64 == 0 or npix64 > max_pixels) return error.BadPayload;

    return .{
        .version = version,
        .variant = variant,
        .width = width,
        .height = height,
        .layer_count = layer_count,
        .npix = @intCast(npix64), // <= max_pixels, so this cannot truncate
    };
}

/// One layer record, decoded from the wire. `slot` is null on a v1 payload,
/// whose records carry no identity byte.
const Record = struct {
    all_blank: bool,
    hidden: bool,
    /// bit2 — a browser-native image background (`FLAG_RASTER_IMAGE`). Its
    /// `data` is the asset HASH, never RLE, so the RLE decoders skip it.
    raster_image: bool,
    slot: ?types.LayerSlot,
    data: []const u8,
};

/// Reads the record at the cursor. v2: flags + slot + len; v1: flags + len (no
/// slot, never hidden).
fn readRecord(cur: *Cursor, version: u8) Error!Record {
    const flags = (try cur.take(1))[0];
    const slot: ?types.LayerSlot = if (version >= VERSION)
        // An unknown slot byte is tolerated as "no identity" rather than
        // rejected: identity is panel metadata, not decode geometry.
        types.LayerSlot.fromWireId((try cur.take(1))[0])
    else
        null;
    const data_len = try cur.u32le();
    return .{
        .all_blank = flags & FLAG_ALL_BLANK != 0,
        .hidden = version >= VERSION and flags & FLAG_HIDDEN != 0,
        .raster_image = version >= VERSION and flags & FLAG_RASTER_IMAGE != 0,
        .slot = slot,
        .data = try cur.take(data_len),
    };
}

/// Decodes and composites an SNPG `payload` into an opaque RGBA8888 image —
/// the DEFAULT (device-authored) composite: records flagged `hidden` are
/// skipped, so the output is byte-identical to what v1 produced for the same
/// page (the golden fixture hashes pin exactly this).
///
/// Grayscale ink is mapped faithfully: a composited value `g` becomes
/// `(g, g, g, 255)` — black ink on a white page. Light/dark THEME handling is
/// the JS caller's job (invert the channels for dark mode); this output commits
/// to no theme.
pub fn decodeRgba(gpa: std.mem.Allocator, payload: []const u8) Error!Rgba {
    var cur = Cursor{ .buf = payload };
    const head = try readHeader(&cur);
    const rgba_len: usize = head.npix * 4; // <= 64 MiB, well inside usize on wasm32

    // Composite in grayscale first, then expand to RGBA at the end. One scratch
    // buffer is reused across all layers (same shape as render.renderPage; the
    // run-level-compositing shortcut is deferred there too, until measured).
    const gray = try gpa.alloc(u8, head.npix);
    defer gpa.free(gray);
    @memset(gray, WHITE);

    const scratch = try gpa.alloc(u8, head.npix);
    defer gpa.free(scratch);

    var layer: u32 = 0;
    while (layer < head.layer_count) : (layer += 1) {
        const rec = try readRecord(&cur, head.version);
        if (rec.hidden) continue; // shipped for the panel, not for the default view
        // A raster-image background carries its asset HASH, not RLE — the
        // browser draws it with `createImageBitmap` UNDER this composite. Never
        // feed it to the RLE decoder; skip it and let the white base show
        // through (the JS caller underlays the image before drawing these ink
        // pixels). See `FLAG_RASTER_IMAGE`.
        if (rec.raster_image) continue;

        try decoder.decodeInto(scratch, head.variant, rec.data, rec.all_blank);
        for (gray, scratch) |*dst, s| {
            if (s != TRANSPARENT) dst.* = s;
        }
    }

    const pixels = try gpa.alloc(u8, rgba_len);
    errdefer gpa.free(pixels);
    for (gray, 0..) |g, i| {
        pixels[i * 4 + 0] = g;
        pixels[i * 4 + 1] = g;
        pixels[i * 4 + 2] = g;
        pixels[i * 4 + 3] = 0xff;
    }
    return .{ .width = head.width, .height = head.height, .pixels = pixels };
}

/// Decodes ONE layer record (`layer_index`, bottom-to-top record order) into
/// RGBA with the transparent value (0xff) mapped to **alpha 0** — the
/// stacked-canvas input for a per-layer view. Hidden records decode like any
/// other: the whole point of shipping them is that a panel can show them.
///
/// Same record walk and RLE decoder as `decodeRgba`; works on v1 payloads too
/// (their records simply carry no slot identity). `layer_index >=
/// layer_count` is `error.LayerOutOfRange`.
pub fn decodeLayerRgba(gpa: std.mem.Allocator, payload: []const u8, layer_index: u32) Error!Rgba {
    var cur = Cursor{ .buf = payload };
    const head = try readHeader(&cur);
    if (layer_index >= head.layer_count) return error.LayerOutOfRange;

    // Walk (and bounds-check) the records before the target; their bytes are
    // not decoded.
    var i: u32 = 0;
    var rec = try readRecord(&cur, head.version);
    while (i < layer_index) : (i += 1) rec = try readRecord(&cur, head.version);

    const pixels = try gpa.alloc(u8, head.npix * 4);
    errdefer gpa.free(pixels);

    // A raster-image background carries its asset HASH, not RLE pixels — the
    // browser draws it with `createImageBitmap`, not `decode_layer`. If a panel
    // asks for the record anyway, hand back a fully transparent layer rather
    // than feeding the hash to the RLE decoder (which would fail): the image
    // itself rides the dedicated template fetch.
    if (rec.raster_image) {
        @memset(pixels, 0x00);
        return .{ .width = head.width, .height = head.height, .pixels = pixels };
    }

    const gray = try gpa.alloc(u8, head.npix);
    defer gpa.free(gray);
    try decoder.decodeInto(gray, head.variant, rec.data, rec.all_blank);

    for (gray, 0..) |g, i_px| {
        pixels[i_px * 4 + 0] = g;
        pixels[i_px * 4 + 1] = g;
        pixels[i_px * 4 + 2] = g;
        pixels[i_px * 4 + 3] = if (g == TRANSPARENT) 0x00 else 0xff;
    }
    return .{ .width = head.width, .height = head.height, .pixels = pixels };
}

/// Walks the SNPG records of `snpg` and returns the background record's `data`
/// slice — the browser-native image template's asset HASH (`PAGESTYLEMD5`) — when
/// that record is flagged `FLAG_RASTER_IMAGE` on the background slot, else null.
///
/// The one place the "read the template hash out of a page payload" rule lives,
/// so the browser needs no knowledge of the SNPG byte layout: the freestanding
/// wasm calls this and hands JS the hash. Reuses `readHeader`/`readRecord`, so it
/// can never drift from the layout the decoders and `serialize` agree on.
///
/// `snpg` is attacker-supplied: this never panics and never errors — any
/// malformed / truncated / short / foreign input yields null (a best-effort
/// lookup, not a decode). v1 payloads always yield null (their records carry no
/// raster-image bit and no slot identity). The returned slice ALIASES `snpg` and
/// is valid only for as long as `snpg` is.
pub fn backgroundImageHash(snpg: []const u8) ?[]const u8 {
    var cur = Cursor{ .buf = snpg };
    const head = readHeader(&cur) catch return null;
    var i: u32 = 0;
    while (i < head.layer_count) : (i += 1) {
        const rec = readRecord(&cur, head.version) catch return null;
        if (rec.raster_image and rec.slot == .background) return rec.data;
    }
    return null;
}

/// One record's identity for the browser's layers-panel enumerator: its slot,
/// the two panel-relevant flag bits, and its `data` slice (aliases the input —
/// the asset HASH for a `raster_image` background, else the RLE stream the panel
/// never reads directly, decoding by index through `decodeLayerRgba` instead).
pub const RecordInfo = struct {
    slot: types.LayerSlot,
    /// bit1 (`FLAG_HIDDEN`): excluded from the default composite.
    excluded: bool,
    /// bit2 (`FLAG_RASTER_IMAGE`): a browser-native image background; `data` is
    /// the asset hash, not RLE.
    raster_image: bool,
    data: []const u8,
};

/// The page's effective dims plus the enumerated record identities. `records`
/// points into the caller's buffer; each record's `data` aliases the payload.
pub const Enumeration = struct {
    width: u32,
    height: u32,
    records: []const RecordInfo,
};

/// Enumerates the SNPG **v2** record heads for the browser's layers panel — the
/// one place that walk lives, so the browser holds no knowledge of the wire
/// layout. It reuses `readHeader`/`readRecord` (so it can never drift from the
/// decoders), touches no RLE, and returns each record's `slot` + flag bits +
/// `data`, plus the header dims.
///
/// `null` for anything the stacked panel cannot present — the strict superset of
/// the decoders' tolerance the panel needs: a v1 payload (no per-record slot
/// identity), a foreign/short/truncated blob, an unknown slot id, a record
/// over-claiming its length, zero or more than `max_layers` records, or trailing
/// junk after the last record. Never panics; `snpg` is attacker-supplied.
pub fn enumerateRecords(snpg: []const u8, buf: *[max_layers]RecordInfo) ?Enumeration {
    var cur = Cursor{ .buf = snpg };
    const head = readHeader(&cur) catch return null;
    if (head.version != VERSION) return null; // v2 only: v1 carries no slot id
    if (head.layer_count == 0 or head.layer_count > max_layers) return null;

    var n: usize = 0;
    var i: u32 = 0;
    while (i < head.layer_count) : (i += 1) {
        const rec = readRecord(&cur, head.version) catch return null;
        const slot = rec.slot orelse return null; // unknown wire id: no identity
        buf[n] = .{
            .slot = slot,
            .excluded = rec.hidden,
            .raster_image = rec.raster_image,
            .data = rec.data,
        };
        n += 1;
    }
    if (cur.pos != snpg.len) return null; // trailing junk: not our payload
    return .{ .width = head.width, .height = head.height, .records = buf[0..n] };
}

/// Bounds-checked forward reader over the payload.
const Cursor = struct {
    buf: []const u8,
    pos: usize = 0,

    fn take(self: *Cursor, n: usize) Error![]const u8 {
        // Checked add: `n` is a payload-supplied u32 length and on wasm32 `usize`
        // is 32 bits, so `pos + n` can wrap to a small value that passes the
        // bound and then slices with `end < start`.
        const end = std.math.add(usize, self.pos, n) catch return error.BadPayload;
        if (end > self.buf.len) return error.BadPayload;
        const s = self.buf[self.pos..end];
        self.pos = end;
        return s;
    }

    fn u32le(self: *Cursor) Error!u32 {
        const s = try self.take(4);
        return std.mem.readInt(u32, s[0..4], .little);
    }
};

// ---------------------------------------------------------------------------
// Tests — synthetic / hand-built payloads (no real .note needed here; the real
// fixture cross-check lives in tests/content_test.zig).
// ---------------------------------------------------------------------------

const testing = std.testing;

/// Builds a one-layer SNPG v2 payload by hand for the decode tests.
fn buildOneLayer(gpa: std.mem.Allocator, variant: u8, w: u32, h: u32, all_blank: bool, rle: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try out.appendSlice(gpa, MAGIC);
    try out.append(gpa, VERSION);
    try out.append(gpa, variant);
    try out.appendSlice(gpa, &.{ 0, 0 });
    try appendU32(&out, gpa, w);
    try appendU32(&out, gpa, h);
    try appendU32(&out, gpa, 1);
    try out.append(gpa, if (all_blank) FLAG_ALL_BLANK else 0x00);
    try out.append(gpa, types.LayerSlot.main.wireId());
    try appendU32(&out, gpa, @intCast(rle.len));
    try out.appendSlice(gpa, rle);
    return out.toOwnedSlice(gpa);
}

/// One record's head + data in v2 form, appended to a payload under construction.
fn appendRecord(out: *std.ArrayList(u8), gpa: std.mem.Allocator, flags: u8, slot: types.LayerSlot, rle: []const u8) !void {
    try out.append(gpa, flags);
    try out.append(gpa, slot.wireId());
    try appendU32(out, gpa, @intCast(rle.len));
    try out.appendSlice(gpa, rle);
}

test "decodeRgba: single black pixel -> opaque black RGBA" {
    const gpa = testing.allocator;
    // (0x61 black, len byte 0 => run of 1) over a 1x1 page.
    const payload = try buildOneLayer(gpa, 1, 1, 1, false, &.{ 0x61, 0x00 });
    defer gpa.free(payload);

    const img = try decodeRgba(gpa, payload);
    defer img.deinit(gpa);
    try testing.expectEqual(@as(u32, 1), img.width);
    try testing.expectEqual(@as(u32, 1), img.height);
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x00, 0x00, 0xff }, img.pixels);
}

test "decodeRgba: transparent code composites to the white base" {
    const gpa = testing.allocator;
    // (0x62 transparent, len 4+1=5) over a 5x1 page: nothing overwrites white.
    const payload = try buildOneLayer(gpa, 1, 5, 1, false, &.{ 0x62, 0x04 });
    defer gpa.free(payload);

    const img = try decodeRgba(gpa, payload);
    defer img.deinit(gpa);
    try testing.expectEqual(@as(usize, 5 * 4), img.pixels.len);
    for (0..5) |i| {
        try testing.expectEqualSlices(u8, &.{ 0xff, 0xff, 0xff, 0xff }, img.pixels[i * 4 ..][0..4]);
    }
}

test "decodeRgba: two-byte length run fills the row" {
    const gpa = testing.allocator;
    // (0x61,0x81) held high part, (0x61,0x00) matching => 1 + 0 + ((1+1)<<7) = 257 black.
    const payload = try buildOneLayer(gpa, 1, 257, 1, false, &.{ 0x61, 0x81, 0x61, 0x00 });
    defer gpa.free(payload);

    const img = try decodeRgba(gpa, payload);
    defer img.deinit(gpa);
    try testing.expectEqual(@as(usize, 257 * 4), img.pixels.len);
    for (0..257) |i| {
        try testing.expectEqualSlices(u8, &.{ 0x00, 0x00, 0x00, 0xff }, img.pixels[i * 4 ..][0..4]);
    }
}

/// Head of a 2x1, X2-variant, `n`-layer payload under construction.
fn beginPayload(gpa: std.mem.Allocator, layer_count: u32) !std.ArrayList(u8) {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try out.appendSlice(gpa, MAGIC);
    try out.append(gpa, VERSION);
    try out.append(gpa, 1); // x2 variant
    try out.appendSlice(gpa, &.{ 0, 0 });
    try appendU32(&out, gpa, 2); // width
    try appendU32(&out, gpa, 1); // height
    try appendU32(&out, gpa, layer_count);
    return out;
}

test "decodeRgba: two layers composite bottom-to-top (top ink wins)" {
    const gpa = testing.allocator;
    // Bottom layer: gray 0xc9 across 2px; top layer: black then transparent.
    var out = try beginPayload(gpa, 2);
    defer out.deinit(gpa);
    // layer 0 (bottom): 0xC9 gray, run 2 (len byte 1 => 2).
    try appendRecord(&out, gpa, 0x00, .background, &.{ 0xC9, 0x01 });
    // layer 1 (top): black 1px then transparent 1px.
    try appendRecord(&out, gpa, 0x00, .main, &.{ 0x61, 0x00, 0x62, 0x00 });

    const img = try decodeRgba(gpa, out.items);
    defer img.deinit(gpa);
    // px0: top black wins -> 0x00; px1: top transparent -> bottom gray 0xc9 shows.
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x00, 0x00, 0xff }, img.pixels[0..4]);
    try testing.expectEqualSlices(u8, &.{ 0xc9, 0xc9, 0xc9, 0xff }, img.pixels[4..8]);
}

test "decodeRgba: a hidden-flagged record is skipped by the default composite" {
    const gpa = testing.allocator;
    // Same two layers as above, but the top (black) one is hidden: the default
    // composite must look exactly like the bottom layer alone.
    var out = try beginPayload(gpa, 2);
    defer out.deinit(gpa);
    try appendRecord(&out, gpa, 0x00, .background, &.{ 0xC9, 0x01 });
    try appendRecord(&out, gpa, FLAG_HIDDEN, .layer2, &.{ 0x61, 0x00, 0x62, 0x00 });

    const img = try decodeRgba(gpa, out.items);
    defer img.deinit(gpa);
    try testing.expectEqualSlices(u8, &.{ 0xc9, 0xc9, 0xc9, 0xff }, img.pixels[0..4]);
    try testing.expectEqualSlices(u8, &.{ 0xc9, 0xc9, 0xc9, 0xff }, img.pixels[4..8]);

    // ...but the hidden record's bytes are still on the wire, decodable one at
    // a time — that is the whole point of shipping it.
    const hidden = try decodeLayerRgba(gpa, out.items, 1);
    defer hidden.deinit(gpa);
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x00, 0x00, 0xff }, hidden.pixels[0..4]);
}

test "decodeRgba: a v1 payload (5-byte heads, no slot) still decodes" {
    const gpa = testing.allocator;
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    try out.appendSlice(gpa, MAGIC);
    try out.append(gpa, VERSION_1);
    try out.append(gpa, 1); // x2 variant
    try out.appendSlice(gpa, &.{ 0, 0 });
    try appendU32(&out, gpa, 1);
    try appendU32(&out, gpa, 1);
    try appendU32(&out, gpa, 1);
    try out.append(gpa, 0x00); // v1 head: flags only, no slot byte
    try appendU32(&out, gpa, 2);
    try out.appendSlice(gpa, &.{ 0x61, 0x00 }); // 1 black px

    const img = try decodeRgba(gpa, out.items);
    defer img.deinit(gpa);
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x00, 0x00, 0xff }, img.pixels);

    // The per-layer call walks v1 records too.
    const one = try decodeLayerRgba(gpa, out.items, 0);
    defer one.deinit(gpa);
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x00, 0x00, 0xff }, one.pixels);

    // An unknown version is refused.
    out.items[4] = 3;
    try testing.expectError(error.BadPayload, decodeRgba(gpa, out.items));
}

test "decodeLayerRgba: one record, transparent 0xff maps to alpha 0" {
    const gpa = testing.allocator;
    var out = try beginPayload(gpa, 2);
    defer out.deinit(gpa);
    try appendRecord(&out, gpa, 0x00, .background, &.{ 0xC9, 0x01 }); // gray, gray
    try appendRecord(&out, gpa, 0x00, .main, &.{ 0x61, 0x00, 0x62, 0x00 }); // black, transparent

    // Bottom record: fully opaque gray.
    const bg = try decodeLayerRgba(gpa, out.items, 0);
    defer bg.deinit(gpa);
    try testing.expectEqual(@as(u32, 2), bg.width);
    try testing.expectEqualSlices(u8, &.{ 0xc9, 0xc9, 0xc9, 0xff, 0xc9, 0xc9, 0xc9, 0xff }, bg.pixels);

    // Top record: opaque black then TRANSPARENT (alpha 0) — the stacked-canvas
    // contract, letting the browser composite the layers itself.
    const main_l = try decodeLayerRgba(gpa, out.items, 1);
    defer main_l.deinit(gpa);
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x00, 0x00, 0xff }, main_l.pixels[0..4]);
    try testing.expectEqual(@as(u8, 0x00), main_l.pixels[7]); // alpha 0
    try testing.expectEqual(@as(u8, 0xff), main_l.pixels[4]); // rgb stays white under it

    // Out of range is its own fact, not a garbage decode.
    try testing.expectError(error.LayerOutOfRange, decodeLayerRgba(gpa, out.items, 2));
}

test "decodeRgba: hostile dimensions are refused before anything is allocated" {
    const gpa = testing.allocator;

    // The wasm32 attack shape: `width * height` overflows a 32-bit `usize`, and
    // `npix * 4` overflows it a second time to exactly 0 — an empty RGBA buffer
    // that the expansion loop then writes a gigabyte past. This host is 64-bit,
    // so the arithmetic here does not wrap; what the assertion pins is that the
    // payload is rejected on its DIMENSIONS, before either allocation is
    // attempted, which is what makes the wasm build safe too.
    {
        const payload = try buildOneLayer(gpa, 0, 0x2000_0000, 2, false, &.{});
        defer gpa.free(payload);
        try testing.expectError(error.BadPayload, decodeRgba(gpa, payload));
    }
    // Wraps to a plausible-looking small product on wasm32 (0x1_0000_0000 -> 0),
    // which the old `npix == 0` check would have caught only by accident.
    {
        const payload = try buildOneLayer(gpa, 0, 0x1_0000, 0x1_0000, false, &.{});
        defer gpa.free(payload);
        try testing.expectError(error.BadPayload, decodeRgba(gpa, payload));
    }
    // Just past the ceiling: no overflow anywhere, just an absurd page.
    {
        const payload = try buildOneLayer(gpa, 0, 1 << 12, (1 << 12) + 1, false, &.{});
        defer gpa.free(payload);
        try testing.expectError(error.BadPayload, decodeRgba(gpa, payload));
    }
    // A real device page (Manta, the largest) stays comfortably under it.
    try testing.expect(@as(u64, 1920) * 2560 < max_pixels);

    // A layer whose declared length is near `maxInt(u32)` must not wrap the
    // cursor into an inverted slice.
    {
        var out: std.ArrayList(u8) = .empty;
        defer out.deinit(gpa);
        try out.appendSlice(gpa, MAGIC);
        try out.append(gpa, VERSION);
        try out.append(gpa, 0);
        try out.appendSlice(gpa, &.{ 0, 0 });
        try appendU32(&out, gpa, 2);
        try appendU32(&out, gpa, 2);
        try appendU32(&out, gpa, 1);
        try out.append(gpa, 0x00);
        try out.append(gpa, types.LayerSlot.main.wireId());
        try appendU32(&out, gpa, 0xffff_ffff); // claims 4 GiB of layer data
        try testing.expectError(error.BadPayload, decodeRgba(gpa, out.items));
        try testing.expectError(error.BadPayload, decodeLayerRgba(gpa, out.items, 0));
    }
}

test "decodeRgba: bad magic / short buffer rejected, never crashes" {
    const gpa = testing.allocator;
    try testing.expectError(error.BadPayload, decodeRgba(gpa, "XXXX\x01\x01\x00\x00"));
    try testing.expectError(error.BadPayload, decodeRgba(gpa, "SN"));
}

test "backgroundImageHash: a bit2 background record yields its asset hash" {
    const gpa = testing.allocator;
    const hash = "deadbeefdeadbeefdeadbeefdeadbeef";
    var out = try beginPayload(gpa, 2);
    defer out.deinit(gpa);
    try appendRecord(&out, gpa, FLAG_RASTER_IMAGE, .background, hash);
    try appendRecord(&out, gpa, 0x00, .main, &.{ 0x61, 0x00 });
    try testing.expectEqualStrings(hash, backgroundImageHash(out.items).?);
}

test "backgroundImageHash: null for an ordinary RLE page (no bit2 anywhere)" {
    const gpa = testing.allocator;
    var out = try beginPayload(gpa, 2);
    defer out.deinit(gpa);
    try appendRecord(&out, gpa, 0x00, .background, &.{ 0x65, 0x03 });
    try appendRecord(&out, gpa, 0x00, .main, &.{ 0x61, 0x00 });
    try testing.expect(backgroundImageHash(out.items) == null);
}

test "backgroundImageHash: a raster-image flag on a non-background slot is ignored" {
    const gpa = testing.allocator;
    var out = try beginPayload(gpa, 1);
    defer out.deinit(gpa);
    try appendRecord(&out, gpa, FLAG_RASTER_IMAGE, .main, "x");
    try testing.expect(backgroundImageHash(out.items) == null);
}

test "backgroundImageHash: short / foreign / truncated input returns null, never crashes" {
    const gpa = testing.allocator;
    // Short and foreign-magic buffers fail in the header.
    try testing.expect(backgroundImageHash("SN") == null);
    try testing.expect(backgroundImageHash("XXXX\x02\x01\x00\x00") == null);
    // A well-formed header + record head whose declared data runs past EOF.
    var out = try beginPayload(gpa, 1);
    defer out.deinit(gpa);
    try out.append(gpa, FLAG_RASTER_IMAGE);
    try out.append(gpa, types.LayerSlot.background.wireId());
    try appendU32(&out, gpa, 64); // claims 64 bytes of hash; none follow
    try testing.expect(backgroundImageHash(out.items) == null);
}

test "enumerateRecords: v2 records yield slot + flag bits + hash, dims from header" {
    const gpa = testing.allocator;
    const hash = "deadbeefdeadbeefdeadbeefdeadbeef";
    var out = try beginPayload(gpa, 2); // 2x1 header
    defer out.deinit(gpa);
    try appendRecord(&out, gpa, FLAG_RASTER_IMAGE, .background, hash);
    try appendRecord(&out, gpa, FLAG_HIDDEN, .main, &.{ 0x61, 0x03 });

    var buf: [max_layers]RecordInfo = undefined;
    const en = enumerateRecords(out.items, &buf).?;
    try testing.expectEqual(@as(u32, 2), en.width);
    try testing.expectEqual(@as(u32, 1), en.height);
    try testing.expectEqual(@as(usize, 2), en.records.len);

    try testing.expectEqual(types.LayerSlot.background, en.records[0].slot);
    try testing.expect(!en.records[0].excluded);
    try testing.expect(en.records[0].raster_image);
    try testing.expectEqualStrings(hash, en.records[0].data);

    try testing.expectEqual(types.LayerSlot.main, en.records[1].slot);
    try testing.expect(en.records[1].excluded);
    try testing.expect(!en.records[1].raster_image);
}

test "enumerateRecords: rejects everything the stacked panel cannot present" {
    const gpa = testing.allocator;
    var buf: [max_layers]RecordInfo = undefined;

    // A v1 payload (5-byte heads, no slot identity).
    {
        var out: std.ArrayList(u8) = .empty;
        defer out.deinit(gpa);
        try out.appendSlice(gpa, MAGIC);
        try out.append(gpa, VERSION_1);
        try out.append(gpa, 1);
        try out.appendSlice(gpa, &.{ 0, 0 });
        try appendU32(&out, gpa, 2);
        try appendU32(&out, gpa, 1);
        try appendU32(&out, gpa, 1);
        try out.append(gpa, 0x00); // v1 head: flags only
        try appendU32(&out, gpa, 2);
        try out.appendSlice(gpa, &.{ 0x61, 0x00 });
        try testing.expect(enumerateRecords(out.items, &buf) == null);
    }
    // Foreign magic, and a short buffer.
    try testing.expect(enumerateRecords("XXXX\x02\x01\x00\x00", &buf) == null);
    try testing.expect(enumerateRecords(&.{ 0x53, 0x4e, 0x50, 0x47, 2 }, &buf) == null);

    // An unknown slot id (5 is past `background` = 4).
    {
        var out = try beginPayload(gpa, 1);
        defer out.deinit(gpa);
        try out.append(gpa, 0x00);
        try out.append(gpa, 5); // no such slot
        try appendU32(&out, gpa, 2);
        try out.appendSlice(gpa, &.{ 0x61, 0x00 });
        try testing.expect(enumerateRecords(out.items, &buf) == null);
    }
    // A record over-claiming its data length.
    {
        var out = try beginPayload(gpa, 1);
        defer out.deinit(gpa);
        try out.append(gpa, 0x00);
        try out.append(gpa, types.LayerSlot.main.wireId());
        try appendU32(&out, gpa, 999); // claims bytes the payload lacks
        try testing.expect(enumerateRecords(out.items, &buf) == null);
    }
    // Trailing junk after the last record.
    {
        var out = try beginPayload(gpa, 1);
        defer out.deinit(gpa);
        try appendRecord(&out, gpa, 0x00, .main, &.{ 0x61, 0x00 });
        try out.appendSlice(gpa, &.{ 0xde, 0xad }); // not our payload
        try testing.expect(enumerateRecords(out.items, &buf) == null);
    }
    // Zero records, and a count past `max_layers`.
    {
        var zero = try beginPayload(gpa, 0);
        defer zero.deinit(gpa);
        try testing.expect(enumerateRecords(zero.items, &buf) == null);

        var over = try beginPayload(gpa, 6);
        defer over.deinit(gpa);
        try testing.expect(enumerateRecords(over.items, &buf) == null);
    }
}
