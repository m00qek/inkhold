//! Tests for reconcile, the derived-file backfill.

const std = @import("std");
const derivedstore = @import("../../store/derived.zig");
const derivesearch = @import("../derive_search.zig");
const testing = std.testing;
const deferred = @import("../deferred.zig");
const runPdfText = deferred.runPdfText;
const Found = deferred.Found;
const nextJob = deferred.nextJob;
const Worker = deferred.Worker;
const fixture = @import("fixture.zig");
const Fixture = fixture.Fixture;
const two_paragraphs = fixture.two_paragraphs;
const rotate90_pdf = fixture.rotate90_pdf;
const book_pdf = fixture.book_pdf;
const sample2_note = fixture.sample2_note;

test "RECONCILE: an ALREADY-INDEXED .txt gets its files, and a drain cannot give them" {
    // A library indexed before the derived stores existed owes no tenant work.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("notes.txt", two_paragraphs);
    f.drain(); // a worker with no stores wired
    try testing.expect(try f.txtDone(&md5));
    try testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));

    const s = try f.stores();
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
    try testing.expectEqual(@as(usize, 0), w.done.load(.acquire));
    try testing.expect(!s.terms.has(&md5, derivesearch.index_version));

    w.reconcileDerived();

    try testing.expect(s.terms.has(&md5, derivesearch.index_version));
    try testing.expect(s.text.has(&md5, derivesearch.index_version));

    const t = try derivedstore.readPlain(testing.allocator, s.terms, &md5, derivesearch.index_version);
    defer testing.allocator.free(t);
    var lines = std.mem.tokenizeScalar(u8, t, '\n');
    try testing.expect(std.mem.indexOf(u8, lines.next().?, "\"n\":2") != null);
    try testing.expectEqualStrings(
        "{\"p\":0,\"t\":\"first in it paragraph with words\"}",
        lines.next().?,
    );
    try testing.expectEqualStrings(
        "{\"p\":1,\"t\":\"also paragraph second with words\"}",
        lines.next().?,
    );
    try testing.expect(lines.next() == null);
}

test "RECONCILE: a .note gets its files, which NOTHING else in the worker can do" {
    // A `.note` has no tenant: pre-store or dedup re-linked notes are reached only here.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("n.note", sample2_note);
    f.drain();
    try testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));

    const s = try f.stores();
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = s.terms,
        .text = s.text,
    };
    w.reconcileDerived();

    try testing.expect(s.terms.has(&md5, derivesearch.index_version));
    try testing.expect(s.text.has(&md5, derivesearch.index_version));

    const t = try derivedstore.readPlain(testing.allocator, s.terms, &md5, derivesearch.index_version);
    defer testing.allocator.free(t);
    var lines = std.mem.tokenizeScalar(u8, t, '\n');
    try testing.expect(std.mem.indexOf(u8, lines.next().?, "\"n\":2") != null);
    try testing.expect(std.mem.startsWith(u8, lines.next().?, "{\"p\":0,\"t\":\""));
    try testing.expect(lines.next() == null);
}

test "RECONCILE: a .pdf gets its files through the chunked source" {
    // Drives the PDF page source without `runPdfText`'s `any_text` shortcut.
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put("book.pdf", book_pdf);
    f.drain();
    try testing.expectEqual(@as(?Found, null), try nextJob(testing.allocator, f.db));

    const s = try f.stores();
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = s.terms,
        .text = s.text,
    };
    w.reconcileDerived();

    try testing.expect(s.terms.has(&md5, derivesearch.index_version));
    try testing.expect(s.text.has(&md5, derivesearch.index_version));

    const t = try derivedstore.readPlain(testing.allocator, s.terms, &md5, derivesearch.index_version);
    defer testing.allocator.free(t);
    var lines = std.mem.tokenizeScalar(u8, t, '\n');
    try testing.expect(std.mem.indexOf(u8, lines.next().?, "\"n\":120") != null);
    var seen: usize = 0;
    while (lines.next()) |line| : (seen += 1) {
        var buf: [64]u8 = undefined;
        try testing.expectEqualStrings(
            try std.fmt.bufPrint(&buf, "{{\"p\":{d},\"t\":\"{d} leaf{d:0>3} recipe rutabaga\"}}", .{ seen, seen, seen }),
            line,
        );
    }
    try testing.expectEqual(@as(usize, 120), seen); // past both chunk boundaries
}

