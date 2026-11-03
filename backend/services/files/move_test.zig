//! Tests for move and rename.

const std = @import("std");
const testing = std.testing;
const filesmod = @import("../files.zig");
const Entry = filesmod.Entry;
const sqlite = @import("../../db/sqlite.zig");
const nb = @import("note_builder");
const fx = @import("fixture.zig");
const Fixture = fx.Fixture;
const putBytes = fx.putBytes;
const freeEntry = fx.freeEntry;

/// A one-page `.note` with `labels` as finished recognition.
fn putSearchNote(f: *Fixture, user_id: u64, parent: ?u64, name: []const u8, labels: []const []const u8) !Entry {
    const bytes = try nb.serialize(testing.allocator, .{ .pages = &.{.{
        .layers = &.{.{ .slot = .main, .bitmap = "AAAA" }},
        .recogn_status = 1,
        .recogn_labels = labels,
    }} });
    defer testing.allocator.free(bytes);
    var r = std.Io.Reader.fixed(bytes);
    return f.files.putFile(user_id, parent, name, &r, null);
}

test "move renames in place and relocates between folders, bumping sync each time" {
    var f = try Fixture.init();
    defer f.deinit();

    const notes = try f.files.createFolder(1, null, "Notes");
    defer freeEntry(notes);
    const docs = try f.files.createFolder(1, null, "Docs");
    defer freeEntry(docs);
    const a = try putBytes(&f, 1, notes.id, "a.note", "aaaa");
    defer freeEntry(a);

    const v0 = try f.files.syncVersion(1);
    {
        const moved = try f.files.move(1, a.id, notes.id, "b.note", false);
        defer freeEntry(moved);
        try testing.expectEqual(a.id, moved.id);
        try testing.expectEqual(notes.id, moved.parent_id.?);
        try testing.expectEqualStrings("b.note", moved.name);
    }
    try testing.expectEqual(@as(?u64, a.id), try f.files.resolvePath(1, "/Notes/b.note"));
    try testing.expectEqual(@as(?u64, null), try f.files.resolvePath(1, "/Notes/a.note"));
    try testing.expect(try f.files.syncVersion(1) > v0);

    const v1 = try f.files.syncVersion(1);
    {
        const moved = try f.files.move(1, a.id, docs.id, "b.note", false);
        defer freeEntry(moved);
        try testing.expectEqual(docs.id, moved.parent_id.?);
    }
    try testing.expectEqual(@as(?u64, a.id), try f.files.resolvePath(1, "/Docs/b.note"));
    try testing.expectEqual(@as(?u64, null), try f.files.resolvePath(1, "/Notes/b.note"));
    try testing.expect(try f.files.syncVersion(1) > v1);

    {
        const moved = try f.files.move(1, a.id, null, "b.note", false);
        defer freeEntry(moved);
        try testing.expectEqual(@as(?u64, null), moved.parent_id);
    }
    try testing.expectEqual(@as(?u64, a.id), try f.files.resolvePath(1, "/b.note"));
}

test "move of a FOLDER carries its whole subtree — every descendant's path follows in one txn" {
    var f = try Fixture.init();
    defer f.deinit();

    const src = try f.files.createFolder(1, null, "Src");
    defer freeEntry(src);
    const inner = try f.files.createFolder(1, src.id, "inner");
    defer freeEntry(inner);
    const deep = try putBytes(&f, 1, inner.id, "deep.note", "dddd");
    defer freeEntry(deep);
    const top = try putBytes(&f, 1, src.id, "top.note", "tttt");
    defer freeEntry(top);
    const dst = try f.files.createFolder(1, null, "Dst");
    defer freeEntry(dst);

    {
        const moved = try f.files.move(1, src.id, dst.id, "Src", false);
        defer freeEntry(moved);
        try testing.expectEqual(dst.id, moved.parent_id.?);
    }

    try testing.expectEqual(@as(?u64, src.id), try f.files.resolvePath(1, "/Dst/Src"));
    try testing.expectEqual(@as(?u64, inner.id), try f.files.resolvePath(1, "/Dst/Src/inner"));
    try testing.expectEqual(@as(?u64, deep.id), try f.files.resolvePath(1, "/Dst/Src/inner/deep.note"));
    try testing.expectEqual(@as(?u64, top.id), try f.files.resolvePath(1, "/Dst/Src/top.note"));
    try testing.expectEqual(@as(?u64, null), try f.files.resolvePath(1, "/Src"));
    try testing.expectEqual(@as(?u64, null), try f.files.resolvePath(1, "/Src/inner/deep.note"));

    const deep_path = try f.files.pathOf(testing.allocator, 1, deep.id);
    defer testing.allocator.free(deep_path);
    try testing.expectEqualStrings("/Dst/Src/inner/deep.note", deep_path);
}

