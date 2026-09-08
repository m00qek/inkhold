//! The `.pdf` text index: one segment per PAGE, stored as `kind = 2` rows in
//! `note_page_index`, so library search returns PDF pages interleaved with note
//! pages and `.txt` paragraphs through the machinery that already serves them
//! (`segment_search` + `segment_fts`) — the segment seam's THIRD tenant.
//!
//! `txt_index.zig` is the shape to read first; this is deliberately its sibling,
//! and everything it inherits is inherited rather than rewritten: the shared
//! searchable-text lens (`txt_index.sanitizeUtf8`), the column contract for a
//! non-note segment row, the "record your dead ends or be handed them for ever"
//! rule, and the deferred worker's three steps.
//!
//! ## What is NOT inherited, and why this file exists at all
//!
//! **The write is CHUNKED, and that changes who mints the band.** A `.txt` is
//! chunked and written in one transaction; a 1,450-page PDF written the same way
//! holds the global `db_lock` for **13.9-24.4 s** (`mupdf.md` §9.8, measured on
//! the Pi). Chunking the commit is the only lever — `nice` cannot help with a
//! lock — and chunking is exactly what breaks the invariant search now depends
//! on, unless the rowid range is RESERVED UP FRONT. That reservation lives in
//! `search/maintain.zig` (`reserveOwnerBlobBands` / `fillBandChunk` /
//! `finishOwnerBlobBands`), which is the module declared the sole owner of
//! `segment_search` rows; this file never writes them.
//!
//! A consequence worth stating: **`search.reconcilePage` is NOT used here**,
//! though it is what `.note` and `.txt` both call. Its last step mints a fresh
//! masked rowid per new segment (`mintPageForHolders`), which is precisely the
//! per-chunk minting the reservation exists to replace. Filling a reserved band
//! bypasses it by design.
//!
//! ## The row contract (the `.txt` contract, with two differences)
//!
//!   - `page_index` is the PDF PAGE NUMBER, 0-based. Not an ordinal into
//!     something else: that is what makes `first_rowid + page_index` a legal
//!     band address and what a deep link will eventually open.
//!   - `recogn_offset`/`recogn_length` are NULL. A `.txt` paragraph has a byte
//!     range in the blob and a PDF page does not — the page number IS the
//!     address, and the client already renders PDFs by page.
//!   - `content_hash` = `text_hash` = md5 of the indexed text; `width`/`height`
//!     0; `layers` the empty blob; `recogn_status` 1 where there is text and 0
//!     where there is none. All exactly as `txt_index` documents them, and safe
//!     for the same reason: every reader of those columns gates on
//!     `note_index.indexable = 1`, which a PDF never is.
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
//! A blank page still gets a row: the band arithmetic is `first + page_index`,
//! so a missing row is a hole in the run. It carries `recogn_status = 0` and
//! NULL text, which keeps it out of the FTS predicate and out of
//! `scoped_from_where` — present, addressable, invisible to search. A document
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
const search = @import("search/maintain.zig");
// The segment seam's shared rules about what a row carries, owned by the first
// tenant: the UTF-8 lens and the text hash. One copy, two callers.
const txtindex = @import("txt_index.zig");
const sanitizeUtf8 = txtindex.sanitizeUtf8;
const md5Hex = txtindex.md5Hex;

const Allocator = std.mem.Allocator;
const log = std.log.scoped(.pdf_text);

/// The `kind` discriminator for a PDF page segment (0 = note page, 1 = `.txt`
/// paragraph).
pub const kind_pdf: i64 = 2;

/// Pages indexed at most, per document. **A DECISION, not a limit that fell out
/// of something** — see the module docs. A document longer than this is indexed
/// to the cap and RECORDS the truncation.
///
/// 5,000 is generous against everything measured (the harshest real subject on
/// record is 1,703 pages) and is a bound on the pass rather than a policy about
/// documents: at the measured ~0.10 s/page on the Pi it caps one job at roughly
/// eight minutes of niced background CPU.
pub const max_pages: u32 = 5_000;

/// How much a single write transaction takes on. **A DUAL cap, and both halves
/// were measured** (`mupdf.md` §9.8): neither rows nor bytes alone predicts the
/// hold, and text volume matters as much as page count — the cookbook costs
/// 1.76x the planner's write on FEWER pages. ~50 pages or ~40 KB of text,
/// whichever comes first, held ≤0.8 s on both documents measured.
///
/// A starting point that has since been re-measured on the real path; see the
/// bench at the bottom of this file for what it actually costs here.
pub const chunk_pages: u32 = 50;
pub const chunk_bytes: usize = 40 * 1024;

