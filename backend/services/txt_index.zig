//! The `.txt` blob index: split a text blob into PARAGRAPH segments and store
//! them as `kind = 1` rows in `note_page_index`, so library search returns
//! `.txt` paragraphs interleaved with note pages through the exact machinery
//! that already serves them (`segment_search` + `segment_fts`),
//! the segment seam's first tenant.
//!
//! ## Paragraphs, not fixed chunks (plan decisions 1–2)
//!
//! Segments split on blank lines (one-or-more empty or whitespace-only lines);
//! one segment per paragraph. Boundaries are therefore content-defined by
//! NATURE: edit or insert a paragraph and only that segment's `text_hash`
//! changes — every other segment repoints through the existing hash-diff flip
//! (`search.flipOwnerBlob`) with its masked rowid (its recency) kept.
//! Two bounded fallbacks keep the row shape sane on hostile shapes:
//!
//!   - a paragraph over `max_segment_bytes` splits hard at the last newline
//!     before the cap (which also makes a no-blank-lines file degrade to
//!     fixed LINE-ALIGNED chunks at the cap);
//!   - one enormous line (no newline inside the cap window) splits at the cap
//!     itself, backed off to a UTF-8 sequence boundary so the seam does not
//!     manufacture replacement characters out of a valid file.
//!
//! `page_index` is the segment ordinal; `recogn_offset`/`recogn_length` are
//! the paragraph's BYTE RANGE in the blob (the viewer's deep-link address);
//! `text` is the paragraph; `text_hash` is the md5 of the indexed text — the
//! flip's diff key, and equal-hash ⇒ equal-indexed-text by construction.
//!
//! ## Encoding + caps (decision 3)
//!
//! UTF-8 assumed (what the txt viewer renders). Invalid sequences are LOSSILY
//! REPLACED (U+FFFD) in the INDEX copy only — the blob is untouched, and the
//! stored byte range still addresses the raw bytes. A recorded fact, never an
//! error: hostile bytes named `.txt` index as mojibake, not as a failure.
//! Files over `max_file_bytes` are SKIPPED WHOLE with a logged warning — no
//! silent truncation — and the skip is memoized (see the marker below) so the
//! log fires once per blob, not once per listing.
//!
//! ## CRLF (decided here, pinned by tests)
//!
//! `\r` counts as whitespace for blank-line detection (so `"\r\n"` is a blank
//! line), and a `\r` immediately before a line terminator — or before EOF — is
//! trimmed from the segment's end exactly as the `\n` is. INTERIOR `\r\n`
//! sequences inside a paragraph are preserved verbatim in both the byte range
//! and the indexed text (unicode61 treats them as separators, so search never
//! sees the difference).
//!
//! ## `note_index` semantics stay note-specific (decision 4)
//!
//! Every blob owns a `note_index` row and segments hang off it by FK; that
//! row keeps `indexable = 0` for a `.txt` ("indexable" means "parseable
//! `.note`", and a blob the note parser DID verify is never chunked, whatever
//! it is called). Chunk rows carry `recogn_status = 1` ("text present"), which
//! is what lets them through the shared FTS predicate with no predicate
//! change. Freshness rides `note_index.index_version` (bumped 5→6 for this
//! feature): a pre-existing `.txt` heals on its first listing view, where the
//! ensure path now learns the file NAME (the extension is the gate).
//!
//! ## The derived-state marker
//!
//! "Was this blob ever chunked?" must be answerable without re-deriving, and
//! segments alone cannot answer it — an empty file and an over-cap skip both
//! yield zero. So a derivation that produced no segments writes ONE marker row
//! (`kind = 1`, `recogn_status = 0`, `text` NULL): invisible to the FTS
//! predicate and to every query, but present, so `needsDerive` memoizes the
//! way `indexable = 0` memoizes an unparseable blob. `mintOwnerBlobSearch`
//! counts it and mints a phantom ~24-byte segment row per owner — harmless,
//! postings-free.
//!
//! ## Known edges, recorded
//!
//!   - The gate is the file NAME at ingest/heal time. Renaming `b.dat` →
//!     `b.txt` does not re-derive (rename never touches blobs); the content
//!     becomes searchable the next time any link or heal sees it under a
//!     `.txt` name.
//!   - Chunk rows are per-BLOB, like all index rows: if one user holds the
//!     content as `a.dat` and another uploads it as `b.txt`, the derivation
//!     mints segments for every current holder — the `.dat` holder's file
//!     becomes searchable too. Same posture as `.note` (verified content
//!     over claimed name); the `files` join still scopes who sees what.
//!   - A future `index_version` bump re-mints txt segments wholesale (the
//!     note-half heal wipes them via its tail drop before this module
//!     re-derives): segment recency resets, exactly like a re-index.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const blobstore = @import("../store/blobs.zig");
const blob_source = @import("../store/blob_source.zig");
const noteindex = @import("note_index.zig");
const search = @import("search/maintain.zig");
const notesearch = @import("search/query.zig");
const sn = @import("supernote");

const Allocator = std.mem.Allocator;
const Md5 = std.crypto.hash.Md5;
const log = std.log.scoped(.txt_index);

/// The `kind` discriminator for a `.txt` paragraph segment (0 = note page).
pub const kind_txt: i64 = 1;

/// Paragraph cap: a segment never exceeds this. ~8 KB keeps every row a
/// "paragraph's worth" — snippets stay coherent, and one edit re-posts at
/// most this much text.
pub const max_segment_bytes: usize = 8 * 1024;

/// Per-file indexing cap (decision 3, matching the ingest source cap): a
/// larger file is skipped WHOLE, with a logged warning — never silently
/// truncated to a searchable prefix that lies about covering the file.
pub const max_file_bytes: u64 = 16 * 1024 * 1024;

/// Does this filename name a `.txt`? Case-insensitive, and the same
/// extension rules as `thumbnail.wants`/`controlplane.extensionOf`: a
/// leading-dot name (`.txt`) has no extension, nor does a trailing dot.
pub fn wants(name: []const u8) bool {
    const dot = std.mem.lastIndexOfScalar(u8, name, '.') orelse return false;
    if (dot == 0 or dot + 1 == name.len) return false;
    return std.ascii.eqlIgnoreCase(name[dot + 1 ..], "txt");
}

// ---------------------------------------------------------------------------
// Derive — pure over the source. MUST be called outside the DB lock.
// ---------------------------------------------------------------------------

/// One paragraph as the index stores it.
pub const Segment = struct {
    /// The paragraph's byte range IN THE BLOB — raw bytes, before any UTF-8
    /// replacement, excluding the trailing line terminator (and a `\r`
    /// before it). What the viewer's deep link addresses.
    offset: u64,
    len: u32,
    /// The INDEX copy: the ranged bytes, lossily UTF-8-sanitized. Equal to
    /// `blob[offset..][0..len]` whenever the file is valid UTF-8.
    text: []const u8,
    /// md5 (hex) of `text` — the flip's diff key AND the row's
    /// `content_hash` (see `store` for why one value serves both).
    text_hash: [32]u8,
};

/// Everything `store` needs, owning its own memory (the `Parsed` shape).
pub const Derived = struct {
    arena: std.heap.ArenaAllocator,
    segments: []const Segment,
    /// True when the file exceeded `max_file_bytes` and was skipped whole
    /// (already logged by `derive`). Zero segments either way; the marker
    /// row `store` writes is what stops the re-derive-and-relog loop.
    skipped_over_cap: bool = false,

    pub fn deinit(self: *Derived) void {
        self.arena.deinit();
    }
};

/// An unflushed segment byte range (phase 1's output, phase 2's input).
const SegRange = struct { offset: u64, len: u32 };

