//! Tests for PDF text derivation.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const blobstore = @import("../../store/blobs.zig");
const noteindex = @import("../note_index.zig");
const pdfindex = @import("../pdf_index.zig");
const pdftext = @import("../../pdf/text.zig");
const Allocator = std.mem.Allocator;
const testing = std.testing;
const schema = @import("../../db/schema.zig");
const thumbstore = @import("../../store/thumbs.zig");
const filesmod = @import("../files.zig");
const deferredmod = @import("../deferred.zig");
const pdf_text = @import("../pdf_text.zig");
const max_pages = pdf_text.max_pages;
const chunk_pages = pdf_text.chunk_pages;
const Verdict = pdf_text.Verdict;
const wants = pdf_text.wants;
const needsText = pdf_text.needsText;
const Pages = pdf_text.Pages;
const finish = pdf_text.finish;
const verdictFor = pdf_text.verdictFor;

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

/// 120 pages, each "Recipe N rutabaga leafNNN": three chunks at `chunk_pages`.
const book_pdf = @embedFile("../../pdf/testdata/text-120-page.pdf");

const scan_pdf = @embedFile("../../pdf/testdata/three-page.pdf");

const Fixture = struct {
    db: sqlite.Db,
    files: filesmod.Files,
    tmp: testing.TmpDir,
    arena: std.heap.ArenaAllocator,
    lock: std.Io.Mutex = .init,

    fn init() !Fixture {
        const tmp = testing.tmpDir(.{});
        var db = try sqlite.Db.openMemory();
        try schema.migrate(db);
        for ([_]u8{ 1, 2 }) |uid| {
            try db.run(
                "INSERT INTO users(id, email, password_md5, created_at) VALUES(?1, ?1 || '@b.c', '0123456789abcdef0123456789abcdef', 0);",
                &.{.{ .int = uid }},
            );
            try db.run(
                "INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(?1, 0, 1000000000);",
                &.{.{ .int = uid }},
            );
        }
        const store_ = try blobstore.BlobStore.init(testing.io, tmp.dir);
        const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
        const thumbs = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
        return .{
            .db = db,
            .files = filesmod.Files.init(testing.allocator, testing.io, db, store_, thumbs),
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
    try testing.expectEqual(@as(?i64, @backingInt(Verdict.no_text)), try f.verdictOf(&md5));
    try testing.expect(!try needsText(f.db, &md5)); // never offered again
}

test "AN INDEXED PDF SETTLES: the tenant runs once, records `ok`, and is never offered again" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put(1, "book.pdf", book_pdf);
    try testing.expectEqual(@as(?i64, @backingInt(Verdict.ok)), try f.verdictOf(&md5));
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

    try testing.expectEqual(@as(?i64, @backingInt(Verdict.truncated)), try f.verdictOf(&md5));
    try testing.expect(!try needsText(f.db, &md5)); // recorded, so not retried
}

test "A NOTE HEAL LEAVES THE PDF TENANT'S MEMO ALONE — a tenant owns its own answers" {
    // `note_index.store` drops page rows past the parsed count, which is zero
    // for a PDF; the delete is scoped to `kind = 0` so `pdf_text` survives.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put(1, "book.pdf", book_pdf);
    try testing.expectEqual(@as(?i64, @backingInt(Verdict.ok)), try f.verdictOf(&md5));

    try f.db.exec("UPDATE note_index SET index_version = 0;");
    try noteindex.ensureIndexed(testing.allocator, testing.io, f.db, f.files.blobs, &md5, 1);

    try testing.expectEqual(@as(?i64, @backingInt(Verdict.ok)), try f.verdictOf(&md5));
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
        try f.db.run(
            "UPDATE note_index SET pdf_probe = ?2 WHERE blob_md5 = ?1;",
            &.{ .{ .text = &md5 }, .{ .int = @backingInt(v) } },
        );
        try testing.expect(!try pdfindex.needsProbe(f.db, &md5));
    }
}

fn pageCountOf(f: *Fixture, md5: []const u8) !i64 {
    var r = (try f.db.row("SELECT page_count FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = md5 }})).?;
    defer r.finalize();
    return r.int(0);
}