/// `note_index.pdf_text`. NULL (absent) means never extracted.
pub const Verdict = enum(i64) {
    /// Every page of the document is indexed.
    ok = 0,
    /// Opened, and yielded no text on any page — a scan. A RESULT: recorded so
    /// the document is never re-read.
    no_text = 1,
    /// Indexed the first `max_pages`; the rest are not in the index. Recorded
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

/// One page as the index stores it.
pub const Page = struct {
    /// The PDF page number, 0-based. The band address and the deep link.
    index: u32,
    /// The indexed copy: MuPDF's text for the page, through the seam's UTF-8
    /// lens. Empty for a page with no text at all.
    text: []const u8,
};

/// A run of consecutive pages, owning its own memory — one write transaction's
/// worth. `pages` is never empty and is always `[from, from + pages.len)`.
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
        // pass: `Extractor` counts it, and the row still has to exist or the
        // band gains a hole.
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
/// A page with no extractable text is SKIPPED rather than yielded empty. The
/// index rows cannot do that — `first_rowid + page_index` needs every page
/// present or the band gains a hole — but the derived files are addressed by the
/// ordinal written on each line, so an image-only page is simply a line that is
/// not there. It is also what the two writers would do with it anyway.
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

const upsert_page_sql =
    \\INSERT INTO note_page_index(blob_md5, kind, page_index, content_hash, width, height,
    \\                            layers, recogn_status, text_hash, recogn_offset,
    \\                            recogn_length, text)
    \\VALUES(?1,2,?2,?3,0,0,x'',?4,?5,NULL,NULL,?6)
    \\ON CONFLICT(blob_md5, page_index) DO UPDATE SET
    \\  kind=excluded.kind, content_hash=excluded.content_hash, width=excluded.width,
    \\  height=excluded.height, layers=excluded.layers, recogn_status=excluded.recogn_status,
    \\  text_hash=excluded.text_hash, recogn_offset=NULL, recogn_length=NULL,
    \\  text=excluded.text;
;

/// Opens a document's write: drops whatever band the blob had, clears any tail
/// a shorter re-run would strand, and reserves one contiguous run of
/// `page_count` masked rowids per holder.
///
/// Runs in its own transaction (the caller's), BEFORE any page row is rewritten
/// — the drop's FTS 'delete' reads the text through the rows it is about to
/// replace. Returns the bands, owned by the caller.
pub fn reserve(
    gpa: Allocator,
    db: sqlite.Db,
    blob_md5: []const u8,
    page_count: u32,
    now: i64,
) ![]search.Band {
    const bands = try search.reserveOwnerBlobBands(gpa, db, blob_md5, page_count, now);
    errdefer gpa.free(bands);
    // A tail from a previous run at a different cap. The segment rows for it are
    // already gone (the drop above took every one of this blob's), so this is
    // just the page rows.
    var s = try db.prepare("DELETE FROM note_page_index WHERE blob_md5 = ?1 AND page_index >= ?2;");
    defer s.finalize();
    s.bindText(1, blob_md5);
    s.bindInt(2, page_count);
    _ = try s.step();
    return bands;
}

/// Writes one chunk: the page rows, then the reserved band's segment rows and
/// postings for exactly those pages. One transaction, ~0.5 s at the measured
/// chunk size, and a safe place to be interrupted.
pub fn storeChunk(
    db: sqlite.Db,
    blob_md5: []const u8,
    bands: []const search.Band,
    chunk: Chunk,
) !void {
    try storePageRows(db, blob_md5, chunk.pages);
    try search.fillBandChunk(db, bands, blob_md5, chunk.from, chunk.to());
}

/// The page rows alone — the adapter's own half of a chunk, split out from the
/// band fill so the two can be TIMED apart (see the bench at the bottom of this
/// file, which is where the plan's one unmeasured number lives).
fn storePageRows(db: sqlite.Db, blob_md5: []const u8, pages: []const Page) !void {
    for (pages) |p| {
        const hash = md5Hex(p.text);
        var s = try db.prepare(upsert_page_sql);
        defer s.finalize();
        s.bindText(1, blob_md5);
        s.bindInt(2, p.index);
        s.bindText(3, &hash); // content_hash — see the module's column contract
        // "Text present" is what `recogn_status = 1` means everywhere on this
        // table, and `scoped_from_where` filters on it. A blank page says 0 and
        // carries NULL text, so it is present in the band and absent from search.
        s.bindInt(4, if (p.text.len == 0) 0 else 1);
        s.bindTextOpt(5, if (p.text.len == 0) null else &hash);
        s.bindTextOpt(6, if (p.text.len == 0) null else p.text);
        _ = try s.step();
    }
}

/// Closes the document's write: the per-document term sets, the late-holder
/// repair, and the verdict. Its own transaction, LAST, so "this PDF's text is
/// indexed" is true only when it is.
pub fn finish(
    db: sqlite.Db,
    blob_md5: []const u8,
    page_count: u32,
    v: Verdict,
    now: i64,
) !void {
    try search.finishOwnerBlobBands(db, blob_md5, page_count, now);
    // NEVER A SILENT TRUNCATION — the half of `txt_index`'s cap tradition worth
    // keeping. Once per blob, because the verdict written on the next line is
    // what stops the document being offered again.
    if (v == .truncated) {
        log.warn("indexed the first {d} pages of {s}; the rest of the document is not searchable", .{ page_count, blob_md5 });
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

/// How many pages of `blob_md5` the index holds — the honest answer to "is this
/// document searchable, and how much of it". Used by the tests and by the
/// truncation arithmetic; cheap (a covering index scan on `note_page_index`).
pub fn indexedPages(db: sqlite.Db, blob_md5: []const u8) !i64 {
    var r = (try db.row(
        "SELECT COUNT(*) FROM note_page_index WHERE blob_md5 = ?1 AND kind = 2;",
        &.{.{ .text = blob_md5 }},
    )).?;
    defer r.finalize();
    return r.int(0);
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
// Tests — the chunked write, and the invariant it must not break
// ---------------------------------------------------------------------------

const thumbstore = @import("../store/thumbs.zig");
const filesvc = @import("files.zig");
const deferredmod = @import("deferred.zig");
const notesearch = @import("search/query.zig");
const partition = @import("search_partition.zig");

/// 120 pages, one line of text each: "Recipe N rutabaga leafNNN". Every page
/// carries `rutabaga`, exactly one carries its own `leafNNN` — so "this document
/// matches everywhere" and "this hit is page N" are both assertable. At
/// `chunk_pages = 50` it is THREE chunks, which is the only reason the fixture
/// is this long: a one-chunk document cannot exercise a chunk boundary.
const book_pdf = @embedFile("../pdf/testdata/text-120-page.pdf");
/// Three bare `/MediaBox` pages with no content stream — a scan, minus the image.
const scan_pdf = @embedFile("../pdf/testdata/three-page.pdf");

/// WHAT REPLACED LIBRARY-WIDE SEARCH IN THESE TESTS. `golden-search.md` §6 step 6
/// deleted the server's global read, so a test that used to ask "which of my
/// files does this word appear in?" asks every live file it owns, one at a time,
/// through the in-document read. The `files` join those reads are built on is
/// the same security boundary the deleted one carried.
const FoundFile = struct {
    noteId: u64,
    noteName: []const u8,
    /// The first matching ordinal — a page index for a `.note`/PDF, a paragraph
    /// ordinal for a `.txt`.
    pageIndex: i64,
};

const FoundFiles = struct { hits: []const FoundFile };

const Fixture = struct {
    db: sqlite.Db,
    files: filesvc.Files,
    tmp: testing.TmpDir,
    arena: std.heap.ArenaAllocator,
    lock: std.Io.Mutex = .init,

    fn init() !Fixture {
        return initAt(false);
    }

    /// `on_disk` opens a REAL database file under the test's temp dir, with the
    /// production pragma set (WAL and all) — because an in-memory `COMMIT` has
    /// no journal and no fsync, and the commit is exactly half of what a chunked
    /// write costs. Only the bench asks for it.
    fn initAt(on_disk: bool) !Fixture {
        const tmp = testing.tmpDir(.{});
        var path_buf: [128]u8 = undefined;
        var db = if (on_disk)
            try sqlite.Db.open(try std.fmt.bufPrintZ(&path_buf, ".zig-cache/tmp/{s}/bench.db", .{tmp.sub_path}))
        else
            try sqlite.Db.openMemory();
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
    /// rows are safe, and everything derived happens afterwards; the tests below
    /// that drive the chunked write themselves need exactly that state.
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

    /// A `.txt` uploaded and derived WITHOUT the worker, through the real lazy
    /// heal. The tests that drive a PDF's chunked write by hand cannot drain —
    /// the tenant would index the very document they are half-way through — but
    /// they still need a second document with a real band to search for.
    fn putTxt(f: *Fixture, user_id: u64, name: []const u8, bytes: []const u8) ![32]u8 {
        const md5 = try f.putRaw(user_id, name, bytes);
        try txtindex.ensureIndexed(testing.allocator, f.db, f.files.blobs, &md5, name, 100);
        return md5;
    }

    fn fileId(f: *Fixture, name: []const u8) !u64 {
        var r = (try f.db.row("SELECT id FROM files WHERE name = ?1 AND deleted = 0;", &.{.{ .text = name }})).?;
        defer r.finalize();
        return @intCast(r.int(0));
    }

    /// The blob's segment rowids in page order, for one owner — the band, as the
    /// jump arithmetic sees it.
    fn band(f: *Fixture, user_id: u64, md5: []const u8) ![]i64 {
        var out: std.ArrayList(i64) = .empty;
        var s = try f.db.prepare(
            "SELECT s.id FROM search_partitions sp " ++
                "JOIN segment_search s ON s.id BETWEEN (sp.id << 48) AND ((sp.id + 1) << 48) - 1 " ++
                "JOIN note_page_index p ON p.id = s.segment_id " ++
                "WHERE sp.user_id = ?1 AND p.blob_md5 = ?2 ORDER BY p.page_index;",
        );
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindText(2, md5);
        while (try s.step()) try out.append(f.a(), s.columnInt(0));
        return out.items;
    }

    /// Which of `user_id`'s OWN live files contain `q` — see `FoundFile`.
    fn search_(f: *Fixture, user_id: u64, q: []const u8) !FoundFiles {
        var hits: std.ArrayList(FoundFile) = .empty;
        var names: std.ArrayList(FoundFile) = .empty;
        {
            var s = try f.db.prepare(
                "SELECT id, name FROM files WHERE user_id = ?1 AND deleted = 0 AND is_folder = 0 ORDER BY id;",
            );
            defer s.finalize();
            s.bindInt(1, @intCast(user_id));
            while (try s.step()) try names.append(f.a(), .{
                .noteId = @intCast(s.columnInt(0)),
                .noteName = try f.a().dupe(u8, s.columnText(1)),
                .pageIndex = 0,
            });
        }
        for (names.items) |cand| {
            const r = try notesearch.searchNotePages(f.a(), f.db, user_id, cand.noteId, q, null, notesearch.max_batch);
            if (r.pages.len == 0) continue;
            try hits.append(f.a(), .{ .noteId = cand.noteId, .noteName = cand.noteName, .pageIndex = r.pages[0].pageIndex });
        }
        return .{ .hits = hits.items };
    }
};

/// Runs the chunked write over a real PDF, stopping after `max_chunks` commits
/// — which is how a crash between chunks is staged. Returns the bands and how
/// many pages actually landed.
///
/// This is the deferred worker's loop with the lock discipline removed (there is
/// one thread here): reserve in one transaction, each chunk in its own, finish
/// in a last one. `deferred.zig` runs the same sequence with the lock taken and
/// released around each.
fn runPipeline(
    f: *Fixture,
    md5: []const u8,
    max_chunks: usize,
    now: i64,
) !struct { bands: []search.Band, indexed: u32, verdict: ?Verdict } {
    const file = try f.files.blobs.open(md5);
    defer file.close(testing.io);
    var ex = try pdftext.Extractor.open(file);
    defer ex.close();

    const doc_pages = ex.pages;
    const to_index = @min(doc_pages, max_pages);

    try f.db.exec("BEGIN IMMEDIATE;");
    const bands = try reserve(f.a(), f.db, md5, to_index, now);
    try f.db.exec("COMMIT;");

    var at: u32 = 0;
    var chunks: usize = 0;
    var any_text = false;
    while (chunks < max_chunks) : (chunks += 1) {
        var chunk = (try nextChunk(testing.allocator, &ex, at)) orelse break;
        defer chunk.deinit();
        for (chunk.pages) |p| {
            if (p.text.len != 0) any_text = true;
        }
        try f.db.exec("BEGIN IMMEDIATE;");
        try storeChunk(f.db, md5, bands, chunk);
        try f.db.exec("COMMIT;");
        at = chunk.to();
    }
    if (at < to_index) return .{ .bands = bands, .indexed = at, .verdict = null }; // "crashed"

    const v = verdictFor(doc_pages, to_index, any_text);
    try f.db.exec("BEGIN IMMEDIATE;");
    try finish(f.db, md5, to_index, v, now);
    try f.db.exec("COMMIT;");
    return .{ .bands = bands, .indexed = at, .verdict = v };
}

/// FTS5's own audit of the external-content index: every posting resolves to the
/// text it claims to come from. The one assertion that catches a posting written
/// at a rowid whose row later changed underneath it.
fn expectFtsClean(f: *Fixture) !void {
    try f.db.exec("INSERT INTO segment_fts(segment_fts) VALUES('integrity-check');");
}

test "THE BAND IS STILL CONTIGUOUS after a chunked write — the arithmetic the scan rests on" {
    // The load-bearing property of this whole file. `query.docSegmentRanges`
    // derives the document's own rowid ranges and runs one `M1><` pass per
    // range, and `rowid ASC` is reading order only while a document's segments
    // are ONE contiguous run in page order — so a scattered band costs a find
    // extra passes and, past the range cap, the whole partition. Three commits
    // produced this band, and it has to look exactly like one statement did.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.putRaw(1, "book.pdf", book_pdf);
    const r = try runPipeline(&f, &md5, 99, 100);
    try testing.expectEqual(@as(u32, 120), r.indexed);
    try testing.expectEqual(@as(?Verdict, .ok), r.verdict);
    defer f.a().free(r.bands);

    const ids = try f.band(1, &md5);
    try testing.expectEqual(@as(usize, 120), ids.len);
    for (ids, 0..) |id, i| {
        // Not merely "sorted": `rowid = first + page_index`, exactly, which is
        // the equation the jump inverts.
        try testing.expectEqual(r.bands[0].first_rowid + @as(i64, @intCast(i)), id);
    }
    try expectFtsClean(&f);
}

test "AN INGEST BETWEEN CHUNKS DOES NOT INTERLEAVE — this is what the reservation buys" {
    // Minting per chunk would allocate fresh sequences each time, so a `.txt`
    // uploaded halfway through the book would land IN THE MIDDLE of its band and
    // the jump would step over a document that had not been reported yet.
    // Reserving up front makes the interloper land above the whole band.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.putRaw(1, "book.pdf", book_pdf);

    const file = try f.files.blobs.open(&md5);
    defer file.close(testing.io);
    var ex = try pdftext.Extractor.open(file);
    defer ex.close();

    try f.db.exec("BEGIN IMMEDIATE;");
    const bands = try reserve(f.a(), f.db, &md5, ex.pages, 100);
    try f.db.exec("COMMIT;");

    var at: u32 = 0;
    var interloper: [32]u8 = undefined;
    while (true) {
        var chunk = (try nextChunk(testing.allocator, &ex, at)) orelse break;
        defer chunk.deinit();
        try f.db.exec("BEGIN IMMEDIATE;");
        try storeChunk(f.db, &md5, bands, chunk);
        try f.db.exec("COMMIT;");
        at = chunk.to();
        // Exactly one upload, right after the first chunk commits.
        if (at == chunk_pages) interloper = try f.putTxt(1, "between.txt", "an interloping paragraph\n");
    }
    try f.db.exec("BEGIN IMMEDIATE;");
    try finish(f.db, &md5, ex.pages, .ok, 100);
    try f.db.exec("COMMIT;");

    const ids = try f.band(1, &md5);
    try testing.expectEqual(@as(usize, 120), ids.len);
    for (ids, 0..) |id, i| try testing.expectEqual(bands[0].first_rowid + @as(i64, @intCast(i)), id);

    // And the interloper is entirely OUTSIDE the book's range, not inside it.
    const other = try f.band(1, &interloper);
    try testing.expect(other.len > 0);
    for (other) |id| try testing.expect(id > ids[ids.len - 1]);
}

test "a crash between chunks leaves search CORRECT, not complete — holes never skip a neighbour" {
    // The chunked write's stated failure mode: allocated-but-unfilled rowids.
    // They are holes, and the jump guard already refuses to jump when the
    // candidate is not this blob's page 0 — so a half-written book degrades to a
    // step and cannot swallow the document below it.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.putRaw(1, "book.pdf", book_pdf);
    // A second document that WILL be sitting below the book's band, and that
    // matches the same term. If the holes made the jump land wrong, this is what
    // would vanish.
    _ = try f.putTxt(1, "neighbour.txt", "a rutabaga in the neighbour file\n");

    const r = try runPipeline(&f, &md5, 1, 100); // one chunk of three, then "crash"
    defer f.a().free(r.bands);
    try testing.expectEqual(@as(u32, chunk_pages), r.indexed);
    try testing.expectEqual(@as(?Verdict, null), r.verdict); // never marked done

    const ids = try f.band(1, &md5);
    try testing.expectEqual(@as(usize, chunk_pages), ids.len); // the filled prefix only

    // Both documents still surface. The book is searchable for what landed…
    const hits = try f.search_(1, "rutabaga");
    var saw_book = false;
    var saw_neighbour = false;
    for (hits.hits) |h| {
        if (std.mem.eql(u8, h.noteName, "book.pdf")) saw_book = true;
        if (std.mem.eql(u8, h.noteName, "neighbour.txt")) saw_neighbour = true;
    }
    try testing.expect(saw_book);
    try testing.expect(saw_neighbour); // …and the neighbour was NOT skipped over.
    try expectFtsClean(&f);
}

test "a re-run after a partial write DROPS and re-reserves — one band, no duplicates, clean FTS" {
    // Never patch holes in place. The re-run is the same code path as the first
    // run, and the only way that is safe is if reserving starts by dropping.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.putRaw(1, "book.pdf", book_pdf);
    const partial = try runPipeline(&f, &md5, 1, 100);
    f.a().free(partial.bands);
    const first_band_start = (try f.band(1, &md5))[0];

    const full = try runPipeline(&f, &md5, 99, 200);
    defer f.a().free(full.bands);
    try testing.expectEqual(@as(u32, 120), full.indexed);

    const ids = try f.band(1, &md5);
    try testing.expectEqual(@as(usize, 120), ids.len);
    try testing.expect(ids[0] > first_band_start); // a FRESH reservation, not the old one
    for (ids, 0..) |id, i| try testing.expectEqual(full.bands[0].first_rowid + @as(i64, @intCast(i)), id);

    // No row survived twice — the shape a "patch the holes" implementation would
    // leave behind, and the shape that would double every hit.
    var dup = (try f.db.row(
        "SELECT COUNT(*) FROM (SELECT s.segment_id FROM segment_search s " ++
            "JOIN note_page_index p ON p.id = s.segment_id WHERE p.blob_md5 = ?1 " ++
            "GROUP BY s.segment_id HAVING COUNT(*) > 1);",
        &.{.{ .text = &md5 }},
    )).?;
    defer dup.finalize();
    try testing.expectEqual(@as(i64, 0), dup.int(0));
    try expectFtsClean(&f);
}

test "AN INDEXED PDF IS SEARCHABLE END TO END: every page that matched, at its real page number" {
    var f = try Fixture.init();
    defer f.deinit();

    // Through the WORKER, so this is also the end-to-end assertion that the
    // tenant's two questions leave a searchable document behind.
    const md5 = try f.put(1, "book.pdf", book_pdf);
    try testing.expectEqual(@as(i64, 120), try indexedPages(f.db, &md5));
    try testing.expect(!try needsText(f.db, &md5));

    // The document is reachable at all, as the caller's own file.
    const id = try f.fileId("book.pdf");
    const hits = try f.search_(1, "rutabaga"); // on all 120 pages
    try testing.expectEqual(@as(usize, 1), hits.hits.len);
    try testing.expectEqualStrings("book.pdf", hits.hits[0].noteName);

    // And the find inside it is COMPLETE — every page, which is the claim no
    // ranked read could make.
    const in_doc = try notesearch.searchNotePages(f.a(), f.db, 1, id, "rutabaga", null, 500);
    try testing.expectEqual(@as(usize, 120), in_doc.pages.len);

    // A word on exactly one page finds exactly that page, which is what makes
    // `page_index` the PDF PAGE NUMBER rather than an ordinal into something.
    const one = try notesearch.searchNotePages(f.a(), f.db, 1, id, "leaf077", null, 500);
    try testing.expectEqual(@as(usize, 1), one.pages.len);
    try testing.expectEqual(@as(i64, 77), one.pages[0].pageIndex);

    // And a term the document lacks reaches it from neither direction.
    try testing.expectEqual(@as(usize, 0), (try notesearch.searchNotePages(f.a(), f.db, 1, id, "quokka", null, 500)).pages.len);
    for ((try f.search_(1, "quokka")).hits) |h| try testing.expect(!std.mem.eql(u8, h.noteName, "book.pdf"));
}

test "find-in-PDF's whole server side is the note-scoped route unchanged: kind = 2 pages, with the terms the client locates against" {
    // THE GATE FOR find-in-PDF (`pdf-in-doc-search.md` §2). The claim under test
    // is that the in-document route needs NOTHING new for a PDF: it is keyed on
    // the document's blob, not on its format, so a `kind = 2` page comes back
    // through the same statement a `.note` page does — and it comes back with
    // `terms`, which is the whole client contract. The viewer marks what the
    // server COUNTED; without terms it would have to re-derive membership, which
    // is the one thing the division of labour forbids.
    //
    // The `indexable = 1` gate this file's header warns every reader about is a
    // COVERAGE predicate (the manifest's unsearchable-notes denominator,
    // `index_export.zig`) and is not in `scoped_from_where`, which is what
    // `searchNotePages` runs. Asserted below rather than argued: the flag really
    // is off for this document and the pages really do come back anyway, so a
    // future reader who moves that predicate into the shared clause breaks this
    // test rather than the feature.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put(1, "book.pdf", book_pdf);
    const id = try f.fileId("book.pdf");

    // A PDF is not an indexable NOTE, and never becomes one.
    var ix = (try f.db.row("SELECT indexable FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = &md5 }})).?;
    defer ix.finalize();
    try testing.expectEqual(@as(i64, 0), ix.int(0));

    // Every row this document contributed is `kind = 2` — the PDF tenant's — so
    // what the route returns below is unambiguously a PDF page and not some
    // `.note` row that wandered in.
    var kinds = (try f.db.row(
        "SELECT COUNT(*), SUM(kind = 2) FROM note_page_index WHERE blob_md5 = ?1;",
        &.{.{ .text = &md5 }},
    )).?;
    defer kinds.finalize();
    try testing.expectEqual(@as(i64, 120), kinds.int(0));
    try testing.expectEqual(@as(i64, 120), kinds.int(1));

    // The route itself, on a word that lives on ONE page: the page number the
    // viewer opens, the count it displays, and the folded term it locates.
    const one = try notesearch.searchNotePages(f.a(), f.db, 1, id, "leaf042", null, 500);
    try testing.expectEqual(@as(usize, 1), one.pages.len);
    try testing.expectEqual(@as(i64, 42), one.pages[0].pageIndex);
    try testing.expectEqual(@as(i64, 1), one.pages[0].matches);
    try testing.expectEqual(@as(usize, 1), one.pages[0].terms.len);
    try testing.expectEqualStrings("leaf042", one.pages[0].terms[0]);

    // AND THE TERM IS THE INDEX'S, NOT THE QUERY'S — the property §6 leans on.
    // A prefix query (the box mid-typing) counts the words it expanded to and
    // NAMES them, so the client locates `leaf042` rather than re-implementing
    // what `leaf042*` meant.
    const typing = try notesearch.searchNotePages(f.a(), f.db, 1, id, "leaf04", null, 500);
    try testing.expectEqual(@as(usize, 10), typing.pages.len); // leaf040..leaf049
    for (typing.pages) |p| {
        try testing.expectEqual(@as(usize, 1), p.terms.len);
        try testing.expect(std.mem.startsWith(u8, p.terms[0], "leaf04"));
        try testing.expect(p.terms[0].len == "leaf040".len); // the WORD, not the prefix
    }
}

test "a PDF that yields NO TEXT is a verdict, and its pages stay invisible to search" {
    // A scan. It goes through exactly the same path as a book — there is no
    // second code path for it, because "this document says nothing" is only
    // knowable after the whole pass. What differs is the verdict, and that the
    // rows it wrote carry no text: present and addressable, invisible to search.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.putRaw(1, "scan.pdf", scan_pdf);
    f.drain();

    var v = (try f.db.row("SELECT pdf_text FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = &md5 }})).?;
    defer v.finalize();
    try testing.expectEqual(@as(?i64, @intFromEnum(Verdict.no_text)), v.intOpt(0));
    try testing.expect(!try needsText(f.db, &md5)); // never offered again

    try testing.expectEqual(@as(i64, 3), try indexedPages(f.db, &md5));
    var rs = (try f.db.row(
        "SELECT COUNT(*) FROM note_page_index WHERE blob_md5 = ?1 AND recogn_status = 1;",
        &.{.{ .text = &md5 }},
    )).?;
    defer rs.finalize();
    try testing.expectEqual(@as(i64, 0), rs.int(0)); // nothing the FTS predicate can reach
    try expectFtsClean(&f);
}

test "TRUNCATION IS RECORDED — a capped document says so on the row, and says how much it has" {
    // The one place this departs from `txt_index.max_file_bytes`, which skips an
    // over-cap file WHOLE. Indexing a prefix is the better answer for a book;
    // it is only defensible if the prefix announces itself, so this drives the
    // cap's arithmetic with a small cap standing in for 5,000 pages.
    //
    // The warn is part of the contract; silence it for the suite's output.
    const saved = testing.log_level;
    testing.log_level = .err;
    defer testing.log_level = saved;

    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.putRaw(1, "book.pdf", book_pdf);
    const file = try f.files.blobs.open(&md5);
    defer file.close(testing.io);
    var ex = try pdftext.Extractor.open(file);
    defer ex.close();

    const capped: u32 = 40; // stands in for `max_pages` against a 120-page book
    try f.db.exec("BEGIN IMMEDIATE;");
    const bands = try reserve(f.a(), f.db, &md5, capped, 100);
    try f.db.exec("COMMIT;");
    var chunk = (try nextChunk(testing.allocator, &ex, 0)).?;
    defer chunk.deinit();
    try testing.expectEqual(@as(u32, chunk_pages), chunk.to()); // the page cap bites first
    try f.db.exec("BEGIN IMMEDIATE;");
    // Only the pages inside the cap are offered to the band.
    try storeChunk(f.db, &md5, bands, .{ .arena = chunk.arena, .from = 0, .pages = chunk.pages[0..capped] });
    try finish(f.db, &md5, capped, verdictFor(ex.pages, capped, true), 100);
    try f.db.exec("COMMIT;");

    try testing.expectEqual(@as(i64, capped), try indexedPages(f.db, &md5));
    var r = (try f.db.row("SELECT pdf_text FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = &md5 }})).?;
    defer r.finalize();
    try testing.expectEqual(@as(?i64, @intFromEnum(Verdict.truncated)), r.intOpt(0));
    try testing.expect(!try needsText(f.db, &md5)); // recorded, so not retried
    try expectFtsClean(&f);
}

test "TWO HOLDERS get one contiguous band each, in their own partitions" {
    // A household sharing a cookbook is the ordinary case, not the exotic one.
    // Segment rows are per owner x blob, so the reservation is too.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.putRaw(1, "book.pdf", book_pdf);
    const md5b = try f.putRaw(2, "same-book.pdf", book_pdf);
    try testing.expectEqualStrings(&md5, &md5b); // content addressing: one blob
    f.drain(); // both holders exist before the reservation is taken

    for ([_]u64{ 1, 2 }) |uid| {
        const ids = try f.band(uid, &md5);
        try testing.expectEqual(@as(usize, 120), ids.len);
        for (ids, 1..) |id, i| try testing.expectEqual(ids[0] + @as(i64, @intCast(i)) - 1, id);
        // Each band lives in its OWNER's partition — the mask is per user.
        try testing.expectEqual(
            @as(?i64, partition.partitionOf(ids[0])),
            try partition.active(f.db, uid),
        );
    }
    try expectFtsClean(&f);
}

// ---------------------------------------------------------------------------
// The bench — the plan's one UNMEASURED number
// ---------------------------------------------------------------------------

// `mupdf.md` §9.8 sized the chunk from a PYTHON harness against the real schema,
// and its own docstring insists the measurement belongs in the server. It also
// lists what the harness got wrong in both directions: no prepared-statement
// cache in production against python's 128, a plain INSERT where production
// upserts, and per-ROW writes where the band fill is set-based — "plausibly
// ~1.5-2x net", too coarse to pin a chunk size.
//
// So this times the REAL statements, split into the two halves a chunk is made
// of: the per-page upserts (`storePageRows`, one prepare + step per page) and
// the SET-BASED band fill (`search.fillBandChunk` — the `segment_search` insert
// plus the external-content `segment_fts` insert, which is the specific cost the
// plan says is unmeasured).
//
// It sweeps chunk size, because that is the knob the number decides.
// `std.log.debug`, never `std.debug.print`: console output from a test binary
// makes the Zig build runner report a bogus failure, which has been
// misdiagnosed twice. Run it with `testing.log_level = .debug`, and in
// ReleaseSafe — a Debug build is 6-10x slower under the same statements and
// would report a chunk hold that no deployment ever pays.

/// Cookbook density: 1,412 chars/page, the harsher of the two documents §9.8
/// measured and the one that set the 24.4 s single-transaction figure.
fn benchPages(a: Allocator, count: u32) ![]Page {
    const pages = try a.alloc(Page, count);
    for (pages, 0..) |*p, i| {
        var t: std.ArrayList(u8) = .empty;
        var k: usize = 0;
        while (t.items.len < 1412) : (k += 1) {
            try t.print(a, "page {d} line {d}: braise the shallots until the fond lifts, " ++
                "then deglaze with cider vinegar and reduce by half {d}. ", .{ i, k, i * 100 + k });
        }
        p.* = .{ .index = @intCast(i), .text = t.items };
    }
    return pages;
}

test "BENCH note: what one chunk of a PDF write actually costs, by chunk size (figures printed)" {
    var f = try Fixture.initAt(true); // a real file: the COMMIT has to be real
    defer f.deinit();
    const md5 = try f.putRaw(1, "book.pdf", book_pdf);

    const doc_pages: u32 = 500;
    const pages = try benchPages(f.a(), doc_pages);
    var text_bytes: usize = 0;
    for (pages) |p| text_bytes += p.text.len;

    for ([_]u32{ 25, 50, 100, 200 }) |per_chunk| {
        try f.db.exec("BEGIN IMMEDIATE;");
        const bands = try reserve(f.a(), f.db, &md5, doc_pages, 100);
        try f.db.exec("COMMIT;");

        var rows_ns: u64 = 0;
        var fill_ns: u64 = 0;
        var whole_ns: u64 = 0;
        var max_chunk_ns: u64 = 0;
        var at: u32 = 0;
        while (at < doc_pages) {
            const end = @min(at + per_chunk, doc_pages);
            const t0 = std.Io.Clock.awake.now(testing.io);
            try f.db.exec("BEGIN IMMEDIATE;");
            try storePageRows(f.db, &md5, pages[at..end]);
            const t1 = std.Io.Clock.awake.now(testing.io);
            try search.fillBandChunk(f.db, bands, &md5, at, end);
            const t2 = std.Io.Clock.awake.now(testing.io);
            try f.db.exec("COMMIT;");
            const t3 = std.Io.Clock.awake.now(testing.io);

            rows_ns += @intCast(t0.durationTo(t1).toNanoseconds());
            fill_ns += @intCast(t1.durationTo(t2).toNanoseconds());
            const whole: u64 = @intCast(t0.durationTo(t3).toNanoseconds());
            whole_ns += whole;
            if (whole > max_chunk_ns) max_chunk_ns = whole;
            at = end;
        }
        const chunks = doc_pages / per_chunk;
        std.log.debug(
            "[bench] pdf chunk={d} pages: rows {d} us, band fill {d} us, WHOLE TRANSACTION mean {d} us / worst {d} us ({d} pages, {d} KB text)",
            .{
                per_chunk,
                rows_ns / 1000 / chunks,
                fill_ns / 1000 / chunks,
                whole_ns / 1000 / chunks,
                max_chunk_ns / 1000,
                doc_pages,
                text_bytes / 1024,
            },
        );
    }

    // The bench is also an assertion: a 500-page document survives four full
    // re-runs at four different chunk sizes and still has exactly one band.
    const ids = try f.band(1, &md5);
    try testing.expectEqual(@as(usize, doc_pages), ids.len);
    for (ids, 0..) |id, i| try testing.expectEqual(ids[0] + @as(i64, @intCast(i)), id);
    try expectFtsClean(&f);
}

test "A NOTE HEAL LEAVES THE PDF TENANT'S ROWS ALONE — a tenant owns its own segments" {
    // THE HOLE THIS CLOSES. `note_index.store` ends by dropping every segment at
    // or past the parsed page count, and for a blob the note parser REJECTED
    // that count is ZERO — so, unscoped, a note re-index deleted a PDF's entire
    // text index. Nothing about a note-parser bump has anything to do with a
    // PDF's pages; the delete is now `kind = 0` and this pins it.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put(1, "book.pdf", book_pdf);
    const id = try f.fileId("book.pdf");
    const before = try f.band(1, &md5);

    // Force the lazy heal the way the shipped path does: stale the version, then
    // ask the note half to bring the row up to date.
    try f.db.exec("UPDATE note_index SET index_version = 0;");
    try noteindex.ensureIndexed(testing.allocator, testing.io, f.db, f.files.blobs, &md5, 1);

    var kinds = (try f.db.row(
        "SELECT COUNT(*), SUM(kind = 2) FROM note_page_index WHERE blob_md5 = ?1;",
        &.{.{ .text = &md5 }},
    )).?;
    defer kinds.finalize();
    try testing.expectEqual(@as(i64, 120), kinds.int(0));
    try testing.expectEqual(@as(i64, 120), kinds.int(1));

    // The band is not merely present, it is the SAME band — a heal that
    // re-minted would break the jump arithmetic even while keeping the rows.
    const after = try f.band(1, &md5);
    try testing.expectEqualSlices(i64, before, after);

    // And the document is still findable, which is the property a user notices.
    const hit = try notesearch.searchNotePages(f.a(), f.db, 1, id, "leaf042", null, 500);
    try testing.expectEqual(@as(usize, 1), hit.pages.len);
    try testing.expectEqual(@as(i64, 42), hit.pages[0].pageIndex);
    try expectFtsClean(&f);
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

// ---------------------------------------------------------------------------
// The bench — the CLOSING transaction, which is not chunk-shaped
// ---------------------------------------------------------------------------

// The sweep above sizes a CHUNK. This one measures the hold a chunk cannot
// bound: `search.finishOwnerBlobBands`, the closing transaction of the write.
//
// It exists because the residue `optimizations.md` entry 11 recorded was found
// on the `.txt` tenant and fixed in `search/maintain.zig`, which BOTH tenants
// call — so the PDF side needs its own before/after rather than inheriting a
// `.txt` figure. A 1,450-page book carries ~2 MB of text where a `.txt` may
// carry 16 MB, which is exactly why the closing fold was invisible here.
//
// The closing fold this measured is SMALLER since §6 step 6: `doc_terms` and the
// whole-document term fold that landed it are gone, so what remains in the close
// is the band shape alone. The figures below are from before that.
//
// `std.log.INFO`, not `std.log.debug`, and that is not drift from the sweep
// above: outside a Debug build `std.options.log_level` is `.info` and every
// `std.log.debug` call is COMPILED OUT, so the sweep's own advice ("run it in
// ReleaseSafe with `testing.log_level = .debug`") prints nothing at all — which
// is what `txt_index.zig`'s benches found and why they say info. Silent by
// default all the same: `testing.log_level` starts at `.warn`, so taking the
// measurement is one line and never suite noise.
//
// TAKEN 2026-08-09, x86 Ryzen 7840U, NVMe, ReleaseSafe, 1,450 pages at cookbook
// density (2,113 KB of indexed text), three runs each:
//
// | | worst chunk | CLOSING txn | whole write |
// |---|---:|---:|---:|
// | fold in the close (before) | 7-8 ms | **48-50 ms** | 142-143 ms |
// | fold per chunk (after) | 10-11 ms | **23 ms** | 189-194 ms |
//
// The longest hold is the close in both arms, and it halves. The whole write is
// ~35 % dearer, which is the honest shape of the trade HERE: a book carries
// 2 MB of text, so there is little fold to move, and 29 chunks each pay ~1.6 ms
// for their own. The `.txt` tenant, where the fold is 16 MB, gets the same
// per-chunk cost and 5.6x off its longest hold (`txt_index.zig`'s bench).

test "BENCH note: what the CLOSING transaction of a PDF write costs (figures printed)" {
    var f = try Fixture.initAt(true); // a real file: the COMMIT has to be real
    defer f.deinit();
    const md5 = try f.putRaw(1, "book.pdf", book_pdf);

    // The harshest document on record is 1,703 pages; 1,450 is the figure
    // `mupdf.md` §9.8 and this module's header both quote.
    const doc_pages: u32 = 1450;
    const pages = try benchPages(f.a(), doc_pages);
    var text_bytes: usize = 0;
    for (pages) |p| text_bytes += p.text.len;

    try f.db.exec("BEGIN IMMEDIATE;");
    const bands = try reserve(f.a(), f.db, &md5, doc_pages, 100);
    try f.db.exec("COMMIT;");

    var worst_ns: u64 = 0;
    var total_ns: u64 = 0;
    var chunks: u32 = 0;
    var at: u32 = 0;
    while (at < doc_pages) {
        const end = @min(at + chunk_pages, doc_pages);
        const t0 = std.Io.Clock.awake.now(testing.io);
        try f.db.exec("BEGIN IMMEDIATE;");
        try storeChunk(f.db, &md5, bands, .{
            .arena = std.heap.ArenaAllocator.init(testing.allocator),
            .from = at,
            .pages = pages[at..end],
        });
        try f.db.exec("COMMIT;");
        const t1 = std.Io.Clock.awake.now(testing.io);
        const held: u64 = @intCast(t0.durationTo(t1).toNanoseconds());
        if (held > worst_ns) worst_ns = held;
        total_ns += held;
        chunks += 1;
        at = end;
    }

    const fin0 = std.Io.Clock.awake.now(testing.io);
    try f.db.exec("BEGIN IMMEDIATE;");
    try finish(f.db, &md5, doc_pages, .ok, 200);
    try f.db.exec("COMMIT;");
    const fin1 = std.Io.Clock.awake.now(testing.io);
    const finish_ns: u64 = @intCast(fin0.durationTo(fin1).toNanoseconds());
    total_ns += finish_ns;

    std.log.info(
        "[bench] pdf close: {d} pages, {d} KB text — {d} chunks, worst chunk {d} ms, " ++
            "CLOSING TXN {d} ms, total {d} ms",
        .{
            doc_pages,                      text_bytes / 1024,
            chunks,                         worst_ns / std.time.ns_per_ms,
            finish_ns / std.time.ns_per_ms, total_ns / std.time.ns_per_ms,
        },
    );

    // The bench is also an assertion: one contiguous band, and every page of it
    // in the index rather than a prefix.
    const ids = try f.band(1, &md5);
    try testing.expectEqual(@as(usize, doc_pages), ids.len);
    for (ids, 0..) |id, i| try testing.expectEqual(ids[0] + @as(i64, @intCast(i)), id);
    try expectFtsClean(&f);
}