test "move name conflict: autorename=false refuses without clobbering; autorename=true suffixes" {
    var f = try Fixture.init();
    defer f.deinit();

    const notes = try f.files.createFolder(1, null, "Notes");
    defer freeEntry(notes);
    const a = try putBytes(&f, 1, notes.id, "a.note", "aaaa");
    defer freeEntry(a);
    const b = try putBytes(&f, 1, notes.id, "b.note", "bbbb");
    defer freeEntry(b);

    try testing.expectError(error.NameConflict, f.files.move(1, a.id, notes.id, "b.note", false));
    try testing.expectEqual(@as(?u64, a.id), try f.files.resolvePath(1, "/Notes/a.note"));
    try testing.expectEqual(@as(?u64, b.id), try f.files.resolvePath(1, "/Notes/b.note"));

    {
        const moved = try f.files.move(1, a.id, notes.id, "b.note", true);
        defer freeEntry(moved);
        try testing.expectEqualStrings("b (2).note", moved.name);
    }
    try testing.expectEqual(@as(?u64, a.id), try f.files.resolvePath(1, "/Notes/b (2).note"));
    try testing.expectEqual(@as(?u64, b.id), try f.files.resolvePath(1, "/Notes/b.note"));
    try testing.expectEqual(@as(?u64, null), try f.files.resolvePath(1, "/Notes/a.note"));
}

test "move is a clean no-op when the target is the row's own current parent+name" {
    var f = try Fixture.init();
    defer f.deinit();

    const notes = try f.files.createFolder(1, null, "Notes");
    defer freeEntry(notes);
    const a = try putBytes(&f, 1, notes.id, "a.note", "aaaa");
    defer freeEntry(a);

    const v0 = try f.files.syncVersion(1);
    const moved = try f.files.move(1, a.id, notes.id, "a.note", false);
    defer freeEntry(moved);
    try testing.expectEqual(a.id, moved.id);
    try testing.expectEqualStrings("a.note", moved.name);
    try testing.expectEqual(v0, try f.files.syncVersion(1));
}

test "move is user-scoped: an unknown id and a foreign id are both NotFound, and nothing crosses accounts" {
    var f = try Fixture.init();
    defer f.deinit();

    const a = try putBytes(&f, 1, null, "mine.note", "aaaa");
    defer freeEntry(a);
    const bob = try putBytes(&f, 2, null, "bob.note", "bbbb");
    defer freeEntry(bob);

    try testing.expectError(error.NotFound, f.files.move(1, 999_999, null, "x.note", false));

    try testing.expectError(error.NotFound, f.files.move(1, bob.id, null, "stolen.note", false));
    const still = (try f.files.get(2, bob.id)).?;
    defer freeEntry(still);
    try testing.expectEqualStrings("bob.note", still.name);
    try testing.expect((try f.files.get(1, bob.id)) == null); // invisible to user 1
}

test "move refuses to send a folder into its own subtree (or into itself)" {
    var f = try Fixture.init();
    defer f.deinit();

    const parent = try f.files.createFolder(1, null, "Parent");
    defer freeEntry(parent);
    const child = try f.files.createFolder(1, parent.id, "Child");
    defer freeEntry(child);

    try testing.expectError(error.InvalidMove, f.files.move(1, parent.id, child.id, "Parent", false));
    try testing.expectError(error.InvalidMove, f.files.move(1, parent.id, parent.id, "Parent", false));

    try testing.expectEqual(@as(?u64, parent.id), try f.files.resolvePath(1, "/Parent"));
    try testing.expectEqual(@as(?u64, child.id), try f.files.resolvePath(1, "/Parent/Child"));
}

test "SEARCH-NEUTRALITY: a renamed + relocated note leaves the blob-keyed index untouched" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.db.exec("UPDATE capacity SET total_bytes = 100000000 WHERE user_id = 1;");

    const note = try putSearchNote(&f, 1, null, "orig.note", &.{"quarterly roadmap review"});
    defer freeEntry(note);

    // A re-derive moves `indexed_at` even when the row count is unchanged.
    const IndexState = struct { rows: i64, indexed_at: i64 };
    const read = struct {
        fn get(db: sqlite.Db, md5: []const u8) !IndexState {
            var r = (try db.row(
                "SELECT (SELECT COUNT(*) FROM note_page_index WHERE blob_md5 = ?1), " ++
                    "indexed_at FROM note_index WHERE blob_md5 = ?1;",
                &.{.{ .text = md5 }},
            )) orelse return error.NoIndexRow;
            defer r.finalize();
            return .{ .rows = r.int(0), .indexed_at = r.int(1) };
        }
    }.get;
    const before = try read(f.db, note.md5.?);
    try testing.expect(before.rows > 0); // or the assertion below is vacuous

    const archive = try f.files.createFolder(1, null, "Archive");
    defer freeEntry(archive);
    {
        const moved = try f.files.move(1, note.id, archive.id, "renamed.note", false);
        defer freeEntry(moved);
        try testing.expectEqualStrings("renamed.note", moved.name);
    }
    try testing.expectEqual(@as(?u64, note.id), try f.files.resolvePath(1, "/Archive/renamed.note"));

    const after = try read(f.db, note.md5.?);
    try testing.expectEqual(before.rows, after.rows);
    try testing.expectEqual(before.indexed_at, after.indexed_at);
}
