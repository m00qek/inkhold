//! Writing the two per-document derived files — `golden-search.md` §2.2.
//!
//! One place, three callers. `.txt` paragraphs, `.note` pages and `.pdf` pages
//! are three different derivations that produce the same two files, and the
//! whole point of §1.1 is that search stops having per-format mechanisms. So
//! the format lives here and the derive paths supply `(ordinal, text)`.
//!
//! ## Both writers STREAM, and that is the design rather than an optimisation
//!
//! A page's line is written the moment that page is available and is never
//! looked at again. Nothing accumulates.
//!
//! That is what §2.2's move to per-page records bought. The record it replaced
//! was `term -> [pages]`, inverted across the whole document, which forced the
//! deriving side to hold a map until the last page — 2.84 MB for the largest
//! document in the corpus and 11.18 MB for a pathological one, on a 50 MB
//! budget (§8.2). Per-page rows have no such map, which also turns `.pdf`'s
//! chunked arrival — 50 pages at a time, never held whole — from the awkward
//! case into the natural one.
//!
//! ## The fold is the SERVER's tokenizer, and that is the parity argument
//!
//! Terms are produced by `fuzzy.foldRows`, i.e. by FTS5's own
//! `unicode61 remove_diacritics 2` running inside SQLite. The browser folds only
//! the QUERY, with the same C compiled to wasm. Neither side owns a second
//! tokenizer, so the corpus cannot diverge from the query — which is the entire
//! reason SQLite is in the browser at all rather than a JS index.
//!
//! **A consequence that removes code: a folded term needs no JSON escaping.**
//! `unicode61` treats `"`, `\` and every control character as separators, so a
//! term cannot contain one. The terms file therefore writes bare strings and
//! asserts that in a test rather than trusting it. The TEXT file is raw document
//! content and is escaped properly.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const derived = @import("../store/derived.zig");
const fuzzy = @import("search/fuzzy.zig");

/// The `v` in a record's header line — the CONTENT version, matching the
/// `index_version` in the filename. Kept as one import so the two cannot drift.
pub const index_version = @import("note_index.zig").index_version;

/// Written by both files as their first line.
///
/// `n` is the document's ADDRESS SPACE — its page/paragraph count — not the
/// number of lines that follow. The two differ whenever a page has no text
/// (an unrecognised `.note` page, an image-only PDF page), and the address space
/// is both the more useful number and the one every derive path knows before it
/// starts. A client that wants the row count counts rows.
fn writeHeader(f: *derived.Fragment, md5: []const u8, n: u32) !void {
    var buf: [96]u8 = undefined;
    const line = try std.fmt.bufPrint(
        &buf,
        "{{\"md5\":\"{s}\",\"v\":{d},\"n\":{d}}}\n",
        .{ md5, index_version, n },
    );
    try f.write(line);
}

/// One unit of a document, whatever the format calls it: a `.txt` paragraph, a
/// `.pdf` page, a `.note` page.
pub const Page = struct {
    ordinal: i64,
    text: []const u8,
    /// The segment's byte range into the RAW BLOB, for the one format whose
    /// address is a range rather than an ordinal (`.txt`). Null everywhere else,
    /// where the ordinal IS the address.
    offset: ?u64 = null,
    len: ?u32 = null,
};

/// Write both derived files for one document from a PAGE SOURCE.
///
/// **This is the whole per-format seam.** A source is anything with
/// `fn next(self: *Self) !?Page`, and the three that exist live beside the data
/// they walk — `txt_index.Pages` over a `Derived`, `note_index.Pages` over a
/// `Parsed`, `pdf_text.Pages` over a live `Extractor`. Everything downstream of
/// `next` is format-blind already: the fold, the JSON, the deflate fragment, the
/// CRC, the atomic rename.
///
/// **A PULL iterator specifically, because of `.pdf`.** Its text arrives 50
/// pages at a time and is never held whole, so a push interface ("here are all
/// the pages") could not express it and a callback would invert control for the
/// two formats that do not need it. Pulling makes the awkward case disappear
/// into the same call the easy ones use.
///
/// `src` is `anytype` rather than a vtable: every call site is known at compile
/// time, so this monomorphizes with no indirection and no `*anyopaque`.
///
/// `n` is the ADDRESS SPACE — the document's page or paragraph count — not the
/// number of pages the source will yield. See `writeHeader`.
pub fn writeDerived(
    gpa: std.mem.Allocator,
    terms_store: derived.DerivedStore,
    text_store: derived.DerivedStore,
    md5: []const u8,
    n: u32,
    src: anytype,
) !void {
    // Private, in-memory, and used for NOTHING but the tokenizer. `temp.token_fold`
    // is contentless, so the fold reads no table — which is what lets every
    // caller do this off the global write lock (§2.5). Opened per document:
    // once per derive is not a cost worth pooling.
    var fold = try sqlite.Db.openMemory();
    defer fold.close();

    const tw = try gpa.create(TermsWriter);
    defer gpa.destroy(tw);
    try tw.begin(gpa, terms_store, fold, md5, n);
    errdefer tw.abort();

    // Both are large values (each embeds deflate's 64 KB window), which is why
    // they are heap-allocated rather than locals.
    const xw = try gpa.create(TextWriter);
    defer gpa.destroy(xw);
    try xw.begin(text_store, md5, n);
    errdefer xw.abort();

    while (try src.next()) |page| {
        try tw.page(page.ordinal, page.text);
        try xw.page(page.ordinal, page.offset, page.len, page.text);
    }

    try tw.commit();
    try xw.commit();
}

