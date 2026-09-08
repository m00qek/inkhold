//! The `.pdf` text pass: extract one page of text at a time and hand it to
//! `derive_search.writeDerived`, which writes the document's `terms/` and
//! `text/` files (`golden-search.md` §2.2). The browser searches those.
//!
//! **It used to write rows too** — one `kind = 2` row per page in
//! `note_page_index`, scoped by `segment_search` and indexed by `segment_fts`,
//! so library search returned PDF pages interleaved with note pages. It was the
//! segment seam's third tenant, it forced the whole reserved-band design
//! (`search/maintain.zig`), and `golden-search.md` §6 step 8 deleted all of it.
//! What that removes from THIS file is the chunked index write and the second
//! MuPDF walk it forced (`deferred.writePdfFiles` used to be a separate pass
//! over the same extractor); what is left is `Chunk`/`nextChunk`, which are how
//! a book's text arrives without ever being held whole, and the VERDICT.
//!
//! `txt_index.zig` is the shape to read first; this is deliberately its sibling,
//! and everything it inherits is inherited rather than rewritten: the shared
//! searchable-text lens (`txt_index.sanitizeUtf8`), the "record your dead ends
//! or be handed them for ever" rule, and the deferred worker's three steps.
//!
//! ## Caps, and the one that is a decision
//!
//! **`max_pages` = 5,000, and a longer document is INDEXED TO THE CAP AND SAID
//! SO** (`pdf_text = 2`), which is a deliberate departure from
//! `txt_index.max_file_bytes`. That tradition is *skip the whole file with a
//! marker*, and skipping a 2,000-page book entirely is a worse answer than
//! finding most of it. What survives from the tradition is the part worth
//! keeping: **never a silent truncation** — the verdict records it and the log
//! says it once.
//!
//! ## Pages with no text
//!
//! A page MuPDF returns nothing for is simply a line the derived record does not
//! carry — the record is addressed by the ordinal written on each line, and `n`
//! on the header line is the document's whole address space either way. (While
//! `kind = 2` rows existed a blank page still needed a ROW, because the band
//! arithmetic was `first + page_index` and a missing row was a hole.) A document
//! where EVERY page is like that is a scan, and that is a verdict
//! (`Verdict.no_text`), not a failure: unrecorded, the worker would re-read a
//! 1,450-page scanned book every idle tick for ever.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const blobstore = @import("../store/blobs.zig");
const derivesearch = @import("derive_search.zig");
const noteindex = @import("note_index.zig");
const pdfindex = @import("pdf_index.zig");
const pdftext = @import("../pdf/text.zig");
// The seam's shared rule about what a page of text IS, owned by the first
// tenant: the lossy UTF-8 lens. One copy, two callers.
const txtindex = @import("txt_index.zig");
const sanitizeUtf8 = txtindex.sanitizeUtf8;

const Allocator = std.mem.Allocator;
const log = std.log.scoped(.pdf_text);

/// Pages indexed at most, per document. **A DECISION, not a limit that fell out
/// of something** — see the module docs. A document longer than this is indexed
/// to the cap and RECORDS the truncation.
///
/// 5,000 is generous against everything measured (the harshest real subject on
/// record is 1,703 pages) and is a bound on the pass rather than a policy about
/// documents: at the measured ~0.10 s/page on the Pi it caps one job at roughly
/// eight minutes of niced background CPU.
pub const max_pages: u32 = 5_000;

/// How much of a book is held in memory at once — one `Chunk`. ~50 pages or
/// ~40 KB of text, whichever comes first, which is ~2 MB for the harshest
/// document on record against a 50 MB budget.
///
/// **These were a WRITE-TRANSACTION cap, and both halves were measured as one**
/// (`mupdf.md` §9.8): neither rows nor bytes alone predicted the lock hold, and
/// text volume mattered as much as page count — the cookbook cost 1.76x the
/// planner's write on FEWER pages. `golden-search.md` §6 step 8 deleted the write,
/// so what the dual cap bounds now is RESIDENCY, where the byte half is the one
/// that was always doing the work. The numbers are kept rather than re-derived:
/// they are known to keep a book out of memory, and nothing measured says a
/// different pair would.
pub const chunk_pages: u32 = 50;
pub const chunk_bytes: usize = 40 * 1024;

