//! What the server records about a paged document (a PDF, an XPS or a CBZ):
//! page count, page-1 shape, a probe verdict. MuPDF opens all three alike;
//! the name says "pdf" because PDFs came first. Locking is the deferred
//! worker's job, not this file's.

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
    /// Opening it needed more than MuPDF's memory ceiling (`backend/pdf/
    /// budget.h`): a zip entry read whole, a decompression bomb, a huge image.
    too_large = 4,

    pub fn of(e: pdfprobe.Error) ?Verdict {
        return switch (e) {
            // Our allocation failed, not the file; recording it would write
            // off a good PDF for good.
            pdfprobe.Error.NoContext => null,
            pdfprobe.Error.Unopenable => .unopenable,
            pdfprobe.Error.Encrypted => .encrypted,
            pdfprobe.Error.NoPages => .no_pages,
            pdfprobe.Error.TooLarge => .too_large,
        };
    }
};

/// The paged formats, lowercase, no dot: fixed pages that MuPDF lays out
/// once. Never EPUB or FB2, which reflow (laid out whole on open). The
/// browser's `PAGED_DOCUMENT_TYPES` matches.
pub const extensions = [_][]const u8{ "pdf", "xps", "cbz" };

/// Paged formats whose pages are images (comic books): no text pass, which
/// would read the whole file to learn that.
const textless = [_][]const u8{"cbz"};

/// How far into a file MuPDF looks for `%PDF-` (`pdf_recognize_doc_content`:
/// 4096 bytes in which the header may start, plus its five).
const pdf_header_window = 4096 + 5;

/// A leading-dot name (`.pdf`) has no extension, nor does a trailing dot.
fn extensionOf(name: []const u8) ?[]const u8 {
    const dot = std.mem.lastIndexOfScalar(u8, name, '.') orelse return null;
    if (dot == 0 or dot + 1 == name.len) return null;
    return name[dot + 1 ..];
}

fn listed(list: []const []const u8, name: []const u8) bool {
    const ext = extensionOf(name) orelse return false;
    for (list) |e| {
        if (std.ascii.eqlIgnoreCase(ext, e)) return true;
    }
    return false;
}

/// Whether the name is a paged document's: the extension rule, not a substring.
pub fn wants(name: []const u8) bool {
    return listed(&extensions, name);
}

/// Whether a paged document can have text: not a CBZ.
pub fn hasText(name: []const u8) bool {
    return wants(name) and !listed(&textless, name);
}

/// What the worker may do with a file, decided by its bytes (`gate`).
pub const Gate = enum {
    /// A PDF or a zip: MuPDF may open it, under its memory ceiling.
    open,
    /// Neither (a tar, an OLE file, junk): verdict `unopenable`, without MuPDF
    /// ever seeing it.
    refuse,
};

/// Whether MuPDF may open this file: a PDF (its header where MuPDF looks for
/// it) or a zip (its first local header) goes to MuPDF; so does any file named
/// `.pdf`, which MuPDF opens as a PDF without a header, repairing it, as it
/// did before XPS and CBZ were read here. Anything else (a tar, an OLE file,
/// junk) is refused unread. Whatever passes, only a zip is opened by its
/// content; the rest is read as a PDF (`backend/pdf/open.h`), so a tar named
/// `.pdf` never reaches MuPDF's archive readers. What opening may cost is not
/// decided here but bounded where it is spent: MuPDF's allocator
/// (`backend/pdf/pool.zig`).
pub fn gate(io: std.Io, file: std.Io.File, name: []const u8) Gate {
    if (listed(&.{"pdf"}, name)) return .open;
    var head: [pdf_header_window]u8 = undefined;
    const n = file.readPositional(io, &.{&head}, 0) catch return .refuse;
    if (std.mem.indexOf(u8, head[0..n], "%PDF-") != null) return .open;
    if (n >= zip_magic.len and std.mem.eql(u8, head[0..zip_magic.len], zip_magic)) return .open;
    return .refuse;
}

/// A zip's local file header, which every zip MuPDF opens as a CBZ or XPS starts with.
const zip_magic = "PK\x03\x04";

/// `wants` as SQL over `<column>`: one `LIKE '%_.<ext>'` per paged format, so
/// the queries cannot drift from the list.
pub fn nameLike(comptime column: []const u8) []const u8 {
    comptime {
        var out: []const u8 = "(";
        for (extensions, 0..) |ext, i| {
            if (i > 0) out = out ++ " OR ";
            out = out ++ "LOWER(" ++ column ++ ") LIKE '%_." ++ ext ++ "'";
        }
        return out ++ ")";
    }
}

/// The paged tenant's predicate as a bare FROM/WHERE (aliases `f`, `b`, `ni`;
/// `?1` is `noteindex.index_version`), shared by `deferred.zig` and
/// `pending.zig`; callers may only add bounds. One tenant asks both questions
/// (probe, then text pass gated on `pdf_probe = 0`) because the worker offers a
/// blob at most once per pass. The `LIKE`s are `wants`. A missing or stale
/// `note_index` row is not offered: the note half heals first.
pub const pending_from_where =
    \\  FROM files f
    \\  JOIN blobs b ON b.md5 = f.md5
    \\  JOIN note_index ni ON ni.blob_md5 = f.md5
    \\ WHERE f.is_folder = 0
    \\   AND f.deleted = 0
    \\   AND f.md5 IS NOT NULL
    \\   AND
++ " " ++ nameLike("f.name") ++ "\n" ++
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

/// Whether the probe opened this blob and said `ok`: the only state in which
/// anything else may open it. Unprobed, refused (`too_large`) or broken files
/// are never opened behind the probe's back.
pub fn probedOk(db: sqlite.Db, blob_md5: []const u8) !bool {
    var r = (try db.row(
        "SELECT pdf_probe FROM note_index " ++
            "WHERE blob_md5 = ?1 AND index_version = ?2 AND indexable = 0;",
        &.{ .{ .text = blob_md5 }, .{ .int = noteindex.index_version } },
    )) orelse return false;
    defer r.finalize();
    return r.intOpt(0) == @as(?i64, @backingInt(Verdict.ok));
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
    try db.run(
        "UPDATE note_index SET pdf_probe = ?2 WHERE blob_md5 = ?1;",
        &.{ .{ .text = blob_md5 }, .{ .int = @backingInt(v) } },
    );
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
    try testing.expect(wants("Manual.XPS"));
    try testing.expect(wants("comic.cbz"));
    try testing.expect(!wants("book.epub")); // reflows: laid out whole on open
    try testing.expect(!wants("book.fb2"));
    try testing.expect(!wants("comic.cbz.mark"));
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
