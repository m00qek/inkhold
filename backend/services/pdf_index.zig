//! What the server records about a PDF: page count, page-1 shape, a probe
//! verdict. Locking is the deferred worker's job, not this file's.

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
            // Our allocation failed, not the file; recording it would write
            // off a good PDF for good.
            pdfprobe.Error.NoContext => null,
            pdfprobe.Error.Unopenable => .unopenable,
            pdfprobe.Error.Encrypted => .encrypted,
            pdfprobe.Error.NoPages => .no_pages,
        };
    }
};

/// A leading-dot name (`.pdf`) has no extension, nor does a trailing dot.
pub fn wants(name: []const u8) bool {
    const dot = std.mem.lastIndexOfScalar(u8, name, '.') orelse return false;
    if (dot == 0 or dot + 1 == name.len) return false;
    return std.ascii.eqlIgnoreCase(name[dot + 1 ..], "pdf");
}

/// The `.pdf` tenant's predicate as a bare FROM/WHERE (aliases `f`, `b`, `ni`;
/// `?1` is `noteindex.index_version`), shared by `deferred.zig` and
/// `pending.zig`; callers may only add bounds. One tenant asks both questions
/// (probe, then text pass gated on `pdf_probe = 0`) because the worker offers a
/// blob at most once per pass. `LIKE '%_.pdf'` is `wants`. A missing or stale
/// `note_index` row is not offered: the note half heals first.
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

/// Whether this blob still needs probing. Checks `page_count` as well as the
/// verdict because an `index_version` heal zeroes the shape columns but keeps
/// `pdf_probe`; `ok` with no pages is therefore outstanding work. Terminal
/// verdicts are not retried.
pub fn needsProbe(db: sqlite.Db, blob_md5: []const u8) !bool {
    var r = (try db.row(
        "SELECT pdf_probe, page_count FROM note_index " ++
            "WHERE blob_md5 = ?1 AND index_version = ?2 AND indexable = 0;",
        &.{ .{ .text = blob_md5 }, .{ .int = noteindex.index_version } },
    )) orelse return false; // no current row: the note half heals first
    defer r.finalize();
    const verdict = r.intOpt(0);
    if (verdict == null) return true;
    return verdict == @as(?i64, @backingInt(Verdict.ok)) and r.int(1) == 0;
}

/// Record a successful probe. Call inside the caller's transaction.
pub fn store(db: sqlite.Db, blob_md5: []const u8, shape: pdfprobe.Shape) !void {
    var s = try db.prepare(
        "UPDATE note_index SET page_count = ?2, width = ?3, height = ?4, pdf_probe = 0 WHERE blob_md5 = ?1;",
    );
    defer s.finalize();
    s.bindText(1, blob_md5);
    s.bindInt(2, @intCast(shape.pages));
    // Rounded to whole points; the consumer is an aspect ratio.
    s.bindInt(3, @intFromFloat(@round(shape.width)));
    s.bindInt(4, @intFromFloat(@round(shape.height)));
    _ = try s.step();
}

/// Record a non-shape verdict so the file is never probed again. The shape
/// columns stay zero, which `aspectOf` reads as "no fact".
pub fn storeVerdict(db: sqlite.Db, blob_md5: []const u8, v: Verdict) !void {
    var s = try db.prepare("UPDATE note_index SET pdf_probe = ?2 WHERE blob_md5 = ?1;");
    defer s.finalize();
    s.bindText(1, blob_md5);
    s.bindInt(2, @backingInt(v));
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