/// The blank-line scanner. Phase 1 of `derive`: a single sequential pass
/// that needs O(1) state — no line is ever buffered, because segment TEXT is
/// read back by range in phase 2.
const Scan = struct {
    line_start: u64 = 0,
    /// No byte other than space/tab/`\r` seen on the current line yet.
    line_blank: bool = true,
    /// The previous byte was `\r` — consulted at `\n` (and at EOF) to trim
    /// the CR of a CRLF terminator from the segment's end.
    prev_cr: bool = false,
    /// A paragraph is open: `para_start` is its first byte, `para_end` one
    /// past the last accepted line's content.
    in_para: bool = false,
    para_start: u64 = 0,
    para_end: u64 = 0,

    fn byte(self: *Scan, gpa: Allocator, src: sn.Source, out: *std.ArrayList(SegRange), i: u64, b: u8) !void {
        if (b == '\n') {
            const content_end = i - @intFromBool(self.prev_cr);
            try self.line(gpa, src, out, content_end);
            self.line_start = i + 1;
            self.line_blank = true;
            self.prev_cr = false;
            return;
        }
        self.prev_cr = b == '\r';
        if (b != ' ' and b != '\t' and b != '\r') self.line_blank = false;
    }

    /// One finished line, `[self.line_start, content_end)` after CR trim.
    fn line(self: *Scan, gpa: Allocator, src: sn.Source, out: *std.ArrayList(SegRange), content_end: u64) !void {
        if (self.line_blank) {
            // A blank line closes the open paragraph (and is itself part of
            // no segment — segments cover content, not separators).
            try self.flush(gpa, out);
            return;
        }
        if (!self.in_para) {
            self.in_para = true;
            self.para_start = self.line_start;
        } else if (content_end - self.para_start > max_segment_bytes) {
            // Adding this line would blow the cap: split hard at the last
            // newline before it. On a file with no blank lines at all this
            // IS the degenerate fallback — fixed line-aligned chunks.
            try push(gpa, out, self.para_start, self.para_end);
            self.para_start = self.line_start;
        }
        // One enormous line: cap-sized cuts, backed off to UTF-8 boundaries.
        while (content_end - self.para_start > max_segment_bytes) {
            const cut = utf8CutBack(src, self.para_start, self.para_start + max_segment_bytes);
            try push(gpa, out, self.para_start, cut);
            self.para_start = cut;
        }
        self.para_end = content_end;
    }

    fn flush(self: *Scan, gpa: Allocator, out: *std.ArrayList(SegRange)) !void {
        if (!self.in_para) return;
        try push(gpa, out, self.para_start, self.para_end);
        self.in_para = false;
    }

    /// EOF: the last line may have no terminator (a bare trailing `\r` is
    /// trimmed exactly as a CRLF's would be), and the open paragraph closes.
    fn finish(self: *Scan, gpa: Allocator, src: sn.Source, out: *std.ArrayList(SegRange), total: u64) !void {
        if (self.line_start < total) {
            const content_end = total - @intFromBool(self.prev_cr);
            if (content_end > self.line_start) try self.line(gpa, src, out, content_end);
        }
        try self.flush(gpa, out);
    }

    fn push(gpa: Allocator, out: *std.ArrayList(SegRange), start: u64, end: u64) !void {
        std.debug.assert(end > start and end - start <= max_segment_bytes);
        try out.append(gpa, .{ .offset = start, .len = @intCast(end - start) });
    }
};

/// The largest cut `<= want` that starts a UTF-8 sequence (i.e. does not land
/// on a continuation byte), probing at most 4 bytes of the source. Hostile
/// bytes (4 continuation bytes in a row — not UTF-8) cut at `want` itself;
/// the lossy sanitize owns that seam. Only reached for a single line larger
/// than the cap, so the extra read is off every normal path.
fn utf8CutBack(src: sn.Source, start: u64, want: u64) u64 {
    var probe: [4]u8 = undefined;
    const lo = @max(start + 1, want - @min(want, 3));
    const n: usize = @intCast(want + 1 - lo);
    src.read(lo, probe[0..n]) catch return want;
    var cut = want;
    while (cut > lo and probe[@intCast(cut - lo)] & 0xC0 == 0x80) cut -= 1;
    if (probe[@intCast(cut - lo)] & 0xC0 == 0x80) return want; // no boundary in reach
    return cut;
}

/// `derive` for a caller that already holds the whole file (tests).
pub fn deriveSlice(gpa: Allocator, bytes: []const u8) !Derived {
    return derive(gpa, sn.Source.fromSlice(bytes));
}

/// Chunks whatever `src` addresses into paragraph segments. Ranged reads
/// throughout — one `blobstore.chunk_len` window for the scan, one
/// `max_segment_bytes` buffer for the copies — so a multi-MB file is NEVER
/// buffered whole. Only allocation and source I/O can fail.
pub fn derive(gpa: Allocator, src: sn.Source) !Derived {
    var arena = std.heap.ArenaAllocator.init(gpa);
    errdefer arena.deinit();
    const a = arena.allocator();

    const total = src.size();
    if (total > max_file_bytes) {
        // The logged skip (decision 3): the whole file, loudly, never a
        // silent prefix. `store`'s marker memoizes it to one log per blob.
        log.warn("skipping .txt indexing: {d}-byte blob exceeds the {d} MiB cap", .{
            total, max_file_bytes / (1024 * 1024),
        });
        return .{ .arena = arena, .segments = &.{}, .skipped_over_cap = true };
    }

    // Phase 1: segment byte ranges, one sequential scan in fixed windows.
    var ranges: std.ArrayList(SegRange) = .empty;
    defer ranges.deinit(gpa);
    {
        var scan: Scan = .{};
        var chunk: [blobstore.chunk_len]u8 = undefined;
        var pos: u64 = 0;
        while (pos < total) {
            const n: usize = @intCast(@min(total - pos, chunk.len));
            try src.read(pos, chunk[0..n]);
            for (chunk[0..n], 0..) |b, i| try scan.byte(gpa, src, &ranges, pos + i, b);
            pos += n;
        }
        try scan.finish(gpa, src, &ranges, total);
    }

    // Phase 2: the index copies — ranged read per segment, then the lossy
    // UTF-8 sanitize (INDEX copy only; the ranges above address raw bytes).
    const segs = try a.alloc(Segment, ranges.items.len);
    var buf: [max_segment_bytes]u8 = undefined;
    for (ranges.items, segs) |r, *seg| {
        try src.read(r.offset, buf[0..r.len]);
        const text = try sanitizeUtf8(a, buf[0..r.len]);
        seg.* = .{ .offset = r.offset, .len = r.len, .text = text, .text_hash = md5Hex(text) };
    }
    return .{ .arena = arena, .segments = segs };
}

/// `derive` over a stored blob. Null when the blob is not on disk.
pub fn deriveStored(gpa: Allocator, blobs: blobstore.BlobStore, md5: []const u8) !?Derived {
    var bs = blob_source.BlobSource.init(blobs, md5) catch return null;
    return try derive(gpa, bs.source());
}

/// `bytes` if it is valid UTF-8 (copied verbatim), else a copy with every
/// invalid byte replaced by U+FFFD. Never touches the blob — the recorded
/// ranges keep addressing the raw bytes.
fn sanitizeUtf8(a: Allocator, bytes: []const u8) ![]const u8 {
    if (std.unicode.utf8ValidateSlice(bytes)) return a.dupe(u8, bytes);
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < bytes.len) {
        const l = std.unicode.utf8ByteSequenceLength(bytes[i]) catch {
            try out.appendSlice(a, "\u{FFFD}");
            i += 1;
            continue;
        };
        if (i + l > bytes.len) {
            try out.appendSlice(a, "\u{FFFD}");
            i += 1;
            continue;
        }
        if (std.unicode.utf8Decode(bytes[i..][0..l])) |_| {
            try out.appendSlice(a, bytes[i..][0..l]);
            i += l;
        } else |_| {
            try out.appendSlice(a, "\u{FFFD}");
            i += 1;
        }
    }
    return out.items;
}

fn md5Hex(data: []const u8) [32]u8 {
    var digest: [Md5.digest_length]u8 = undefined;
    Md5.hash(data, &digest, .{});
    const hex = "0123456789abcdef";
    var out: [32]u8 = undefined;
    for (digest, 0..) |b, i| {
        out[2 * i] = hex[b >> 4];
        out[2 * i + 1] = hex[b & 0x0f];
    }
    return out;
}

// ---------------------------------------------------------------------------
// Write — inside the caller's transaction.
// ---------------------------------------------------------------------------

// The NOT NULL columns built for note pages, and the values a chunk row
// carries (documented here because they are a contract, not filler):
//
//   - `content_hash` = the segment's `text_hash`. Honest — it IS the md5 of
//     the row's content — and SAFE because nothing serves it: every reader
//     of `content_hash` (`pagePlan`, `pageRefAt`, `pageRefsFromIndex`) gates
//     on `note_index.indexable = 1`, which a `.txt` blob never is.
//   - `width`/`height` = 0. No raster geometry exists; the same
//     indexable-gate keeps every consumer away.
//   - `layers` = the EMPTY blob (`x''`). `unpackLayerRecords` reads it as
//     "no records" (not an error), and `layerVOsFromBlob` maps that to "no
//     panel" — but again, no reader reaches a kind = 1 row.
//   - `recogn_status` = 1 on real segments ("text present" — decision 4: the
//     FTS predicate and `search_from_where`'s `recogn_status = 1` pass with
//     no predicate change), 0 on the marker.

const upsert_segment_sql =
    \\INSERT INTO note_page_index(blob_md5, kind, page_index, content_hash, width, height,
    \\                            layers, recogn_status, text_hash, recogn_offset,
    \\                            recogn_length, text)
    \\VALUES(?1,1,?2,?3,0,0,x'',1,?4,?5,?6,?7)
    \\ON CONFLICT(blob_md5, page_index) DO UPDATE SET
    \\  kind=excluded.kind, content_hash=excluded.content_hash, width=excluded.width,
    \\  height=excluded.height, layers=excluded.layers, recogn_status=excluded.recogn_status,
    \\  text_hash=excluded.text_hash, recogn_offset=excluded.recogn_offset,
    \\  recogn_length=excluded.recogn_length, text=excluded.text;
;