/// `note_index.pdf_text`. NULL (absent) means never extracted.
pub const Verdict = enum(i64) {
    /// Every page of the document is derived.
    ok = 0,
    /// Opened, and yielded no text on any page — a scan. A RESULT: recorded so
    /// the document is never re-read.
    no_text = 1,
    /// Derived the first `max_pages`; the rest are not in the record. Recorded
    /// rather than inferred, so "searchable, and incomplete" is a fact on the
    /// row instead of an inference from two page counts.
    truncated = 2,
    /// The text pass could not open a file the probe could. A verdict for the
    /// same reason every `pdf_probe` failure is one.
    unopenable = 3,

    /// The verdict for an extractor error, or null when the failure is about US
    /// rather than the file — `NoContext` is an allocation failure, and
    /// recording it would permanently write off a good PDF because the machine
    /// was briefly out of memory.
    pub fn of(e: pdftext.Error) ?Verdict {
        return switch (e) {
            pdftext.Error.NoContext => null,
            // The probe already said this file opens, has pages and is not
            // encrypted. If the text pass disagrees the file is unreadable to
            // us whatever the reason, and retrying will not change that.
            pdftext.Error.Unopenable, pdftext.Error.Encrypted, pdftext.Error.NoPages => .unopenable,
        };
    }
};

/// Does this filename name a `.pdf`? The extension rule, shared with the probe
/// so the two halves of the `.pdf` tenant cannot disagree about what they are
/// looking at.
pub const wants = pdfindex.wants;

/// Whether this blob still needs its text extracted — the authority the
/// discovery query approximates. False once any verdict is recorded, including
/// a failure, and false before the probe has run at all: text is the SECOND
/// question about a PDF and is never asked of a file whose first answer is
/// missing or negative.
pub fn needsText(db: sqlite.Db, blob_md5: []const u8) !bool {
    var r = (try db.row(
        "SELECT pdf_probe, pdf_text FROM note_index " ++
            "WHERE blob_md5 = ?1 AND index_version = ?2 AND indexable = 0;",
        &.{ .{ .text = blob_md5 }, .{ .int = noteindex.index_version } },
    )) orelse return false; // no current row: the note half heals first
    defer r.finalize();
    return r.intOpt(0) == @as(?i64, @intFromEnum(pdfindex.Verdict.ok)) and r.intOpt(1) == null;
}

/// Record the outcome. Call inside the caller's transaction, LAST — the memo
/// must not be true before the segments are.
pub fn storeVerdict(db: sqlite.Db, blob_md5: []const u8, v: Verdict) !void {
    var s = try db.prepare("UPDATE note_index SET pdf_text = ?2 WHERE blob_md5 = ?1;");
    defer s.finalize();
    s.bindText(1, blob_md5);
    s.bindInt(2, @intFromEnum(v));
    _ = try s.step();
}

// ---------------------------------------------------------------------------
// One chunk of pages — the unit of both extraction and commit
// ---------------------------------------------------------------------------

/// One page as the derivation sees it.
pub const Page = struct {
    /// The PDF page number, 0-based. The record's ordinal and the deep link.
    index: u32,
    /// MuPDF's text for the page, through the seam's UTF-8 lens. Empty for a
    /// page with no text at all.
    text: []const u8,
};

/// A run of consecutive pages, owning its own memory. `pages` is never empty and
/// is always `[from, from + pages.len)`.
///
/// It used to be one WRITE TRANSACTION's worth as well as one extraction's. Since
/// §6 step 8 there is no write, and this is purely the unit that keeps a book out
/// of memory: ~2 MB for a 1,450-page document rather than the whole of it.
pub const Chunk = struct {
    arena: std.heap.ArenaAllocator,
    from: u32,
    pages: []const Page,

    pub fn deinit(self: *Chunk) void {
        self.arena.deinit();
    }

    /// One past the last page in the chunk.
    pub fn to(self: Chunk) u32 {
        return self.from + @as(u32, @intCast(self.pages.len));
    }
};

/// Extracts the next chunk starting at `from`, or null when `from` is past the
/// end. Stops at `chunk_pages` pages or once `chunk_bytes` of text has
/// accumulated, whichever comes first — but ALWAYS takes at least one page, so a
/// single page larger than the byte cap forms its own chunk rather than
/// deadlocking the loop.
///
/// MUST be called OFF the DB lock. This is the expensive half (~0.10 s/page on
/// the target), and holding the connection through it is the failure mode
/// `deferred.zig` exists to prevent.
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
        // A page MuPDF cannot render to text is an empty page, not a failed
        // pass: `Extractor` counts it, and the chunk carries it so `index` stays
        // the real page number. `Pages` is what drops it from the record.
        const raw = (try ex.page(n)) orelse "";
        const text = try sanitizeUtf8(a, raw);
        try pages.append(a, .{ .index = n, .text = text });
        bytes += text.len;
        if (bytes >= chunk_bytes) break;
    }
    return .{ .arena = arena, .from = from, .pages = try pages.toOwnedSlice(a) };
}

