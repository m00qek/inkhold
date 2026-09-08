//! The `.txt` derivation: split a text blob into PARAGRAPH segments, which
//! `derive_search.writeDerived` turns into the document's `terms/` and `text/`
//! files. The browser searches those.
//!
//! **It used to write rows too** — one `kind = 1` row per paragraph in
//! `note_page_index`, scoped by `segment_search` and indexed by `segment_fts`,
//! so library search could return `.txt` paragraphs interleaved with note pages.
//! schema v14 deleted all three, so what is left here is the
//! paragraph splitter, the page source over it, and the VERDICT column that
//! tells the deferred worker this blob is done.
//!
//! ## Paragraphs, not fixed chunks (plan decisions 1–2)
//!
//! Segments split on blank lines (one-or-more empty or whitespace-only lines);
//! one segment per paragraph.
//! Two bounded fallbacks keep the row shape sane on hostile shapes:
//!
//!   - a paragraph over `max_segment_bytes` splits hard at the last newline
//!     before the cap (which also makes a no-blank-lines file degrade to
//!     fixed LINE-ALIGNED chunks at the cap);
//!   - one enormous line (no newline inside the cap window) splits at the cap
//!     itself, backed off to a UTF-8 sequence boundary so the seam does not
//!     manufacture replacement characters out of a valid file.
//!
//! A segment's ADDRESS is its BYTE RANGE in the blob, not its ordinal — that is
//! what `txtFind.ts` deep-links to through `byteToCharMap`, and it is what the
//! derived record carries (`Pages` below).
//!
//! ## Encoding + caps (decision 3)
//!
//! UTF-8 assumed (what the txt viewer renders). Invalid sequences are LOSSILY
//! REPLACED (U+FFFD) in the INDEX copy only — the blob is untouched, and the
//! stored byte range still addresses the raw bytes. A recorded fact, never an
//! error: hostile bytes named `.txt` index as mojibake, not as a failure.
//! Files over `max_file_bytes` are SKIPPED WHOLE with a logged warning — no
//! silent truncation — and the skip is memoized (the VERDICT column below) so
//! the log fires once per blob, not once per listing.
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
//! Every blob owns a `note_index` row; that row keeps `indexable = 0` for a
//! `.txt` ("indexable" means "parseable `.note`", and a blob the note parser DID
//! verify is never split into paragraphs, whatever it is called). Freshness
//! rides `note_index.index_version` (bumped 5→6 for this feature): a
//! pre-existing `.txt` becomes derivable once the NOTE half heals its row to the
//! current version on a read, at which point the worker's discovery query offers
//! it — the extension is the gate, and `pending_from_where` reads it in SQL.
//!
//! ## `note_index.txt_index` is the memo
//!
//! A column (schema v11), not "does the blob have rows" — which is what it used
//! to be, until the row write became chunked and "finished" started meaning "the
//! first chunk committed". The rows are gone now and the column is simply the
//! honest place for a verdict that has to distinguish an EMPTY file from an
//! OVER-CAP one, both of which derive to zero segments.
//!
//! There is now exactly ONE writer of it — `deferred.runTxt`, which writes it
//! LAST, after the two derived files. There used to be a second: the listing
//! path's lazy heal (`ensureIndexed`), serialized against the worker by
//! `needsDerive` re-asked under the write lock. It is gone, and the long comment
//! where it stood says why — it wrote the verdict without the files it now
//! stands for.
//!
//! ## Known edges, recorded
//!
//!   - The gate is the file NAME at ingest/heal time. Renaming `b.dat` →
//!     `b.txt` does not re-derive (rename never touches blobs); the content
//!     becomes searchable the next time any link or heal sees it under a
//!     `.txt` name.
//!   - The derivation is per-BLOB: if one user holds the content as `a.dat` and
//!     another uploads it as `b.txt`, both get the derived files. Same posture
//!     as `.note` (verified content over claimed name); the manifest still
//!     scopes who is told about what.
//!   - A future `index_version` bump re-derives wholesale: `needsDerive` asks
//!     the memo on a row at the CURRENT version, so a bumped row is outstanding
//!     again whatever its verdict says.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const derivesearch = @import("derive_search.zig");
const blobstore = @import("../store/blobs.zig");
const blob_source = @import("../store/blob_source.zig");
const noteindex = @import("note_index.zig");
const sn = @import("supernote");

const Allocator = std.mem.Allocator;
const Md5 = std.crypto.hash.Md5;
const log = std.log.scoped(.txt_index);

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
    ///
    /// There used to be a `text_hash` beside it — md5 of this string, the
    /// version-flip's per-paragraph diff key and the row's `content_hash`. Both
    /// consumers were `note_page_index` rows
    /// retired them, so the derive no longer hashes every paragraph.
    text: []const u8,
};