/// The derived-state marker (see the module docs): ordinal 0, no text, no
/// range — `recogn_status = 0` keeps it out of the FTS predicate and out of
/// `search_from_where`. `content_hash` is md5("") for want of content.
const upsert_marker_sql =
    \\INSERT INTO note_page_index(blob_md5, kind, page_index, content_hash, width, height,
    \\                            layers, recogn_status)
    \\VALUES(?1,1,0,?2,0,0,x'',0)
    \\ON CONFLICT(blob_md5, page_index) DO UPDATE SET
    \\  kind=excluded.kind, content_hash=excluded.content_hash, width=excluded.width,
    \\  height=excluded.height, layers=excluded.layers, recogn_status=excluded.recogn_status,
    \\  text_hash=NULL, recogn_offset=NULL, recogn_length=NULL, text=NULL;
;

/// The one format-specific write `reconcilePage` hands the `.txt` adapter: a
/// paragraph-row upsert (`kind = 1`, the byte range, `text_hash` doubling as
/// `content_hash` — see the column contract above). `ordinal` is the segment
/// index the driver diffed on, bound as `page_index`.
const SegUpsert = struct {
    blob_md5: []const u8,
    seg: Segment,
    pub fn upsert(self: @This(), db: sqlite.Db, ordinal: i64) !void {
        var s = try db.prepare(upsert_segment_sql);
        defer s.finalize();
        s.bindText(1, self.blob_md5);
        s.bindInt(2, ordinal);
        s.bindText(3, &self.seg.text_hash); // content_hash — see the contract above
        s.bindText(4, &self.seg.text_hash);
        s.bindInt(5, @intCast(self.seg.offset));
        s.bindInt(6, self.seg.len);
        s.bindText(7, self.seg.text);
        _ = try s.step();
    }
};

/// Writes `d`'s segment rows for `blob_md5`. Call inside the caller's
/// transaction, AFTER the blob's `note_index` row exists (the FK; on the
/// ingest path `noteindex.store` has just written it, on the heal path
/// `ensureIndexed` gates on it being current).
///
/// This is `note_index.store`'s exact re-derive discipline, per segment: the
/// stored text is DIFFED first, postings are refreshed IN PLACE only where it
/// actually changed ('delete' while the old row still resolves, insert after
/// the rewrite, at the same masked rowids for every partition holding the
/// blob), and a segment the blob did not have before mints a fresh masked
/// rowid for every CURRENT holder (`mintPageForHolders` — which is also what
/// makes the v5→v6 heal self-serve: the healed blob's holders all gain their
/// segment rows here, no re-upload). On first ingest nobody holds the blob
/// yet, so every search call degenerates to a no-op and the ingesting owner's
/// rows are minted by `mintOwnerBlobSearch` once their `files` row exists.
pub fn store(db: sqlite.Db, blob_md5: []const u8, d: Derived, now: i64) !void {
    if (d.segments.len == 0) {
        // Nothing indexable (empty/whitespace-only file, or the over-cap
        // skip): the marker memoizes "derived, nothing to index" so the
        // derivation — and the over-cap log line — happen once per blob.
        var old_exists = false;
        var had_text = false;
        {
            if (try db.row("SELECT text FROM note_page_index WHERE blob_md5 = ?1 AND page_index = 0;", &.{.{ .text = blob_md5 }})) |r| {
                defer r.finalize();
                old_exists = true;
                had_text = r.text(0).len != 0;
            }
        }
        if (old_exists and had_text) try search.deletePagePostings(db, blob_md5, 0);
        {
            var s = try db.prepare(upsert_marker_sql);
            defer s.finalize();
            s.bindText(1, blob_md5);
            s.bindText(2, &md5Hex(""));
            _ = try s.step();
        }
        // Holders gain a phantom segment row for the marker (its postings
        // insert is predicate-filtered to nothing) — cheap, and it keeps
        // `mintOwnerBlobSearch`'s "count all rows" arithmetic uniform.
        if (!old_exists) try search.mintPageForHolders(db, blob_md5, 0, now);
        try dropTail(db, blob_md5, 1);
        return;
    }

    for (d.segments, 0..) |seg, i| {
        // The per-segment re-derive discipline lives once in
        // `search.reconcilePage`; the adapter hands it the new text to diff on
        // and the paragraph-row upsert.
        try search.reconcilePage(db, blob_md5, @intCast(i), seg.text, now, SegUpsert{
            .blob_md5 = blob_md5,
            .seg = seg,
        });
    }
    try dropTail(db, blob_md5, @intCast(d.segments.len));
}

/// A re-derive yielded fewer segments (an `index_version` bump changing the
/// chunking — same-blob content never shrinks by itself): the tail goes,
/// search rows first so the FK cannot trip.
fn dropTail(db: sqlite.Db, blob_md5: []const u8, from: i64) !void {
    try search.dropTailSearch(db, blob_md5, from);
    var s = try db.prepare("DELETE FROM note_page_index WHERE blob_md5 = ?1 AND page_index >= ?2;");
    defer s.finalize();
    s.bindText(1, blob_md5);
    s.bindInt(2, from);
    _ = try s.step();
}

// ---------------------------------------------------------------------------
// The gate + lazy heal
// ---------------------------------------------------------------------------

/// Whether this blob still needs a `.txt` derivation. False — the memo —
/// only when a CURRENT `note_index` row exists AND either the note parser
/// verified the bytes (`indexable = 1`: a real `.note` is never chunked,
/// whatever it is called) or `kind = 1` rows already hang off it (real
/// segments, or the zero-segment marker). A missing/stale row is `true`: the
/// note half heals first and this question is asked again after.
pub fn needsDerive(db: sqlite.Db, blob_md5: []const u8) !bool {
    var r = (try db.row(
        "SELECT indexable, EXISTS(SELECT 1 FROM note_page_index np WHERE np.blob_md5 = ?1 AND np.kind = 1) " ++
            "FROM note_index WHERE blob_md5 = ?1 AND index_version = ?2;",
        &.{ .{ .text = blob_md5 }, .{ .int = noteindex.index_version } },
    )) orelse return true;
    defer r.finalize();
    return r.int(0) == 0 and r.int(1) == 0;
}

/// Lazy backfill, for read paths — the `.txt` half of what makes the v5→v6
/// `index_version` bump need no migration: a pre-existing `.txt` derives its
/// segments on first view. A no-op (two indexed single-row SELECTs) once the
/// blob is derived.
///
/// `name` is the file name when the caller has one in hand (listings do);
/// null lets the heal look the blob's name up from any `files` row bearing
/// it — one cheap indexed SELECT, and any row will do because the extension
/// is the whole gate.
///
/// ORDER CONTRACT: the note half heals first (`noteindex.ensureIndexed` —
/// `controlplane.backfill` runs it immediately before this). A stale
/// `note_index` row returns early here rather than deriving segments the
/// note heal's tail-drop would immediately wipe.
pub fn ensureIndexed(
    gpa: Allocator,
    db: sqlite.Db,
    blobs: blobstore.BlobStore,
    md5: []const u8,
    name: ?[]const u8,
    now: i64,
) !void {
    if (name) |n| {
        if (!wants(n)) return;
    }
    if (!try noteindex.isCurrent(db, md5)) return; // the note half heals first
    if (!try needsDerive(db, md5)) return;
    if (name == null) {
        var r = (try db.row("SELECT name FROM files WHERE md5 = ?1 AND is_folder = 0 LIMIT 1;", &.{.{ .text = md5 }})) orelse return; // orphan blob: nothing names it
        defer r.finalize();
        if (!wants(r.text(0))) return;
    }

    // Derive OUTSIDE the transaction (the parse-outside-lock rule): the scan
    // is ranged I/O, and only the row writes need the write lock. One-time
    // cost, accepted (plan decision 6): the first view after the upgrade
    // derives each txt inline — seconds for a big file, once per blob.
    var d = (try deriveStored(gpa, blobs, md5)) orelse return;
    defer d.deinit();

    try db.exec("BEGIN IMMEDIATE;");
    errdefer db.exec("ROLLBACK;") catch {};
    try store(db, md5, d, now);
    // Canonical-order heal (index_version 8), the `.txt` half: re-mint any
    // holder's paragraph band a past flip left out of order. No-op on the
    // contiguous bands the whole-doc-band re-mint now produces.
    try search.recanonicalizeHolders(db, md5, now);
    try db.exec("COMMIT;");
}

// ---------------------------------------------------------------------------
// Tests — the chunker
// ---------------------------------------------------------------------------

const testing = std.testing;
const schema = @import("../db/schema.zig");
const thumbstore = @import("../store/thumbs.zig");
const filesvc = @import("files.zig");
const deferredmod = @import("deferred.zig");
const nb = @import("note_builder");

/// Asserts every segment's byte range replays exactly (`seg == blob[offset..]
/// [0..len]` — pinned against the real bytes) wherever the file is valid
/// UTF-8, which is the contract the viewer's deep links depend on.
fn expectExactRanges(blob: []const u8, d: Derived) !void {
    for (d.segments) |seg| {
        try testing.expect(seg.offset + seg.len <= blob.len);
        try testing.expectEqualStrings(blob[@intCast(seg.offset)..][0..seg.len], seg.text);
        try testing.expectEqualStrings(&md5Hex(seg.text), &seg.text_hash);
    }
}