/// A `derive_search.Page` source over a LIVE `Extractor` — the `.pdf` end of the
/// one per-format seam search has (`derive_search.writeDerived`).
///
/// **This is the case that earns the pull iterator.** `txt_index.Pages` walks a
/// document already in hand; here there is no such document and there must not
/// be one. Text arrives a `Chunk` at a time (50 pages / 40 KB, whichever comes
/// first) and the whole memory story of the text pass is that a book is never
/// held whole — 2 MB for a 1,450-page document, on a 50 MB budget. So `next`
/// hands out one page of the chunk it is holding and pulls the next chunk when
/// that runs out; the caller sees a flat sequence of pages and nothing above it
/// knows chunks exist.
///
/// **THE ARENA LIFETIME IS THE INVARIANT THE WHOLE DESIGN RESTS ON.** A page's
/// text is a slice into its chunk's arena and dies when that chunk is released,
/// which happens the moment `next` is asked for the page after the chunk's last.
/// That is safe because `writeDerived` consumes a `Page` COMPLETELY before it
/// calls `next` again — it folds it into the terms fragment and writes it into
/// the text fragment inside one loop body, and neither writer keeps the slice.
/// Verified against `derive_search.writeDerived`, and stated here because a
/// source that buffered its pages would need a different iterator and a
/// consumer that stashed one would corrupt this one silently.
///
/// A page with no extractable text is SKIPPED rather than yielded empty: the
/// derived files are addressed by the ordinal written on each line, so an
/// image-only page is simply a line that is not there. It is also what the two
/// writers would do with it anyway.
pub const Pages = struct {
    gpa: Allocator,
    ex: *pdftext.Extractor,
    /// The chunk being handed out, or null before the first pull and after the
    /// last. Owned here: `deinit` releases whatever is still held.
    chunk: ?Chunk = null,
    /// How far into `chunk.pages` the hand-out has got.
    at: usize = 0,
    /// Where the next chunk starts. `nextChunk` is the sole authority on where
    /// the document ends (`min(pages, max_pages)`), so there is no second copy
    /// of the cap here to drift from it.
    from: u32 = 0,
    /// Did the walk ever yield a page? Read AFTER the source is exhausted, it is
    /// exactly `verdictFor`'s `any_text`: `false` means MuPDF returned nothing
    /// for every page in the document, which is a scan.
    ///
    /// It lives here because this walk is now the ONLY one. The chunked index
    /// write used to walk the extractor first and hand its answer to the derive
    /// pass; §6 step 8 removed that walk, and the fact had to come from
    /// somewhere that is not a second extraction of a book.
    any_text: bool = false,

    pub fn init(gpa: Allocator, ex: *pdftext.Extractor) Pages {
        return .{ .gpa = gpa, .ex = ex };
    }

    /// Releases the chunk in flight. Idempotent, and needed on the error path
    /// only — a completed walk has already released its last chunk.
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
                    // Addressed by ORDINAL: a PDF page has no byte range in the
                    // blob, and the page number is what a viewer deep-links to.
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
// Write — inside the caller's transaction
// ---------------------------------------------------------------------------

/// Closes the document's pass: the verdict, in its own transaction and LAST, so
/// "this PDF's text is derived" is true only when it is.
///
/// It used to close a CHUNKED INDEX WRITE — the late-holder band repair, then
/// the verdict. `golden-search.md` §6 step 8 deleted the `kind = 2` rows and the
/// bands, so the verdict is all that is left of the transaction.
pub fn finish(
    db: sqlite.Db,
    blob_md5: []const u8,
    page_count: u32,
    v: Verdict,
) !void {
    // NEVER A SILENT TRUNCATION — the half of `txt_index`'s cap tradition worth
    // keeping. Once per blob, because the verdict written on the next line is
    // what stops the document being offered again.
    if (v == .truncated) {
        log.warn("derived the first {d} pages of {s}; the rest of the document is not searchable", .{ page_count, blob_md5 });
    }
    try storeVerdict(db, blob_md5, v);
}

/// The verdict a completed pass earns, given what the document had and what was
/// indexed. Split out so the rule is one expression rather than three branches
/// scattered through the driver — and so it is testable without a PDF.
pub fn verdictFor(doc_pages: u32, indexed_pages: u32, any_text: bool) Verdict {
    if (!any_text) return .no_text;
    return if (indexed_pages < doc_pages) .truncated else .ok;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;
const schema = @import("../db/schema.zig");

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
    // No text anywhere wins over everything: a scan is a scan whether or not it
    // was long enough to truncate.
    try testing.expectEqual(Verdict.no_text, verdictFor(3, 3, false));
    try testing.expectEqual(Verdict.no_text, verdictFor(6000, max_pages, false));
}

test "the page cap is a decision with a stated value, not an accident" {
    // Pinned so a change to it is a change to the plan and not a typo: 5,000 is
    // generous against the 1,703-page harshest subject on record, and it is what
    // `Verdict.truncated` exists to report crossing.
    try testing.expectEqual(@as(u32, 5_000), max_pages);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Tests — the walk, and the verdict it earns
// ---------------------------------------------------------------------------

// WHAT WENT FROM HERE, AND WHERE IT WENT. Until `golden-search.md` §6 step 8
// this file wrote `kind = 2` rows into a reserved band, and most of the tests
// below were about that band: contiguity across three commits, an ingest between
// chunks that must not interleave, a crash that leaves holes rather than
// corruption, a re-run that drops and re-reserves, two holders getting a band
// each, and two benches sizing the chunk and the closing transaction. Step 8
// deleted the rows, the band and both benches' subjects, so those tests were
// deleted with them rather than left asserting something else.
//
// The property they ultimately protected — *every page of an indexed PDF is
// findable, at its real page number* — did not go with them. It moved to the
// derived files, and `deferred.zig` asserts it there against real bytes: "the
// .pdf tenant writes BOTH derived files, ACROSS CHUNK BOUNDARIES" and "a
// SCANNED PDF still gets its two files, and they are the header alone".

const thumbstore = @import("../store/thumbs.zig");
const filesvc = @import("files.zig");
const deferredmod = @import("deferred.zig");

/// 120 pages, one line of text each: "Recipe N rutabaga leafNNN". Every page
/// carries `rutabaga`, exactly one carries its own `leafNNN`. At
/// `chunk_pages = 50` it is THREE chunks, which is the only reason the fixture
/// is this long: a one-chunk document cannot exercise a chunk boundary.
const book_pdf = @embedFile("../pdf/testdata/text-120-page.pdf");
/// Three bare `/MediaBox` pages with no content stream — a scan, minus the image.
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

    /// Upload ONLY — no worker. `putFile` returns as soon as the bytes and the
    /// rows are safe, and everything derived happens afterwards.
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

    /// Upload AND drain — the real sequence, which for a `.pdf` runs the probe
    /// and the whole text pass through the deferred tenant.
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

/// Walks a blob's pages exactly as `deferred.runPdfText` does — one `Pages`
/// source over one `Extractor`, drained — and reports what the verdict rests on.
/// The whole of what this file contributes to a document, since the rows went.
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
    // What replaced the band. `Pages` is now the only thing this file does with a
    // document, and the verdict, the two derived files and the client's find are
    // all downstream of it — so its contract is asserted directly: one record per
    // page that has text, in page order, at the PDF PAGE NUMBER.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.putRaw(1, "book.pdf", book_pdf);
    const r = try walk(&f, &md5);
    try testing.expectEqual(@as(u32, 120), r.yielded);
    try testing.expectEqual(@as(i64, 119), r.last_ordinal); // 0-based, and the LAST page
    try testing.expect(r.any_text);
}

test "the walk crosses chunk boundaries transparently — 120 pages, three chunks, one sequence" {
    // `Chunk` exists so a book is never held whole (~2 MB for 1,450 pages). The
    // caller must not be able to tell: `next` pulls the next chunk when the one
    // it is holding runs out, and the arena lifetime rule is what makes that
    // safe. Asserted by ordinal continuity across the two seams.
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
        // A `.pdf` page is addressed by its ORDINAL; the byte-range fields are
        // `.txt`'s alone and must not leak into a PDF's record.
        try testing.expectEqual(@as(?u64, null), p.offset);
        try testing.expectEqual(@as(?u32, null), p.len);
    }
    try testing.expectEqual(@as(i64, 120), expect_ordinal);
}