/// Writes `terms/<md5>.<v>`: a header line, then `{"p":…,"t":"…"}` per page,
/// the `t` being that page's folded terms separated by spaces.
pub const TermsWriter = struct {
    frag: derived.Fragment,
    db: sqlite.Db,
    /// One reusable line buffer for the whole document.
    line: std.ArrayList(u8),
    gpa: std.mem.Allocator,

    pub fn begin(
        w: *TermsWriter,
        gpa: std.mem.Allocator,
        store: derived.DerivedStore,
        db: sqlite.Db,
        md5: []const u8,
        n: u32,
    ) !void {
        try derived.beginFragment(store, &w.frag, md5, index_version);
        errdefer w.frag.abort();
        w.db = db;
        w.gpa = gpa;
        w.line = .empty;
        try writeHeader(&w.frag, md5, n);
    }

    /// Fold one page and write its line. A page whose text folds to NOTHING —
    /// punctuation, an empty transcript — is skipped rather than written as an
    /// empty row: an FTS5 row with no terms can never match, so it would be
    /// pure size.
    pub fn page(w: *TermsWriter, ordinal: i64, text: []const u8) !void {
        w.line.clearRetainingCapacity();

        var rows = try fuzzy.foldRows(w.db, text);
        defer rows.finalize();
        var any = false;
        while (try rows.step()) {
            const term = rows.columnText(0);
            if (term.len == 0) continue;
            if (any) try w.line.append(w.gpa, ' ');
            try w.line.appendSlice(w.gpa, term);
            any = true;
        }
        if (!any) return;

        var head: [48]u8 = undefined;
        try w.frag.write(try std.fmt.bufPrint(&head, "{{\"p\":{d},\"t\":\"", .{ordinal}));
        // No escaping: a folded term cannot contain `"` or `\` — see the header.
        try w.frag.write(w.line.items);
        try w.frag.write("\"}\n");
    }

    /// Safe to follow with `abort` — a caller's `errdefer w.abort()` still runs
    /// if the underlying commit fails, so releasing `line` must be idempotent.
    pub fn commit(w: *TermsWriter) !void {
        w.release();
        try w.frag.commit();
    }

    /// Idempotent, and safe after `commit`.
    pub fn abort(w: *TermsWriter) void {
        w.release();
        w.frag.abort();
    }

    fn release(w: *TermsWriter) void {
        w.line.deinit(w.gpa);
        w.line = .empty;
    }
};

/// Writes `text/<md5>.<v>`: a header line, then one line per segment carrying
/// the real text and that segment's ADDRESS — the byte range for `.txt`, the
/// page number for `.pdf`/`.note`. The address is what a viewer deep-links to,
/// and it is why in-document search can drop the server entirely (§4.1).
pub const TextWriter = struct {
    frag: derived.Fragment,

    pub fn begin(
        w: *TextWriter,
        store: derived.DerivedStore,
        md5: []const u8,
        n: u32,
    ) !void {
        try derived.beginFragment(store, &w.frag, md5, index_version);
        errdefer w.frag.abort();
        try writeHeader(&w.frag, md5, n);
    }

    /// One segment. `offset`/`len` are the `.txt` raw-blob byte range and are
    /// null for formats addressed by page alone — `txtFind.ts` is the only
    /// consumer that needs them, and it is the only viewer whose address is not
    /// simply the ordinal.
    pub fn page(
        w: *TextWriter,
        ordinal: i64,
        offset: ?u64,
        len: ?u32,
        text: []const u8,
    ) !void {
        if (text.len == 0) return;
        var head: [96]u8 = undefined;
        try w.frag.write(try std.fmt.bufPrint(&head, "{{\"p\":{d}", .{ordinal}));
        if (offset) |o| {
            try w.frag.write(try std.fmt.bufPrint(&head, ",\"o\":{d}", .{o}));
        }
        if (len) |l| {
            try w.frag.write(try std.fmt.bufPrint(&head, ",\"l\":{d}", .{l}));
        }
        try w.frag.write(",\"t\":");
        try encodeString(&w.frag, text);
        try w.frag.write("}\n");
    }

    pub fn commit(w: *TextWriter) !void {
        try w.frag.commit();
    }

    pub fn abort(w: *TextWriter) void {
        w.frag.abort();
    }
};