test "wants: .txt only, case-insensitive, leading-dot and trailing-dot excluded" {
    try testing.expect(wants("notes.txt"));
    try testing.expect(wants("NOTES.TXT"));
    try testing.expect(wants("a.b.txt"));
    try testing.expect(!wants("notes.text"));
    try testing.expect(!wants("txt"));
    try testing.expect(!wants(".txt"));
    try testing.expect(!wants("trailing."));
    try testing.expect(!wants("note.note"));
}

test "paragraphs split on blank lines (whitespace-only included), ranges exact" {
    const blob = "First paragraph line one\nline two\n\n  \t \nSecond paragraph\n\n\nThird";
    var d = try deriveSlice(testing.allocator, blob);
    defer d.deinit();

    try testing.expectEqual(@as(usize, 3), d.segments.len);
    try expectExactRanges(blob, d);

    // The multi-line paragraph keeps its interior newline and sheds only the
    // terminator; segments start exactly where their first line starts.
    try testing.expectEqualStrings("First paragraph line one\nline two", d.segments[0].text);
    try testing.expectEqual(@as(u64, 0), d.segments[0].offset);
    try testing.expectEqualStrings("Second paragraph", d.segments[1].text);
    try testing.expectEqual(@as(u64, std.mem.indexOf(u8, blob, "Second").?), d.segments[1].offset);
    try testing.expectEqualStrings("Third", d.segments[2].text); // EOF without a newline
    try testing.expectEqual(@as(u64, std.mem.indexOf(u8, blob, "Third").?), d.segments[2].offset);
}

test "CRLF: \\r\\n blank lines split, trailing \\r is trimmed, interior CRLF preserved" {
    const blob = "alpha\r\nbeta\r\n\r\ngamma\r\n";
    var d = try deriveSlice(testing.allocator, blob);
    defer d.deinit();

    try testing.expectEqual(@as(usize, 2), d.segments.len);
    try expectExactRanges(blob, d);
    try testing.expectEqualStrings("alpha\r\nbeta", d.segments[0].text); // interior CRLF stays
    try testing.expectEqualStrings("gamma", d.segments[1].text); // trailing CR trimmed

    // A bare trailing \r at EOF trims like a CRLF's would.
    var d2 = try deriveSlice(testing.allocator, "solo\r");
    defer d2.deinit();
    try testing.expectEqual(@as(usize, 1), d2.segments.len);
    try testing.expectEqualStrings("solo", d2.segments[0].text);
}

test "an over-cap paragraph splits hard at the last newline before the cap" {
    const gpa = testing.allocator;
    // 10 lines of 1000 bytes: one 10009-byte paragraph, no blank line.
    var blob: std.ArrayList(u8) = .empty;
    defer blob.deinit(gpa);
    for (0..10) |k| {
        var line: [1000]u8 = undefined;
        @memset(&line, 'a' + @as(u8, @intCast(k)));
        try blob.appendSlice(gpa, &line);
        if (k < 9) try blob.append(gpa, '\n');
    }

    var d = try deriveSlice(gpa, blob.items);
    defer d.deinit();
    try testing.expectEqual(@as(usize, 2), d.segments.len);
    try expectExactRanges(blob.items, d);

    // The first chunk ends at a line boundary (the byte after it is the
    // newline the split happened at), fits the cap, and the second picks up
    // at the very next line — line-aligned chunks, byte-exact.
    const first = d.segments[0];
    try testing.expect(first.len <= max_segment_bytes);
    try testing.expectEqual(@as(u8, '\n'), blob.items[@intCast(first.offset + first.len)]);
    try testing.expectEqual(first.offset + first.len + 1, d.segments[1].offset);
    try testing.expectEqual(@as(u64, blob.items.len), d.segments[1].offset + d.segments[1].len);
}

test "one enormous line falls back to cap-sized cuts on UTF-8 boundaries" {
    const gpa = testing.allocator;
    // 'a' + 5000×'é' (2 bytes each): every 'é' starts at an ODD offset, so
    // the cap (8192, even) lands mid-sequence and must back off by one.
    var blob: std.ArrayList(u8) = .empty;
    defer blob.deinit(gpa);
    try blob.append(gpa, 'a');
    for (0..5000) |_| try blob.appendSlice(gpa, "é");

    var d = try deriveSlice(gpa, blob.items);
    defer d.deinit();
    try testing.expectEqual(@as(usize, 2), d.segments.len);
    try expectExactRanges(blob.items, d);

    try testing.expectEqual(@as(u32, @intCast(max_segment_bytes - 1)), d.segments[0].len);
    try testing.expect(std.unicode.utf8ValidateSlice(d.segments[0].text)); // no manufactured FFFD
    try testing.expect(std.unicode.utf8ValidateSlice(d.segments[1].text));
    try testing.expectEqual(@as(u64, blob.items.len), d.segments[1].offset + d.segments[1].len);
}

test "invalid UTF-8 is lossily replaced in the INDEX copy only; the range still addresses raw bytes" {
    const blob = "good \xff\xfe bytes\nand \x80 tail";
    var d = try deriveSlice(testing.allocator, blob);
    defer d.deinit();

    try testing.expectEqual(@as(usize, 1), d.segments.len);
    const seg = d.segments[0];
    // The RANGE covers the raw bytes verbatim...
    try testing.expectEqual(@as(u64, 0), seg.offset);
    try testing.expectEqual(@as(u32, blob.len), seg.len);
    // ...while the TEXT replaced each invalid byte, one U+FFFD per byte.
    try testing.expectEqualStrings("good \u{FFFD}\u{FFFD} bytes\nand \u{FFFD} tail", seg.text);
    try testing.expectEqualStrings(&md5Hex(seg.text), &seg.text_hash); // the hash is of the INDEX copy
}

test "hostile input: NULs and truncated sequences chunk without panic, text sanitized" {
    // NUL is VALID UTF-8 (kept verbatim); the lone continuation and the
    // truncated 3-byte lead are not.
    const blob = "a\x00b\n\ntail \xe0\xa0";
    var d = try deriveSlice(testing.allocator, blob);
    defer d.deinit();
    try testing.expectEqual(@as(usize, 2), d.segments.len);
    try testing.expectEqualStrings("a\x00b", d.segments[0].text);
    try testing.expectEqualStrings("tail \u{FFFD}\u{FFFD}", d.segments[1].text);
}

test "empty and whitespace-only files chunk to nothing" {
    for ([_][]const u8{ "", "\n", " \n\t\n \n", "\r\n\r\n", "   " }) |blob| {
        var d = try deriveSlice(testing.allocator, blob);
        defer d.deinit();
        try testing.expectEqual(@as(usize, 0), d.segments.len);
        try testing.expect(!d.skipped_over_cap);
    }
}

test "a file over the 16 MiB cap is skipped WHOLE (logged), never silently truncated" {
    const gpa = testing.allocator;
    const big = try gpa.alloc(u8, max_file_bytes + 1);
    defer gpa.free(big);
    @memset(big, 'x');

    // The warn is the contract; silence it for the suite's output.
    const saved = testing.log_level;
    testing.log_level = .err;
    defer testing.log_level = saved;

    var d = try deriveSlice(gpa, big);
    defer d.deinit();
    try testing.expectEqual(@as(usize, 0), d.segments.len);
    try testing.expect(d.skipped_over_cap);
}

test "the ranged (blob-store) source derives identically to the slice source" {
    const gpa = testing.allocator;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store_ = try blobstore.BlobStore.init(testing.io, tmp.dir);

    // Larger than one scan window, so the chunked read loop really runs.
    var blob: std.ArrayList(u8) = .empty;
    defer blob.deinit(gpa);
    for (0..3000) |k| {
        try blob.print(gpa, "paragraph number {d} with some words in it\n\n", .{k});
    }
    try testing.expect(blob.items.len > blobstore.chunk_len);

    var r = std.Io.Reader.fixed(blob.items);
    const put = try store_.put(&r, null);

    var from_slice = try deriveSlice(gpa, blob.items);
    defer from_slice.deinit();
    var from_blob = (try deriveStored(gpa, store_, &put.md5)).?;
    defer from_blob.deinit();

    try testing.expectEqual(@as(usize, 3000), from_slice.segments.len);
    try testing.expectEqual(from_slice.segments.len, from_blob.segments.len);
    for (from_slice.segments, from_blob.segments) |a_, b| {
        try testing.expectEqual(a_.offset, b.offset);
        try testing.expectEqual(a_.len, b.len);
        try testing.expectEqualStrings(a_.text, b.text);
        try testing.expectEqualStrings(&a_.text_hash, &b.text_hash);
    }
    try expectExactRanges(blob.items, from_blob);
}

// ---------------------------------------------------------------------------
// Tests — ingest, search integration, lifecycle
// ---------------------------------------------------------------------------

