//! Tests for the `.txt` and `.pdf` tenants and the worker loop.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const derivedstore = @import("../../store/derived.zig");
const derivesearch = @import("../derive_search.zig");
const txtindex = @import("../txt_index.zig");
const pdfindex = @import("../pdf_index.zig");
const pdftext = @import("../pdf_text.zig");
const schema = @import("../../db/schema.zig");
const testing = std.testing;
const deferred = @import("../deferred.zig");
const discovery = deferred.discovery;
const tenants = deferred.tenants;
const Found = deferred.Found;
const nextJob = deferred.nextJob;
const Worker = deferred.Worker;
const fixture = @import("fixture.zig");
const Fixture = fixture.Fixture;
const two_paragraphs = fixture.two_paragraphs;
const rotate90_pdf = fixture.rotate90_pdf;
const book_pdf = fixture.book_pdf;

test "the .txt tenant writes BOTH derived files, and they inflate to the §2.2 record" {
    var f = try Fixture.init();
    defer f.deinit();

    const terms_dir = try f.tmp.dir.createDirPathOpen(testing.io, "terms", .{});
    const text_dir = try f.tmp.dir.createDirPathOpen(testing.io, "text", .{});
    const terms = try derivedstore.DerivedStore.init(testing.io, terms_dir);
    const text = try derivedstore.DerivedStore.init(testing.io, text_dir);

    const md5 = try f.put("notes.txt", two_paragraphs);
    try testing.expect(!terms.has(&md5, derivesearch.index_version));

    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = terms,
        .text = text,
    };
    w.drain();

    try testing.expect(try f.txtDone(&md5));
    try testing.expect(terms.has(&md5, derivesearch.index_version));
    try testing.expect(text.has(&md5, derivesearch.index_version));

    const t = try derivedstore.readPlain(testing.allocator, terms, &md5, derivesearch.index_version);
    defer testing.allocator.free(t);
    var lines = std.mem.tokenizeScalar(u8, t, '\n');
    const head = lines.next().?;
    try testing.expect(std.mem.indexOf(u8, head, "\"n\":2") != null);
    try testing.expectEqualStrings(
        "{\"p\":0,\"t\":\"first in it paragraph with words\"}",
        lines.next().?,
    );
    try testing.expectEqualStrings(
        "{\"p\":1,\"t\":\"also paragraph second with words\"}",
        lines.next().?,
    );
    try testing.expect(lines.next() == null);

    const x = try derivedstore.readPlain(testing.allocator, text, &md5, derivesearch.index_version);
    defer testing.allocator.free(x);
    var xlines = std.mem.tokenizeScalar(u8, x, '\n');
    _ = xlines.next();
    const p0 = try std.json.parseFromSlice(std.json.Value, testing.allocator, xlines.next().?, .{});
    defer p0.deinit();
    try testing.expectEqualStrings("First paragraph, with words in it.", p0.value.object.get("t").?.string);
    try testing.expectEqual(@as(i64, 0), p0.value.object.get("o").?.integer);
    try testing.expectEqual(@as(i64, 34), p0.value.object.get("l").?.integer);
}

test "no stores wired means no files and no failure" {
    var f = try Fixture.init();
    defer f.deinit();
    const md5 = try f.put("notes.txt", two_paragraphs);
    f.drain();
    try testing.expect(try f.txtDone(&md5));
}

test "an upload does NOT derive the .txt, and a drain does" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("notes.txt", two_paragraphs);
    try std.testing.expect(!try f.txtDone(&md5));

    f.drain();
    try std.testing.expect(try f.txtDone(&md5));
}

test "a second drain finds nothing — the query excludes finished work, so the worker cannot spin" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put("notes.txt", two_paragraphs);
    f.drain();

    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    w.drain();
    try std.testing.expectEqual(@as(usize, 0), w.done.load(.acquire));
}

test "`pending_sql` and `needsDerive` agree — the two expressions of one predicate" {
    // Checked both before and after the work.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("notes.txt", two_paragraphs);

    try std.testing.expect(try txtindex.needsDerive(f.db, &md5));
    {
        const found = (try nextJob(testing.allocator, f.db)).?;
        defer testing.allocator.free(found.name);
        try std.testing.expectEqualStrings(&md5, &found.md5);
    }

    f.drain();

    try std.testing.expect(!try txtindex.needsDerive(f.db, &md5));
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));
}

