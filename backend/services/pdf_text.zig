//! The `.pdf` text pass: extracts pages in bounded chunks and hands them to
//! `derive_search.writeDerived`. A document past `max_pages` is indexed to the
//! cap and recorded as truncated; one with no text anywhere is a scan verdict.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const blobstore = @import("../store/blobs.zig");
const derivesearch = @import("derive_search.zig");
const noteindex = @import("note_index.zig");
const pdfindex = @import("pdf_index.zig");
const pdftext = @import("../pdf/text.zig");
const txtindex = @import("txt_index.zig");
const sanitizeUtf8 = txtindex.sanitizeUtf8;

const Allocator = std.mem.Allocator;
const log = std.log.scoped(.pdf_text);

/// Pages indexed at most, per document; a bound on one job (~8 min of niced CPU
/// on the Pi at ~0.10 s/page), not a policy.
pub const max_pages: u32 = 5_000;

/// One `Chunk`: ~50 pages or ~40 KB of text, whichever first (~2 MB for the
/// harshest document on record). Both bounds were measured together; text
/// volume matters as much as page count.
pub const chunk_pages: u32 = 50;
pub const chunk_bytes: usize = 40 * 1024;

/// `note_index.pdf_text`. NULL (absent) means never extracted.
pub const Verdict = enum(i64) {
    ok = 0,
    /// Opened, and yielded no text on any page: a scan.
    no_text = 1,
    /// Derived the first `max_pages`; the rest are not in the record.
    truncated = 2,
    /// The text pass could not open a file the probe could.
    unopenable = 3,

    /// Null when the failure is ours (`NoContext`), not the file's.
    pub fn of(e: pdftext.Error) ?Verdict {
        return switch (e) {
            pdftext.Error.NoContext => null,
            // The probe already said this file is readable; retrying won't help.
            pdftext.Error.Unopenable, pdftext.Error.Encrypted, pdftext.Error.NoPages => .unopenable,
        };
    }
};

/// Shared with the probe so the two halves of the tenant agree.
pub const wants = pdfindex.wants;

/// Whether this blob still needs its text extracted. False once any verdict is
/// recorded, and false until the probe has said `ok`.
pub fn needsText(db: sqlite.Db, blob_md5: []const u8) !bool {
    var r = (try db.row(
        "SELECT pdf_probe, pdf_text FROM note_index " ++
            "WHERE blob_md5 = ?1 AND index_version = ?2 AND indexable = 0;",
        &.{ .{ .text = blob_md5 }, .{ .int = noteindex.index_version } },
    )) orelse return false; // no current row: the note half heals first
    defer r.finalize();
    return r.intOpt(0) == @as(?i64, @intFromEnum(pdfindex.Verdict.ok)) and r.intOpt(1) == null;
}

/// Call inside the caller's transaction, last: the memo must not be true before
/// the derived output is.
pub fn storeVerdict(db: sqlite.Db, blob_md5: []const u8, v: Verdict) !void {
    var s = try db.prepare("UPDATE note_index SET pdf_text = ?2 WHERE blob_md5 = ?1;");
    defer s.finalize();
    s.bindText(1, blob_md5);
    s.bindInt(2, @intFromEnum(v));
    _ = try s.step();
}

// ---------------------------------------------------------------------------
// One chunk of pages, the unit of both extraction and commit
// ---------------------------------------------------------------------------

pub const Page = struct {
    /// 0-based PDF page number: the record's ordinal and the deep link.
    index: u32,
    /// Empty for a page with no text.
    text: []const u8,
};

/// A run of consecutive pages `[from, from + pages.len)`, never empty, owning
/// its memory.
pub const Chunk = struct {
    arena: std.heap.ArenaAllocator,
    from: u32,
    pages: []const Page,

    pub fn deinit(self: *Chunk) void {
        self.arena.deinit();
    }

    pub fn to(self: Chunk) u32 {
        return self.from + @as(u32, @intCast(self.pages.len));
    }
};

