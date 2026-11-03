//! The `.txt` derivation: splits a text blob into paragraph segments for
//! `derive_search.writeDerived`, and owns the `note_index.txt_index` verdict.
//! Segments split on blank lines (`\r` counts as whitespace; a trailing `\r` is
//! trimmed like the `\n`). Over-long paragraphs split at the last newline before
//! the cap, and a single over-long line at the cap backed off to a UTF-8 boundary.
//! A segment is addressed by its byte range in the raw blob.
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

/// Paragraph cap: keeps snippets coherent and bounds what one edit re-derives.
pub const max_segment_bytes: usize = 8 * 1024;

/// Per-file cap (matches the ingest source cap): a larger file is skipped whole
/// and logged, never truncated to a prefix.
pub const max_file_bytes: u64 = 16 * 1024 * 1024;

/// Case-insensitive; a leading-dot name (`.txt`) has no extension, nor does a
/// trailing dot.
pub fn wants(name: []const u8) bool {
    const dot = std.mem.lastIndexOfScalar(u8, name, '.') orelse return false;
    if (dot == 0 or dot + 1 == name.len) return false;
    return std.ascii.eqlIgnoreCase(name[dot + 1 ..], "txt");
}

// ---------------------------------------------------------------------------
// Derive: pure over the source, called outside the DB lock.
// ---------------------------------------------------------------------------

pub const Segment = struct {
    /// Byte range in the blob (raw bytes), excluding the line terminator and a
    /// `\r` before it. What the viewer's deep link addresses.
    offset: u64,
    len: u32,
    /// The index copy: the ranged bytes, lossily UTF-8-sanitized.
    text: []const u8,
};

pub const Derived = struct {
    arena: std.heap.ArenaAllocator,
    segments: []const Segment,
    /// Skipped whole over `max_file_bytes` (already logged).
    skipped_over_cap: bool = false,

    pub fn deinit(self: *Derived) void {
        self.arena.deinit();
    }
};

const SegRange = struct { offset: u64, len: u32 };