/// Three chunks at `txt_index.chunk_segments`.
fn manyParagraphs(a: std.mem.Allocator, n: usize) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (0..n) |i| {
        if (i != 0) try out.appendSlice(a, "\n\n");
        try out.print(a, "paragraph {d} rutabaga leaf{d:0>3}", .{ i, i });
    }
    return out.items;
}

test "THE .txt DERIVE WRITES IN READING ORDER, and the verdict comes AFTER the files" {
    // Records ascend from ordinal 0, and the verdict lands after both files.
    var f = try Fixture.init();
    defer f.deinit();
    const s = try f.stores();

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const md5 = try f.put("book.txt", try manyParagraphs(arena.allocator(), 120));

    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = s.terms,
        .text = s.text,
    };
    w.drain();

    try testing.expect(try f.txtDone(&md5));
    try testing.expect(s.terms.has(&md5, derivesearch.index_version));
    try testing.expect(s.text.has(&md5, derivesearch.index_version));

    const raw = try derivedstore.readPlain(arena.allocator(), s.text, &md5, derivesearch.index_version);
    var lines = std.mem.tokenizeScalar(u8, raw, '\n');
    const head = try std.json.parseFromSlice(std.json.Value, arena.allocator(), lines.next().?, .{});
    try testing.expectEqual(@as(i64, 120), head.value.object.get("n").?.integer);

    var expect_ordinal: i64 = 0;
    while (lines.next()) |line| : (expect_ordinal += 1) {
        const v = try std.json.parseFromSlice(std.json.Value, arena.allocator(), line, .{});
        try testing.expectEqual(expect_ordinal, v.value.object.get("p").?.integer);
    }
    try testing.expectEqual(@as(i64, 120), expect_ordinal);
}

test "a trashed .txt is not offered — the bin is not a work queue" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("notes.txt", two_paragraphs);
    try f.db.exec("UPDATE files SET deleted = 1 WHERE md5 IS NOT NULL;");
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));

    try f.db.exec("UPDATE files SET deleted = 0 WHERE md5 IS NOT NULL;");
    const found = (try nextJob(testing.allocator, f.db)).?;
    defer testing.allocator.free(found.name);
    try std.testing.expectEqualStrings(&md5, &found.md5);
}

test "a leading-dot name is not a text file, here as in `wants`" {
    // `_` demands a character before the dot, as `txtindex.wants` does.
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put(".txt", two_paragraphs);
    try std.testing.expect(!txtindex.wants(".txt"));
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));
}

test "the worker thread starts, does the work, and JOINS on stop" {
    var f = try Fixture.init();
    defer f.deinit();

    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    try w.start();
    f.files.deferred = &w;

    const md5 = try f.put("notes.txt", two_paragraphs);

    var spins: usize = 0;
    while (spins < 2000) : (spins += 1) {
        f.lock.lockUncancelable(testing.io);
        const done = f.txtDone(&md5) catch false;
        f.lock.unlock(testing.io);
        if (done) break;
        std.Io.sleep(testing.io, .{ .nanoseconds = std.time.ns_per_ms }, .awake) catch {};
    }
    w.stop();
    try std.testing.expect(w.thread == null);
    try std.testing.expect(try f.txtDone(&md5));
}

test "a PDF gets its shape from the worker, and ROTATION survives into the row" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("doc.pdf", rotate90_pdf);
    {
        var r = (try f.db.row("SELECT pdf_probe FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = &md5 }})).?;
        defer r.finalize();
        try std.testing.expectEqual(@as(?i64, null), r.intOpt(0)); // the upload does not probe
    }

    f.drain();

    var r = (try f.db.row(
        "SELECT page_count, width, height, pdf_probe FROM note_index WHERE blob_md5 = ?1;",
        &.{.{ .text = &md5 }},
    )).?;
    defer r.finalize();
    try std.testing.expectEqual(@as(i64, 1), r.int(0));
    try std.testing.expectEqual(@as(i64, 100), r.int(1));
    try std.testing.expectEqual(@as(i64, 200), r.int(2));
    try std.testing.expectEqual(@as(i64, 0), r.int(3)); // Verdict.ok
}

test "a file that is not a PDF records a verdict, so it is never probed twice" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("broken.pdf", "this is definitely not a pdf");
    f.drain();

    {
        var r = (try f.db.row("SELECT pdf_probe FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = &md5 }})).?;
        defer r.finalize();
        try std.testing.expectEqual(@as(?i64, 1), r.intOpt(0)); // Verdict.unopenable
    }

    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    w.drain();
    try std.testing.expectEqual(@as(usize, 0), w.done.load(.acquire));
}

test "`pending_sql` and `needsProbe` agree, on both sides of the work" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("doc.pdf", rotate90_pdf);
    try std.testing.expect(try pdfindex.needsProbe(f.db, &md5));

    f.drain();

    try std.testing.expect(!try pdfindex.needsProbe(f.db, &md5));
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));
}

