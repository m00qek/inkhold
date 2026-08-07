//! Public entry point for the standalone `.note` (Supernote notebook) parser.
//!
//! Two entry points, cost proportional to what you ask (see `note.zig` for the
//! parse-order diagram):
//!
//! ```zig
//! // Tier 0 — is this even a .note? (first `signature.probe_len` bytes)
//! const sig = try note.signature.detect(head);
//!
//! // Eager full parse (what an indexer/renderer wants): signature + header +
//! // footer + every page's metadata, composed over one arena. Peak memory is
//! // the parsed metadata, never the file size — bitmap bodies are read lazily
//! // through the retained `Source`.
//! var doc = try note.parse(gpa, bytes);
//! defer doc.deinit();
//! _ = doc.pageCount();
//! _ = doc.dimensions();
//! for (doc.pages[0].layers) |l| { _ = l.bitmapAddress(); }
//!
//! // Tier 3 — heavy bits, explicit: decode / composite / OCR / flatten.
//! const img = try note.render.renderPage(gpa, doc.source, doc.rleVariant(), doc.dimensions(), doc.pages[0]);
//! defer img.deinit(gpa);
//! ```
//!
//! Results own their strings (arena) — input bytes may be freed after parsing —
//! but content blocks (bitmaps, recognition text) are read lazily through the
//! retained `Source`, so the underlying file/blob must stay readable to render.

const note = @import("note.zig");

// Tier 0: signature detection.
pub const signature = @import("signature.zig"); // detect(), probe_len
pub const Signature = signature.Signature;
pub const Family = signature.Family;

pub const parse = note.parse; // eager full parse
pub const parseSource = note.parseSource;
pub const Note = note.Note;

pub const Error = note.Error;

// Where bytes come from: a slice, or any positional reader (`Ranged`).
pub const source = @import("source.zig");
pub const Source = source.Source;
pub const Ranged = source.Ranged;

// Structure vocabulary shared by every tier.
pub const types = @import("types.zig");
pub const Orientation = types.Orientation; // per-page ORIENTATION (1000+degrees: 1000/1090/1180/1270)
pub const keyblock = @import("keyblock.zig"); // <KEY:VALUE> metadata blocks
pub const layerinfo = @import("layerinfo.zig"); // per-page LAYERINFO panel state

// Tier 3 — content decoding, explicit and heavy.
pub const decoder = @import("decoder.zig"); // RATTA_RLE: decode / decodeInto
pub const render = @import("render.zig"); // layer compositing -> grayscale
pub const recognition = @import("recognition.zig"); // RECOGNTEXT (OCR) blobs
pub const links = @import("links.zig"); // EXTERNALLINKINFO (a PDF template's links)
pub const page_payload = @import("page_payload.zig"); // SNPG wire format
pub const renderPageGray = render.renderPageGray;
pub const Image = render.Image;

test {
    // Pull in every submodule's tests.
    _ = signature;
    _ = source;
    _ = keyblock;
    _ = types;
    _ = layerinfo;
    _ = note;
    _ = decoder;
    _ = render;
    _ = recognition;
    _ = links;
    _ = page_payload;
}
