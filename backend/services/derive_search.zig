//! Streaming writers for the two per-document derived search files (terms, text).

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const derived = @import("../store/derived.zig");
const fuzzy = @import("search/fuzzy.zig");

/// The header's `v`; shared with the filename so the two cannot drift.
pub const index_version = @import("note_index.zig").index_version;

/// `n` is the page/paragraph count, not the row count: textless pages have no row.
fn writeHeader(f: *derived.Fragment, md5: []const u8, n: u32) !void {
    var buf: [96]u8 = undefined;
    const line = try std.fmt.bufPrint(
        &buf,
        "{{\"md5\":\"{s}\",\"v\":{d},\"n\":{d}}}\n",
        .{ md5, index_version, n },
    );
    try f.write(line);
}

/// One unit of a document: a `.txt` paragraph, a `.pdf` page, a `.note` page.
pub const Page = struct {
    ordinal: i64,
    text: []const u8,
    /// Raw-blob byte range; `.txt` only.
    offset: ?u64 = null,
    len: ?u32 = null,
};

/// Write both derived files from `src`, anything with `fn next(*Self) !?Page`.
/// Pull-based so a document is never held whole. `n` is the page count, not
/// the number of pages `src` yields.
pub fn writeDerived(
    gpa: std.mem.Allocator,
    terms_store: derived.DerivedStore,
    text_store: derived.DerivedStore,
    md5: []const u8,
    n: u32,
    src: anytype,
) !void {
    // Private in-memory connection for the tokenizer: keeps off the write lock.
    var fold = try sqlite.Db.openMemory();
    defer fold.close();

    const tw = try gpa.create(TermsWriter);
    defer gpa.destroy(tw);
    try tw.begin(gpa, terms_store, fold, md5, n);
    errdefer tw.abort();

    // Both embed deflate's 64 KB window, hence heap rather than locals.
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
/// `t` being the page's folded terms separated by spaces.
pub const TermsWriter = struct {
    frag: derived.Fragment,
    db: sqlite.Db,
    line: std.ArrayList(u8),
    gpa: std.mem.Allocator,

    /// Opens the fragment and writes the header for `n` pages; `commit` or
    /// `abort` must follow.
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

    /// A page that folds to nothing writes no row.
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
        // No escaping: unicode61 treats `"`, `\` and controls as separators.
        try w.frag.write(w.line.items);
        try w.frag.write("\"}\n");
    }

    /// `abort` may still run after a failed commit, so `release` is idempotent.
    pub fn commit(w: *TermsWriter) !void {
        w.release();
        try w.frag.commit();
    }

    /// Drops the staged fragment; safe after a failed `commit`.
    pub fn abort(w: *TermsWriter) void {
        w.release();
        w.frag.abort();
    }

    fn release(w: *TermsWriter) void {
        w.line.deinit(w.gpa);
        w.line = .empty;
    }
};

/// Writes `text/<md5>.<v>`: a header line, then each segment's text and its
/// address (byte range for `.txt`, page otherwise) for viewer deep links.
pub const TextWriter = struct {
    frag: derived.Fragment,

    /// Opens the fragment and writes the header for `n` pages; `commit` or
    /// `abort` must follow.
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

    /// One segment: page `ordinal`, its byte range when the format has one
    /// (`.txt`), and its text. Empty text writes nothing.
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

    /// Publishes the fragment.
    pub fn commit(w: *TextWriter) !void {
        try w.frag.commit();
    }

    /// Drops the staged fragment.
    pub fn abort(w: *TextWriter) void {
        w.frag.abort();
    }
};

/// JSON-escape `s` into the fragment through a stack buffer (`Fragment` is not
/// a `std.Io.Writer`).
fn encodeString(f: *derived.Fragment, s: []const u8) !void {
    var buf: [4096]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    var rest = s;
    try f.write("\"");
    while (rest.len > 0) {
        // Chunk on a codepoint boundary, or a split sequence encodes as invalid.
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
    try w.page(0, "Reunião ORÇAMENTO reunião");
    try w.page(1, "acta");
    try w.page(2, "!!! ??? ---"); // folds to nothing: no row
    try w.page(3, "Café");
    try w.commit();

    const got = try derived.readPlain(testing.allocator, store, md5_x, index_version);
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

    const got = try derived.readPlain(testing.allocator, store, md5_x, index_version);
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
    try w.page(0, "say \"hello\" \\ back\tnow\nplease \x01 {\"json\":true}");
    try w.commit();

    const got = try derived.readPlain(testing.allocator, store, md5_x, index_version);
    defer testing.allocator.free(got);
    var lines = std.mem.tokenizeScalar(u8, got, '\n');
    _ = lines.next();
    const row = lines.next().?;
    try testing.expect(std.mem.indexOf(u8, row, "\\") == null);
    try testing.expect(lines.next() == null); // the \n and \t did not split it
    const parsed = try std.json.parseFromSlice(std.json.Value, testing.allocator, row, .{});
    defer parsed.deinit();
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

    const got = try derived.readPlain(testing.allocator, store, md5_x, index_version);
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

    // Multi-byte characters straddling the chunk boundary.
    var big: std.ArrayList(u8) = .empty;
    defer big.deinit(testing.allocator);
    while (big.items.len < 40_000) try big.appendSlice(testing.allocator, "não \"x\"\n");

    var w = try testing.allocator.create(TextWriter);
    defer testing.allocator.destroy(w);
    try w.begin(store, md5_x, 1);
    errdefer w.abort();
    try w.page(0, null, null, big.items);
    try w.commit();

    const got = try derived.readPlain(testing.allocator, store, md5_x, index_version);
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