test "a .pdf.mark is not a PDF — the extension rule, not a substring" {
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.put("doc.pdf.mark", rotate90_pdf);
    try std.testing.expect(!pdfindex.wants("doc.pdf.mark"));
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));
}

test "a blob whose FILE is gone cannot spin the worker" {
    // A `files` row whose blob is missing on disk.
    const saved = testing.log_level;
    testing.log_level = .err; // the warning below is the POINT of this test
    defer testing.log_level = saved;

    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("doc.pdf", rotate90_pdf);
    f.files.blobs.remove(&md5); // the row survives, the bytes do not

    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    w.drain(); // must RETURN. Without the guard this never does.

    try std.testing.expect(w.done.load(.acquire) <= 1);
    try std.testing.expect(try pdfindex.needsProbe(f.db, &md5));
}

/// Three bare `/MediaBox` pages: a scan, minus the image.
const scan_pdf = @embedFile("../../pdf/testdata/three-page.pdf");

test "ONE JOB answers both of the .pdf tenant's questions — the shape, then the text" {
    // One drain must leave the document fully indexed despite the guard.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("book.pdf", book_pdf);
    f.drain();

    var r = (try f.db.row(
        "SELECT page_count, pdf_probe, pdf_text FROM note_index WHERE blob_md5 = ?1;",
        &.{.{ .text = &md5 }},
    )).?;
    defer r.finalize();
    try std.testing.expectEqual(@as(i64, 120), r.int(0));
    try std.testing.expectEqual(@as(?i64, 0), r.intOpt(1)); // pdfindex.Verdict.ok
    try std.testing.expectEqual(@as(?i64, 0), r.intOpt(2)); // pdftext.Verdict.ok

    var pages = (try f.db.row(
        "SELECT COUNT(*) FROM note_page_index WHERE blob_md5 = ?1;",
        &.{.{ .text = &md5 }},
    )).?;
    defer pages.finalize();
    try std.testing.expectEqual(@as(i64, 0), pages.int(0));
}

test "a second drain finds nothing for a finished PDF either — text is done work, not outstanding" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put("book.pdf", book_pdf);
    f.drain();

    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    w.drain();
    try std.testing.expectEqual(@as(usize, 0), w.done.load(.acquire));
}

test "`pending_sql`, `needsProbe` and `needsText` agree on both sides of the text pass" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("book.pdf", book_pdf);
    try std.testing.expect(try pdfindex.needsProbe(f.db, &md5));
    try std.testing.expect(!try pdftext.needsText(f.db, &md5)); // never before the probe

    f.drain();

    try std.testing.expect(!try pdfindex.needsProbe(f.db, &md5));
    try std.testing.expect(!try pdftext.needsText(f.db, &md5));
    try std.testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));
}

