//! Tests for ingest-time derivation and on-demand thumbnail repair.

const std = @import("std");
const testing = std.testing;
const repeat = @import("../../repeat.zig").repeat;
const config = @import("../../config.zig");
const sqlite = @import("../../db/sqlite.zig");
const derivedstore = @import("../../store/derived.zig");
const derivesearch = @import("../derive_search.zig");
const noteindex = @import("../note_index.zig");
const thumbnail = @import("../thumbnail.zig");
const spdindex = @import("../spd_index.zig");
const fx = @import("fixture.zig");
const Fixture = fx.Fixture;
const putBytes = fx.putBytes;
const freeEntry = fx.freeEntry;
const dupeMd5 = fx.dupeMd5;
const cover_png = fx.cover_png;
const buildNote = fx.buildNote;
const noteIndexedAt = fx.noteIndexedAt;

/// JPEG magic plus filler, so derivation runs without a committed binary.
const spd_fake_jpeg = "\xff\xd8\xff\xe0" ++ (repeat(u8, "thumbnail-pixels", 4));

/// A minimal in-memory `.spd` with an optional `config.thumbnail` row.
fn buildSpd(gpa: std.mem.Allocator, thumb: ?[]const u8) ![]u8 {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try db.exec("CREATE TABLE config(name TEXT PRIMARY KEY NOT NULL, value BLOB);");
    try db.exec("INSERT INTO config(name, value) VALUES('fmt_ver', '2');");
    if (thumb) |t| {
        var s = try db.prepare("INSERT INTO config(name, value) VALUES('thumbnail', ?1);");
        defer s.finalize();
        s.bindBlob(1, t);
        _ = try s.step();
    }
    return db.serializeAlloc(gpa);
}

/// Stands in for the handler's `lockDb()`/`unlockDb()`.
const NoLock = struct {
    pub fn lockDb(_: NoLock) void {}
    pub fn unlockDb(_: NoLock) void {}
};

fn spdIndexedAt(f: *Fixture, md5: []const u8) !?i64 {
    var r = (try f.db.row("SELECT indexed_at FROM spd_index WHERE blob_md5 = ?1;", &.{.{ .text = md5 }})) orelse return null;
    defer r.finalize();
    return r.int(0);
}

test "linking a .spd derives the spd_index row + thumbs file; dedup re-link does not re-derive" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

    const spd_bytes = try buildSpd(testing.allocator, spd_fake_jpeg);
    defer testing.allocator.free(spd_bytes);

    const e = try putBytes(&f, 1, null, "drawing.spd", spd_bytes);
    defer freeEntry(e);
    const md5 = e.md5.?;

    try testing.expect(try spdindex.isCurrent(f.db, md5));
    try testing.expect(f.files.thumbs.has(md5));

    // A re-derive would overwrite this `indexed_at` sentinel.
    try f.db.exec("UPDATE spd_index SET indexed_at = 999;");
    const e2 = try putBytes(&f, 1, null, "copy.spd", spd_bytes);
    defer freeEntry(e2);
    try testing.expectEqual(@as(?i64, 999), try spdIndexedAt(&f, md5));

    const disguised = try buildSpd(testing.allocator, "\x89PNG\r\n\x1a\n" ++ (repeat(u8, "z", 40)));
    defer testing.allocator.free(disguised);
    const n = try putBytes(&f, 1, null, "secret.note", disguised);
    defer freeEntry(n);
    try testing.expect(!try spdindex.isCurrent(f.db, n.md5.?));
    try testing.expect(!f.files.thumbs.has(n.md5.?));

    const bad = try putBytes(&f, 1, null, "bad.spd", "this is not a sqlite database at all");
    defer freeEntry(bad);
    try testing.expect(try spdindex.isCurrent(f.db, bad.md5.?)); // indexable = 0, current
    try testing.expect(!f.files.thumbs.has(bad.md5.?));
}