/// Phase 1 of `derive`: O(1) state; segment text is read back by range later.
const Scan = struct {
    line_start: u64 = 0,
    /// No byte other than space/tab/`\r` seen on the current line yet.
    line_blank: bool = true,
    /// Consulted at `\n` and EOF to trim the CR of a CRLF.
    prev_cr: bool = false,
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

    fn line(self: *Scan, gpa: Allocator, src: sn.Source, out: *std.ArrayList(SegRange), content_end: u64) !void {
        if (self.line_blank) {
            // Blank lines close the paragraph and belong to no segment.
            try self.flush(gpa, out);
            return;
        }
        if (!self.in_para) {
            self.in_para = true;
            self.para_start = self.line_start;
        } else if (content_end - self.para_start > max_segment_bytes) {
            // Adding this line would exceed the cap: split at the last newline.
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

    /// EOF: trims a bare trailing `\r` and closes the open paragraph.
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

/// The largest cut `<= want` not on a UTF-8 continuation byte, probing at most
/// 4 bytes; hostile runs of continuation bytes cut at `want`.
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

/// Splits `src` into paragraph segments with ranged reads throughout, so a
/// multi-MB file is never buffered whole.
pub fn derive(gpa: Allocator, src: sn.Source) !Derived {
    var arena = std.heap.ArenaAllocator.init(gpa);
    errdefer arena.deinit();
    const a = arena.allocator();

    const total = src.size();
    if (total > max_file_bytes) {
        log.warn("skipping .txt indexing: {d}-byte blob exceeds the {d} MiB cap", .{
            total, max_file_bytes / (1024 * 1024),
        });
        return .{ .arena = arena, .segments = &.{}, .skipped_over_cap = true };
    }

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

    // Phase 2: ranged read per segment, then the lossy sanitize (index copy only).
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

/// `bytes` copied verbatim if valid UTF-8, else with each invalid byte replaced
/// by U+FFFD. Shared by every search tenant; for PDFs it matters because
/// MuPDF's `fz_runetochar` emits overlong `C0 80` for U+0000 and passes unpaired
/// surrogates through.
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

/// A `derive_search.Page` source over a finished `Derived`. A `.txt` segment
/// carries its byte range, because a paragraph ordinal is not an address the
/// viewer can scroll to; other formats leave it null.
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

/// The document's address space, the `n` on the derived header line. Never
/// zero: an empty or over-cap file is still a document.
pub fn rowCount(d: Derived) usize {
    return @max(d.segments.len, 1);
}

// ---------------------------------------------------------------------------
// The verdict and the discovery predicate
// ---------------------------------------------------------------------------

/// `note_index.txt_index`. NULL means never derived.
pub const Verdict = enum(i64) {
    ok = 0,
    /// Recorded because an over-cap file and an empty one both derive to zero
    /// segments.
    over_cap = 1,
};

pub fn verdictFor(d: Derived) Verdict {
    return if (d.skipped_over_cap) .over_cap else .ok;
}

/// Call inside the caller's transaction, last: the memo must not be true before
/// the derived output is.
pub fn storeVerdict(db: sqlite.Db, blob_md5: []const u8, v: Verdict) !void {
    var s = try db.prepare("UPDATE note_index SET txt_index = ?2 WHERE blob_md5 = ?1;");
    defer s.finalize();
    s.bindText(1, blob_md5);
    s.bindInt(2, @intFromEnum(v));
    _ = try s.step();
}

/// The `.txt` tenant's predicate as a bare FROM/WHERE (aliases `f`, `b`, `ni`;
/// `?1` is `noteindex.index_version`). The single copy: `deferred.zig` takes
/// `LIMIT 1` from it and `pending.zig` counts over it, and they must never
/// disagree; callers may only add bounds. `LIKE '%_.txt'` is `wants`. A missing
/// or stale `note_index` row is not offered: the note half heals first.
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

/// Whether this blob still needs a `.txt` derivation: true for a missing or
/// stale row, false once the note parser verified the bytes (`indexable = 1`)
/// or a verdict is recorded. `deferred.runTxt` derives off the lock and re-asks
/// this under it.
pub fn needsDerive(db: sqlite.Db, blob_md5: []const u8) !bool {
    var r = (try db.row(
        "SELECT indexable, txt_index IS NOT NULL FROM note_index " ++
            "WHERE blob_md5 = ?1 AND index_version = ?2;",
        &.{ .{ .text = blob_md5 }, .{ .int = noteindex.index_version } },
    )) orelse return true;
    defer r.finalize();
    return r.int(0) == 0 and r.int(1) == 0;
}

// ---------------------------------------------------------------------------
// Tests: ingest, the derived record, lifecycle
// ---------------------------------------------------------------------------

const testing = std.testing;
const schema = @import("../db/schema.zig");
const thumbstore = @import("../store/thumbs.zig");
const filesvc = @import("files.zig");
const deferredmod = @import("deferred.zig");
const derivedstore = @import("../store/derived.zig");
const nb = @import("note_builder");

/// Every segment's byte range replays to exactly its indexed text.
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

    // The first chunk ends at the newline it split on; the second starts after.
    const first = d.segments[0];
    try testing.expect(first.len <= max_segment_bytes);
    try testing.expectEqual(@as(u8, '\n'), blob.items[@intCast(first.offset + first.len)]);
    try testing.expectEqual(first.offset + first.len + 1, d.segments[1].offset);
    try testing.expectEqual(@as(u64, blob.items.len), d.segments[1].offset + d.segments[1].len);
}

test "one enormous line falls back to cap-sized cuts on UTF-8 boundaries" {
    const gpa = testing.allocator;
    // 'a' + 5000x'é': the even cap lands mid-sequence and must back off.
    var blob: std.ArrayList(u8) = .empty;
    defer blob.deinit(gpa);
    try blob.append(gpa, 'a');
    for (0..5000) |_| try blob.appendSlice(gpa, "é");

    var d = try deriveSlice(gpa, blob.items);
    defer d.deinit();
    try testing.expectEqual(@as(usize, 2), d.segments.len);
    try expectExactRanges(blob.items, d);
    for (d.segments) |seg| try testing.expect(std.unicode.utf8ValidateSlice(seg.text));
}

test "invalid UTF-8 is lossily replaced in the INDEX copy only; the range still addresses raw bytes" {
    const blob = "good \xff\xfe bytes\n\nsecond\n";
    var d = try deriveSlice(testing.allocator, blob);
    defer d.deinit();

    try testing.expectEqual(@as(usize, 2), d.segments.len);
    try testing.expect(std.unicode.utf8ValidateSlice(d.segments[0].text));
    try testing.expect(std.mem.indexOf(u8, d.segments[0].text, "\u{FFFD}") != null);
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
// The derived record
// ---------------------------------------------------------------------------

const Put = struct { id: u64, md5: [32]u8 };

/// One `text/<md5>` record line.
const Record = struct {
    ordinal: i64,
    offset: i64,
    length: i64,
    text: []const u8,
};

fn allTermsIn(text: []const u8, q: []const u8) bool {
    var it = std.mem.tokenizeAny(u8, q, " \t\n");
    var any = false;
    while (it.next()) |t| {
        any = true;
        if (std.ascii.findIgnoreCase(text, t) == null) return false;
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
        // The purge path unlinks a reaped blob's derived files through these.
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

    /// Upload, then drain the deferred worker: the real sequence.
    fn put(f: *Fixture, user_id: u64, name: []const u8, bytes: []const u8) !Put {
        const up = try f.putRaw(user_id, name, bytes);
        f.drain();
        return up;
    }

    fn putRaw(f: *Fixture, user_id: u64, name: []const u8, bytes: []const u8) !Put {
        var r = std.Io.Reader.fixed(bytes);
        const e = try f.files.putFile(user_id, null, name, &r, null);
        defer testing.allocator.free(e.name);
        defer if (e.md5) |m| testing.allocator.free(m);
        var md5: [32]u8 = undefined;
        @memcpy(&md5, e.md5.?[0..32]);
        return .{ .id = e.id, .md5 = md5 };
    }

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

    /// The `text/<md5>` record, parsed. `n` (address space) and the row count
    /// are deliberately different numbers.
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

    /// Records of `md5` carrying every token of `q`, in ordinal order.
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
    var f = try Fixture.init();
    defer f.deinit();

    const put = try f.put(1, "doc.txt", "alpha one\n\nbeta two words\n\ngamma three");

    try testing.expect(f.terms.has(&put.md5, derivesearch.index_version));
    try testing.expect(f.text.has(&put.md5, derivesearch.index_version));
    try testing.expect(!try needsDerive(f.db, &put.md5)); // the memo, written last

    try testing.expectEqual(@as(i64, 0), try f.count("SELECT indexable FROM note_index;"));
    try testing.expectEqual(noteindex.index_version, try f.count("SELECT index_version FROM note_index;"));
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM note_page_index;"));
}

test "FIND-IN-TXT'S MATERIAL: one record per paragraph, its ordinal, and a byte range that replays exactly" {
    var f = try Fixture.init();
    defer f.deinit();

    const blob = "the target sits here\n\nno match in this one\n\ntarget then target again\n";
    const put = try f.put(1, "doc.txt", blob);

    const all = try f.records(&put.md5);
    try testing.expectEqual(@as(i64, 3), all.n);
    try testing.expectEqual(@as(usize, 3), all.rows.len);

    const hits = try f.matching(&put.md5, "target");
    try testing.expectEqual(@as(usize, 2), hits.len);
    try testing.expectEqual(@as(i64, 0), hits[0].ordinal);
    try testing.expectEqual(@as(usize, 1), std.mem.count(u8, hits[0].text, "target"));
    try testing.expectEqual(@as(i64, 2), hits[1].ordinal);
    try testing.expectEqual(@as(usize, 2), std.mem.count(u8, hits[1].text, "target"));

    for (all.rows) |r| {
        const off: usize = @intCast(r.offset);
        const len: usize = @intCast(r.length);
        try testing.expectEqualStrings(r.text, blob[off..][0..len]);
    }
}

test "AND semantics are per-PARAGRAPH: adjacent paragraphs do not co-match, one paragraph does" {
    var f = try Fixture.init();
    defer f.deinit();

    const split = try f.put(1, "adjacent.txt", "solitary wordalpha here\n\nsolitary wordbeta there\n");
    const one = try f.put(1, "together.txt", "both wordgamma and worddelta in one paragraph\n");

    try testing.expectEqual(@as(usize, 0), (try f.matching(&split.md5, "wordalpha wordbeta")).len);
    try testing.expectEqual(@as(usize, 1), (try f.matching(&one.md5, "wordgamma worddelta")).len);
}

test "THE STORED PARAGRAPH IS UNFOLDED: accents survive into the text record" {
    var f = try Fixture.init();
    defer f.deinit();

    // `text/` is unfolded (accents intact, unlike `terms/`); folding on the way
    // in would break both the viewer's marks and the byte ranges.
    const put = try f.put(1, "notes.txt", "a linha sobre caf\u{00e9} aqui\n\nplain paragraph\n");

    const rows = try f.matching(&put.md5, "linha");
    try testing.expectEqual(@as(usize, 1), rows.len);
    try testing.expectEqual(@as(i64, 0), rows[0].ordinal);
    try testing.expectEqualStrings("a linha sobre caf\u{00e9} aqui", rows[0].text);
}

test "an EDIT is a new blob, and the new content derives under its own md5" {
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
    try testing.expectEqual(@as(i64, 1), try f.count("SELECT COUNT(*) FROM note_page_index WHERE kind = 0;"));
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM note_page_index WHERE kind <> 0;"));

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

    // Same content under a `.txt` name derives per blob, for both holders.
    const txt = try f.put(1, "prose.txt", body);
    try testing.expectEqualStrings(&bin.md5, &txt.md5); // content addressing: one blob
    try testing.expect(!try needsDerive(f.db, &txt.md5));
    try testing.expectEqual(@as(usize, 1), (try f.matching(&txt.md5, "prose")).len);
}

test "v5→v6 HEAL: a stale .txt is not offered, and the note half's heal is what makes it derivable" {
    var f = try Fixture.init();
    defer f.deinit();

    const put = try f.put(1, "legacy.txt", "healed alpha\n\nhealed beta\n");

    // A pre-upgrade v5 row: no verdict, no derived files.
    try f.db.exec("UPDATE note_index SET index_version = 5, txt_index = NULL;");
    f.terms.remove(&put.md5, derivesearch.index_version);
    f.text.remove(&put.md5, derivesearch.index_version);

    try testing.expect(try needsDerive(f.db, &put.md5));
    try testing.expect(try noOfferedTxt(&f));

    try noteindex.ensureIndexed(testing.allocator, testing.io, f.db, f.files.blobs, &put.md5, 42);
    try testing.expect(try needsDerive(f.db, &put.md5));
    try testing.expect(!try noOfferedTxt(&f)); // ...and now it IS offered.

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

    // The bin holds the reference, so restore must cost nothing.
    try f.files.trash(1, put.id);
    try testing.expect(f.text.has(&put.md5, derivesearch.index_version));

    try f.files.purge(1, put.id);
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM blobs;"));
    try testing.expectEqual(@as(i64, 0), try f.count("SELECT COUNT(*) FROM note_page_index;"));
    try testing.expect(!f.terms.has(&put.md5, derivesearch.index_version));
    try testing.expect(!f.text.has(&put.md5, derivesearch.index_version));
}