/// The next chunk from `from`, or null past the end. Always takes at least one
/// page, so a page bigger than the byte cap cannot stall the loop. Call off the
/// DB lock: this is the expensive half.
pub fn nextChunk(gpa: Allocator, ex: *pdftext.Extractor, from: u32) !?Chunk {
    const total = @min(ex.pages, max_pages);
    if (from >= total) return null;

    var arena = std.heap.ArenaAllocator.init(gpa);
    errdefer arena.deinit();
    const a = arena.allocator();

    var pages: std.ArrayList(Page) = .empty;
    var bytes: usize = 0;
    var n: u32 = from;
    while (n < total and pages.items.len < chunk_pages) : (n += 1) {
        // An unrenderable page is empty, so `index` stays the real page number.
        const raw = (try ex.page(n)) orelse "";
        const text = try stripPrivateUse(a, try sanitizeUtf8(a, raw));
        try pages.append(a, .{ .index = n, .text = text });
        bytes += text.len;
        if (bytes >= chunk_bytes) break;
    }
    return .{ .arena = arena, .from = from, .pages = try pages.toOwnedSlice(a) };
}

/// Replaces every Private Use Area codepoint with a space. Icon fonts map glyphs
/// into the PUA, and `unicode61` treats PUA as a token character, so
/// `alpha<U+E906>beta` would index as one token matching neither word; deleting
/// instead would fuse the neighbours. PDF-only: a `.txt` file's PUA is the
/// user's content. Input must already be valid UTF-8.
fn stripPrivateUse(a: Allocator, text: []const u8) ![]const u8 {
    if (!hasPrivateUse(text)) return a.dupe(u8, text); // the overwhelming majority
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < text.len) {
        const l = std.unicode.utf8ByteSequenceLength(text[i]) catch {
            try out.append(a, text[i]);
            i += 1;
            continue;
        };
        if (i + l > text.len) {
            try out.appendSlice(a, text[i..]);
            break;
        }
        const cp = std.unicode.utf8Decode(text[i..][0..l]) catch {
            try out.appendSlice(a, text[i..][0..l]);
            i += l;
            continue;
        };
        if (isPrivateUse(cp)) try out.append(a, ' ') else try out.appendSlice(a, text[i..][0..l]);
        i += l;
    }
    // Owned slice: freeing `out.items` by length would trip the debug allocator.
    return out.toOwnedSlice(a);
}

/// Allocation-free check, so the common case copies once.
fn hasPrivateUse(text: []const u8) bool {
    var i: usize = 0;
    while (i < text.len) {
        const l = std.unicode.utf8ByteSequenceLength(text[i]) catch {
            i += 1;
            continue;
        };
        if (i + l > text.len) return false;
        const cp = std.unicode.utf8Decode(text[i..][0..l]) catch {
            i += l;
            continue;
        };
        if (isPrivateUse(cp)) return true;
        i += l;
    }
    return false;
}

fn isPrivateUse(cp: u21) bool {
    return (cp >= 0xE000 and cp <= 0xF8FF) or
        (cp >= 0xF0000 and cp <= 0xFFFFD) or
        (cp >= 0x100000 and cp <= 0x10FFFD);
}

/// A `derive_search.Page` source over a live `Extractor`, a `Chunk` at a time so
/// a book is never held whole. A page's text dies with its chunk on the next
/// `next` call past it; safe only because `writeDerived` consumes each `Page`
/// fully before pulling again. Pages with no text are skipped.
pub const Pages = struct {
    gpa: Allocator,
    ex: *pdftext.Extractor,
    /// Null before the first pull and after the last; `deinit` releases it.
    chunk: ?Chunk = null,
    at: usize = 0,
    /// `nextChunk` alone knows where the document ends.
    from: u32 = 0,
    /// After exhaustion, false means no page had text: a scan.
    any_text: bool = false,

    pub fn init(gpa: Allocator, ex: *pdftext.Extractor) Pages {
        return .{ .gpa = gpa, .ex = ex };
    }

    /// Releases the chunk in flight; only needed on the error path.
    pub fn deinit(self: *Pages) void {
        if (self.chunk) |*c| c.deinit();
        self.chunk = null;
    }

    pub fn next(self: *Pages) !?derivesearch.Page {
        while (true) {
            if (self.chunk) |*c| {
                while (self.at < c.pages.len) {
                    const p = c.pages[self.at];
                    self.at += 1;
                    if (p.text.len == 0) continue; // scanned or image-only
                    self.any_text = true;
                    // A PDF page has no byte range; the page number is the address.
                    return .{ .ordinal = p.index, .text = p.text };
                }
                c.deinit();
                self.chunk = null;
            }
            const c = (try nextChunk(self.gpa, self.ex, self.from)) orelse return null;
            self.from = c.to();
            self.chunk = c;
            self.at = 0;
        }
    }
};

