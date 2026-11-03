//! Tests for the file tree: create, list, paths, walks and sync versions.

const std = @import("std");
const testing = std.testing;
const filesmod = @import("../files.zig");
const Files = filesmod.Files;
const internal = @import("internal.zig");
const blobstore = @import("../../store/blobs.zig");
const fx = @import("fixture.zig");
const Fixture = fx.Fixture;
const putBytes = fx.putBytes;
const countOf = fx.countOf;
const freeEntry = fx.freeEntry;
const dupeMd5 = fx.dupeMd5;

test "create folders and files, then list them" {
    var f = try Fixture.init();
    defer f.deinit();

    const notes = try f.files.createFolder(1, null, "Notes");
    defer testing.allocator.free(notes.name);
    const a = try putBytes(&f, 1, notes.id, "a.note", "aaaa");
    defer freeEntry(a);
    const b = try putBytes(&f, 1, notes.id, "b.note", "bbbbbb");
    defer freeEntry(b);

    const entries = try f.files.list(1, notes.id);
    defer Files.freeEntries(testing.allocator, entries);
    try testing.expectEqual(@as(usize, 2), entries.len);
    try testing.expectEqualStrings("a.note", entries[0].name);
    try testing.expectEqual(@as(u64, 4), entries[0].size);
    try testing.expectEqual(@as(i64, 10), try f.used(1)); // 4 + 6
}

test "childCount counts direct live children of every kind, and never a trashed one" {
    var f = try Fixture.init();
    defer f.deinit();

    const notes = try f.files.createFolder(1, null, "Notes");
    defer testing.allocator.free(notes.name);
    const sub = try f.files.createFolder(1, notes.id, "Projects");
    defer testing.allocator.free(sub.name);

    const a = try putBytes(&f, 1, notes.id, "a.note", "aaaa");
    defer freeEntry(a);
    const b = try putBytes(&f, 1, notes.id, "lease.pdf", "bbbb");
    defer freeEntry(b);
    const deep = try putBytes(&f, 1, sub.id, "deep.note", "cccc");
    defer freeEntry(deep);

    try testing.expectEqual(@as(i64, 3), try f.files.childCount(1, notes.id));
    try testing.expectEqual(@as(i64, 1), try f.files.childCount(1, sub.id));

    try f.files.trash(1, b.id);
    const entries = try f.files.list(1, notes.id);
    defer Files.freeEntries(testing.allocator, entries);
    try testing.expectEqual(@as(usize, 2), entries.len); // Projects + a.note
    try testing.expectEqual(@as(i64, 2), try f.files.childCount(1, notes.id));

    try f.files.trash(1, sub.id);
    try testing.expectEqual(@as(i64, 1), try f.files.childCount(1, notes.id));

    const empty = try f.files.createFolder(1, null, "Empty");
    defer testing.allocator.free(empty.name);
    try testing.expectEqual(@as(i64, 0), try f.files.childCount(1, empty.id));

    try testing.expectEqual(@as(i64, 0), try f.files.childCount(2, notes.id));
}

test "replacing a file swaps its blob and adjusts capacity; the old blob is GC'd" {
    var f = try Fixture.init();
    defer f.deinit();
    f.files.history.keep = 0; // the keep = 0 path: prune-on-supersede, no history

    const v1 = try putBytes(&f, 1, null, "note", "hello");
    const md5_v1 = dupeMd5(v1.md5.?);
    freeEntry(v1);
    try testing.expect(f.files.blobs.has(&md5_v1));
    try testing.expectEqual(@as(i64, 5), try f.used(1));

    const v2 = try putBytes(&f, 1, null, "note", "a much longer body");
    defer freeEntry(v2);
    try testing.expectEqual(@as(i64, 18), try f.used(1)); // replaced 5 with 18
    try testing.expect(!f.files.blobs.has(&md5_v1)); // old blob gone
    try testing.expect(f.files.blobs.has(v2.md5.?)); // new blob present
    try testing.expectEqual(@as(i64, 0), try countOf(&f, "SELECT COUNT(*) FROM file_history;")); // keep=0: nothing retained

    const entries = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, entries);
    try testing.expectEqual(@as(usize, 1), entries.len);
}