const Fixture = struct {
    db: sqlite.Db,
    files: filesvc.Files,
    tmp: testing.TmpDir,
    arena: std.heap.ArenaAllocator,

    fn init() !Fixture {
        var db = try sqlite.Db.openMemory();
        try schema.migrate(db);
        for ([_]u8{ 1, 2 }) |uid| {
            var s = try db.prepare(
                "INSERT INTO users(id, email, password_md5, created_at) VALUES(?1, ?1 || '@b.c', '0123456789abcdef0123456789abcdef', 0);",
            );
            defer s.finalize();
            s.bindInt(1, uid);
            _ = try s.step();
            var c = try db.prepare("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(?1, 0, 1000000000);");
            defer c.finalize();
            c.bindInt(1, uid);
            _ = try c.step();
        }
        const tmp = testing.tmpDir(.{});
        const store_ = try blobstore.BlobStore.init(testing.io, tmp.dir);
        const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
        const thumbs = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
        return .{
            .db = db,
            .files = filesvc.Files.init(testing.allocator, testing.io, db, store_, thumbs),
            .tmp = tmp,
            .arena = std.heap.ArenaAllocator.init(testing.allocator),
        };
    }

    fn deinit(f: *Fixture) void {
        f.arena.deinit();
        f.db.close();
        f.tmp.cleanup();
    }

    fn a(f: *Fixture) Allocator {
        return f.arena.allocator();
    }

    /// Puts `bytes` as a file, returning its id and (owned) md5 hex.
    ///
    /// THEN DRAINS THE DEFERRED WORKER, because segment derivation is no longer
    /// part of an upload: `putFile` returns as soon as the bytes and the rows
    /// are safe, and `services/deferred.zig` produces the `kind = 1` rows
    /// afterwards. Every assertion below is about the state once that has
    /// happened, so the fixture models the real sequence rather than pretending
    /// the upload still does the work.
    fn put(f: *Fixture, user_id: u64, name: []const u8, bytes: []const u8) !struct { id: u64, md5: [32]u8 } {
        var r = std.Io.Reader.fixed(bytes);
        const e = try f.files.putFile(user_id, null, name, &r, null);
        var lock: std.Io.Mutex = .init;
        deferredmod.drainNow(testing.allocator, f.db, f.files.blobs, &lock, testing.io);
        defer testing.allocator.free(e.name);
        defer if (e.md5) |m| testing.allocator.free(m);
        var md5: [32]u8 = undefined;
        @memcpy(&md5, e.md5.?[0..32]);
        return .{ .id = e.id, .md5 = md5 };
    }

    fn search_(f: *Fixture, user_id: u64, q: []const u8) !notesearch.Results {
        return notesearch.searchPages(f.a(), testing.io, f.db, user_id, q, notesearch.default_limit, null);
    }

    /// Find-in-txt DRAINED to completion: auto-continues the keyset until the
    /// cursor is absent, accumulating every paragraph — the client's auto-drain,
    /// so the complete-result assertions read the whole file through the batched
    /// entry point exactly as the viewer will. `usedFuzzy` rides the first batch.
    fn txtSearch(f: *Fixture, user_id: u64, note_id: u64, q: []const u8) !notesearch.TxtResults {
        const arena = f.a();
        var segs: std.ArrayList(notesearch.TxtMatch) = .empty;
        var used_fuzzy = false;
        var query: []const u8 = q;
        var cursor: ?[]const u8 = null;
        var first = true;
        while (true) {
            const r = try notesearch.searchTxtSegments(arena, f.db, user_id, note_id, q, cursor, notesearch.default_batch);
            if (first) {
                used_fuzzy = r.usedFuzzy;
                query = r.query;
                first = false;
            }
            try segs.appendSlice(arena, r.segments);
            cursor = r.cursor orelse break;
        }
        return .{ .query = query, .segments = segs.items, .usedFuzzy = used_fuzzy };
    }

    fn count(f: *Fixture, sql: []const u8) !i64 {
        var s = try f.db.prepare(sql);
        defer s.finalize();
        _ = try s.step();
        return s.columnInt(0);
    }

    /// The owner's masked rowid for the segment whose stored text is `text` —
    /// identity tracked by CONTENT, because ordinals are exactly what a
    /// mid-file insert moves around.
    fn segRowidByText(f: *Fixture, user_id: u64, text: []const u8) !i64 {
        var r = (try f.db.row(
            "SELECT s.id FROM search_partitions sp " ++
                "JOIN segment_search s ON s.id BETWEEN (sp.id << 48) AND ((sp.id + 1) << 48) - 1 " ++
                "JOIN note_page_index p ON p.id = s.segment_id " ++
                "WHERE sp.user_id = ?1 AND p.text = ?2;",
            &.{ .{ .int = @intCast(user_id) }, .{ .text = text } },
        )) orelse return error.NoSegment;
        defer r.finalize();
        return r.int(0);
    }

    fn setUpdatedAt(f: *Fixture, id: u64, ts: i64) !void {
        var s = try f.db.prepare("UPDATE files SET updated_at = ?2 WHERE id = ?1;");
        defer s.finalize();
        s.bindInt(1, @intCast(id));
        s.bindInt(2, ts);
        _ = try s.step();
    }
};

test "a .txt upload mints kind=1 paragraph rows: ordinals, byte ranges, hashes, and the NOT NULL contract" {
    var f = try Fixture.init();
    defer f.deinit();

    const blob = "alpha one\n\nbeta two words\n\ngamma three";
    const put = try f.put(1, "doc.txt", blob);

    // The note_index row stays note-specific: not a parseable .note.
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT indexable FROM note_index;"));
    try testing.expectEqual(noteindex.index_version, try f.count("SELECT index_version FROM note_index;"));

    var s = try f.db.prepare(
        "SELECT page_index, kind, content_hash, width, height, LENGTH(layers), recogn_status, " ++
            "text_hash, recogn_offset, recogn_length, text FROM note_page_index ORDER BY page_index;",
    );
    defer s.finalize();
    const want = [_][]const u8{ "alpha one", "beta two words", "gamma three" };
    for (want, 0..) |text, i| {
        try testing.expect(try s.step());
        try testing.expectEqual(@as(i64, @intCast(i)), s.columnInt(0));
        try testing.expectEqual(kind_txt, s.columnInt(1));
        try testing.expectEqualStrings(&md5Hex(text), s.columnText(2)); // content_hash = text_hash
        try testing.expectEqual(@as(i64, 0), s.columnInt(3)); // width
        try testing.expectEqual(@as(i64, 0), s.columnInt(4)); // height
        try testing.expectEqual(@as(i64, 0), s.columnInt(5)); // layers: the empty blob
        try testing.expectEqual(@as(i64, 1), s.columnInt(6)); // recogn_status = "text present"
        try testing.expectEqualStrings(&md5Hex(text), s.columnText(7));
        // The byte range replays to exactly the paragraph.
        const off: usize = @intCast(s.columnInt(8));
        const len: usize = @intCast(s.columnInt(9));
        try testing.expectEqualStrings(text, blob[off..][0..len]);
        try testing.expectEqualStrings(text, s.columnText(10));
    }
    try testing.expect(!try s.step());

    // Derived state is memoized: no re-derive on the next link of the same
    // content, and the owner's postings landed (one per paragraph).
    try testing.expect(!try needsDerive(f.db, &put.md5));
    try testing.expectEqual(@as(i64, 3), try f.count("SELECT COUNT(*) FROM segment_search;"));
    try testing.expectEqual(@as(i64, 3), try f.count("SELECT COUNT(*) FROM segment_fts_docsize;"));

    // And the library search finds a paragraph, kind-tagged, snippet marked.
    const res = try f.search_(1, "beta");
    try testing.expectEqual(@as(usize, 1), res.hits.len);
    try testing.expectEqualStrings("doc.txt", res.hits[0].noteName);
    try testing.expectEqual(@as(i64, 1), res.hits[0].pageIndex); // the paragraph ordinal
    try testing.expectEqual(@as(?i64, kind_txt), res.hits[0].kind);
    try testing.expect(std.mem.indexOf(u8, res.hits[0].snippet, "<mark>beta</mark>") != null);
}

test "the wire shape: kind is OMITTED for a note-page hit and 1 for a .txt hit" {
    var f = try Fixture.init();
    defer f.deinit();

    const note_bytes = try nb.serialize(testing.allocator, .{ .pages = &.{.{
        .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }},
        .recogn_status = 1,
        .recogn_labels = &.{"shared apple pie"},
    }} });
    defer testing.allocator.free(note_bytes);
    var r = std.Io.Reader.fixed(note_bytes);
    const e = try f.files.putFile(1, null, "old.note", &r, null);
    testing.allocator.free(e.name);
    if (e.md5) |m| testing.allocator.free(m);
    _ = try f.put(1, "new.txt", "apple tart recipe\n");

    const res = try f.search_(1, "apple");
    try testing.expectEqual(@as(usize, 2), res.hits.len);
    for (res.hits) |hit| {
        const json = try std.json.Stringify.valueAlloc(f.a(), hit, .{ .emit_null_optional_fields = false });
        if (std.mem.eql(u8, hit.noteName, "new.txt")) {
            try testing.expect(std.mem.indexOf(u8, json, "\"kind\":1") != null);
        } else {
            // The kind-0 wire shape is byte-for-byte what it was before
            // `.txt` hits existed: no `kind` key at all.
            try testing.expect(std.mem.indexOf(u8, json, "kind") == null);
        }
    }
}