test "a SCANNED PDF records its verdict and is never offered again" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("scan.pdf", scan_pdf);
    f.drain();

    {
        var r = (try f.db.row("SELECT pdf_text FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = &md5 }})).?;
        defer r.finalize();
        try std.testing.expectEqual(@as(?i64, 1), r.intOpt(0)); // pdftext.Verdict.no_text
    }

    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    w.drain();
    try std.testing.expectEqual(@as(usize, 0), w.done.load(.acquire));
}

test "the .pdf tenant writes BOTH derived files, ACROSS CHUNK BOUNDARIES" {
    // Three chunks: catches a source that hands out only its first chunk or frees
    // one while `writeDerived` still reads it.
    var f = try Fixture.init();
    defer f.deinit();

    const terms_dir = try f.tmp.dir.createDirPathOpen(testing.io, "terms", .{});
    const text_dir = try f.tmp.dir.createDirPathOpen(testing.io, "text", .{});
    const terms = try derivedstore.DerivedStore.init(testing.io, terms_dir);
    const text = try derivedstore.DerivedStore.init(testing.io, text_dir);

    const md5 = try f.put("book.pdf", book_pdf);
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = terms,
        .text = text,
    };
    w.drain();

    try testing.expect(terms.has(&md5, derivesearch.index_version));
    try testing.expect(text.has(&md5, derivesearch.index_version));

    const t = try derivedstore.readPlain(testing.allocator, terms, &md5, derivesearch.index_version);
    defer testing.allocator.free(t);
    var lines = std.mem.tokenizeScalar(u8, t, '\n');
    try testing.expect(std.mem.indexOf(u8, lines.next().?, "\"n\":120") != null);
    var seen: usize = 0;
    while (lines.next()) |line| : (seen += 1) {
        var buf: [64]u8 = undefined;
        try testing.expectEqualStrings(
            try std.fmt.bufPrint(
                &buf,
                "{{\"p\":{d},\"t\":\"{d} leaf{d:0>3} recipe rutabaga\"}}",
                .{ seen, seen, seen },
            ),
            line,
        );
    }
    try testing.expectEqual(@as(usize, 120), seen); // the last two chunks, too

    // A PDF page has no byte range in the blob, so `o`/`l` are absent.
    const x = try derivedstore.readPlain(testing.allocator, text, &md5, derivesearch.index_version);
    defer testing.allocator.free(x);
    var xlines = std.mem.tokenizeScalar(u8, x, '\n');
    _ = xlines.next();
    const p0 = try std.json.parseFromSlice(std.json.Value, testing.allocator, xlines.next().?, .{});
    defer p0.deinit();
    try testing.expectEqual(@as(i64, 0), p0.value.object.get("p").?.integer);
    try testing.expect(p0.value.object.get("o") == null);
    try testing.expect(p0.value.object.get("l") == null);
    try testing.expect(std.mem.indexOf(u8, p0.value.object.get("t").?.string, "Recipe 0 rutabaga leaf000") != null);
}

test "a SCANNED PDF still gets its two files, and they are the header alone" {
    var f = try Fixture.init();
    defer f.deinit();

    const terms_dir = try f.tmp.dir.createDirPathOpen(testing.io, "terms", .{});
    const text_dir = try f.tmp.dir.createDirPathOpen(testing.io, "text", .{});
    const terms = try derivedstore.DerivedStore.init(testing.io, terms_dir);
    const text = try derivedstore.DerivedStore.init(testing.io, text_dir);

    const md5 = try f.put("scan.pdf", scan_pdf);
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = terms,
        .text = text,
    };
    w.drain();

    try testing.expect(terms.has(&md5, derivesearch.index_version));
    try testing.expect(text.has(&md5, derivesearch.index_version));

    for ([_]derivedstore.DerivedStore{ terms, text }) |store| {
        const got = try derivedstore.readPlain(testing.allocator, store, &md5, derivesearch.index_version);
        defer testing.allocator.free(got);
        var lines = std.mem.tokenizeScalar(u8, got, '\n');
        try testing.expect(std.mem.indexOf(u8, lines.next().?, "\"n\":3") != null);
        try testing.expect(lines.next() == null);
    }
}

test "the tenant table is ordered by priority, so `nextJob` can take the first match" {
    var prev: u8 = 0;
    for (&tenants) |*t| {
        try std.testing.expect(t.priority >= prev);
        prev = t.priority;
        try std.testing.expect(t.name.len > 0);
        try std.testing.expect(t.pending_sql.len > 0);
        try std.testing.expect(t.from_where.len > 0);
    }
}

test "every tenant's pending_sql is valid SQL against the real schema" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);
    for (&tenants) |*t| {
        const s = try db.prepare(t.pending_sql);
        s.finalize();
    }
}

test "a tenant's discovery statement CONTAINS its predicate, so a second reader cannot drift from it" {
    for (&tenants) |*t| {
        try std.testing.expect(std.mem.indexOf(u8, t.pending_sql, t.from_where) != null);
    }
}

