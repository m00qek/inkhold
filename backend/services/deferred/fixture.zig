//! Fixture and helpers shared by the `deferred` tests.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const blobstore = @import("../../store/blobs.zig");
const derivedstore = @import("../../store/derived.zig");
const txtindex = @import("../txt_index.zig");
const schema = @import("../../db/schema.zig");
const testing = std.testing;
const thumbstore = @import("../../store/thumbs.zig");
const filesvc = @import("../files.zig");
const deferred = @import("../deferred.zig");
const drainNow = deferred.drainNow;

/// Real database, blob store and ingest path, minus the thread.
pub const Fixture = struct {
    db: sqlite.Db,
    files: filesvc.Files,
    tmp: testing.TmpDir,
    lock: std.Io.Mutex = .init,

    pub fn init() !Fixture {
        var db = try sqlite.Db.openMemory();
        try schema.migrate(db);
        var s = try db.prepare(
            "INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);",
        );
        defer s.finalize();
        _ = try s.step();
        var c = try db.prepare("INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(1, 0, 1000000000);");
        defer c.finalize();
        _ = try c.step();

        const tmp = testing.tmpDir(.{});
        const blobs = try blobstore.BlobStore.init(testing.io, tmp.dir);
        const thumbs_dir = try tmp.dir.createDirPathOpen(testing.io, "thumbs", .{});
        const thumbs = try thumbstore.ThumbStore.init(testing.io, thumbs_dir);
        return .{
            .db = db,
            .files = filesvc.Files.init(testing.allocator, testing.io, db, blobs, thumbs),
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
        defer testing.allocator.free(e.name);
        defer if (e.md5) |m| testing.allocator.free(m);
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

/// Two pages, page 0 recognised.
pub const sample2_note = @embedFile("sample-2.note");