test "AND semantics are per-PARAGRAPH: adjacent paragraphs do not co-match, one paragraph does" {
    var f = try Fixture.init();
    defer f.deinit();

    // The deliberate semantic consequence of paragraph segments (plan
    // decision 2), pinned as documented behavior.
    _ = try f.put(1, "adjacent.txt", "solitary wordalpha here\n\nsolitary wordbeta there\n");
    _ = try f.put(1, "together.txt", "both wordgamma and worddelta in one paragraph\n");

    try testing.expectEqual(@as(usize, 0), (try f.search_(1, "wordalpha wordbeta")).hits.len);
    const both = try f.search_(1, "wordgamma worddelta");
    try testing.expectEqual(@as(usize, 1), both.hits.len);
    try testing.expectEqualStrings("together.txt", both.hits[0].noteName);
}

test "mixed results: txt paragraphs interleave with note pages in recency order, kinds correct" {
    var f = try Fixture.init();
    defer f.deinit();

    const note_bytes = try nb.serialize(testing.allocator, .{ .pages = &.{.{
        .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }},
        .recogn_status = 1,
        .recogn_labels = &.{"harvest schedule notes"},
    }} });
    defer testing.allocator.free(note_bytes);
    var r = std.Io.Reader.fixed(note_bytes);
    const note = try f.files.putFile(1, null, "field.note", &r, null);
    testing.allocator.free(note.name);
    if (note.md5) |m| testing.allocator.free(m);
    const txt = try f.put(1, "journal.txt", "the harvest came early this year\n");

    // Display order is files.updated_at, newest first — make it unambiguous.
    try f.setUpdatedAt(note.id, 100);
    try f.setUpdatedAt(txt.id, 200);
    var res = try f.search_(1, "harvest");
    try testing.expectEqual(@as(usize, 2), res.hits.len);
    try testing.expectEqualStrings("journal.txt", res.hits[0].noteName);
    try testing.expectEqual(@as(?i64, kind_txt), res.hits[0].kind);
    try testing.expectEqualStrings("field.note", res.hits[1].noteName);
    try testing.expectEqual(@as(?i64, null), res.hits[1].kind);

    // Flip the recency: the note leads, the kinds ride their rows unchanged.
    try f.setUpdatedAt(note.id, 300);
    res = try f.search_(1, "harvest");
    try testing.expectEqualStrings("field.note", res.hits[0].noteName);
    try testing.expectEqual(@as(?i64, null), res.hits[0].kind);
    try testing.expectEqual(@as(?i64, kind_txt), res.hits[1].kind);
}

test "isolation: another user never sees the txt segments, though the text rows are shared" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put(1, "mine.txt", "a rather private manifesto\n");
    try testing.expectEqual(@as(usize, 1), (try f.search_(1, "manifesto")).hits.len);
    try testing.expectEqual(@as(usize, 0), (try f.search_(2, "manifesto")).hits.len);

    // Both holders of the SAME content each see their own file.
    _ = try f.put(2, "theirs.txt", "a rather private manifesto\n");
    const theirs = try f.search_(2, "manifesto");
    try testing.expectEqual(@as(usize, 1), theirs.hits.len);
    try testing.expectEqualStrings("theirs.txt", theirs.hits[0].noteName);
    // One shared text row, one segment row per owner.
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM note_page_index;"));
    try testing.expectEqual(@as(i64, 2), try f.count("SELECT COUNT(*) FROM segment_search;"));
}

test "FIND-IN-TXT: blob-scoped, complete, unranked, with an EXACT per-paragraph count and byte range" {
    var f = try Fixture.init();
    defer f.deinit();

    // Three paragraphs; "target" appears 0/1/2 times across them, and once in a
    // SECOND file that must never leak into the first file's find.
    const blob = "the target sits here\n\nno match in this one\n\ntarget then target again\n";
    const put = try f.put(1, "doc.txt", blob);
    _ = try f.put(1, "other.txt", "a decoy target elsewhere\n");

    const res = try f.txtSearch(1, put.id, "target");
    // COMPLETE: both matching paragraphs, in ordinal order, and nothing from the
    // non-matching middle paragraph or the other file.
    try testing.expectEqual(@as(usize, 2), res.segments.len);
    try testing.expect(!res.usedFuzzy);

    try testing.expectEqual(@as(i64, 0), res.segments[0].segment);
    try testing.expectEqual(@as(i64, 1), res.segments[0].matches); // "target" ×1
    try testing.expectEqual(@as(i64, 2), res.segments[1].segment);
    try testing.expectEqual(@as(i64, 2), res.segments[1].matches); // "target" ×2 — EXACT

    // The byte range replays to exactly the paragraph the viewer scrolls to.
    for (res.segments) |seg| {
        const off: usize = @intCast(seg.offset);
        const len: usize = @intCast(seg.length);
        const para = blob[off..][0..len];
        try testing.expect(std.mem.indexOf(u8, para, "target") != null);
        try testing.expect(std.mem.indexOf(u8, "target", seg.terms[0]) != null);
    }
}

test "FIND-IN-TXT: same FTS as library search — a diacritic-folded / prefix term that finds the file finds its paragraphs" {
    var f = try Fixture.init();
    defer f.deinit();

    // Accented corpus word; the query is typed WITHOUT the accent (the household
    // case). Both the library search and find-in-txt fold it the same way.
    const put = try f.put(1, "notes.txt", "a linha sobre caf\u{00e9} aqui\n\nplain paragraph\n");

    // Library search finds the file (parity anchor).
    try testing.expect((try f.search_(1, "cafe")).hits.len >= 1);

    // Find-in-txt finds the same paragraph, unaccented query.
    const exact = try f.txtSearch(1, put.id, "cafe");
    try testing.expectEqual(@as(usize, 1), exact.segments.len);
    try testing.expectEqual(@as(i64, 0), exact.segments[0].segment);

    // And a prefix of it (the word still being typed — trailing char, no space)
    // reaches it too, exactly as the library prefix rules do.
    const prefix = try f.txtSearch(1, put.id, "caf");
    try testing.expectEqual(@as(usize, 1), prefix.segments.len);
}

test "FIND-IN-TXT: isolation — another user's identical text and a foreign file id both answer empty" {
    var f = try Fixture.init();
    defer f.deinit();

    const body = "a shared private paragraph\n";
    const mine = try f.put(1, "mine.txt", body);
    const theirs = try f.put(2, "theirs.txt", body); // same content, user 2

    // User 1 finds their own paragraph...
    try testing.expectEqual(@as(usize, 1), (try f.txtSearch(1, mine.id, "private")).segments.len);
    // ...but never through user 2's file id (the `files` join is the boundary,
    // even though the underlying text row is shared)...
    try testing.expectEqual(@as(usize, 0), (try f.txtSearch(1, theirs.id, "private")).segments.len);
    // ...and user 2 sees only their own.
    try testing.expectEqual(@as(usize, 1), (try f.txtSearch(2, theirs.id, "private")).segments.len);
    try testing.expectEqual(@as(usize, 0), (try f.txtSearch(2, mine.id, "private")).segments.len);

    // A note id that never existed is the same empty answer, not an error.
    try testing.expectEqual(@as(usize, 0), (try f.txtSearch(1, 999999, "private")).segments.len);
}

/// Every paragraph ordinal GLOBAL search returns for `name`/`q`, drained across
/// the keyset stream so truncation cannot hide one, sorted — the parity anchor
/// for find-in-txt, exactly as `globalDocPages` is for find-in-note.
fn globalFilePages(f: *Fixture, user_id: u64, name: []const u8, q: []const u8) ![]i64 {
    var pages: std.ArrayList(i64) = .empty;
    var cursor: ?[]const u8 = null;
    while (true) {
        const r = try notesearch.searchPages(f.a(), testing.io, f.db, user_id, q, notesearch.default_limit, cursor);
        for (r.hits) |h| {
            if (std.mem.eql(u8, h.noteName, name)) try pages.append(f.a(), h.pageIndex);
        }
        if (r.cursor) |c| cursor = c else break;
    }
    std.sort.pdq(i64, pages.items, {}, std.sort.asc(i64));
    return pages.items;
}

/// The `.txt` twin of `query.zig`'s `expectDocParity`, asserted wherever global↔
/// in-doc set equality used to be. Global search names FILES now, one hit per
/// band, so it is a strict subset of in-doc by design; what must survive is
/// presence in both directions (named exactly when in-doc finds something),
/// every named paragraph being one in-doc returns, and no repeats. Completeness
/// inside a file is in-doc's claim alone.
fn expectFileParity(global: []const i64, in_doc: []const i64) !void {
    try testing.expectEqual(in_doc.len == 0, global.len == 0);
    for (global, 0..) |g, i| {
        try testing.expect(std.mem.indexOfScalar(i64, in_doc, g) != null);
        try testing.expect(std.mem.indexOfScalar(i64, global[i + 1 ..], g) == null);
    }
}