test "an XPS and a CBZ go through the paged tenant: shape, then text where there is any" {
    var f = try Fixture.init();
    defer f.deinit();

    const terms_dir = try f.tmp.dir.createDirPathOpen(testing.io, "terms", .{});
    const text_dir = try f.tmp.dir.createDirPathOpen(testing.io, "text", .{});
    const terms = try derivedstore.DerivedStore.init(testing.io, terms_dir);
    const text = try derivedstore.DerivedStore.init(testing.io, text_dir);

    const xps = try f.put("Quince guide.XPS", fixture.three_page_xps);
    const cbz = try f.put("Harbour.cbz", fixture.two_page_cbz);
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = terms,
        .text = text,
    };
    w.drain();

    // Shapes in points, so only their proportions are the files' own: an XPS
    // page is 400x300 in 1/96 inch, the CBZ's first image 300x400 pixels.
    const Want = struct { md5: []const u8, pages: i64, landscape: bool, text_verdict: i64 };
    for ([_]Want{
        .{ .md5 = &xps, .pages = 3, .landscape = true, .text_verdict = @backingInt(pdftext.Verdict.ok) },
        .{ .md5 = &cbz, .pages = 2, .landscape = false, .text_verdict = @backingInt(pdftext.Verdict.no_text) }, // like a scan
    }) |want| {
        var r = (try f.db.row(
            "SELECT page_count, width, height, pdf_probe, pdf_text FROM note_index WHERE blob_md5 = ?1;",
            &.{.{ .text = want.md5 }},
        )).?;
        defer r.finalize();
        try testing.expectEqual(want.pages, r.int(0));
        const w_pt = r.int(1);
        const h_pt = r.int(2);
        try testing.expect(w_pt > 0 and h_pt > 0);
        // 4:3 or 3:4, as the file has it.
        if (want.landscape) try testing.expectEqual(w_pt * 3, h_pt * 4) else try testing.expectEqual(w_pt * 4, h_pt * 3);
        try testing.expectEqual(@as(?i64, @backingInt(pdfindex.Verdict.ok)), r.intOpt(3));
        try testing.expectEqual(@as(?i64, want.text_verdict), r.intOpt(4));
    }

    // The XPS's words reach the search files.
    const t = try derivedstore.readPlain(testing.allocator, terms, &xps, derivesearch.index_version);
    defer testing.allocator.free(t);
    try testing.expect(std.mem.indexOf(u8, t, "\"n\":3") != null);
    try testing.expect(std.mem.indexOf(u8, t, "quince") != null);

    // The CBZ's are its header alone, written without a text pass.
    for ([_]derivedstore.DerivedStore{ terms, text }) |store| {
        const c = try derivedstore.readPlain(testing.allocator, store, &cbz, derivesearch.index_version);
        defer testing.allocator.free(c);
        try testing.expectEqual(@as(usize, 1), std.mem.count(u8, c, "\n"));
        try testing.expect(std.mem.indexOf(u8, c, "\"n\":2") != null);
    }
}