/// JSON-escape `s` into the fragment. Goes through a small stack buffer so a
/// large segment does not need an allocation — `std.json`'s encoder writes to a
/// `std.Io.Writer`, and `Fragment` deliberately is not one (it tees into a hash
/// as well as a compressor), so the buffer is the seam between them.
fn encodeString(f: *derived.Fragment, s: []const u8) !void {
    var buf: [4096]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    var rest = s;
    try f.write("\"");
    while (rest.len > 0) {
        // Chunk on a codepoint boundary: splitting a multi-byte sequence would
        // make the encoder emit two invalid strings instead of one valid one.
        var take = @min(rest.len, buf.len / 8);
        while (take < rest.len and (rest[take] & 0xC0) == 0x80) take += 1;
        w = .fixed(&buf);
        try std.json.Stringify.encodeJsonStringChars(rest[0..take], .{}, &w);
        try f.write(w.buffered());
        rest = rest[take..];
    }
    try f.write("\"");
}

// ---- tests ----

const testing = std.testing;

fn inflate(gpa: std.mem.Allocator, store: derived.DerivedStore, md5: []const u8) ![]u8 {
    var file = try store.open(md5, index_version);
    defer file.close(store.io);
    var raw: [1 << 16]u8 = undefined;
    const n = try file.readPositionalAll(store.io, &raw, 0);

    var body: std.Io.Writer.Allocating = .init(gpa);
    defer body.deinit();
    try body.writer.writeAll(raw[derived.header_len..n]);
    try body.writer.writeAll(&[_]u8{ 0x03, 0x00 }); // the serve path's final block

    var input: std.Io.Reader = .fixed(body.written());
    var window: [std.compress.flate.max_window_len]u8 = undefined;
    var d = std.compress.flate.Decompress.init(&input, .raw, &window);
    var out: std.Io.Writer.Allocating = .init(gpa);
    errdefer out.deinit();
    _ = try d.reader.streamRemaining(&out.writer);
    return out.toOwnedSlice();
}

const md5_x = "cccccccccccccccccccccccccccccccc";

test "terms: folded, deduplicated, one line per page, empty pages skipped" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try derived.DerivedStore.init(io, tmp.dir);
    var db = try sqlite.Db.openMemory();
    defer db.close();

    var w = try testing.allocator.create(TermsWriter);
    defer testing.allocator.destroy(w);
    try w.begin(testing.allocator, store, db, md5_x, 4);
    errdefer w.abort();
    // Diacritics folded, case folded, duplicates collapsed, vocabulary order.
    try w.page(0, "Reunião ORÇAMENTO reunião");
    try w.page(1, "acta");
    try w.page(2, "!!! ??? ---"); // folds to nothing: no row
    try w.page(3, "Café");
    try w.commit();

    const got = try inflate(testing.allocator, store, md5_x);
    defer testing.allocator.free(got);
    var lines = std.mem.tokenizeScalar(u8, got, '\n');
    _ = lines.next(); // header
    try testing.expectEqualStrings("{\"p\":0,\"t\":\"orcamento reuniao\"}", lines.next().?);
    try testing.expectEqualStrings("{\"p\":1,\"t\":\"acta\"}", lines.next().?);
    try testing.expectEqualStrings("{\"p\":3,\"t\":\"cafe\"}", lines.next().?);
    try testing.expect(lines.next() == null);
}

test "terms: the header carries the address space, not the row count" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try derived.DerivedStore.init(io, tmp.dir);
    var db = try sqlite.Db.openMemory();
    defer db.close();

    var w = try testing.allocator.create(TermsWriter);
    defer testing.allocator.destroy(w);
    try w.begin(testing.allocator, store, db, md5_x, 900); // 900 pages...
    errdefer w.abort();
    try w.page(7, "reuniao"); // ...one of which has text
    try w.commit();

    const got = try inflate(testing.allocator, store, md5_x);
    defer testing.allocator.free(got);
    var lines = std.mem.tokenizeScalar(u8, got, '\n');
    const head = lines.next().?;
    try testing.expect(std.mem.indexOf(u8, head, "\"n\":900") != null);
    try testing.expect(std.mem.indexOf(u8, head, "\"md5\":\"" ++ md5_x ++ "\"") != null);
    try testing.expectEqualStrings("{\"p\":7,\"t\":\"reuniao\"}", lines.next().?);
}