test "identical content dedups: shared blob survives until the last reference is deleted" {
    var f = try Fixture.init();
    defer f.deinit();

    const a = try putBytes(&f, 1, null, "a", "same bytes");
    const b = try putBytes(&f, 1, null, "b", "same bytes");
    const md5 = dupeMd5(a.md5.?);
    freeEntry(a);
    freeEntry(b);
    try testing.expect(f.files.blobs.has(&md5)); // one physical blob, two refs

    try f.files.trash(1, 1);
    try f.files.purge(1, 1); // destroy "a" for real
    try testing.expect(f.files.blobs.has(&md5)); // still referenced by "b"

    try f.files.trash(1, 2);
    try f.files.purge(1, 2); // destroy "b"
    try testing.expect(!f.files.blobs.has(&md5)); // now GC'd
    try testing.expectEqual(@as(i64, 0), try f.used(1));
}

test "purging a folder recurses, frees capacity, and GCs its blobs" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    const sub = try f.files.createFolder(1, dir.id, "Sub");
    defer testing.allocator.free(sub.name);
    const a = try putBytes(&f, 1, dir.id, "a", "1234");
    const md5a = dupeMd5(a.md5.?);
    freeEntry(a);
    const b = try putBytes(&f, 1, sub.id, "b", "567");
    const md5b = dupeMd5(b.md5.?);
    freeEntry(b);
    try testing.expectEqual(@as(i64, 7), try f.used(1));

    try f.files.trash(1, dir.id); // the whole tree into the bin…
    try testing.expectEqual(@as(i64, 7), try f.used(1)); // …still charged, still on disk
    try testing.expect(f.files.blobs.has(&md5a));
    try f.files.purge(1, dir.id); // …and now destroyed

    try testing.expectEqual(@as(i64, 0), try f.used(1));
    try testing.expect(!f.files.blobs.has(&md5a));
    try testing.expect(!f.files.blobs.has(&md5b));
    const root = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, root);
    try testing.expectEqual(@as(usize, 0), root.len); // subtree gone
}

test "createFolderPath: creates ancestors, and autorename governs only the leaf" {
    var f = try Fixture.init();
    defer f.deinit();

    const a = try f.files.createFolderPath(1, "/NOTE/Note/Trip", false);
    defer testing.allocator.free(a.name);
    try testing.expectEqualStrings("Trip", a.name);
    try testing.expect(a.is_folder);
    const p = try f.files.pathOf(testing.allocator, 1, a.id);
    defer testing.allocator.free(p);
    try testing.expectEqualStrings("/NOTE/Note/Trip", p);

    const again = try f.files.createFolderPath(1, "/NOTE/Note/Trip", false);
    defer testing.allocator.free(again.name);
    try testing.expectEqual(a.id, again.id);

    const renamed = try f.files.createFolderPath(1, "/NOTE/Note/Trip", true);
    defer testing.allocator.free(renamed.name);
    try testing.expectEqualStrings("Trip (2)", renamed.name);
    try testing.expect(renamed.id != a.id);

    const sibling = try f.files.createFolderPath(1, "/NOTE/Note/Other", true);
    defer testing.allocator.free(sibling.name);
    try testing.expectEqualStrings("Other", sibling.name);
    const note_id = (try f.files.resolvePath(1, "/NOTE/Note")).?;
    try testing.expectEqual(note_id, sibling.parent_id.?);

    const root_level = try f.files.createFolderPath(1, "Inbox", false);
    defer testing.allocator.free(root_level.name);
    try testing.expect(root_level.parent_id == null);
    try testing.expectError(error.NotFound, f.files.createFolderPath(1, "/", false));
}

test "createFolderPath: a FILE in the way is a conflict, or a rename if asked" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "D");
    defer testing.allocator.free(dir.name);
    const note = try putBytes(&f, 1, dir.id, "x", "bytes");
    freeEntry(note);

    try testing.expectError(error.NameConflict, f.files.createFolderPath(1, "/D/x", false));

    const renamed = try f.files.createFolderPath(1, "/D/x", true);
    defer testing.allocator.free(renamed.name);
    try testing.expectEqualStrings("x (2)", renamed.name);
    try testing.expect(renamed.is_folder);

    try testing.expectError(error.NameConflict, f.files.createFolderPath(1, "/D/x/deeper", false));
    try testing.expectError(error.NameConflict, f.files.createFolderPath(1, "/D/x/deeper", true));
}