/// Everything the derive produces, owning its own memory (the `Parsed` shape).
pub const Derived = struct {
    arena: std.heap.ArenaAllocator,
    segments: []const Segment,
    /// True when the file exceeded `max_file_bytes` and was skipped whole
    /// (already logged by `derive`). Zero segments either way; the VERDICT is
    /// what stops the re-derive-and-relog loop.
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
        seg.* = .{ .offset = r.offset, .len = r.len, .text = text };
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
///
/// PUBLIC because it is the segment seam's SEARCHABLE-TEXT LENS, not a `.txt`
/// detail: every tenant of `note_page_index.text` passes its bytes through this
/// one function, so what the index holds is UTF-8 by construction whatever
/// produced it. `pdf_text.zig` is the second caller, and it is not a formality —
/// MuPDF's own `fz_runetochar` encodes U+0000 as the OVERLONG `C0 80` and passes
/// unpaired surrogates straight through, so a hostile or merely odd PDF can
/// hand us bytes SQLite would store and FTS5 would tokenize as mojibake.
/// It lives here rather than in a new module because the first tenant defined
/// the rule and there is exactly one copy of it.
pub fn sanitizeUtf8(a: Allocator, bytes: []const u8) ![]const u8 {
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

// ---------------------------------------------------------------------------
// The derived files' page source
// ---------------------------------------------------------------------------

/// A `derive_search.Page` source over a finished `Derived` — the `.txt` half of
/// the one per-format seam search has (`derive_search.writeDerived`).
///
/// Trivial, because the whole document is already in hand; `.pdf`'s equivalent
/// is the one that earns the iterator. What is NOT trivial and belongs here is
/// the ADDRESS: a `.txt` segment is addressed by its byte range into the raw
/// blob, not by its ordinal, because that is what `txtFind.ts` deep-links to
/// through `byteToCharMap`. Every other format leaves those null.
pub const Pages = struct {
    d: Derived,
    i: usize = 0,

    pub fn init(d: Derived) Pages {
        return .{ .d = d };
    }

    pub fn next(self: *Pages) !?derivesearch.Page {
        if (self.i >= self.d.segments.len) return null;
        const seg = self.d.segments[self.i];
        defer self.i += 1;
        return .{
            .ordinal = @intCast(self.i),
            .text = seg.text,
            .offset = seg.offset,
            .len = seg.len,
        };
    }
};

/// The document's ADDRESS SPACE — the `n` on the derived files' header line
/// (`derive_search.writeHeader`), which is a page/paragraph count and not the
/// number of records that follow.
///
/// **Never zero, and the `@max` is why.** A file that produced no paragraphs (an
/// empty one, or the over-cap skip) is still a document, and a zero would say it
/// has no address at all. It used to be the count of `note_page_index` rows the
/// write laid down — a marker row for exactly this case — and the rows went with
/// schema v14; the address space did not.
pub fn rowCount(d: Derived) usize {
    return @max(d.segments.len, 1);
}

// ---------------------------------------------------------------------------
// The gate + lazy heal
// ---------------------------------------------------------------------------

/// `note_index.txt_index` (schema v11). NULL (absent) means never derived.
pub const Verdict = enum(i64) {
    /// The blob's paragraphs are in the index.
    ok = 0,
    /// Over `max_file_bytes` and skipped WHOLE. A RESULT, not a failure, and
    /// recorded rather than inferred: an over-cap file and an empty one both
    /// derive to zero segments, and only this tells them apart afterwards.
    over_cap = 1,
};

/// The verdict a completed derivation earns. One expression of the rule rather
/// than a branch at each call site, and testable without a blob.
pub fn verdictFor(d: Derived) Verdict {
    return if (d.skipped_over_cap) .over_cap else .ok;
}

/// Record the outcome. Call inside the caller's transaction, LAST — the memo
/// must not be true before the segments are.
pub fn storeVerdict(db: sqlite.Db, blob_md5: []const u8, v: Verdict) !void {
    var s = try db.prepare("UPDATE note_index SET txt_index = ?2 WHERE blob_md5 = ?1;");
    defer s.finalize();
    s.bindText(1, blob_md5);
    s.bindInt(2, @intFromEnum(v));
    _ = try s.step();
}

/// THE `.txt` TENANT'S PREDICATE: every `files` row whose blob still owes
/// paragraph segments, as a bare FROM/WHERE with the `files` alias `f`, the
/// `blobs` alias `b` and the `note_index` alias `ni`. Bound parameter 1 is
/// `noteindex.index_version`.
///
/// **A FROM/WHERE and not a statement, deliberately — this is the one copy.**
/// `deferred.zig` selects `LIMIT 1` from it to find the next job; `pending.zig`
/// counts over it to tell a user how much of their library is still being
/// indexed. Those two must never be able to disagree about what is outstanding:
/// a count that says "nothing pending" while the worker is still deriving is
/// worse than no count at all, and a second hand-written copy of these five
/// clauses is exactly how that happens. One clause, several statements built ON
/// it, and callers may only ADD to it (a user scope, a blob scope), never
/// restate it.
///
/// It also answers PER BLOB — `... AND f.md5 = ?` — which is what the per-blob
/// term-set question in the pending-ness work needs, so that
/// distinction is a bound parameter here rather than a fourth copy of the rule.
///
/// The clauses, each load-bearing:
///
/// `LIKE '%_.txt'` IS `wants`, not an approximation: `_` is LIKE's
/// single-character wildcard, so the pattern demands at least one character
/// before the dot — which is exactly the rule that makes a bare `.txt` a
/// leading-dot name with no extension rather than a text file.
///
/// `ni.txt_index IS NULL` mirrors `needsDerive`'s memo exactly. It used to ask
/// about ROWS, and stopped when the write became chunked: `kind = 1` rows
/// existed from the first commit onwards while the document was still half
/// written, so the question called an interrupted write finished for ever.
/// schema v14 deleted the rows, and the column is simply the
/// only place the answer lives now.
///
/// The `note_index` join is the ORDER CONTRACT: the note half heals first
/// (`noteindex.ensureIndexed`, on the read path), so a blob whose row is missing
/// or stale is not offered here at all. It becomes visible on a later pass, once
/// that row is current — which the idle tick guarantees will happen.
///
/// `deleted = 0` and `is_folder = 0` are the `files` VISIBILITY rules, and they
/// live here rather than at the call sites for the same reason the rest does:
/// the bin is not a work queue, and a count scoped to a user must not restate
/// them differently from the worker.
pub const pending_from_where =
    \\  FROM files f
    \\  JOIN blobs b ON b.md5 = f.md5
    \\  JOIN note_index ni ON ni.blob_md5 = f.md5
    \\ WHERE f.is_folder = 0
    \\   AND f.deleted = 0
    \\   AND f.md5 IS NOT NULL
    \\   AND LOWER(f.name) LIKE '%_.txt'
    \\   AND ni.index_version = ?1
    \\   AND ni.indexable = 0
    \\   AND ni.txt_index IS NULL
;

/// Whether this blob still needs a `.txt` derivation. False — the memo — only
/// when a CURRENT `note_index` row exists AND either the note parser verified
/// the bytes (`indexable = 1`: a real `.note` is never chunked, whatever it is
/// called) or a verdict is recorded. A missing/stale row is `true`: the note
/// half heals first and this question is asked again after.
///
/// **The verdict COLUMN, not "does the blob have segment rows".** The write is
/// chunked, so rows exist from the first commit onwards while the document is
/// still half written; the column is set last. Reading rows here would call an
/// interrupted write finished for ever, silently — see the module docs.
///
/// It is also the CONCURRENCY question, and it stays one with a single writer:
/// `deferred.runTxt` derives OFF the lock, so an ingest can heal the same blob
/// in between, and this is what it re-asks under the lock to find out whether
/// the work is still its to do. It used to arbitrate between the worker and the
/// listing path's lazy heal; that second writer is gone.
pub fn needsDerive(db: sqlite.Db, blob_md5: []const u8) !bool {
    var r = (try db.row(
        "SELECT indexable, txt_index IS NOT NULL FROM note_index " ++
            "WHERE blob_md5 = ?1 AND index_version = ?2;",
        &.{ .{ .text = blob_md5 }, .{ .int = noteindex.index_version } },
    )) orelse return true;
    defer r.finalize();
    return r.int(0) == 0 and r.int(1) == 0;
}

// THERE IS NO `ensureIndexed` HERE ANY MORE, AND ITS REMOVAL IS THE POINT.
//
// It was the listing path's lazy heal: `controlplane.summarize` called it once
// per row, it parsed the blob outside the lock (up to `max_file_bytes`) and
// wrote the verdict under it. Two writers of the same document, serialized by
// `needsDerive` re-asked under the write lock — hence the "CONCURRENCY question"
// this file's `needsDerive` still describes, now asked by the worker alone.
//
// **What it cost while it earned its keep.** It used to write the blob's whole
// paragraph index in ONE transaction — 4 min 28 s of held `db_lock` for a
// 15.65 MB `.txt` on the deployment target, the largest single hold on record
// (2026-08-09 §5), with chunking built, measured and
// REVERTED for costing memory.
// §6 step 8 deleted that index and the hold fell to one UPDATE.
//
// **Why one UPDATE was still the wrong write.** After step 8 the verdict no
// longer means "the paragraphs are in `segment_fts`"; it means "`terms/<md5>`
// and `text/<md5>` exist", which this path never wrote. `deferred.runTxt` writes
// the two FILES and *then* the verdict, and says why that order is load-bearing
// (§2.4: the file is the fact). A read that wrote the verdict alone inverted it:
// the blob stopped being offered to the worker, and `pending.owesDerive` — the
// search manifest's `Derivation` byte, whose `derived` means *"cache this,
// empty included"* — reported `derived` for a document with no derived files.
// Not data loss, and that took checking rather than assuming: `manifestDiff.ts`
// deliberately does not consult `derivation`, the stream skips a missing
// fragment under `no-store`, and `reconcileDerived` writes the files on a later
// idle tick. But it was the one direction that column must not lie in, and the
// parse was being paid on a listing to buy it.
//
// **Nothing replaces it, because nothing needs to.** Every blob it could reach
// came from `summarize`, i.e. a LIVE, non-folder `files` row — exactly the set
// `pending_from_where` offers the worker, which finds the `.txt` name in SQL and
// needs no name in hand. `Files.putFile` signals the worker on commit, so the
// usual case does not wait for the 30 s idle tick at all. The bin never called
// it (the bin heals the note half only), and §2.6's version-only hole is
// untouched: this wrote no derived files, so it closed no part of it.
//
// WHAT MOVED, stated rather than discovered: a `.txt` that a listing used to
// beat the worker to left `pending` at the moment of that read. It now stays
// pending until `runTxt` finishes — which is the moment its files land, so the
// count finally means what it says. `pending.Pulse.version`'s known gap closes
// with it: every `.txt` pending→done transition goes through the worker now.

// ---------------------------------------------------------------------------
// Tests — ingest, the derived record, lifecycle
// ---------------------------------------------------------------------------

// WHAT WENT FROM HERE, AND WHERE IT WENT. Until schema v14
// this file wrote a `kind = 1` row per paragraph into a reserved band, and most
// of the tests below were about those rows and that band: the NOT NULL column
// contract, per-owner isolation through `segment_search`, a re-mint that keeps a
// band contiguous through an edit or a mid-file insert, contiguity across a
// chunked write, an ingest between two chunks, a crash that leaves holes, a
// re-run that drops and re-reserves, and two benches sizing the chunk against a
// one-transaction write. Step 8 deleted every one of those subjects.
//
// The property they ultimately protected — *a paragraph is findable, at its
// ordinal, and its byte range replays to exactly the text the viewer scrolls to*
// — did NOT go with them. It moved to the derived TEXT record, and that is what
// the tests below read: `derive_search.writeDerived` over `Pages`, through the
// real deferred tenant, out of a real store.
//
// Per-owner isolation moved too, and further: the derived files are md5-keyed
// and shared by every holder of the content, so who is told about a document is
// the MANIFEST's question now (`search/index_export.zig`, which owns the `files`
// join and tests it).

const testing = std.testing;
const schema = @import("../db/schema.zig");
const thumbstore = @import("../store/thumbs.zig");
const filesvc = @import("files.zig");
const deferredmod = @import("deferred.zig");
const derivedstore = @import("../store/derived.zig");
const nb = @import("note_builder");

/// Asserts every segment's byte range replays to exactly its indexed text —
/// the address contract, checked against the raw blob the ranges point into.
fn expectExactRanges(blob: []const u8, d: Derived) !void {
    for (d.segments) |seg| {
        const off: usize = @intCast(seg.offset);
        try testing.expectEqualStrings(seg.text, blob[off..][0..seg.len]);
    }
}

test "wants: .txt only, case-insensitive, leading-dot and trailing-dot excluded" {
    try testing.expect(wants("notes.txt"));
    try testing.expect(wants("NOTES.TXT"));
    try testing.expect(wants("a.b.txt"));
    try testing.expect(!wants(".txt")); // leading dot: no extension
    try testing.expect(!wants("notes.")); // trailing dot
    try testing.expect(!wants("notes"));
    try testing.expect(!wants("notes.md"));
    try testing.expect(!wants("notes.txt.bak"));
}

test "paragraphs split on blank lines (whitespace-only included), ranges exact" {
    const blob = "First para line one\nline two\n\n   \t \nSecond para\n\n\n\nThird para\n";
    var d = try deriveSlice(testing.allocator, blob);
    defer d.deinit();

    try testing.expectEqual(@as(usize, 3), d.segments.len);
    try expectExactRanges(blob, d);
    try testing.expectEqualStrings("First para line one\nline two", d.segments[0].text);
    try testing.expectEqualStrings("Second para", d.segments[1].text);
    try testing.expectEqualStrings("Third para", d.segments[2].text);
    try testing.expectEqual(@as(u64, 0), d.segments[0].offset);
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
    // No replacement characters were manufactured out of a valid file.
    for (d.segments) |seg| try testing.expect(std.unicode.utf8ValidateSlice(seg.text));
}

test "invalid UTF-8 is lossily replaced in the INDEX copy only; the range still addresses raw bytes" {
    const blob = "good \xff\xfe bytes\n\nsecond\n";
    var d = try deriveSlice(testing.allocator, blob);
    defer d.deinit();

    try testing.expectEqual(@as(usize, 2), d.segments.len);
    try testing.expect(std.unicode.utf8ValidateSlice(d.segments[0].text));
    try testing.expect(std.mem.indexOf(u8, d.segments[0].text, "\u{FFFD}") != null);
    // The RANGE is into the raw blob, so it still names the original bytes.
    const off: usize = @intCast(d.segments[0].offset);
    try testing.expectEqualStrings("good \xff\xfe bytes", blob[off..][0..d.segments[0].len]);
}

test "hostile input: NULs and truncated sequences chunk without panic, text sanitized" {
    const blob = "a\x00b\n\n\xe2\x82\n\nplain\n";
    var d = try deriveSlice(testing.allocator, blob);
    defer d.deinit();
    try testing.expectEqual(@as(usize, 3), d.segments.len);
    for (d.segments) |seg| try testing.expect(std.unicode.utf8ValidateSlice(seg.text));
}

test "empty and whitespace-only files chunk to nothing" {
    for ([_][]const u8{ "", "\n\n\n", "   \t\n  \n" }) |blob| {
        var d = try deriveSlice(testing.allocator, blob);
        defer d.deinit();
        try testing.expectEqual(@as(usize, 0), d.segments.len);
        try testing.expect(!d.skipped_over_cap);
        // Never zero: the document still has an address space.
        try testing.expectEqual(@as(usize, 1), rowCount(d));
    }
}

test "a file over the 16 MiB cap is skipped WHOLE (logged), never silently truncated" {
    const saved = testing.log_level;
    testing.log_level = .err; // the warn is the contract; silence it for the suite
    defer testing.log_level = saved;

    const gpa = testing.allocator;
    const big = try gpa.alloc(u8, max_file_bytes + 1);
    defer gpa.free(big);
    @memset(big, 'x');

    var d = try deriveSlice(gpa, big);
    defer d.deinit();
    try testing.expectEqual(@as(usize, 0), d.segments.len);
    try testing.expect(d.skipped_over_cap);
    // And the verdict tells an empty file apart from a skipped one, which is the
    // whole reason the flag exists.
    try testing.expectEqual(Verdict.over_cap, verdictFor(d));
}

test "the ranged (blob-store) source derives identically to the slice source" {
    const gpa = testing.allocator;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try blobstore.BlobStore.init(testing.io, tmp.dir);

    const blob = "alpha one\n\nbeta two\n\ngamma three\n";
    var r = std.Io.Reader.fixed(blob);
    const put = try store.put(&r, null);

    var a_ = try deriveSlice(gpa, blob);
    defer a_.deinit();
    var b = (try deriveStored(gpa, store, &put.md5)).?;
    defer b.deinit();

    try testing.expectEqual(a_.segments.len, b.segments.len);
    for (a_.segments, b.segments) |x, y| {
        try testing.expectEqual(x.offset, y.offset);
        try testing.expectEqual(x.len, y.len);
        try testing.expectEqualStrings(x.text, y.text);
    }
}

// ---------------------------------------------------------------------------
// The derived record — what a `.txt` actually contributes since §6 step 8
// ---------------------------------------------------------------------------

/// What an upload gives a test: the `files` row's id and the blob's md5 hex.
const Put = struct { id: u64, md5: [32]u8 };

/// One record line of `text/<md5>`: the ordinal, the byte range in the raw blob
/// that the viewer scrolls to, and the unfolded paragraph. These three fields
/// ARE the `.txt` record.
const Record = struct {
    ordinal: i64,
    offset: i64,
    length: i64,
    text: []const u8,
};

/// Every whitespace-separated token of `q` present in `text`, case-insensitively.
fn allTermsIn(text: []const u8, q: []const u8) bool {
    var it = std.mem.tokenizeAny(u8, q, " \t\n");
    var any = false;
    while (it.next()) |t| {
        any = true;
        if (std.ascii.indexOfIgnoreCase(text, t) == null) return false;
    }
    return any;
}

const Fixture = struct {
    db: sqlite.Db,
    files: filesvc.Files,
    terms: derivedstore.DerivedStore,
    text: derivedstore.DerivedStore,
    tmp: testing.TmpDir,
    arena: std.heap.ArenaAllocator,

    fn init() !Fixture {
        const tmp = testing.tmpDir(.{});
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
        const store_ = try blobstore.BlobStore.init(testing.io, tmp.dir);
        const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
        const thumbs = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
        const terms_dir = try tmp.dir.createDirPathOpen(testing.io, "terms", .{});
        const text_dir = try tmp.dir.createDirPathOpen(testing.io, "text", .{});
        const terms = try derivedstore.DerivedStore.init(testing.io, terms_dir);
        const text = try derivedstore.DerivedStore.init(testing.io, text_dir);

        var files = filesvc.Files.init(testing.allocator, testing.io, db, store_, thumbs);
        // The purge path unlinks a reaped blob's derived files through these, so
        // they are wired here rather than only on the worker.
        files.terms = terms;
        files.text = text;
        return .{
            .db = db,
            .files = files,
            .terms = terms,
            .text = text,
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

    /// Puts `bytes` as a file, THEN DRAINS THE DEFERRED WORKER — the real
    /// sequence. `putFile` returns as soon as the bytes and the rows are safe,
    /// and `services/deferred.zig` derives afterwards.
    fn put(f: *Fixture, user_id: u64, name: []const u8, bytes: []const u8) !Put {
        const up = try f.putRaw(user_id, name, bytes);
        f.drain();
        return up;
    }

    /// Upload ONLY — no worker.
    fn putRaw(f: *Fixture, user_id: u64, name: []const u8, bytes: []const u8) !Put {
        var r = std.Io.Reader.fixed(bytes);
        const e = try f.files.putFile(user_id, null, name, &r, null);
        defer testing.allocator.free(e.name);
        defer if (e.md5) |m| testing.allocator.free(m);
        var md5: [32]u8 = undefined;
        @memcpy(&md5, e.md5.?[0..32]);
        return .{ .id = e.id, .md5 = md5 };
    }

    /// The worker with BOTH stores wired, which is what the server runs.
    fn drain(f: *Fixture) void {
        var lock: std.Io.Mutex = .init;
        var w: deferredmod.Worker = .{
            .gpa = testing.allocator,
            .db = f.db,
            .blobs = f.files.blobs,
            .lock = &lock,
            .io = testing.io,
            .terms = f.terms,
            .text = f.text,
        };
        w.drain();
    }

    /// The `text/<md5>` record, parsed. The header line is skipped; `n` is
    /// returned beside the rows because the address space and the row count are
    /// deliberately different numbers.
    fn records(f: *Fixture, md5: []const u8) !struct { n: i64, rows: []const Record } {
        const raw = try derivedstore.readPlain(f.a(), f.text, md5, derivesearch.index_version);
        var lines = std.mem.tokenizeScalar(u8, raw, '\n');
        const head = try std.json.parseFromSlice(std.json.Value, f.a(), lines.next().?, .{});
        var out: std.ArrayList(Record) = .empty;
        while (lines.next()) |line| {
            const v = try std.json.parseFromSlice(std.json.Value, f.a(), line, .{});
            try out.append(f.a(), .{
                .ordinal = v.value.object.get("p").?.integer,
                .offset = v.value.object.get("o").?.integer,
                .length = v.value.object.get("l").?.integer,
                .text = try f.a().dupe(u8, v.value.object.get("t").?.string),
            });
        }
        return .{ .n = head.value.object.get("n").?.integer, .rows = out.items };
    }

    /// The records of `md5` carrying every token of `q`, in ordinal order — the
    /// material the browser's own index answers a find-in-document from.
    fn matching(f: *Fixture, md5: []const u8, q: []const u8) ![]const Record {
        const all = try f.records(md5);
        var out: std.ArrayList(Record) = .empty;
        for (all.rows) |r| if (allTermsIn(r.text, q)) try out.append(f.a(), r);
        return out.items;
    }

    fn count(f: *Fixture, sql: []const u8) !i64 {
        var s = try f.db.prepare(sql);
        defer s.finalize();
        _ = try s.step();
        return s.columnInt(0);
    }
};

test "A .txt DERIVATION IS TWO FILES AND A VERDICT — and no `note_page_index` rows at all" {
    // THE STEP-8 ASSERTION for this tenant. A `.txt` used to contribute one
    // `kind = 1` row per paragraph, a masked rowid per owner and an FTS posting
    // per row, all inside the ingest's transaction. It contributes none of that
    // now: two md5-keyed files written off the lock, and one column.
    var f = try Fixture.init();
    defer f.deinit();

    const put = try f.put(1, "doc.txt", "alpha one\n\nbeta two words\n\ngamma three");

    try testing.expect(f.terms.has(&put.md5, derivesearch.index_version));
    try testing.expect(f.text.has(&put.md5, derivesearch.index_version));
    try testing.expect(!try needsDerive(f.db, &put.md5)); // the memo, written last

    // The `note_index` row stays note-specific: not a parseable `.note`.
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT indexable FROM note_index;"));
    try testing.expectEqual(noteindex.index_version, try f.count("SELECT index_version FROM note_index;"));
    // And NOTHING in the page table. Not a marker, not a paragraph.
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM note_page_index;"));
}

test "FIND-IN-TXT'S MATERIAL: one record per paragraph, its ordinal, and a byte range that replays exactly" {
    var f = try Fixture.init();
    defer f.deinit();

    // Three paragraphs; "target" appears 1/0/2 times across them.
    const blob = "the target sits here\n\nno match in this one\n\ntarget then target again\n";
    const put = try f.put(1, "doc.txt", blob);

    const all = try f.records(&put.md5);
    try testing.expectEqual(@as(i64, 3), all.n);
    try testing.expectEqual(@as(usize, 3), all.rows.len);

    // The find itself is the browser's; what the
    // server owes is the material it answers from, at the right ordinals, with
    // the non-matching middle paragraph absent from the answer.
    const hits = try f.matching(&put.md5, "target");
    try testing.expectEqual(@as(usize, 2), hits.len);
    try testing.expectEqual(@as(i64, 0), hits[0].ordinal);
    try testing.expectEqual(@as(usize, 1), std.mem.count(u8, hits[0].text, "target"));
    try testing.expectEqual(@as(i64, 2), hits[1].ordinal);
    try testing.expectEqual(@as(usize, 2), std.mem.count(u8, hits[1].text, "target"));

    // THE BYTE RANGE IS THE ADDRESS, and it replays to exactly the paragraph the
    // viewer scrolls to — the one field `.txt` needs that `.note` and PDF do not
    // (§1.1), because a paragraph ordinal is not itself an address.
    for (all.rows) |r| {
        const off: usize = @intCast(r.offset);
        const len: usize = @intCast(r.length);
        try testing.expectEqualStrings(r.text, blob[off..][0..len]);
    }
}

test "AND semantics are per-PARAGRAPH: adjacent paragraphs do not co-match, one paragraph does" {
    var f = try Fixture.init();
    defer f.deinit();

    // The deliberate semantic consequence of paragraph segments (plan
    // decision 2), pinned as documented behaviour — and it is a property of the
    // SPLIT, which is why it survives the index that used to express it.
    const split = try f.put(1, "adjacent.txt", "solitary wordalpha here\n\nsolitary wordbeta there\n");
    const one = try f.put(1, "together.txt", "both wordgamma and worddelta in one paragraph\n");

    try testing.expectEqual(@as(usize, 0), (try f.matching(&split.md5, "wordalpha wordbeta")).len);
    try testing.expectEqual(@as(usize, 1), (try f.matching(&one.md5, "wordgamma worddelta")).len);
}

test "THE STORED PARAGRAPH IS UNFOLDED: accents survive into the text record" {
    var f = try Fixture.init();
    defer f.deinit();

    // The fold used to live on the READ, so nothing downstream cared what was
    // stored. It lives in the browser now, over `text/<md5>` — and `docText.ts`
    // states the contract this pins: *"The text is UNFOLDED — accents intact,
    // unlike `terms/`"*. A server that folded on the way IN would hand the viewer
    // `cafe` to mark inside a paragraph that says `café`, and the byte ranges
    // beside it would stop addressing the blob the viewer decoded.
    const put = try f.put(1, "notes.txt", "a linha sobre caf\u{00e9} aqui\n\nplain paragraph\n");

    const rows = try f.matching(&put.md5, "linha");
    try testing.expectEqual(@as(usize, 1), rows.len);
    try testing.expectEqual(@as(i64, 0), rows[0].ordinal);
    try testing.expectEqualStrings("a linha sobre caf\u{00e9} aqui", rows[0].text);
}

test "an EDIT is a new blob, and the new content derives under its own md5" {
    // A `.txt` version flip used to re-mint the owner's whole paragraph band so
    // `rowid ASC` stayed ordinal order through an edit or a mid-file insert. The
    // derived files are content-addressed, so a new version is simply a different
    // md5 with its own pair — there is no ordering to preserve and nothing
    // per-owner to re-point.
    var f = try Fixture.init();
    defer f.deinit();

    const v1 = try f.put(1, "doc.txt", "alpha one\n\nbeta two\n");
    const v2 = try f.put(1, "doc.txt", "alpha one\n\nBETA EDITED\n\ngamma three\n");
    try testing.expect(!std.mem.eql(u8, &v1.md5, &v2.md5));

    const rows = (try f.records(&v2.md5)).rows;
    try testing.expectEqual(@as(usize, 3), rows.len);
    try testing.expectEqualStrings("BETA EDITED", rows[1].text);
    try testing.expectEqualStrings("gamma three", rows[2].text);
    try testing.expectEqual(@as(usize, 1), (try f.matching(&v2.md5, "EDITED")).len);
}

test "an empty .txt records its verdict: no records, no re-derive" {
    var f = try Fixture.init();
    defer f.deinit();

    const put = try f.put(1, "empty.txt", "");
    try testing.expect(!try needsDerive(f.db, &put.md5)); // the memo

    // Header-only files, and the header still claims an address space of 1: a
    // document with no paragraphs is a document, not an absence.
    const all = try f.records(&put.md5);
    try testing.expectEqual(@as(i64, 1), all.n);
    try testing.expectEqual(@as(usize, 0), all.rows.len);
}

test "a real .note named .txt is never split: the parser's verdict wins over the extension" {
    var f = try Fixture.init();
    defer f.deinit();

    const note_bytes = try nb.serialize(testing.allocator, .{ .pages = &.{.{
        .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }},
        .recogn_status = 1,
        .recogn_labels = &.{"genuine ink"},
    }} });
    defer testing.allocator.free(note_bytes);
    const put = try f.put(1, "disguised.txt", note_bytes);

    try testing.expectEqual(@as(i64, 1), try f.count("SELECT indexable FROM note_index;"));
    try testing.expect(!try needsDerive(f.db, &put.md5)); // `indexable = 1` is the whole answer
    // Its rows are the NOTE's — `kind = 0`, page geometry — and never paragraphs.
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM note_page_index WHERE kind = 0;"));
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM note_page_index WHERE kind <> 0;"));

    // Derived as the note it is, not as chunked container bytes.
    const raw = try derivedstore.readPlain(f.a(), f.text, &put.md5, derivesearch.index_version);
    try testing.expect(std.mem.indexOf(u8, raw, "genuine ink") != null);
}

test "content linked under a non-.txt name derives when a .txt name arrives" {
    var f = try Fixture.init();
    defer f.deinit();

    const body = "one single paragraph of prose\n";
    const bin = try f.put(1, "data.bin", body); // no txt gate: not offered
    try testing.expect(try needsDerive(f.db, &bin.md5));
    try testing.expect(!f.text.has(&bin.md5, derivesearch.index_version));

    // The same content under a `.txt` name: the derivation runs, per BLOB — the
    // `.note` posture (verified content over claimed name), so the `.bin`
    // holder's file becomes searchable too, off the very same pair of files.
    const txt = try f.put(1, "prose.txt", body);
    try testing.expectEqualStrings(&bin.md5, &txt.md5); // content addressing: one blob
    try testing.expect(!try needsDerive(f.db, &txt.md5));
    try testing.expectEqual(@as(usize, 1), (try f.matching(&txt.md5, "prose")).len);
}

test "v5→v6 HEAL: a stale .txt is not offered, and the note half's heal is what makes it derivable" {
    // THE ORDER CONTRACT, now that the `.txt` half of the lazy heal is gone. It
    // used to be this file's `ensureIndexed` that recorded the verdict on the
    // first listing view; the property that outlived it belongs to
    // `pending_from_where`: a blob at a stale `index_version` is invisible to the
    // worker, the NOTE half heals it on a read, and the worker takes it from
    // there — files first, verdict last.
    var f = try Fixture.init();
    defer f.deinit();

    const put = try f.put(1, "legacy.txt", "healed alpha\n\nhealed beta\n");

    // Simulate the pre-upgrade state: a v5 `note_index` row, no verdict and no
    // derived files, exactly what a database indexed before this feature holds.
    try f.db.exec("UPDATE note_index SET index_version = 5, txt_index = NULL;");
    f.terms.remove(&put.md5, derivesearch.index_version);
    f.text.remove(&put.md5, derivesearch.index_version);

    // NOT OFFERED while the row is stale — the join in `pending_from_where`.
    try testing.expect(try needsDerive(f.db, &put.md5));
    try testing.expect(try noOfferedTxt(&f));

    // The note half heals on the read path (`controlplane.backfill`), re-parsing
    // the txt to an unindexable row at the current version...
    try noteindex.ensureIndexed(testing.allocator, testing.io, f.db, f.files.blobs, &put.md5, 42);
    try testing.expect(try needsDerive(f.db, &put.md5));
    try testing.expect(!try noOfferedTxt(&f)); // ...and now it IS offered.

    // The worker does the rest, and does it in the order §2.4 requires.
    f.drain();
    try testing.expect(!try needsDerive(f.db, &put.md5));
    try testing.expect(f.terms.has(&put.md5, derivesearch.index_version));
    try testing.expect(f.text.has(&put.md5, derivesearch.index_version));
    try testing.expectEqual(@as(usize, 1), (try f.matching(&put.md5, "alpha")).len);
}

/// True when the `.txt` tenant's discovery query has nothing to offer.
fn noOfferedTxt(f: *Fixture) !bool {
    const found = try deferredmod.nextJob(testing.allocator, f.db) orelse return true;
    defer testing.allocator.free(found.name);
    return !std.mem.eql(u8, found.tenant.name, "txt");
}

test "purge and GC: a purged .txt takes its derived files with it" {
    var f = try Fixture.init();
    defer f.deinit();

    const put = try f.put(1, "gone.txt", "ephemeral paragraph\n");
    try testing.expect(f.terms.has(&put.md5, derivesearch.index_version));
    try testing.expect(f.text.has(&put.md5, derivesearch.index_version));

    // Trashed: the bin HOLDS the reference, so restore must cost nothing.
    try f.files.trash(1, put.id);
    try testing.expect(f.text.has(&put.md5, derivesearch.index_version));

    // Purged: the blob is reaped and its md5-keyed derivations go with it
    // (— purge rides the blob GC).
    try f.files.purge(1, put.id);
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM blobs;"));
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM note_page_index;"));
    try testing.expect(!f.terms.has(&put.md5, derivesearch.index_version));
    try testing.expect(!f.text.has(&put.md5, derivesearch.index_version));
}