// ---------------------------------------------------------------------------
// Write, inside the caller's transaction
// ---------------------------------------------------------------------------

/// Records the verdict last, so "this PDF's text is derived" is true only when
/// it is.
pub fn finish(
    db: sqlite.Db,
    blob_md5: []const u8,
    page_count: u32,
    v: Verdict,
) !void {
    // Never a silent truncation; logged once, since the verdict stops re-offers.
    if (v == .truncated) {
        log.warn("derived the first {d} pages of {s}; the rest of the document is not searchable", .{ page_count, blob_md5 });
    }
    try storeVerdict(db, blob_md5, v);
}

pub fn verdictFor(doc_pages: u32, indexed_pages: u32, any_text: bool) Verdict {
    if (!any_text) return .no_text;
    return if (indexed_pages < doc_pages) .truncated else .ok;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;
const schema = @import("../db/schema.zig");

test "a PUA glyph becomes a SPACE, so the word it touched stays findable" {
    const a = testing.allocator;

    const glued = try stripPrivateUse(a, "alpha\u{E906}beta");
    defer a.free(glued);
    try testing.expectEqualStrings("alpha beta", glued);

    const all = try stripPrivateUse(a, "a\u{E000}b\u{F8FF}c\u{F0000}d\u{10FFFD}e");
    defer a.free(all);
    try testing.expectEqualStrings("a b c d e", all);

    // U+DFFF is a surrogate, so U+F900 and U+FFFD stand for "just past".
    const edges = try stripPrivateUse(a, "\u{F900}\u{FFFD}\u{EFFFF}");
    defer a.free(edges);
    try testing.expectEqualStrings("\u{F900}\u{FFFD}\u{EFFFF}", edges);

    const clean = try stripPrivateUse(a, "reunião — a normal page, 2026");
    defer a.free(clean);
    try testing.expectEqualStrings("reunião — a normal page, 2026", clean);
}

test "the PUA filter runs on the derive path, not just in isolation" {
    // Order matters: `stripPrivateUse` assumes valid UTF-8.
    const a = testing.allocator;
    const sanitized = try sanitizeUtf8(a, "x\u{E906}y");
    defer a.free(sanitized);
    const stripped = try stripPrivateUse(a, sanitized);
    defer a.free(stripped);
    try testing.expectEqualStrings("x y", stripped);
}

test "wants is the probe's extension rule, so the two halves cannot disagree" {
    try testing.expect(wants("book.pdf"));
    try testing.expect(!wants("book.pdf.mark")); // the mark, not the document
    try testing.expect(!wants(".pdf"));
}

test "NoContext is not a verdict — a transient failure must not write off a good file" {
    try testing.expectEqual(@as(?Verdict, null), Verdict.of(pdftext.Error.NoContext));
    try testing.expectEqual(@as(?Verdict, .unopenable), Verdict.of(pdftext.Error.Unopenable));
    try testing.expectEqual(@as(?Verdict, .unopenable), Verdict.of(pdftext.Error.Encrypted));
    try testing.expectEqual(@as(?Verdict, .unopenable), Verdict.of(pdftext.Error.NoPages));
}

test "verdictFor: a truncated document is SAID to be truncated, never silently short" {
    try testing.expectEqual(Verdict.ok, verdictFor(3, 3, true));
    try testing.expectEqual(Verdict.truncated, verdictFor(6000, max_pages, true));
    try testing.expectEqual(Verdict.no_text, verdictFor(3, 3, false));
    try testing.expectEqual(Verdict.no_text, verdictFor(6000, max_pages, false));
}

test "the page cap is a decision with a stated value, not an accident" {
    try testing.expectEqual(@as(u32, 5_000), max_pages);
}

// ---------------------------------------------------------------------------
// Tests: the walk, and the verdict it earns
// ---------------------------------------------------------------------------

const thumbstore = @import("../store/thumbs.zig");
const filesvc = @import("files.zig");
const deferredmod = @import("deferred.zig");

/// 120 pages, each "Recipe N rutabaga leafNNN": three chunks at `chunk_pages`.
const book_pdf = @embedFile("../pdf/testdata/text-120-page.pdf");
const scan_pdf = @embedFile("../pdf/testdata/three-page.pdf");

const Fixture = struct {
    db: sqlite.Db,
    files: filesvc.Files,
    tmp: testing.TmpDir,
    arena: std.heap.ArenaAllocator,
    lock: std.Io.Mutex = .init,

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

    fn putRaw(f: *Fixture, user_id: u64, name: []const u8, bytes: []const u8) ![32]u8 {
        var r = std.Io.Reader.fixed(bytes);
        const e = try f.files.putFile(user_id, null, name, &r, null);
        defer testing.allocator.free(e.name);
        defer if (e.md5) |m| testing.allocator.free(m);
        var md5: [32]u8 = undefined;
        @memcpy(&md5, e.md5.?[0..32]);
        return md5;
    }

    fn drain(f: *Fixture) void {
        deferredmod.drainNow(testing.allocator, f.db, f.files.blobs, &f.lock, testing.io);
    }

    fn put(f: *Fixture, user_id: u64, name: []const u8, bytes: []const u8) ![32]u8 {
        const md5 = try f.putRaw(user_id, name, bytes);
        f.drain();
        return md5;
    }

    fn verdictOf(f: *Fixture, md5: []const u8) !?i64 {
        var r = (try f.db.row("SELECT pdf_text FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = md5 }})).?;
        defer r.finalize();
        return r.intOpt(0);
    }
};

/// Walks a blob's pages as `deferred.runPdfText` does.
const Walk = struct { yielded: u32, last_ordinal: i64, any_text: bool };

fn walk(f: *Fixture, md5: []const u8) !Walk {
    const file = try f.files.blobs.open(md5);
    defer file.close(testing.io);
    var ex = try pdftext.Extractor.open(file);
    defer ex.close();

    var src = Pages.init(testing.allocator, &ex);
    defer src.deinit();
    var out: Walk = .{ .yielded = 0, .last_ordinal = -1, .any_text = false };
    while (try src.next()) |p| {
        out.yielded += 1;
        out.last_ordinal = p.ordinal;
    }
    out.any_text = src.any_text;
    return out;
}

test "THE WALK IS THE WHOLE PASS: every page with text, once, addressed by its page number" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.putRaw(1, "book.pdf", book_pdf);
    const r = try walk(&f, &md5);
    try testing.expectEqual(@as(u32, 120), r.yielded);
    try testing.expectEqual(@as(i64, 119), r.last_ordinal); // 0-based, and the LAST page
    try testing.expect(r.any_text);
}

test "the walk crosses chunk boundaries transparently — 120 pages, three chunks, one sequence" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.putRaw(1, "book.pdf", book_pdf);
    const file = try f.files.blobs.open(&md5);
    defer file.close(testing.io);
    var ex = try pdftext.Extractor.open(file);
    defer ex.close();
    try testing.expect(ex.pages > chunk_pages); // or there is no boundary to cross

    var src = Pages.init(testing.allocator, &ex);
    defer src.deinit();
    var expect_ordinal: i64 = 0;
    while (try src.next()) |p| : (expect_ordinal += 1) {
        try testing.expectEqual(expect_ordinal, p.ordinal);
        try testing.expectEqual(@as(?u64, null), p.offset);
        try testing.expectEqual(@as(?u32, null), p.len);
    }
    try testing.expectEqual(@as(i64, 120), expect_ordinal);
}

test "a PDF that yields NO TEXT is a verdict, and the walk is what knows it" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.putRaw(1, "scan.pdf", scan_pdf);
    const r = try walk(&f, &md5);
    try testing.expectEqual(@as(u32, 0), r.yielded);
    try testing.expect(!r.any_text);

    f.drain();
    try testing.expectEqual(@as(?i64, @intFromEnum(Verdict.no_text)), try f.verdictOf(&md5));
    try testing.expect(!try needsText(f.db, &md5)); // never offered again
}

