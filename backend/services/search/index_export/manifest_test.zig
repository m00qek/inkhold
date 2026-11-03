//! Tests for the manifest's rows and tiering.

const std = @import("std");
const pending = @import("../../pending.zig");
const testing = std.testing;
const nb = @import("note_builder");
const noteindex = @import("../../note_index.zig");
const index_export = @import("../index_export.zig");
const Tier = index_export.Tier;
const Derivation = index_export.Derivation;
const manifest = index_export.manifest;
const fixture = @import("fixture.zig");
const Fixture = fixture.Fixture;
const fill = fixture.fill;

test "the manifest arrives in the fill order: notes, then anything annotated, then everything else" {
    var f = try Fixture.init();
    defer f.deinit();

    // Timestamped so recency alone would reverse the tiers.
    const bulk = try f.putBytes(1, "Don Quijote.txt", "windmills");
    const annotated = try f.putBytes(1, "Plano diretor.pdf", "%PDF-1.4 zoning");
    _ = try f.putBytes(1, "Plano diretor.pdf.mark", "ink");
    const own = try f.putNote(1, "BuJo.note", &.{"segunda-feira"});
    try f.touch(bulk, 3_000);
    try f.touch(annotated, 2_000);
    try f.touch(own, 1_000);

    const m = try f.manifest(1);
    // Three rows, not four: the `.mark` is a layer of the PDF, not a document.
    try testing.expectEqual(@as(usize, 3), m.rows.len);
    try testing.expectEqual(Tier.note, m.rows[0].tier);
    try testing.expectEqual(@as(i64, @intCast(own)), m.rows[0].file_id);
    try testing.expectEqual(Tier.marked, m.rows[1].tier);
    try testing.expectEqual(@as(i64, @intCast(annotated)), m.rows[1].file_id);
    try testing.expectEqual(Tier.other, m.rows[2].tier);
    try testing.expectEqual(@as(i64, @intCast(bulk)), m.rows[2].file_id);
}

test "within a tier the newest document comes first, and a tie is still deterministic" {
    var f = try Fixture.init();
    defer f.deinit();

    // Ids ascend while timestamps descend, so only a real sort passes.
    const oldest = try f.putNote(1, "a.note", &.{"alpha"});
    const middle = try f.putNote(1, "b.note", &.{"bravo"});
    const newest = try f.putNote(1, "c.note", &.{"charlie"});
    try f.touch(oldest, 100);
    try f.touch(middle, 200);
    try f.touch(newest, 300);

    var m = try f.manifest(1);
    try testing.expectEqual(@as(i64, @intCast(newest)), m.rows[0].file_id);
    try testing.expectEqual(@as(i64, @intCast(middle)), m.rows[1].file_id);
    try testing.expectEqual(@as(i64, @intCast(oldest)), m.rows[2].file_id);

    // Same second for all three: the order must still be total.
    for ([_]u64{ oldest, middle, newest }) |id| try f.touch(id, 500);
    m = try f.manifest(1);
    try testing.expectEqual(@as(i64, @intCast(oldest)), m.rows[0].file_id);
    try testing.expectEqual(@as(i64, @intCast(middle)), m.rows[1].file_id);
    try testing.expectEqual(@as(i64, @intCast(newest)), m.rows[2].file_id);
}

test "tier 1 is the indexer's verdict, not the file's name" {
    var f = try Fixture.init();
    defer f.deinit();

    const liar = try f.putBytes(1, "not-really.note", "PNG\x89 not a note at all");
    const honest = try f.putNote(1, "handwriting.bin", &.{"caligrafia"});

    try testing.expectEqual(Tier.other, (try f.rowFor(1, liar)).?.tier);
    try testing.expectEqual(Tier.note, (try f.rowFor(1, honest)).?.tier);
}