test "FIND-IN-TXT DOCUMENT PARITY (the non-negotiable): global names the file iff in-doc finds it, on a paragraph in-doc returns" {
    var f = try Fixture.init();
    defer f.deinit();

    // A big decoy file crowds the library result so parity must survive
    // truncation, plus a shared common word across many paragraphs.
    var big: std.ArrayList(u8) = .empty;
    for (0..30) |i| {
        if (i != 0) try big.appendSlice(f.a(), "\n\n");
        try big.appendSlice(f.a(), try std.fmt.allocPrint(f.a(), "decoy common line {d}", .{i}));
    }
    _ = try f.put(1, "big.txt", big.items);

    // The file under test: a common term, a rare one, and an accented word the
    // query reaches unaccented — same fold as global search.
    const blob = "alpha common line\n\nbeta common\n\ngamma caf\u{00e9} common\n";
    const put = try f.put(1, "doc.txt", blob);

    for ([_][]const u8{ "common ", "alpha ", "cafe ", "caf" }) |q| {
        const g = try globalFilePages(&f, 1, "doc.txt", q);
        const r = try f.txtSearch(1, put.id, q);
        const d = try f.a().alloc(i64, r.segments.len);
        for (r.segments, d) |seg, *o| o.* = seg.segment;
        std.sort.pdq(i64, d, {}, std.sort.asc(i64));
        // The band is canonical, so the file is named exactly once however many
        // of its paragraphs matched — and that paragraph is one in-doc returns.
        try testing.expect(d.len > 0);
        try testing.expectEqual(@as(usize, 1), g.len);
        try expectFileParity(g, d);
    }
    // The negative, on both sides: a term the file lacks names it in neither.
    try testing.expectEqual(@as(usize, 0), (try globalFilePages(&f, 1, "doc.txt", "zzzptl ")).len);
    try testing.expectEqual(@as(usize, 0), (try f.txtSearch(1, put.id, "zzzptl ")).segments.len);
}

test "FIND-IN-TXT BATCHED PARITY (the non-negotiable): the UNION of SMALL batches == global ∩ file, boundary-clean" {
    var f = try Fixture.init();
    defer f.deinit();

    // Twelve paragraphs sharing a common word — batch 3 ⇒ several round-trips, so
    // the cursor boundary is crossed repeatedly. This is the `.txt` shape the Pi
    // pathology lives in (a big file's find must chunk into small lock windows).
    var blob: std.ArrayList(u8) = .empty;
    for (0..12) |i| {
        if (i != 0) try blob.appendSlice(f.a(), "\n\n");
        try blob.appendSlice(f.a(), try std.fmt.allocPrint(f.a(), "para{d} common rare{d}", .{ i, i }));
    }
    const put = try f.put(1, "doc.txt", blob.items);

    for ([_][]const u8{ "common ", "rare5 ", "zzzptl " }) |q| {
        // The UNBATCHED in-doc result is the oracle for the batched drain — the
        // half of this pin that never depended on global, and now does not
        // mention it. Global re-anchors to document parity below.
        const whole = try f.txtSearch(1, put.id, q);
        const d = try f.a().alloc(i64, whole.segments.len);
        for (whole.segments, d) |seg, *o| o.* = seg.segment;
        std.sort.pdq(i64, d, {}, std.sort.asc(i64));

        // Drain in-doc at batch 3, checking each batch is BOUNDED and no paragraph
        // is dropped or duplicated across the cursor boundary.
        var seen: std.AutoHashMapUnmanaged(i64, void) = .empty;
        var got: std.ArrayList(i64) = .empty;
        var cursor: ?[]const u8 = null;
        while (true) {
            const r = try notesearch.searchTxtSegments(f.a(), f.db, 1, put.id, q, cursor, 3);
            if (!r.usedFuzzy) try testing.expect(r.segments.len <= 3);
            for (r.segments) |seg| {
                const gop = try seen.getOrPut(f.a(), seg.segment);
                try testing.expect(!gop.found_existing);
                try got.append(f.a(), seg.segment);
            }
            cursor = r.cursor orelse break;
        }
        std.sort.pdq(i64, got.items, {}, std.sort.asc(i64));
        try testing.expectEqualSlices(i64, d, got.items);

        // One canonical band ⇒ global names the file once, on a paragraph the
        // batches also produced (or not at all, for a term it lacks).
        const g = try globalFilePages(&f, 1, "doc.txt", q);
        try testing.expectEqual(@as(usize, if (d.len == 0) 0 else 1), g.len);
        try expectFileParity(g, got.items);
    }
}

test "FIND-IN-TXT EDITED ORDER: editing paragraphs keeps the band CONTIGUOUS in ordinal order; find stays complete" {
    var f = try Fixture.init();
    defer f.deinit();

    // Another file widens the partition; a decoy paragraph must never leak.
    _ = try f.put(1, "other.txt", "an unrelated common paragraph elsewhere\n");
    const v1 = "p0 common\n\np1 common\n\np2 common\n\np3 common\n\np4 common\n\np5 common\n";
    const put1 = try f.put(1, "doc.txt", v1);

    // Contiguous at ingest: find returns all six paragraphs.
    try testing.expectEqual(@as(usize, 6), (try f.txtSearch(1, put1.id, "common ")).segments.len);

    // Edit paragraphs 1 and 3: the replace flips the blob, and the whole-doc-band
    // re-mint (in-doc-search plan Phase 1) re-mints the file's paragraphs afresh
    // in ordinal order — no edited paragraph lands at a tail rowid, so the band
    // stays ONE contiguous run and `rowid ASC == reading order`.
    const v2 = "p0 common\n\np1 EDITED common\n\np2 common\n\np3 EDITED common\n\np4 common\n\np5 common\n";
    const put2 = try f.put(1, "doc.txt", v2);
    try testing.expectEqual(put1.id, put2.id); // a version replace keeps the id

    // The band is contiguous in ordinal order — no scatter.
    const r0 = try f.segRowidByText(1, "p0 common");
    try testing.expectEqual(r0 + 1, try f.segRowidByText(1, "p1 EDITED common"));
    try testing.expectEqual(r0 + 2, try f.segRowidByText(1, "p2 common"));
    try testing.expectEqual(r0 + 3, try f.segRowidByText(1, "p3 EDITED common"));
    try testing.expectEqual(r0 + 4, try f.segRowidByText(1, "p4 common"));
    try testing.expectEqual(r0 + 5, try f.segRowidByText(1, "p5 common"));

    // Find is COMPLETE and file-scoped: all six paragraphs in ordinal order.
    const res = try f.txtSearch(1, put2.id, "common ");
    try testing.expectEqual(@as(usize, 6), res.segments.len);
    for (res.segments, 0..) |seg, i| try testing.expectEqual(@as(i64, @intCast(i)), seg.segment);
    try testing.expectEqual(@as(usize, 2), (try f.txtSearch(1, put2.id, "edited ")).segments.len);
}

test "LIFECYCLE: editing one paragraph re-mints the whole band CONTIGUOUS in ordinal order" {
    var f = try Fixture.init();
    defer f.deinit();

    const v1 = "alpha one\n\nbeta two\n\ngamma three\n\ndelta four\n";
    _ = try f.put(1, "doc.txt", v1);

    // Same name, one paragraph edited: the replace flow flips old→new blob and
    // re-mints the band. `rowid ASC == ordinal order` by construction.
    const v2 = "alpha one\n\nbeta EDITED two\n\ngamma three\n\ndelta four\n";
    _ = try f.put(1, "doc.txt", v2);

    const r0 = try f.segRowidByText(1, "alpha one");
    try testing.expectEqual(r0 + 1, try f.segRowidByText(1, "beta EDITED two"));
    try testing.expectEqual(r0 + 2, try f.segRowidByText(1, "gamma three"));
    try testing.expectEqual(r0 + 3, try f.segRowidByText(1, "delta four"));
    try testing.expectError(error.NoSegment, f.segRowidByText(1, "beta two")); // old text gone
    try testing.expectEqual(@as(i64, 4), try f.count("SELECT COUNT(*) FROM segment_search;"));
    try testing.expectEqual(@as(i64, 4), try f.count("SELECT COUNT(*) FROM segment_fts_docsize;"));

    try testing.expectEqual(@as(usize, 1), (try f.search_(1, "edited")).hits.len);
    try testing.expectEqual(@as(usize, 1), (try f.search_(1, "gamma")).hits.len);
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "LIFECYCLE: inserting a paragraph mid-file re-mints the band so rowid ASC stays ordinal order" {
    var f = try Fixture.init();
    defer f.deinit();
    // Prune path: this pins the re-mint ORDINAL mechanics, and reads
    // `note_page_index` unscoped by blob — so keep the superseded version from
    // retaining its (identically-texted) render rows, which is versioning's
    // concern, tested separately.
    f.files.history.keep = 0;

    // THE case fixed-size chunking failed: an early insert shifted every later
    // chunk's content. Paragraph boundaries move WITH the content, and the
    // whole-band re-mint keeps the inserted paragraph BETWEEN its neighbours
    // (at its ordinal position) rather than at a tail rowid.
    const v1 = "alpha one\n\nbeta two\n\ngamma three\n\ndelta four\n";
    _ = try f.put(1, "doc.txt", v1);

    const v2 = "alpha one\n\nINSERTED paragraph\n\nbeta two\n\ngamma three\n\ndelta four\n";
    _ = try f.put(1, "doc.txt", v2);

    const r0 = try f.segRowidByText(1, "alpha one");
    try testing.expectEqual(r0 + 1, try f.segRowidByText(1, "INSERTED paragraph"));
    try testing.expectEqual(r0 + 2, try f.segRowidByText(1, "beta two"));
    try testing.expectEqual(r0 + 3, try f.segRowidByText(1, "gamma three"));
    try testing.expectEqual(r0 + 4, try f.segRowidByText(1, "delta four"));
    try testing.expectEqual(@as(i64, 5), try f.count("SELECT COUNT(*) FROM segment_search;"));

    // The ordinals shifted underneath (beta is ordinal 2 now) — the join carries
    // it, and the masked rowid tracks the new position.
    var s = try f.db.prepare("SELECT page_index FROM note_page_index WHERE text = 'beta two';");
    defer s.finalize();
    try testing.expect(try s.step());
    try testing.expectEqual(@as(i64, 2), s.columnInt(0));
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "an empty .txt records the derived marker: no postings, no re-derive, invisible to search" {
    var f = try Fixture.init();
    defer f.deinit();

    const put = try f.put(1, "empty.txt", "");
    // One marker row: kind=1, no text, out of the FTS predicate.
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM note_page_index WHERE kind = 1;"));
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM note_page_index WHERE text IS NOT NULL;"));
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM segment_fts_docsize;"));
    try testing.expect(!try needsDerive(f.db, &put.md5)); // the memo
    try testing.expectEqual(@as(usize, 0), (try f.search_(1, "anything")).hits.len);
}

test "a real .note named .txt is never chunked: the parser's verdict wins over the extension" {
    var f = try Fixture.init();
    defer f.deinit();

    const note_bytes = try nb.serialize(testing.allocator, .{ .pages = &.{.{
        .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }},
        .recogn_status = 1,
        .recogn_labels = &.{"genuine ink"},
    }} });
    defer testing.allocator.free(note_bytes);
    var r = std.Io.Reader.fixed(note_bytes);
    const e = try f.files.putFile(1, null, "disguised.txt", &r, null);
    testing.allocator.free(e.name);
    if (e.md5) |m| testing.allocator.free(m);

    try testing.expectEqual(@as(i64, 1), try f.count("SELECT indexable FROM note_index;"));
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM note_page_index WHERE kind = 1;"));
    // Searchable as the note it is, not as chunked container bytes.
    const res = try f.search_(1, "genuine");
    try testing.expectEqual(@as(usize, 1), res.hits.len);
    try testing.expectEqual(@as(?i64, null), res.hits[0].kind);
}