test "purging the last reference removes the spd_index row AND the thumbs file" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

    const spd_bytes = try buildSpd(testing.allocator, spd_fake_jpeg);
    defer testing.allocator.free(spd_bytes);
    const e = try putBytes(&f, 1, null, "drawing.spd", spd_bytes);
    defer freeEntry(e);
    const md5 = dupeMd5(e.md5.?);

    try f.files.trash(1, e.id);
    try f.files.purge(1, e.id);

    try testing.expect(!try spdindex.isCurrent(f.db, &md5)); // row released in the txn
    try testing.expect(!f.files.blobs.has(&md5)); // blob GC'd post-commit
    try testing.expect(!f.files.thumbs.has(&md5)); // and its derived thumbnail with it
}

test "replacing a .spd GCs the OLD blob's thumbs file along with the blob" {
    var f = try Fixture.init();
    defer f.deinit();
    f.files.history.keep = 0; // prune path: a superseded blob (and its thumb) is GC'd at once
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

    const v1 = try buildSpd(testing.allocator, spd_fake_jpeg);
    defer testing.allocator.free(v1);
    const v2 = try buildSpd(testing.allocator, "\x89PNG\r\n\x1a\n" ++ (repeat(u8, "q", 40)));
    defer testing.allocator.free(v2);

    const e1 = try putBytes(&f, 1, null, "drawing.spd", v1);
    defer freeEntry(e1);
    const old_md5 = dupeMd5(e1.md5.?);
    try testing.expect(f.files.thumbs.has(&old_md5));

    const e2 = try putBytes(&f, 1, null, "drawing.spd", v2);
    defer freeEntry(e2);
    try testing.expect(!std.mem.eql(u8, &old_md5, e2.md5.?));
    try testing.expect(!f.files.blobs.has(&old_md5));
    try testing.expect(!f.files.thumbs.has(&old_md5));
    try testing.expect(f.files.thumbs.has(e2.md5.?)); // the new one derived
}

test "repairDerivedThumb (.spd) heals a missing row, a lost file, and a stale version — and memoizes a corrupt .spd" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

    const spd_bytes = try buildSpd(testing.allocator, spd_fake_jpeg);
    defer testing.allocator.free(spd_bytes);
    const e = try putBytes(&f, 1, null, "drawing.spd", spd_bytes);
    defer freeEntry(e);
    const md5 = e.md5.?;

    try f.db.exec("DELETE FROM spd_index;");
    f.files.thumbs.remove(md5);
    try testing.expect(try spdindex.needsRepair(f.db, f.files.thumbs, md5));
    f.files.repairDerivedThumb(NoLock{}, md5);
    try testing.expect(try spdindex.isCurrent(f.db, md5));
    try testing.expect(f.files.thumbs.has(md5));
    try testing.expect(!try spdindex.needsRepair(f.db, f.files.thumbs, md5));

    f.files.thumbs.remove(md5);
    try testing.expect(try spdindex.needsRepair(f.db, f.files.thumbs, md5));
    f.files.repairDerivedThumb(NoLock{}, md5);
    try testing.expect(f.files.thumbs.has(md5));

    try f.db.exec("UPDATE spd_index SET index_version = 0;");
    try testing.expect(try spdindex.needsRepair(f.db, f.files.thumbs, md5));
    f.files.repairDerivedThumb(NoLock{}, md5);
    try testing.expect(try spdindex.isCurrent(f.db, md5));

    const bad = try putBytes(&f, 1, null, "bad.spd", "SQLite format 3\x00 then total garbage \xff\x00\xab");
    defer freeEntry(bad);
    const bad_md5 = bad.md5.?;
    try f.db.exec("DELETE FROM spd_index WHERE indexable = 0;"); // pre-v13 state for it
    try testing.expect(try spdindex.needsRepair(f.db, f.files.thumbs, bad_md5));
    f.files.repairDerivedThumb(NoLock{}, bad_md5);
    try testing.expect(try spdindex.isCurrent(f.db, bad_md5)); // the memo row
    try testing.expect(!f.files.thumbs.has(bad_md5)); // no file was produced
    try testing.expect(!try spdindex.needsRepair(f.db, f.files.thumbs, bad_md5));
    const at = (try spdIndexedAt(&f, bad_md5)).?;
    f.files.repairDerivedThumb(NoLock{}, bad_md5); // double-check gate: a no-op
    try testing.expectEqual(at, (try spdIndexedAt(&f, bad_md5)).?);
}

