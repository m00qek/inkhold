//! What the server knows about a PDF: how many pages, what shape page 1 is, and
//! whether it opens at all. The `.pdf` half of `note_index`.
//!
//! Deliberately the same shape as `txt_index`, so the deferred worker's three
//! steps apply unchanged: ask under the lock (`needsProbe`), do the expensive
//! part off it (`probe.probeFile`), write under it in one transaction
//! (`store`). Nothing here takes a lock — that discipline belongs to
//! `services/deferred.zig`, where the threading is.
//!

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const blobstore = @import("../store/blobs.zig");
const noteindex = @import("note_index.zig");
const pdfprobe = @import("../pdf/probe.zig");

/// `note_index.pdf_probe`. NULL (absent) means never probed.
pub const Verdict = enum(i64) {
    ok = 0,
    unopenable = 1,
    encrypted = 2,
    no_pages = 3,

    pub fn of(e: pdfprobe.Error) ?Verdict {
        return switch (e) {
            // NOT a verdict about the file — the allocation failed on OUR side,
            // and recording it would permanently write off a good PDF because
            // the machine was briefly out of memory.
            pdfprobe.Error.NoContext => null,
            pdfprobe.Error.Unopenable => .unopenable,
            pdfprobe.Error.Encrypted => .encrypted,
            pdfprobe.Error.NoPages => .no_pages,
        };
    }
};

/// The same extension rule as `txt_index.wants` and `thumbnail.wants`: a
/// leading-dot name (`.pdf`) has no extension, nor does a trailing dot.
pub fn wants(name: []const u8) bool {
    const dot = std.mem.lastIndexOfScalar(u8, name, '.') orelse return false;
    if (dot == 0 or dot + 1 == name.len) return false;
    return std.ascii.eqlIgnoreCase(name[dot + 1 ..], "pdf");
}

/// THE `.pdf` TENANT'S PREDICATE: every `files` row whose blob still owes PDF
/// work, as a bare FROM/WHERE with the `files` alias `f`, the `blobs` alias `b`
/// and the `note_index` alias `ni`. Bound parameter 1 is
/// `noteindex.index_version`.
///
/// **A FROM/WHERE and not a statement, deliberately — this is the one copy**,
/// for the reason `txt_index.pending_from_where` states: `deferred.zig` takes
/// `LIMIT 1` from it and `pending.zig` counts over it. Callers may only ADD a
/// bound (a user scope, a blob scope).
///
/// TWO QUESTIONS, ONE TENANT, asked in order. A PDF owes a PROBE (page count
/// and the page-1 box, ~1 s) and then a TEXT PASS (`pdf_text.zig`, ~2 minutes
/// on the target). One tenant rather than two because `deferred.Worker.drain`
/// offers each blob at most once per pass — its forward-progress guard — so a
/// second tenant asking about the same md5 would be refused as "no progress"
/// and the text would wait for the idle tick.
///
/// The text half is gated on `pdf_probe = 0`: text is never asked of a file
/// whose first answer is missing or negative.
///
/// `LIKE '%_.pdf'` IS `wants`: `_` is LIKE's single-character wildcard, so the
/// pattern demands at least one character before the dot — the rule that makes a
/// bare `.pdf` a leading-dot name rather than a document.
///
/// The `note_index` join is the same ORDER CONTRACT `txt_index` has: a blob
/// whose row is missing or stale is not offered, because the note half heals
/// first and its heal rewrites the row this one writes into.
pub const pending_from_where =
    \\  FROM files f
    \\  JOIN blobs b ON b.md5 = f.md5
    \\  JOIN note_index ni ON ni.blob_md5 = f.md5
    \\ WHERE f.is_folder = 0
    \\   AND f.deleted = 0
    \\   AND f.md5 IS NOT NULL
    \\   AND LOWER(f.name) LIKE '%_.pdf'
    \\   AND ni.index_version = ?1
    \\   AND ni.indexable = 0
    \\   AND (ni.pdf_probe IS NULL
    \\        OR (ni.pdf_probe = 0 AND ni.page_count = 0)
    \\        OR (ni.pdf_probe = 0 AND ni.pdf_text IS NULL))