test "createFolderPath is scoped per user: same path, two independent trees" {
    var f = try Fixture.init();
    defer f.deinit();

    const one = try f.files.createFolderPath(1, "/NOTE/Shared", false);
    defer testing.allocator.free(one.name);
    const two = try f.files.createFolderPath(2, "/NOTE/Shared", false);
    defer testing.allocator.free(two.name);

    try testing.expect(one.id != two.id);
    try testing.expectEqualStrings("Shared", two.name);
    try testing.expect((try f.files.get(1, two.id)) == null); // foreign id: invisible
}

test "name conflicts and bad parents are rejected; users are isolated" {
    var f = try Fixture.init();
    defer f.deinit();

    const dir = try f.files.createFolder(1, null, "Dir");
    defer testing.allocator.free(dir.name);
    try testing.expectError(error.NameConflict, f.files.createFolder(1, null, "Dir"));

    const file = try putBytes(&f, 1, null, "thing", "x");
    defer freeEntry(file);
    try testing.expectError(error.NameConflict, f.files.createFolder(1, null, "thing"));
    var r = std.Io.Reader.fixed("y");
    try testing.expectError(error.NameConflict, f.files.putFile(1, null, "Dir", &r, null));

    var r2 = std.Io.Reader.fixed("z");
    try testing.expectError(error.NotAFolder, f.files.putFile(1, file.id, "child", &r2, null));
    try testing.expectError(error.NotFound, f.files.createFolder(1, 9999, "x"));

    const u2list = try f.files.list(2, null);
    defer Files.freeEntries(testing.allocator, u2list);
    try testing.expectEqual(@as(usize, 0), u2list.len);
    try testing.expectError(error.NotFound, f.files.createFolder(2, dir.id, "x")); // dir belongs to user 1
    try testing.expect((try f.files.get(2, file.id)) == null);
}

test "pathOf derives full paths; ensureFolderPath is idempotent and nests" {
    var f = try Fixture.init();
    defer f.deinit();

    const note_id = try f.files.ensureFolderPath(1, "NOTE/Note");
    _ = try f.files.ensureFolderPath(1, "NOTE/MyStyle");
    const note_id2 = try f.files.ensureFolderPath(1, "NOTE/Note"); // no duplicate
    try testing.expectEqual(note_id, note_id2);

    const root = try f.files.list(1, null);
    defer Files.freeEntries(testing.allocator, root);
    try testing.expectEqual(@as(usize, 1), root.len);
    try testing.expectEqualStrings("NOTE", root[0].name);
    const under_note = try f.files.list(1, root[0].id);
    defer Files.freeEntries(testing.allocator, under_note);
    try testing.expectEqual(@as(usize, 2), under_note.len);

    const file = try putBytes(&f, 1, note_id, "foo.note", "data");
    defer freeEntry(file);
    const p = try f.files.pathOf(testing.allocator, 1, file.id);
    defer testing.allocator.free(p);
    try testing.expectEqualStrings("/NOTE/Note/foo.note", p);

    const rootfile = try putBytes(&f, 1, null, "top.note", "x");
    defer freeEntry(rootfile);
    const rp = try f.files.pathOf(testing.allocator, 1, rootfile.id);
    defer testing.allocator.free(rp);
    try testing.expectEqualStrings("/top.note", rp);

    try testing.expectError(error.NameConflict, f.files.ensureFolderPath(1, "top.note/sub"));
}