test "linking a .note with a cover records its location (NOT a thumbs file); a coverless one memoizes NULL and never repairs" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

    const covered = try buildNote(testing.allocator, cover_png);
    defer testing.allocator.free(covered);
    const e = try putBytes(&f, 1, null, "covered.note", covered);
    defer freeEntry(e);
    try testing.expect(!f.files.thumbs.has(e.md5.?));
    {
        var s = try f.db.prepare("SELECT cover_w, cover_h, cover_offset, cover_length, cover_mime FROM note_index WHERE blob_md5 = ?1;");
        defer s.finalize();
        s.bindText(1, e.md5.?);
        try testing.expect(try s.step());
        try testing.expectEqual(@as(i64, 320), s.columnInt(0));
        try testing.expectEqual(@as(i64, 240), s.columnInt(1));
        try testing.expect(s.columnInt(2) > 0); // offset inside the blob
        try testing.expectEqual(@as(i64, cover_png.len), s.columnInt(3));
        try testing.expectEqualStrings("image/png", s.columnText(4));
    }
    const loc = (try f.files.noteCover(e.md5.?)).?;
    try testing.expectEqual(@as(u64, cover_png.len), loc.length);
    try testing.expectEqualStrings("image/png", loc.mime());
    var rbuf: [64]u8 = undefined;
    const got = try f.files.blobs.readRange(e.md5.?, loc.offset, loc.length, rbuf[0..@intCast(loc.length)]);
    try testing.expectEqualSlices(u8, cover_png, got);
    try testing.expect(!f.files.thumbNeedsRepair(e.md5.?));

    // The sentinel would be clobbered by any re-parse.
    const plain = try buildNote(testing.allocator, null);
    defer testing.allocator.free(plain);
    const p = try putBytes(&f, 1, null, "plain.note", plain);
    defer freeEntry(p);
    try testing.expect((try f.files.noteCover(p.md5.?)) == null);
    try f.db.exec("UPDATE note_index SET indexed_at = 999;");
    try testing.expect(!f.files.thumbNeedsRepair(p.md5.?));
    f.files.repairDerivedThumb(NoLock{}, p.md5.?); // gate inside: a no-op
    try testing.expectEqual(@as(?i64, 999), try noteIndexedAt(&f, p.md5.?));

    const txt = try putBytes(&f, 1, null, "readme.txt", "plain text, no magic");
    defer freeEntry(txt);
    try testing.expect(!f.files.thumbNeedsRepair(txt.md5.?));
}

test "repairDerivedThumb (.note) heals a stale row and a wiped row — restoring the recorded cover location, no thumbs file" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

    const covered = try buildNote(testing.allocator, cover_png);
    defer testing.allocator.free(covered);
    const e = try putBytes(&f, 1, null, "covered.note", covered);
    defer freeEntry(e);
    const md5 = e.md5.?;

    try testing.expect(!f.files.thumbs.has(md5));
    try testing.expect(!f.files.thumbNeedsRepair(md5));

    try f.db.exec("UPDATE note_index SET index_version = 3, cover_w = NULL, cover_h = NULL, " ++
        "cover_offset = NULL, cover_length = NULL, cover_mime = NULL;");
    try testing.expect(f.files.thumbNeedsRepair(md5));
    f.files.repairDerivedThumb(NoLock{}, md5);
    try testing.expect(try noteindex.isCurrent(f.db, md5));
    try testing.expect(!f.files.thumbs.has(md5)); // still no derived file
    try testing.expect((try f.files.noteCover(md5)) != null); // location restored

    try f.db.exec("DELETE FROM note_index;");
    try testing.expect(f.files.thumbNeedsRepair(md5));
    f.files.repairDerivedThumb(NoLock{}, md5);
    try testing.expect(try noteindex.isCurrent(f.db, md5));
    try testing.expect((try f.files.noteCover(md5)) != null);
}