test "AN INDEXED PDF SETTLES: the tenant runs once, records `ok`, and is never offered again" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put(1, "book.pdf", book_pdf);
    try testing.expectEqual(@as(?i64, @intFromEnum(Verdict.ok)), try f.verdictOf(&md5));
    try testing.expect(!try needsText(f.db, &md5));

    // A PDF contributes no `note_page_index` rows.
    var rows = (try f.db.row(
        "SELECT COUNT(*) FROM note_page_index WHERE blob_md5 = ?1;",
        &.{.{ .text = &md5 }},
    )).?;
    defer rows.finalize();
    try testing.expectEqual(@as(i64, 0), rows.int(0));
}

test "TRUNCATION IS RECORDED — a capped document says so, and says how much it has" {
    // A small cap stands in for 5,000 pages; silence the expected warn.
    const saved = testing.log_level;
    testing.log_level = .err;
    defer testing.log_level = saved;

    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.putRaw(1, "book.pdf", book_pdf);
    const capped: u32 = 40; // stands in for `max_pages` against a 120-page book
    try f.db.exec("BEGIN IMMEDIATE;");
    try finish(f.db, &md5, capped, verdictFor(120, capped, true));
    try f.db.exec("COMMIT;");

    try testing.expectEqual(@as(?i64, @intFromEnum(Verdict.truncated)), try f.verdictOf(&md5));
    try testing.expect(!try needsText(f.db, &md5)); // recorded, so not retried
}