test "walkTree materializes the tree with Dropbox path_display + parent_path in one pass" {
    var f = try Fixture.init();
    defer f.deinit();

    const note = try f.files.ensureFolderPath(1, "NOTE/Note"); // /NOTE, /NOTE/Note
    const a = try putBytes(&f, 1, note, "a.note", "aaaa");
    const a_id = a.id;
    freeEntry(a);
    const top = try putBytes(&f, 1, null, "top.note", "x"); // root-level file
    const top_id = top.id;
    freeEntry(top);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const nodes = try f.files.walkTree(arena.allocator(), 1);

    try testing.expectEqual(@as(usize, 4), nodes.len);

    try testing.expectEqualStrings("NOTE", nodes[0].name);
    try testing.expect(nodes[0].is_folder);
    try testing.expectEqualStrings("/NOTE", nodes[0].path_display);
    try testing.expectEqualStrings("/", nodes[0].parent_path);
    try testing.expectEqualStrings("", nodes[0].md5);
    try testing.expectEqual(@as(u64, 0), nodes[0].size);

    const file = nodes[2];
    try testing.expectEqual(a_id, file.id);
    try testing.expectEqualStrings("a.note", file.name);
    try testing.expect(!file.is_folder);
    try testing.expectEqualStrings("/NOTE/Note/a.note", file.path_display);
    try testing.expectEqualStrings("/NOTE/Note", file.parent_path);
    try testing.expectEqualStrings(&blobstore.md5HexOf("aaaa"), file.md5);
    try testing.expectEqual(@as(u64, 4), file.size);

    try testing.expectEqualStrings("/top.note", nodes[3].path_display);
    try testing.expectEqualStrings("/", nodes[3].parent_path);

    const byid = (try f.files.nodeById(arena.allocator(), 1, a_id)).?;
    try testing.expectEqualStrings("/NOTE/Note/a.note", byid.path_display);
    try testing.expectEqualStrings("/NOTE/Note", byid.parent_path);
    try testing.expect((try f.files.nodeById(arena.allocator(), 1, 99999)) == null);
    try testing.expect((try f.files.nodeById(arena.allocator(), 2, a_id)) == null); // foreign user

    try testing.expectEqual(a_id, (try f.files.resolvePath(1, "/NOTE/Note/a.note")).?);
    try testing.expectEqual(note, (try f.files.resolvePath(1, "/NOTE/Note")).?);
    try testing.expectEqual(top_id, (try f.files.resolvePath(1, "/top.note")).?);
    try testing.expect((try f.files.resolvePath(1, "/")) == null);
    try testing.expect((try f.files.resolvePath(1, "/NOTE/nope")) == null);
    try testing.expect((try f.files.resolvePath(2, "/NOTE/Note/a.note")) == null); // user isolation
}

test "syncVersion starts at 0 and bumps on every tree mutation" {
    var f = try Fixture.init();
    defer f.deinit();

    try testing.expectEqual(@as(i64, 0), try f.files.syncVersion(1));

    const dir = try f.files.createFolder(1, null, "Dir"); // bump 1
    defer testing.allocator.free(dir.name);
    try testing.expectEqual(@as(i64, 1), try f.files.syncVersion(1));

    const a = try putBytes(&f, 1, dir.id, "a.note", "aaaa"); // bump 2
    freeEntry(a);
    try testing.expectEqual(@as(i64, 2), try f.files.syncVersion(1));

    const a2 = try putBytes(&f, 1, dir.id, "a.note", "bbbb"); // replace → bump 3
    freeEntry(a2);
    try testing.expectEqual(@as(i64, 3), try f.files.syncVersion(1));

    try f.files.trash(1, dir.id); // bump 4
    try testing.expectEqual(@as(i64, 4), try f.files.syncVersion(1));

    try f.files.trash(1, dir.id); // idempotent retry: nothing changed, no bump
    try testing.expectEqual(@as(i64, 4), try f.files.syncVersion(1));

    const restored = try f.files.restore(1, dir.id); // bump 5
    restored.deinit(testing.allocator);
    try testing.expectEqual(@as(i64, 5), try f.files.syncVersion(1));

    try f.files.trash(1, dir.id); // bump 6
    try f.files.purge(1, dir.id); // bump 7
    try testing.expectEqual(@as(i64, 7), try f.files.syncVersion(1));

    try testing.expectEqual(@as(i64, 0), try f.files.syncVersion(2));
}

test "linkBlob links a pre-stored blob, replaces, and enforces quota" {
    var f = try Fixture.init();
    defer f.deinit();

    var r = std.Io.Reader.fixed("note bytes");
    const res = try f.files.blobs.put(&r, null);
    try testing.expect(f.files.blobs.has(&res.md5));

    const e = try f.files.linkBlob(1, null, "a.note", &res.md5, res.size);
    defer freeEntry(e);
    try testing.expectEqualStrings(&res.md5, e.md5.?);
    try testing.expectEqual(res.size, e.size);
    try testing.expectEqual(@as(i64, @intCast(res.size)), try f.used(1));
    try testing.expectEqual(@as(i64, 1), try f.files.syncVersion(1));

    var big: [1025]u8 = undefined;
    @memset(&big, 'x');
    var rb = std.Io.Reader.fixed(&big);
    const rbig = try f.files.blobs.put(&rb, null);
    try testing.expectError(error.QuotaExceeded, f.files.linkBlob(1, null, "big", &rbig.md5, rbig.size));
    try testing.expect(f.files.blobs.has(&rbig.md5));
    try testing.expectEqual(@as(i64, @intCast(res.size)), try f.used(1)); // unchanged
}