fn probeVerdict(f: *Fixture, md5: []const u8) !?i64 {
    var r = (try f.db.row("SELECT pdf_probe FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = md5 }})).?;
    defer r.finalize();
    return r.intOpt(0);
}

test "a part past MuPDF's memory ceiling ends as too_large, whatever the file is named" {
    // MuPDF picks the format by content: a zip named `.pdf` or `.xps` opens as
    // a comic book and reads its entries whole; the ceiling bounds it anyway.
    // One install per name, so the blob is offered under that name alone.
    for ([_][]const u8{ "Scans.cbz", "Scans.pdf", "Guide.xps" }) |name| {
        var f = try Fixture.init();
        defer f.deinit();

        const md5 = try f.put(name, fixture.over_budget_cbz);
        f.drain();

        try testing.expectEqual(@as(?i64, @backingInt(pdfindex.Verdict.too_large)), try probeVerdict(&f, &md5));
        var r = (try f.db.row("SELECT page_count FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = &md5 }})).?;
        defer r.finalize();
        try testing.expectEqual(@as(i64, 0), r.int(0)); // no shape: the tile keeps its A4 guess

        var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
        w.drain();
        try testing.expectEqual(@as(usize, 0), w.done.load(.acquire));
    }
}

test "nor does the idle-time rebuild of search files open a refused file" {
    // Reconcile rebuilds missing derived files; a `too_large` file never got
    // any, so it is exactly what reconcile would pick, with stores in place.
    var f = try Fixture.init();
    defer f.deinit();
    const terms_dir = try f.tmp.dir.createDirPathOpen(testing.io, "terms", .{});
    const text_dir = try f.tmp.dir.createDirPathOpen(testing.io, "text", .{});
    const terms = try derivedstore.DerivedStore.init(testing.io, terms_dir);
    const text = try derivedstore.DerivedStore.init(testing.io, text_dir);

    const md5 = try f.put("Guide.xps", fixture.over_budget_cbz);
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = terms,
        .text = text,
    };
    w.drain();
    try testing.expectEqual(@as(?i64, @backingInt(pdfindex.Verdict.too_large)), try probeVerdict(&f, &md5));
    w.reconcileDerived();
    try testing.expect(!terms.has(&md5, derivesearch.index_version));
    try testing.expect(!text.has(&md5, derivesearch.index_version));
}

test "a big part under the ceiling is MuPDF's to judge, not refused for its size" {
    var f = try Fixture.init();
    defer f.deinit();

    // 17 MiB of zeros named `01.png`: read whole, then not an image.
    const md5 = try f.put("Big.cbz", fixture.huge_page_cbz);
    f.drain();
    const v = try probeVerdict(&f, &md5);
    try testing.expect(v != null);
    try testing.expect(v.? != @backingInt(pdfindex.Verdict.too_large));
}

test "only a PDF or a zip reaches MuPDF; tricks inside a zip end at the ceiling" {
    const Case = struct { name: []const u8, bytes: []const u8, verdict: pdfindex.Verdict };
    const cases = [_]Case{
        // Neither a PDF nor a zip, though MuPDF would open each: refused unseen.
        .{ .name = "Tar.cbz", .bytes = fixture.two_page_tar_cbz, .verdict = .unopenable },
        .{ .name = "V7.cbz", .bytes = fixture.two_page_v7tar_cbz, .verdict = .unopenable },
        .{ .name = "Office.xps", .bytes = fixture.ole_header, .verdict = .unopenable },
        // A file named `.pdf` is MuPDF's to read, as before XPS and CBZ: its
        // header up to 4 KB in, or none at all, which MuPDF repairs.
        .{ .name = "Junk first.pdf", .bytes = fixture.junk_first_pdf, .verdict = .ok },
        .{ .name = "Headerless.pdf", .bytes = fixture.headerless_pdf, .verdict = .ok },
        // Named `.pdf`, a tar or an OLE file is read as a PDF (`open.h`), not
        // as the comic book MuPDF would make of it: no pages.
        .{ .name = "Tar.pdf", .bytes = fixture.two_page_tar_cbz, .verdict = .unopenable },
        .{ .name = "V7.pdf", .bytes = fixture.two_page_v7tar_cbz, .verdict = .unopenable },
        .{ .name = "Office.pdf", .bytes = fixture.ole_header, .verdict = .unopenable },
        // A zip, however odd, goes to MuPDF: an end record naming disk 1 is
        // just a comic book; a hidden directory and joined pieces hit the ceiling.
        .{ .name = "Disk.cbz", .bytes = fixture.disk_one_cbz, .verdict = .ok },
        .{ .name = "Hidden.cbz", .bytes = fixture.two_eocd_cbz, .verdict = .too_large },
        .{ .name = "Pieces.xps", .bytes = fixture.upper_pieces_xps, .verdict = .too_large },
    };
    for (cases) |c| {
        var f = try Fixture.init();
        defer f.deinit();
        const md5 = try f.put(c.name, c.bytes);
        f.drain();
        try testing.expectEqual(@as(?i64, @backingInt(c.verdict)), try probeVerdict(&f, &md5));
    }
}

test "a page whose text passes the memory ceiling makes the text verdict too_large, and the rest is still read" {
    var f = try Fixture.init();
    defer f.deinit();
    const md5 = try f.put("Bomb.pdf", fixture.text_bomb_pdf);
    f.drain();

    var r = (try f.db.row("SELECT page_count, pdf_probe, pdf_text FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = &md5 }})).?;
    defer r.finalize();
    try testing.expectEqual(@as(i64, 2), r.int(0));
    try testing.expectEqual(@as(?i64, @backingInt(pdfindex.Verdict.ok)), r.intOpt(1)); // the shape is cheap
    try testing.expectEqual(@as(?i64, @backingInt(pdftext.Verdict.too_large)), r.intOpt(2));
}

test "which paged documents have text, by extension: not a CBZ, and a .zip is none" {
    try testing.expect(!pdfindex.wants("Scans.zip"));
    try testing.expect(pdfindex.hasText("a.PDF") and pdfindex.hasText("a.xps"));
    try testing.expect(!pdfindex.hasText("a.CBZ") and !pdfindex.hasText("a.epub"));
}

test "an EPUB is never offered to the paged tenant: it reflows" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("book.epub", fixture.one_chapter_epub);
    f.drain();

    var r = (try f.db.row("SELECT pdf_probe, page_count FROM note_index WHERE blob_md5 = ?1;", &.{.{ .text = &md5 }})).?;
    defer r.finalize();
    try testing.expectEqual(@as(?i64, null), r.intOpt(0)); // never probed
    try testing.expectEqual(@as(i64, 0), r.int(1));
}