test "A NOTE HEAL LEAVES THE PDF TENANT'S MEMO ALONE — a tenant owns its own answers" {
    // `note_index.store` drops page rows past the parsed count, which is zero
    // for a PDF; the delete is scoped to `kind = 0` so `pdf_text` survives.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put(1, "book.pdf", book_pdf);
    try testing.expectEqual(@as(?i64, @intFromEnum(Verdict.ok)), try f.verdictOf(&md5));

    try f.db.exec("UPDATE note_index SET index_version = 0;");
    try noteindex.ensureIndexed(testing.allocator, testing.io, f.db, f.files.blobs, &md5, 1);

    try testing.expectEqual(@as(?i64, @intFromEnum(Verdict.ok)), try f.verdictOf(&md5));
    try testing.expect(!try needsText(f.db, &md5)); // not re-extracted for nothing
}

test "A HEAL ZEROES THE SHAPE, SO THE PROBE ASKS THE DATA AND COMES BACK FOR IT" {
    // The shape lives in the note columns, which a heal zeroes; only the memo
    // survives, so `needsProbe` must read the data.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put(1, "book.pdf", book_pdf);
    try testing.expectEqual(@as(i64, 120), try pageCountOf(&f, &md5));
    try testing.expect(!try pdfindex.needsProbe(f.db, &md5)); // settled before the heal

    try f.db.exec("UPDATE note_index SET index_version = 0;");
    try noteindex.ensureIndexed(testing.allocator, testing.io, f.db, f.files.blobs, &md5, 1);

    try testing.expectEqual(@as(i64, 0), try pageCountOf(&f, &md5));
    var memo = (try f.db.row("SELECT pdf_probe FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = &md5 }})).?;
    defer memo.finalize();
    try testing.expectEqual(@as(?i64, 0), memo.intOpt(0));

    try testing.expect(try pdfindex.needsProbe(f.db, &md5));
    f.drain();
    try testing.expectEqual(@as(i64, 120), try pageCountOf(&f, &md5));
}

test "a TERMINAL verdict is not retried by that rule — it never stored a shape to lose" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put(1, "book.pdf", book_pdf);
    for ([_]pdfindex.Verdict{ .unopenable, .encrypted, .no_pages }) |v| {
        try f.db.exec("UPDATE note_index SET page_count = 0;");
        var s = try f.db.prepare("UPDATE note_index SET pdf_probe = ?2 WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, &md5);
        s.bindInt(2, @intFromEnum(v));
        _ = try s.step();
        try testing.expect(!try pdfindex.needsProbe(f.db, &md5));
    }
}

fn pageCountOf(f: *Fixture, md5: []const u8) !i64 {
    var r = (try f.db.row("SELECT page_count FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = md5 }})).?;
    defer r.finalize();
    return r.int(0);
}