test "terms need no escaping, because unicode61 cannot emit a quote" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try derived.DerivedStore.init(io, tmp.dir);
    var db = try sqlite.Db.openMemory();
    defer db.close();

    var w = try testing.allocator.create(TermsWriter);
    defer testing.allocator.destroy(w);
    try w.begin(testing.allocator, store, db, md5_x, 1);
    errdefer w.abort();
    // Everything a naive writer would corrupt the line with.
    try w.page(0, "say \"hello\" \\ back\tnow\nplease \x01 {\"json\":true}");
    try w.commit();

    const got = try inflate(testing.allocator, store, md5_x);
    defer testing.allocator.free(got);
    var lines = std.mem.tokenizeScalar(u8, got, '\n');
    _ = lines.next();
    const row = lines.next().?;
    // The row is still ONE well-formed line: the quotes, backslash, tab and
    // newline in the input all folded to separators rather than reaching it.
    try testing.expect(std.mem.indexOf(u8, row, "\\") == null);
    try testing.expect(lines.next() == null); // the \n and \t did not split it
    const parsed = try std.json.parseFromSlice(std.json.Value, testing.allocator, row, .{});
    defer parsed.deinit();
    // Vocabulary order, as every terms row is (`fts5vocab` is term-sorted).
    try testing.expectEqualStrings("back hello json now please say true", parsed.value.object.get("t").?.string);
}

test "text: real content, escaped, with the .txt byte range" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try derived.DerivedStore.init(io, tmp.dir);

    var w = try testing.allocator.create(TextWriter);
    defer testing.allocator.destroy(w);
    try w.begin(store, md5_x, 2);
    errdefer w.abort();
    try w.page(0, 1234, 56, "He said \"olá\"\nand left.\t");
    try w.page(1, null, null, "page addressed by ordinal alone");
    try w.page(2, null, null, ""); // empty segment: no row
    try w.commit();

    const got = try inflate(testing.allocator, store, md5_x);
    defer testing.allocator.free(got);
    var lines = std.mem.tokenizeScalar(u8, got, '\n');
    _ = lines.next();

    const first = lines.next().?;
    const p1 = try std.json.parseFromSlice(std.json.Value, testing.allocator, first, .{});
    defer p1.deinit();
    try testing.expectEqual(@as(i64, 1234), p1.value.object.get("o").?.integer);
    try testing.expectEqual(@as(i64, 56), p1.value.object.get("l").?.integer);
    try testing.expectEqualStrings("He said \"olá\"\nand left.\t", p1.value.object.get("t").?.string);

    const second = lines.next().?;
    const p2 = try std.json.parseFromSlice(std.json.Value, testing.allocator, second, .{});
    defer p2.deinit();
    try testing.expect(p2.value.object.get("o") == null);
    try testing.expectEqualStrings("page addressed by ordinal alone", p2.value.object.get("t").?.string);

    try testing.expect(lines.next() == null);
}

test "text: a segment larger than the escape buffer survives intact" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try derived.DerivedStore.init(io, tmp.dir);

    // Multi-byte characters straddling the chunk boundary are the case the
    // codepoint-boundary walk in `encodeString` exists for.
    var big: std.ArrayList(u8) = .empty;
    defer big.deinit(testing.allocator);
    while (big.items.len < 40_000) try big.appendSlice(testing.allocator, "não \"x\"\n");

    var w = try testing.allocator.create(TextWriter);
    defer testing.allocator.destroy(w);
    try w.begin(store, md5_x, 1);
    errdefer w.abort();
    try w.page(0, null, null, big.items);
    try w.commit();

    const got = try inflate(testing.allocator, store, md5_x);
    defer testing.allocator.free(got);
    var lines = std.mem.tokenizeScalar(u8, got, '\n');
    _ = lines.next();
    const p = try std.json.parseFromSlice(std.json.Value, testing.allocator, lines.next().?, .{});
    defer p.deinit();
    try testing.expectEqualStrings(big.items, p.value.object.get("t").?.string);
}

test "abort leaves no file" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const store = try derived.DerivedStore.init(io, tmp.dir);
    var db = try sqlite.Db.openMemory();
    defer db.close();

    var w = try testing.allocator.create(TermsWriter);
    defer testing.allocator.destroy(w);
    try w.begin(testing.allocator, store, db, md5_x, 1);
    try w.page(0, "reuniao");
    w.abort();
    try testing.expect(!store.has(md5_x, index_version));
}