test "a paired .mark is in no tier and in no coverage denominator" {
    var f = try Fixture.init();
    defer f.deinit();

    // A `.mark` is a `.note` container and would otherwise be tier 1.
    const pdf = try f.putBytes(1, "Trip notes.pdf", "%PDF-1.4 itinerary");
    const mark_bytes = try nb.serialize(testing.allocator, .{ .pages = &.{.{
        .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }},
    }} });
    defer testing.allocator.free(mark_bytes);
    const mark = try f.putBytes(1, "Trip notes.pdf.mark", mark_bytes);

    const m = try f.manifest(1);
    try testing.expectEqual(@as(usize, 1), m.rows.len);
    try testing.expectEqual(@as(i64, @intCast(pdf)), m.rows[0].file_id);
    try testing.expectEqual(Tier.marked, m.rows[0].tier);
    try testing.expect((try f.rowFor(1, mark)) == null);
    try testing.expectEqual(@as(i64, 0), m.coverage.notes);
    try testing.expectEqual(@as(i64, 0), m.coverage.unsearchable);

    // An orphaned mark still lists, as tier 1. Trashing the PDF takes its
    // mark along, so the orphan is made directly.
    try f.files.trash(1, pdf);
    try testing.expectEqual(@as(usize, 0), (try f.manifest(1)).rows.len);

    const orphan = try f.putBytes(1, "Nobody's book.epub.mark", mark_bytes);
    try testing.expectEqual(Tier.note, (try f.rowFor(1, orphan)).?.tier);
}

test "the manifest is COMPLETE: a document with nothing to say is still a row" {
    var f = try Fixture.init();
    defer f.deinit();

    // Each of these is a row a tempting filter would drop.
    const png = try f.putBytes(1, "scan.png", "\x89PNG not text at any point"); // never searchable
    const note = try f.putNote(1, "blank.note", &.{}); // no recognised text
    const pdf = try f.putBytes(1, "book.pdf", "%PDF-1.4"); // derived later, by the worker
    const dup = try f.putBytes(1, "scan copy.png", "\x89PNG not text at any point"); // same blob as `png`

    // A blob with no `note_index` row, as during an outstanding derive.
    try f.db.exec("DELETE FROM note_index WHERE blob_md5 = (SELECT md5 FROM files WHERE name = 'book.pdf');");

    const m = try f.manifest(1);
    try testing.expectEqual(@as(usize, 4), m.rows.len);
    for ([_]u64{ png, note, pdf, dup }) |id| try testing.expect((try f.rowFor(1, id)) != null);

    // One blob, two files, two rows.
    const a_row = (try f.rowFor(1, png)).?;
    const b_row = (try f.rowFor(1, dup)).?;
    try testing.expectEqualStrings(a_row.md5, b_row.md5);

    try testing.expect((try f.rowFor(1, pdf)).?.index_version == null);

    // Exactly once: a join fan-out would break the client's set diff.
    for (m.rows, 0..) |r, i| for (m.rows[i + 1 ..]) |other| try testing.expect(r.file_id != other.file_id);
}

test "the version a row reports is the STORE's, so the client never asks for a file that will never exist" {
    var f = try Fixture.init();
    defer f.deinit();

    const png = try f.putBytes(1, "scan.png", "\x89PNG not text at any point");
    const blank = try f.putNote(1, "blank.note", &.{});
    const written = try f.putNote(1, "handwriting.note", &.{"caligrafia"});
    f.drain();

    // The database has a version for all three; that is what is corrected.
    for ([_]u64{ png, blank, written }) |id| {
        var st = try f.db.prepare(
            "SELECT ni.index_version FROM files d JOIN note_index ni ON ni.blob_md5 = d.md5 WHERE d.id = ?1;",
        );
        defer st.finalize();
        st.bindInt(1, @intCast(id));
        try testing.expect(try st.step());
        try testing.expect(!st.columnIsNull(0));
    }

    try testing.expect((try f.rowFor(1, png)).?.index_version == null);

    // A blank `.note` does get a terms file at ingest, so it advertises a
    // version: emptiness that arrived converges.
    const blank_row = (try f.rowFor(1, blank)).?;
    try testing.expect(blank_row.index_version != null);
    try testing.expect(f.files.terms.?.has(blank_row.md5, blank_row.index_version.?));

    const row = (try f.rowFor(1, written)).?;
    try testing.expect(row.index_version != null);
    try testing.expect(f.files.terms.?.has(row.md5, row.index_version.?));

    try testing.expectEqual(@as(usize, 3), (try f.manifest(1)).rows.len);

    f.files.terms.?.removeAll(row.md5);
    try testing.expect((try f.rowFor(1, written)).?.index_version == null);
}

test "a trashed file is absent from the manifest, which is the only way removal ever reaches the client" {
    var f = try Fixture.init();
    defer f.deinit();

    const keep = try f.putNote(1, "keep.note", &.{"fica"});
    const gone = try f.putNote(1, "gone.note", &.{"sai"});
    try testing.expectEqual(@as(usize, 2), (try f.manifest(1)).rows.len);

    try f.files.trash(1, gone);

    const m = try f.manifest(1);
    try testing.expectEqual(@as(usize, 1), m.rows.len);
    try testing.expectEqual(@as(i64, @intCast(keep)), m.rows[0].file_id);
    try testing.expect((try f.rowFor(1, gone)) == null);
}