test "a PDF that yields NO TEXT is a verdict, and the walk is what knows it" {
    // A scan. It goes through exactly the same path as a book — there is no
    // second code path for it, because "this document says nothing" is only
    // knowable after the whole pass. Since §6 step 8 that pass is the `Pages`
    // walk itself, so `any_text` is where the fact comes from.
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

    // And it left NO `note_page_index` rows behind. That is the step-8 assertion
    // in this file: the derivation's whole output is now the two derived files
    // (`deferred.zig` asserts their bytes), and a PDF contributes no rows at all.
    var rows = (try f.db.row(
        "SELECT COUNT(*) FROM note_page_index WHERE blob_md5 = ?1;",
        &.{.{ .text = &md5 }},
    )).?;
    defer rows.finalize();
    try testing.expectEqual(@as(i64, 0), rows.int(0));
}

test "TRUNCATION IS RECORDED — a capped document says so, and says how much it has" {
    // The one place this departs from `txt_index.max_file_bytes`, which skips an
    // over-cap file WHOLE. Deriving a prefix is the better answer for a book; it
    // is only defensible if the prefix announces itself, so this drives the cap's
    // arithmetic with a small cap standing in for 5,000 pages.
    //
    // The warn is part of the contract; silence it for the suite's output.
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
    // THE HOLE THIS CLOSES, restated for what is left of it. `note_index.store`
    // ends by dropping every page row at or past the parsed page count, and for a
    // blob the note parser REJECTED that count is ZERO — so, unscoped, a note
    // re-index deleted a PDF's entire text index, and the upsert had to CLEAR
    // `pdf_text` to admit it. The delete is scoped to `kind = 0` and the memo is
    // left alone, which is what stops a note-parser bump forcing minutes of
    // re-extraction per book. The rows it used to protect went with §6 step 8;
    // the memo it protects is the whole cost now, so this still pins it.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put(1, "book.pdf", book_pdf);
    try testing.expectEqual(@as(?i64, @intFromEnum(Verdict.ok)), try f.verdictOf(&md5));

    // Force the lazy heal the way the shipped path does: stale the version, then
    // ask the note half to bring the row up to date.
    try f.db.exec("UPDATE note_index SET index_version = 0;");
    try noteindex.ensureIndexed(testing.allocator, testing.io, f.db, f.files.blobs, &md5, 1);

    try testing.expectEqual(@as(?i64, @intFromEnum(Verdict.ok)), try f.verdictOf(&md5));
    try testing.expect(!try needsText(f.db, &md5)); // not re-extracted for nothing
}