test "purging the last reference removes the .note cover file along with the blob" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

    const covered = try buildNote(testing.allocator, cover_png);
    defer testing.allocator.free(covered);
    const e = try putBytes(&f, 1, null, "covered.note", covered);
    defer freeEntry(e);
    const md5 = dupeMd5(e.md5.?);

    try f.files.trash(1, e.id);
    try f.files.purge(1, e.id);
    try testing.expect(!try noteindex.isCurrent(f.db, &md5)); // row released in the txn
    try testing.expect(!f.files.blobs.has(&md5)); // blob GC'd post-commit
    try testing.expect(!f.files.thumbs.has(&md5)); // and its derived cover with it
}

/// A device capture: page 0 finished, page 1 still recognising.
const sample2_note = @embedFile("sample-2.note");

fn wireDerivedStores(f: *Fixture) !void {
    const terms_dir = try f.tmp.dir.createDirPathOpen(testing.io, "terms", .{});
    const text_dir = try f.tmp.dir.createDirPathOpen(testing.io, "text", .{});
    f.files.terms = try derivedstore.DerivedStore.init(testing.io, terms_dir);
    f.files.text = try derivedstore.DerivedStore.init(testing.io, text_dir);
}

test "linking a .note writes BOTH derived files AT INGEST, skipping the page with no transcript" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");
    try wireDerivedStores(&f);

    const e = try putBytes(&f, 1, null, "notes.note", sample2_note);
    defer freeEntry(e);
    const md5 = e.md5.?;

    try testing.expect(f.files.terms.?.has(md5, derivesearch.index_version));
    try testing.expect(f.files.text.?.has(md5, derivesearch.index_version));

    const t = try derivedstore.readPlain(testing.allocator, f.files.terms.?, md5, derivesearch.index_version);
    defer testing.allocator.free(t);
    var lines = std.mem.tokenizeScalar(u8, t, '\n');
    try testing.expect(std.mem.indexOf(u8, lines.next().?, "\"n\":2") != null);
    try testing.expectEqualStrings("{\"p\":0,\"t\":\"middle test\"}", lines.next().?);
    try testing.expect(lines.next() == null); // page 1 is still recognising

    const x = try derivedstore.readPlain(testing.allocator, f.files.text.?, md5, derivesearch.index_version);
    defer testing.allocator.free(x);
    var xlines = std.mem.tokenizeScalar(u8, x, '\n');
    _ = xlines.next();
    const p0 = try std.json.parseFromSlice(std.json.Value, testing.allocator, xlines.next().?, .{});
    defer p0.deinit();
    try testing.expectEqual(@as(i64, 0), p0.value.object.get("p").?.integer);
    try testing.expect(p0.value.object.get("o") == null);
    try testing.expect(p0.value.object.get("l") == null);
    try testing.expectEqualStrings("Test\nMiddle\nTest", p0.value.object.get("t").?.string);
    try testing.expect(xlines.next() == null);
}

test "a .txt through the same path derives NOTHING — `indexable` is the gate" {
    var f = try Fixture.init();
    defer f.deinit();
    try wireDerivedStores(&f);

    const e = try putBytes(&f, 1, null, "readme.txt", "plain text, no magic");
    defer freeEntry(e);
    try testing.expect(!f.files.terms.?.has(e.md5.?, derivesearch.index_version));
    try testing.expect(!f.files.text.?.has(e.md5.?, derivesearch.index_version));
}