test "one household member's manifest never contains another's documents" {
    var f = try Fixture.init();
    defer f.deinit();

    const mine = try f.putNote(1, "meu.note", &.{"particular"});
    const theirs = try f.putNote(2, "dele.note", &.{"particular"});

    // Identical bytes, so both users share one blob.
    const shared = try f.putNote(1, "compartilhado.note", &.{"mesmo texto"});
    const shared_2 = try f.putNote(2, "compartilhado.note", &.{"mesmo texto"});

    const m1 = try f.manifest(1);
    try testing.expectEqual(@as(usize, 2), m1.rows.len);
    for (m1.rows) |r| try testing.expect(r.file_id != @as(i64, @intCast(theirs)) and
        r.file_id != @as(i64, @intCast(shared_2)));
    try testing.expect((try f.rowFor(1, mine)) != null);
    try testing.expect((try f.rowFor(1, shared)) != null);

    const m2 = try f.manifest(2);
    try testing.expectEqual(@as(usize, 2), m2.rows.len);
    try testing.expect((try f.rowFor(2, mine)) == null);

    try testing.expectEqualStrings(
        (try f.rowFor(1, shared)).?.md5,
        (try f.rowFor(2, shared_2)).?.md5,
    );
}

test "a just-uploaded document is PENDING, and stops being pending when the worker finishes" {
    var f = try Fixture.init();
    defer f.deinit();

    const txt = try f.putBytes(1, "notes.txt", "Primeiro parágrafo.\n\nSegundo parágrafo.\n");
    try testing.expectEqual(Derivation.pending, (try f.rowFor(1, txt)).?.derivation);

    f.drain();
    try testing.expectEqual(Derivation.derived, (try f.rowFor(1, txt)).?.derivation);
}

test "a derived blob with no text is DERIVED and stays cacheable — the other half of the trap" {
    var f = try Fixture.init();
    defer f.deinit();

    const blank = try f.putNote(1, "blank.note", &.{});
    const scan = try f.putBytes(1, "scan.png", "\x89PNG not text at any point");
    f.drain();

    try testing.expectEqual(Derivation.derived, (try f.rowFor(1, blank)).?.derivation);
    try testing.expectEqual(Derivation.derived, (try f.rowFor(1, scan)).?.derivation);
}

test "a .note is never pending, because nothing is owed for it" {
    var f = try Fixture.init();
    defer f.deinit();

    // The note half is indexed inside the upload transaction.
    const note = try f.putNote(1, "BuJo.note", &.{"segunda-feira"});
    try testing.expectEqual(Derivation.derived, (try f.rowFor(1, note)).?.derivation);
}

test "no row ever reports UNKNOWN now that the seam is filled" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.putNote(1, "own.note", &.{"texto"});
    _ = try f.putBytes(1, "notes.txt", "parágrafo\n\noutro\n");
    _ = try f.putBytes(1, "book.pdf", "%PDF-1.4");
    _ = try f.putBytes(1, "book.pdf.mark", "ink");
    _ = try f.putBytes(1, "scan.png", "\x89PNG");
    try f.db.exec("DELETE FROM note_index WHERE blob_md5 = (SELECT md5 FROM files WHERE name = 'scan.png');");

    const m = try f.manifest(1);
    try testing.expectEqual(@as(usize, 4), m.rows.len);
    for (m.rows) |r| try testing.expect(r.derivation != .unknown);
}

test "CAVEAT: a stale note_index row reports DERIVED though nothing has derived it" {
    var f = try Fixture.init();
    defer f.deinit();

    // Stale `note_index` rows are not offered to the worker, so they read
    // `derived`; safe only because the cache key carries `index_version`.
    const txt = try f.putBytes(1, "notes.txt", "parágrafo um\n\nparágrafo dois\n");
    try testing.expectEqual(Derivation.pending, (try f.rowFor(1, txt)).?.derivation);

    try f.db.exec("UPDATE note_index SET index_version = index_version - 1;");
    const stale = (try f.rowFor(1, txt)).?;
    try testing.expectEqual(Derivation.derived, stale.derivation);
    // ...and the row offers no version, because no such file exists.
    try testing.expect(stale.index_version == null);
    try testing.expect(!f.files.terms.?.has(stale.md5, noteindex.index_version - 1));
}