test "content linked under a non-.txt name first derives when a .txt name arrives, for every holder" {
    var f = try Fixture.init();
    defer f.deinit();

    const body = "one single paragraph of prose\n";
    _ = try f.put(1, "data.bin", body); // no txt gate: no kind rows
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM note_page_index WHERE kind = 1;"));
    try testing.expectEqual(@as(usize, 0), (try f.search_(1, "prose")).hits.len);

    // The same content under a .txt name: the derivation runs, and
    // `mintPageForHolders` gives the existing holder their segments too —
    // per-blob rows, the `.note` posture (verified content over claimed name).
    _ = try f.put(1, "prose.txt", body);
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM note_page_index WHERE kind = 1;"));
    const res = try f.search_(1, "prose");
    // One owner, one blob ⇒ one segment rowid; the files join fans it out to
    // both names.
    try testing.expectEqual(@as(usize, 2), res.hits.len);
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM segment_search;"));
}

test "v5→v6 HEAL: a pre-existing .txt mints segments on ensure, name looked up from the files row" {
    var f = try Fixture.init();
    defer f.deinit();

    const blob = "healed alpha\n\nhealed beta\n";
    const put = try f.put(1, "legacy.txt", blob);

    // Simulate the pre-upgrade state: a v5 note_index row (indexable = 0)
    // and NO kind=1 rows, exactly what a database indexed before this
    // feature holds. Postings and segment rows go the way a v5 database
    // simply never had them.
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('delete-all');");
    try f.db.exec("DELETE FROM segment_search;");
    try f.db.exec("DELETE FROM note_page_index;");
    try f.db.exec("UPDATE note_index SET index_version = 5;");
    try testing.expectEqual(@as(usize, 0), (try f.search_(1, "healed")).hits.len);

    // The heal, in `controlplane.backfill`'s order: the note half first
    // (re-parses the txt to an unindexable row at v6), then the txt half —
    // handed NO name, so it looks the blob's name up from the files row.
    try noteindex.ensureIndexed(testing.allocator, testing.io, f.db, f.files.blobs, &put.md5, 42);
    try ensureIndexed(testing.allocator, f.db, f.files.blobs, &put.md5, null, 42);

    try testing.expectEqual(@as(i64, 2), try f.count("SELECT COUNT(*) FROM note_page_index WHERE kind = 1;"));
    try testing.expectEqual(@as(i64, 2), try f.count("SELECT COUNT(*) FROM segment_search;"));
    try testing.expectEqual(@as(i64, 2), try f.count("SELECT COUNT(*) FROM segment_fts_docsize;"));
    // Searchable again, kind-tagged. ONE hit for one file — the library-wide
    // read names documents — and the counts just above are what pin that BOTH
    // paragraphs were minted, which is what the heal is actually about.
    const res = try f.search_(1, "healed");
    try testing.expectEqual(@as(usize, 1), res.hits.len);
    try testing.expectEqual(@as(?i64, kind_txt), res.hits[0].kind);

    // Repeated ensures are no-ops: same rows, same rowids, same next_seq.
    const rowid_before = try f.segRowidByText(1, "healed alpha");
    const seq_before = try f.count("SELECT next_seq FROM search_partitions;");
    for (0..3) |_| try ensureIndexed(testing.allocator, f.db, f.files.blobs, &put.md5, "legacy.txt", 43);
    try testing.expectEqual(rowid_before, try f.segRowidByText(1, "healed alpha"));
    try testing.expectEqual(seq_before, try f.count("SELECT next_seq FROM search_partitions;"));
    try testing.expectEqual(@as(i64, 2), try f.count("SELECT COUNT(*) FROM segment_search;"));
}

test "purge and GC: txt segments ride the existing lifecycle untouched" {
    var f = try Fixture.init();
    defer f.deinit();

    const put = try f.put(1, "gone.txt", "ephemeral paragraph\n");
    try testing.expectEqual(@as(usize, 1), (try f.search_(1, "ephemeral")).hits.len);

    try f.files.trash(1, put.id);
    // Trashed: hidden by the join, rows intact (restore must cost nothing).
    try testing.expectEqual(@as(usize, 0), (try f.search_(1, "ephemeral")).hits.len);
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM segment_search;"));

    try f.files.purge(1, put.id);
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM blobs;"));
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM note_page_index;"));
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM segment_search;"));
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM segment_fts_docsize;"));
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "BENCH note: a ~5 MB synthetic .txt ingests in one link (figure printed)" {
    var f = try Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;

    // ~5 MB of ~180-byte paragraphs — the plan's "big file" shape.
    var blob: std.ArrayList(u8) = .empty;
    defer blob.deinit(gpa);
    // ~1 KB paragraphs — a "big file" shape that keeps the row count (and so
    // this debug-build test's runtime) reasonable while still exercising the
    // batched postings insert at scale.
    var k: usize = 0;
    while (blob.items.len < 5 * 1024 * 1024) : (k += 1) {
        try blob.print(
            gpa,
            "Paragraph {d}: a moderately sized run of prose with enough distinct words " ++
                "to make the postings realistic — harvest, ledger, orchard, sextant {d}. ",
            .{ k, k },
        );
        // Pad to ~1 KB, then a blank line to close the paragraph.
        for (0..8) |_| try blob.print(gpa, "filler lorem ipsum dolor sit amet consectetur {d}. ", .{k});
        try blob.appendSlice(gpa, "\n\n");
    }

    const t0 = std.Io.Clock.awake.now(testing.io);
    _ = try f.put(1, "big.txt", blob.items);
    const t1 = std.Io.Clock.awake.now(testing.io);

    const paragraphs = try f.count("SELECT COUNT(*) FROM note_page_index WHERE kind = 1;");
    try testing.expectEqual(paragraphs, @as(i64, @intCast(k)));
    try testing.expectEqual(paragraphs, try f.count("SELECT COUNT(*) FROM segment_fts_docsize;"));
    // `std.log.debug`, NOT `std.debug.print`. Any console output from a test
    // binary makes the Zig build runner print a bogus `failed command:` line
    // against a truncated step name while the build still exits 0 — which has
    // now been misdiagnosed twice as a real failure. Debug level is filtered out
    // at the default `testing.log_level`, so the number is still one
    // `testing.log_level = .debug` away when somebody wants it.
    std.log.debug(
        "[bench] txt first ingest: {d} bytes, {d} paragraphs, {d} ms",
        .{ blob.items.len, paragraphs, t0.durationTo(t1).toMilliseconds() },
    );

    // And it is actually searchable at the expected paragraph granularity.
    // The trailing space keeps "17" an EXACT token (no prefix `*`), so it
    // matches only paragraph 17 — not 170, 171, … — AND "sextant" is in the
    // same paragraph.
    try testing.expectEqual(@as(usize, 1), (try f.search_(1, "sextant 17 ")).hits.len);
}