test "RECONCILE: a document that HAS its files is not derived again" {
    // Files overwritten with a sentinel a re-derive would destroy.
    var f = try Fixture.init();
    defer f.deinit();

    const s = try f.stores();
    const md5 = try f.put("notes.txt", two_paragraphs);
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = s.terms,
        .text = s.text,
    };
    w.drain(); // the tenant writes them on the way past
    try testing.expect(s.terms.has(&md5, derivesearch.index_version));

    const sentinel = "not a fragment";
    try s.terms.put(&md5, derivesearch.index_version, sentinel);
    try s.text.put(&md5, derivesearch.index_version, sentinel);

    w.reconcileDerived();

    for ([_]derivedstore.DerivedStore{ s.terms, s.text }) |store| {
        const got = try rawStored(store, &md5);
        defer testing.allocator.free(got);
        try testing.expectEqualStrings(sentinel, got);
    }
}

test "RECONCILE: a HALF-WRITTEN pair is completed — terms alone is not derived" {
    var f = try Fixture.init();
    defer f.deinit();

    const s = try f.stores();
    const md5 = try f.put("notes.txt", two_paragraphs);
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
    s.text.remove(&md5, derivesearch.index_version); // the torn commit

    w.reconcileDerived();

    try testing.expect(s.text.has(&md5, derivesearch.index_version));
    const x = try derivedstore.readPlain(testing.allocator, s.text, &md5, derivesearch.index_version);
    defer testing.allocator.free(x);
    try testing.expect(std.mem.indexOf(u8, x, "First paragraph") != null);
}

test "RECONCILE: null stores are a no-op, not an error" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put("notes.txt", two_paragraphs);
    var w: Worker = .{ .gpa = testing.allocator, .db = f.db, .blobs = f.files.blobs, .lock = &f.lock, .io = testing.io };
    w.reconcileDerived();
    try testing.expectEqual(@as(usize, 0), w.done.load(.acquire));
}

test "RECONCILE: the bin is not a backfill queue either" {
    var f = try Fixture.init();
    defer f.deinit();

    const s = try f.stores();
    const md5 = try f.put("notes.txt", two_paragraphs);
    try f.db.exec("UPDATE files SET deleted = 1 WHERE md5 IS NOT NULL;");

    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = s.terms,
        .text = s.text,
    };
    w.reconcileDerived();
    try testing.expect(!s.terms.has(&md5, derivesearch.index_version));

    try f.db.exec("UPDATE files SET deleted = 0 WHERE md5 IS NOT NULL;");
    w.reconcileDerived();
    try testing.expect(s.terms.has(&md5, derivesearch.index_version));
}

test "RECONCILE: the cursor visits EVERY document, and a second pass reads no blob" {
    var f = try Fixture.init();
    defer f.deinit();

    const txt = try f.put("notes.txt", two_paragraphs);
    const note = try f.put("n.note", sample2_note);
    const pdf = try f.put("doc.pdf", rotate90_pdf);
    f.drain();

    const s = try f.stores();
    var w: Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
        .terms = s.terms,
        .text = s.text,
    };
    w.reconcileDerived();

    for ([_][32]u8{ txt, note, pdf }) |md5| {
        try testing.expect(s.terms.has(&md5, derivesearch.index_version));
        try testing.expect(s.text.has(&md5, derivesearch.index_version));
    }

    const sentinel = "still here";
    try s.terms.put(&txt, derivesearch.index_version, sentinel);
    w.reconcileDerived();
    const got = try rawStored(s.terms, &txt);
    defer testing.allocator.free(got);
    try testing.expectEqualStrings(sentinel, got);
}

/// Raw on-disk bytes, no header skip or inflate.
fn rawStored(store: derivedstore.DerivedStore, md5: []const u8) ![]u8 {
    var file = try store.open(md5, derivesearch.index_version);
    defer file.close(store.io);
    var buf: [1 << 12]u8 = undefined;
    const n = try file.readPositionalAll(store.io, &buf, 0);
    return testing.allocator.dupe(u8, buf[0..n]);
}
