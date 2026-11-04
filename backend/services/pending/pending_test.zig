//! Tests for the pending-work tracker.

const std = @import("std");
const sqlite = @import("../../db/sqlite.zig");
const deferred = @import("../deferred.zig");
const testing = std.testing;
const schema = @import("../../db/schema.zig");
const blobstore = @import("../../store/blobs.zig");
const thumbstore = @import("../../store/thumbs.zig");
const filesmod = @import("../files.zig");
const pending = @import("../pending.zig");
const count_sql = pending.count_sql;
const owesDerive = pending.owesDerive;
const countFor = pending.countFor;
const Pulse = pending.Pulse;
const fixture = @import("fixture.zig");
const owes_derive_d = fixture.owes_derive_d;

/// Two users: one person's outstanding work must not be another's.
const Fixture = struct {
    db: sqlite.Db,
    files: filesmod.Files,
    tmp: testing.TmpDir,
    lock: std.Io.Mutex = .init,

    fn init() !Fixture {
        var db = try sqlite.Db.openMemory();
        try schema.migrate(db);
        for ([_]u8{ 1, 2 }) |id| {
            try db.run(
                "INSERT INTO users(id, email, password_md5, created_at) VALUES(?1, 'a' || ?1 || '@b.c', '0123456789abcdef0123456789abcdef', 0);",
                &.{.{ .int = id }},
            );
            try db.run(
                "INSERT INTO capacity(user_id, used_bytes, total_bytes) VALUES(?1, 0, 1000000000);",
                &.{.{ .int = id }},
            );
        }

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

    fn deinit(f: *Fixture) void {
        f.db.close();
        f.tmp.cleanup();
    }

    fn put(f: *Fixture, user_id: u64, name: []const u8, bytes: []const u8) ![32]u8 {
        var r = std.Io.Reader.fixed(bytes);
        const e = try f.files.putFile(user_id, null, name, &r, null);
        defer testing.allocator.free(e.name);
        defer if (e.md5) |m| testing.allocator.free(m);
        var md5: [32]u8 = undefined;
        @memcpy(&md5, e.md5.?[0..32]);
        return md5;
    }

    fn drain(f: *Fixture) void {
        deferred.drainNow(testing.allocator, f.db, f.files.blobs, &f.lock, testing.io);
    }

    fn pending(f: *Fixture, user_id: u64) !i64 {
        return countFor(f.db, user_id);
    }
};

const two_paragraphs = "First paragraph, with words in it.\n\nSecond paragraph, also with words.\n";

const rotate90_pdf = @embedFile("../../pdf/testdata/rotate90.pdf");

/// A real two-page capture: the only fixture the `ink` tenant will look at.
const sample2_note = @embedFile("sample-2.note");

test "a just-uploaded .txt is reported pending, and stops being pending when the worker finishes" {
    var f = try Fixture.init();
    defer f.deinit();

    try testing.expectEqual(@as(i64, 0), try f.pending(1));
    _ = try f.put(1, "notes.txt", two_paragraphs);
    try testing.expectEqual(@as(i64, 1), try f.pending(1));

    f.drain();
    try testing.expectEqual(@as(i64, 0), try f.pending(1));
}

test "an UPLOADED .note is not pending; one whose pages predate `has_ink` is, until it heals" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put(1, "notes.note", sample2_note);
    try testing.expectEqual(@as(i64, 0), try f.pending(1));

    // The state of a database migrated from schema v15.
    try f.db.exec("UPDATE note_page_index SET has_ink = NULL;");
    try testing.expectEqual(@as(i64, 1), try f.pending(1));
    {
        var s = try f.db.prepare("SELECT " ++ owes_derive_d ++ " FROM files d WHERE d.md5 = ?1;");
        defer s.finalize();
        s.bindText(1, &md5);
        _ = try s.step();
        try testing.expect(s.columnInt(0) != 0);
    }

    f.drain();
    try testing.expectEqual(@as(i64, 0), try f.pending(1));
}

test "the count and `pending_sql` agree about what is outstanding" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put(1, "notes.txt", two_paragraphs);
    _ = try f.put(1, "doc.pdf", rotate90_pdf);

    try testing.expectEqual(@as(i64, 2), try f.pending(1));

    var guard: usize = 0;
    while (guard < 20) : (guard += 1) {
        const next = try deferred.nextJob(testing.allocator, f.db);
        const count = try f.pending(1);
        if (next) |found| {
            testing.allocator.free(found.name);
            try testing.expect(count > 0); // work to do, and the user is told
        } else {
            try testing.expectEqual(@as(i64, 0), count); // nothing to do, nothing claimed
            break;
        }
        f.drain();
    }
    try testing.expect(guard < 20);
}

