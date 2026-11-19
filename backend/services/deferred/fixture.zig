//! Fixture and helpers shared by the `deferred` tests.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const blobstore = @import("../../store/blobs.zig");
const derivedstore = @import("../../store/derived.zig");
const txtindex = @import("../txt_index.zig");
const schema = @import("../../db/schema.zig");
const testing = std.testing;
const thumbstore = @import("../../store/thumbs.zig");
const filesmod = @import("../files.zig");
const deferred = @import("../deferred.zig");
const drainNow = deferred.drainNow;

/// Real database, blob store and ingest path, minus the thread.
pub const Fixture = struct {
    db: sqlite.Db,
    files: filesmod.Files,
    tmp: testing.TmpDir,
    lock: std.Io.Mutex = .init,

    pub fn init() !Fixture {
        var db = try sqlite.Db.openMemory();
        try schema.migrate(db);
        try db.run(
            "INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);",
            &.{},
        );
        try db.run("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(1, 0, 1000000000);", &.{});

        const tmp = testing.tmpDir(.{});
        const blobs = try blobstore.BlobStore.init(testing.io, tmp.dir);
        const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
        const thumbs = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
        return .{
            .db = db,
            .files = filesmod.Files.init(testing.allocator, testing.io, db, blobs, thumbs),
            .tmp = tmp,
        };
    }

    pub fn deinit(f: *Fixture) void {
        f.db.close();
        f.tmp.cleanup();
    }

    /// Uploads without draining.
    pub fn put(f: *Fixture, name: []const u8, bytes: []const u8) ![32]u8 {
        var r = std.Io.Reader.fixed(bytes);
        const e = try f.files.putFile(1, null, name, &r, null);
        defer e.deinit(testing.allocator);
        var md5: [32]u8 = undefined;
        @memcpy(&md5, e.md5.?[0..32]);
        return md5;
    }

    pub fn drain(f: *Fixture) void {
        drainNow(testing.allocator, f.db, f.files.blobs, &f.lock, testing.io);
    }

    pub fn stores(f: *Fixture) !struct { terms: derivedstore.DerivedStore, text: derivedstore.DerivedStore } {
        const terms_dir = try f.tmp.dir.createDirPathOpen(testing.io, "terms", .{});
        const text_dir = try f.tmp.dir.createDirPathOpen(testing.io, "text", .{});
        return .{
            .terms = try derivedstore.DerivedStore.init(testing.io, terms_dir),
            .text = try derivedstore.DerivedStore.init(testing.io, text_dir),
        };
    }

    /// Has the `.txt` tenant written its verdict for this blob?
    pub fn txtDone(f: *Fixture, md5: []const u8) !bool {
        return !(try txtindex.needsDerive(f.db, md5));
    }
};

pub const two_paragraphs = "First paragraph, with words in it.\n\nSecond paragraph, also with words.\n";

/// A 200x100 page with `/Rotate 90`, so the right answer is 100x200.
pub const rotate90_pdf = @embedFile("../../pdf/testdata/rotate90.pdf");

/// Three chunks at `pdf_text.chunk_pages`.
pub const book_pdf = @embedFile("../../pdf/testdata/text-120-page.pdf");

/// Page 1's text is four million characters, past MuPDF's memory ceiling, from
/// a few KB of stream; page 2 says "Quince".
pub const text_bomb_pdf = @embedFile("../../pdf/testdata/text-bomb.pdf");

/// `rotate90_pdf` after 2 KB of junk: legal, since MuPDF looks for the header
/// in the first 4 KB.
pub const junk_first_pdf: []const u8 = &(@as([2048]u8, @splat('#')) ++ rotate90_pdf.*);

/// `rotate90_pdf` without its `%PDF-1.x` line: MuPDF opens a file named `.pdf`
/// anyway, and repairs it.
pub const headerless_pdf = rotate90_pdf[std.mem.indexOfScalar(u8, rotate90_pdf, '\n').? + 1 ..];

/// Three 400x300 pages, one word each: Marmalade, Quince, Sourdough.
pub const three_page_xps = @embedFile("../../pdf/testdata/text-three-page.xps");

/// A 300x400 and a 400x300 image: pages, no text.
pub const two_page_cbz = @embedFile("../../pdf/testdata/two-page.cbz");

/// One 17 MiB entry (zeros, so the file itself is small): big, but under
/// MuPDF's memory ceiling (`backend/pdf/budget.h`).
pub const huge_page_cbz = @embedFile("../../pdf/testdata/huge-page.cbz");

/// One 40 MiB entry (zeros): past MuPDF's memory ceiling.
pub const over_budget_cbz = @embedFile("../../pdf/testdata/over-budget.cbz");

/// A 40 MiB part behind a second directory hidden in the zip's comment: the
/// directory a reader that takes the first end record sees is small, the one
/// MuPDF reads is not.
pub const two_eocd_cbz = @embedFile("../../pdf/testdata/two-eocd.cbz");

/// An XPS page split into upper-case `[n].PIECE` entries MuPDF joins to 40 MiB.
pub const upper_pieces_xps = @embedFile("../../pdf/testdata/upper-pieces.xps");

/// `two-page.cbz`'s images in a tar, which MuPDF would open as a comic book.
pub const two_page_tar_cbz = @embedFile("../../pdf/testdata/two-page-tar.cbz");

/// The same tar as v7 (no `ustar` magic), which MuPDF would open too.
pub const two_page_v7tar_cbz = @embedFile("../../pdf/testdata/two-page-v7tar.cbz");

/// An OLE compound-file header: MuPDF has an archive handler for it.
pub const ole_header = @embedFile("../../pdf/testdata/ole-header.cbz");

/// `two-page.cbz` with its end record naming disk 1, a field MuPDF ignores.
pub const disk_one_cbz = @embedFile("../../pdf/testdata/disk-one.cbz");

/// A one-chapter EPUB: reflows, so the server never opens it.
pub const one_chapter_epub = @embedFile("../../pdf/testdata/one-chapter.epub");

/// Two pages, page 0 recognised.
pub const sample2_note = @embedFile("sample-2.note");