;

/// Whether this blob still needs probing — the authority the discovery query
/// approximates.
///
/// ASKS THE DATA, NOT ONLY THE MEMO, and that is what makes it survive a heal.
/// The shape lives in the NOTE columns (`page_count`/`width`/`height`), so an
/// `index_version` bump overwrites it with the note parser's own zeroes while
/// the verdict on the same row survives. A memo alone would read "already
/// probed" over a shape the heal had just erased, and the blob would never be
/// offered again — a PDF stuck at 0 pages short of editing the database.
///
/// So `ok` with no `page_count` is outstanding work, unambiguously: a document
/// that really has no pages is `no_pages`, never `ok`. A terminal verdict
/// stored no shape in the first place, so it is deliberately NOT retried.
pub fn needsProbe(db: sqlite.Db, blob_md5: []const u8) !bool {
    var r = (try db.row(
        "SELECT pdf_probe, page_count FROM note_index " ++
            "WHERE blob_md5 = ?1 AND index_version = ?2 AND indexable = 0;",
        &.{ .{ .text = blob_md5 }, .{ .int = noteindex.index_version } },
    )) orelse return false; // no current row: the note half heals first
    defer r.finalize();
    const verdict = r.intOpt(0);
    if (verdict == null) return true;
    return verdict == @as(?i64, @intFromEnum(Verdict.ok)) and r.int(1) == 0;
}

/// Record a successful probe. Call inside the caller's transaction.
pub fn store(db: sqlite.Db, blob_md5: []const u8, shape: pdfprobe.Shape) !void {
    var s = try db.prepare(
        "UPDATE note_index SET page_count = ?2, width = ?3, height = ?4, pdf_probe = 0 WHERE blob_md5 = ?1;",
    );
    defer s.finalize();
    s.bindText(1, blob_md5);
    s.bindInt(2, @intCast(shape.pages));
    // Points, ROUNDED to whole units. The columns are INTEGER and the consumer
    // is an aspect ratio, so sub-point precision buys nothing a tile could show.
    s.bindInt(3, @intFromFloat(@round(shape.width)));
    s.bindInt(4, @intFromFloat(@round(shape.height)));
    _ = try s.step();
}

/// Record a verdict that is NOT a shape, so the file is never probed again.
/// Leaves `page_count`/`width`/`height` alone: they are already zero, and zero
/// is what `aspectOf` reads as "no fact".
pub fn storeVerdict(db: sqlite.Db, blob_md5: []const u8, v: Verdict) !void {
    var s = try db.prepare("UPDATE note_index SET pdf_probe = ?2 WHERE blob_md5 = ?1;");
    defer s.finalize();
    s.bindText(1, blob_md5);
    s.bindInt(2, @intFromEnum(v));
    _ = try s.step();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;
const schema = @import("../db/schema.zig");

test "wants is the extension rule, not a substring match" {
    try testing.expect(wants("a.pdf"));
    try testing.expect(wants("A.PDF"));
    try testing.expect(wants("some.name.pdf"));
    try testing.expect(!wants(".pdf")); // leading dot: no extension
    try testing.expect(!wants("pdf"));
    try testing.expect(!wants("a.pdf.mark")); // the mark, not the document
    try testing.expect(!wants("a."));
}

test "NoContext is not a verdict — a transient failure must not write off a good file" {
    try testing.expectEqual(@as(?Verdict, null), Verdict.of(pdfprobe.Error.NoContext));
    try testing.expectEqual(@as(?Verdict, .unopenable), Verdict.of(pdfprobe.Error.Unopenable));
    try testing.expectEqual(@as(?Verdict, .encrypted), Verdict.of(pdfprobe.Error.Encrypted));
    try testing.expectEqual(@as(?Verdict, .no_pages), Verdict.of(pdfprobe.Error.NoPages));
}

test "the pending predicate compiles against the real schema" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);
    const s = try db.prepare("SELECT f.md5\n" ++ pending_from_where ++ ";");
    s.finalize();
}