test "one user's outstanding work is not another user's pending count" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put(1, "notes.txt", two_paragraphs);
    try testing.expectEqual(@as(i64, 1), try f.pending(1));
    try testing.expectEqual(@as(i64, 0), try f.pending(2));

    try testing.expectEqual(@as(i64, 0), try f.pending(99));
}

test "a trashed .txt is not pending — the bin is not a work queue, here as in the worker" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put(1, "notes.txt", two_paragraphs);
    try f.db.exec("UPDATE files SET deleted = 1 WHERE md5 IS NOT NULL;");
    try testing.expectEqual(@as(i64, 0), try f.pending(1));

    try f.db.exec("UPDATE files SET deleted = 0 WHERE md5 IS NOT NULL;");
    try testing.expectEqual(@as(i64, 1), try f.pending(1));
}

test "ONE PDF owing two questions is ONE pending document, and two holders of one blob are too" {
    var f = try Fixture.init();
    defer f.deinit();

    const md5 = try f.put(1, "doc.pdf", rotate90_pdf);
    var r = std.Io.Reader.fixed(rotate90_pdf);
    const dup = try f.files.putFile(1, null, "copy.pdf", &r, null);
    defer testing.allocator.free(dup.name);
    defer if (dup.md5) |m| testing.allocator.free(m);
    try testing.expectEqualStrings(&md5, dup.md5.?[0..32]); // really the same blob

    try testing.expectEqual(@as(i64, 1), try f.pending(1));
}

test "pending and unsearchable are different numbers, and a note with no recognised text is never pending" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put(1, "ink.note", &.{ 0x6e, 0x6f, 0x74, 0x65, 0x00 });
    f.drain();
    try testing.expectEqual(@as(i64, 0), try f.pending(1));

    _ = try f.put(1, "notes.txt", two_paragraphs);
    try testing.expectEqual(@as(i64, 1), try f.pending(1));
}

test "the pending count is computed once per poll, not once per connected client" {
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.put(1, "notes.txt", two_paragraphs);

    var pulse: Pulse = .{ .db = f.db, .db_lock = &f.lock, .io = testing.io };
    for (0..12) |_| {
        try testing.expectEqual(@as(i64, 1), pulse.forUser(1).pending);
        try testing.expectEqual(@as(i64, 0), pulse.forUser(2).pending);
    }
    try testing.expectEqual(@as(usize, 2), pulse.counts);
}

test "an upload and a finished derive each make the count ask again — the signals are WHEN, never WHAT" {
    var f = try Fixture.init();
    defer f.deinit();

    var w: deferred.Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
    };
    f.files.deferred = &w; // so the ingest path signals
    var pulse: Pulse = .{ .db = f.db, .db_lock = &f.lock, .io = testing.io, .worker = &w };

    try testing.expectEqual(@as(i64, 0), pulse.forUser(1).pending);
    const after_first = pulse.counts;

    _ = try f.put(1, "notes.txt", two_paragraphs);
    try testing.expectEqual(@as(i64, 1), pulse.forUser(1).pending);
    try testing.expect(pulse.counts > after_first);
    const after_upload = pulse.counts;

    for (0..8) |_| try testing.expectEqual(@as(i64, 1), pulse.forUser(1).pending);
    try testing.expectEqual(after_upload, pulse.counts);

    w.drain();
    try testing.expectEqual(@as(i64, 0), pulse.forUser(1).pending);
    try testing.expect(pulse.counts > after_upload);
}

test "the backstop makes a count expire even when nothing signalled" {
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.put(1, "notes.txt", two_paragraphs);

    var pulse: Pulse = .{ .db = f.db, .db_lock = &f.lock, .io = testing.io, .max_age_ms = 60_000 };
    try testing.expectEqual(@as(i64, 1), pulse.forUser(1).pending);
    f.drain();
    try testing.expectEqual(@as(i64, 1), pulse.forUser(1).pending); // still inside the window

    pulse.max_age_ms = 0; // the window closes
    try testing.expectEqual(@as(i64, 0), pulse.forUser(1).pending);
}

test "the version moves when the worker finishes a job and not when a file is renamed" {
    var f = try Fixture.init();
    defer f.deinit();

    var w: deferred.Worker = .{
        .gpa = testing.allocator,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &f.lock,
        .io = testing.io,
    };
    var pulse: Pulse = .{ .db = f.db, .db_lock = &f.lock, .io = testing.io, .worker = &w, .max_age_ms = 0 };

    const before = pulse.forUser(1).version;
    _ = try f.put(1, "notes.txt", two_paragraphs);
    try testing.expectEqual(before, pulse.forUser(1).version); // an upload is not a derive

    w.drain();
    const after = pulse.forUser(1).version;
    try testing.expect(after > before);

    try f.db.exec("UPDATE files SET name = 'renamed.txt' WHERE md5 IS NOT NULL;");
    try testing.expectEqual(after, pulse.forUser(1).version);
}