test "A HEAL ZEROES THE SHAPE, SO THE PROBE ASKS THE DATA AND COMES BACK FOR IT" {
    // The other half of the same hole, and it cannot be fixed by scoping: the
    // shape lives in the NOTE columns, so a heal legitimately overwrites
    // `page_count`/`width`/`height` with the note parser's own zeroes. Only the
    // memo survives. `needsProbe` therefore reads the DATA — verdict `ok` with
    // no page count is outstanding work, not finished work.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put(1, "book.pdf", book_pdf);
    try testing.expectEqual(@as(i64, 120), try pageCountOf(&f, &md5));
    try testing.expect(!try pdfindex.needsProbe(f.db, &md5)); // settled before the heal

    try f.db.exec("UPDATE note_index SET index_version = 0;");
    try noteindex.ensureIndexed(testing.allocator, testing.io, f.db, f.files.blobs, &md5, 1);

    // The heal really did erase it, and the memo really did survive — this test
    // is worthless if either stops being true.
    try testing.expectEqual(@as(i64, 0), try pageCountOf(&f, &md5));
    var memo = (try f.db.row("SELECT pdf_probe FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = &md5 }})).?;
    defer memo.finalize();
    try testing.expectEqual(@as(?i64, 0), memo.intOpt(0));

    try testing.expect(try pdfindex.needsProbe(f.db, &md5));
    f.drain();
    try testing.expectEqual(@as(i64, 120), try pageCountOf(&f, &md5));
}

test "a TERMINAL verdict is not retried by that rule — it never stored a shape to lose" {
    // The line between the two: `ok` with no pages lost something and is redone;
    // `unopenable`/`encrypted`/`no_pages` stored nothing, so a zero page count is
    // their normal state and re-probing them on every version bump would be work
    // with no possible result. A document that genuinely has none is `no_pages`,
    // never `ok`, which is what makes the `ok` test unambiguous.
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