test "PLAN PIN: the count is bounded by the CALLER's library, and nothing is scanned" {
    // The count must reach `files` by `files_user_parent (user_id=?)`. Not forced
    // with `INDEXED BY`: the planner picks it unaided.
    var f = try Fixture.init();
    defer f.deinit();
    _ = try f.put(1, "notes.txt", two_paragraphs);

    var s = try f.db.prepare("EXPLAIN QUERY PLAN " ++ count_sql);
    defer s.finalize();
    var by_owner: usize = 0;
    var ni_by_pk: usize = 0;
    var blobs_by_pk: usize = 0;
    while (try s.step()) {
        const detail = s.columnText(3);
        if (std.mem.indexOf(u8, detail, "SEARCH f ") != null and
            std.mem.indexOf(u8, detail, "files_user_parent") != null) by_owner += 1;
        if (std.mem.indexOf(u8, detail, "SEARCH ni ") != null) ni_by_pk += 1;
        if (std.mem.indexOf(u8, detail, "SEARCH b ") != null) blobs_by_pk += 1;
        try testing.expect(std.mem.indexOf(u8, detail, "SCAN f") == null);
        try testing.expect(std.mem.indexOf(u8, detail, "SCAN ni") == null);
        try testing.expect(std.mem.indexOf(u8, detail, "SCAN b") == null);
    }
    try testing.expectEqual(deferred.tenants.len, by_owner);
    try testing.expectEqual(deferred.tenants.len, ni_by_pk);
    try testing.expectEqual(deferred.tenants.len, blobs_by_pk);
}

test "`owesDerive` is valid SQL against the real schema, and answers per blob" {
    // An outer row aliased other than `f`, as in the manifest.
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put(1, "notes.txt", two_paragraphs);
    _ = try f.put(1, "ink.note", &.{ 0x6e, 0x6f, 0x74, 0x65, 0x00 });

    const sql = "SELECT d.name, " ++ owes_derive_d ++ " FROM files d WHERE d.user_id = ?1 ORDER BY d.name;";
    const ask = struct {
        fn run(db: sqlite.Db, name: []const u8) !bool {
            var s = try db.prepare("SELECT " ++ owes_derive_d ++ " FROM files d WHERE d.name = ?1;");
            defer s.finalize();
            s.bindText(1, name);
            _ = try s.step();
            return s.columnInt(0) != 0;
        }
    }.run;

    {
        // The manifest reads NULL as `Derivation.unknown`, so rows must be 0 or 1.
        var s = try f.db.prepare(sql);
        defer s.finalize();
        s.bindInt(1, 1);
        var rows: usize = 0;
        while (try s.step()) : (rows += 1) try testing.expect(!s.columnIsNull(1));
        try testing.expectEqual(@as(usize, 2), rows);
    }

    try testing.expect(try ask(f.db, "notes.txt"));
    try testing.expect(!try ask(f.db, "ink.note"));

    f.drain();
    try testing.expect(!try ask(f.db, "notes.txt"));
}

test "the count and `owesDerive` are the same question asked two ways" {
    var f = try Fixture.init();
    defer f.deinit();

    _ = try f.put(1, "notes.txt", two_paragraphs);
    _ = try f.put(1, "doc.pdf", rotate90_pdf);
    _ = try f.put(1, "ink.note", &.{ 0x6e, 0x6f, 0x74, 0x65, 0x00 });
    _ = try f.put(2, "theirs.txt", two_paragraphs);

    const sum_sql = "SELECT COUNT(DISTINCT d.md5) FROM files d WHERE d.user_id = ?1 " ++
        "AND d.deleted = 0 AND d.is_folder = 0 AND d.md5 IS NOT NULL AND " ++ owes_derive_d;

    var guard: usize = 0;
    while (guard < 20) : (guard += 1) {
        var r = (try f.db.row(sum_sql, &.{.{ .int = 1 }})).?;
        const summed = r.int(0);
        r.finalize();
        try testing.expectEqual(try f.pending(1), summed);
        if (summed == 0) break;
        f.drain();
    }
    try testing.expect(guard < 20);
}

test "the count statement is valid SQL against the real schema, and names EVERY tenant" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);
    const s = try db.prepare(count_sql);
    s.finalize();
    for (&deferred.tenants) |*t| {
        try testing.expect(std.mem.indexOf(u8, count_sql, t.from_where) != null);
    }
}
