//! What changed in one library after a point: the auto-sync push
//! (`handlers/device/socket.zig`). Every write that a tablet must hear about
//! bumps `updated_at`: an edit, a move or rename, a trash (each row of the
//! subtree, with its old path in `deleted_path`), a restore.

const std = @import("std");
const filesmod = @import("../files.zig");
const Files = filesmod.Files;

/// A row seen: the keyset the next page continues after. Rows sharing one
/// second (a folder trashed whole) are told apart by id, so a page boundary
/// never loops. Between checks a caller restarts from `since(second)`
/// instead: a row changed twice within one second keeps its id, and the
/// keyset alone would skip the second change.
pub const Cursor = struct {
    updated_at: i64,
    id: u64,

    /// Every row updated in `second` or later (ids start at 1).
    pub fn since(second: i64) Cursor {
        return .{ .updated_at = second, .id = 0 };
    }
};

pub const Change = struct {
    id: u64,
    is_folder: bool,
    deleted: bool,
    /// The full path, leading slash: the live one, or where it was when trashed.
    path: []u8,
};

pub const Page = struct {
    changes: []Change,
    /// Where to continue; unchanged when nothing new.
    next: Cursor,

    pub fn deinit(p: Page, gpa: std.mem.Allocator) void {
        for (p.changes) |c| gpa.free(c.path);
        gpa.free(p.changes);
    }
};

/// Up to `limit` rows of `user_id` updated after `after`, oldest first. A
/// live row whose path cannot be rebuilt (a parent gone meanwhile) is skipped
/// but still moves the cursor.
pub fn changedAfter(self: Files, gpa: std.mem.Allocator, user_id: u64, after: Cursor, limit: usize) !Page {
    var out: std.ArrayList(Change) = .empty;
    errdefer {
        for (out.items) |c| gpa.free(c.path);
        out.deinit(gpa);
    }
    var next = after;
    var s = try self.db.prepare(
        \\SELECT id, is_folder, deleted, deleted_path, updated_at FROM files
        \\ WHERE user_id = ?1 AND (updated_at > ?2 OR (updated_at = ?2 AND id > ?3))
        \\ ORDER BY updated_at, id LIMIT ?4;
    );
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    s.bindInt(2, after.updated_at);
    s.bindInt(3, @intCast(after.id));
    s.bindInt(4, @intCast(limit));
    var rows: std.ArrayList(struct { id: u64, folder: bool, deleted: bool, old: ?[]u8 }) = .empty;
    defer {
        for (rows.items) |r| if (r.old) |o| gpa.free(o);
        rows.deinit(gpa);
    }
    // Collected first: `pathOf` runs statements of its own.
    while (try s.step()) {
        const deleted = s.columnInt(2) != 0;
        try rows.append(gpa, .{
            .id = @intCast(s.columnInt(0)),
            .folder = s.columnInt(1) != 0,
            .deleted = deleted,
            .old = if (deleted and !s.columnIsNull(3)) try gpa.dupe(u8, s.columnText(3)) else null,
        });
        next = .{ .updated_at = s.columnInt(4), .id = @intCast(s.columnInt(0)) };
    }
    for (rows.items) |*r| {
        const path = if (r.deleted) blk: {
            const o = r.old orelse continue;
            r.old = null;
            break :blk o;
        } else self.pathOf(gpa, user_id, r.id) catch continue;
        if (path.len <= 1) {
            gpa.free(path);
            continue;
        }
        errdefer gpa.free(path);
        try out.append(gpa, .{ .id = r.id, .is_folder = r.folder, .deleted = r.deleted, .path = path });
    }
    return .{ .changes = try out.toOwnedSlice(gpa), .next = next };
}

const testing = std.testing;
const fx = @import("fixture.zig");

test "changedAfter: new rows, then only newer ones; a trashed file by its old path; one library only" {
    var f = try fx.Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    const note = try f.files.createFolder(1, null, "Note");
    defer fx.freeEntry(note);
    const a = try fx.putBytes(&f, 1, note.id, "a.note", "aaaa");
    defer fx.freeEntry(a);
    const other = try f.files.createFolder(2, null, "Theirs");
    defer fx.freeEntry(other);

    const first = try f.files.changedAfter(gpa, 1, .{ .updated_at = 0, .id = 0 }, 50);
    defer first.deinit(gpa);
    try testing.expectEqual(@as(usize, 2), first.changes.len);
    try testing.expectEqualStrings("/Note", first.changes[0].path);
    try testing.expect(first.changes[0].is_folder);
    try testing.expectEqualStrings("/Note/a.note", first.changes[1].path);
    try testing.expect(!first.changes[1].deleted);

    // Nothing new: an empty page, the cursor where it was.
    const none = try f.files.changedAfter(gpa, 1, first.next, 50);
    defer none.deinit(gpa);
    try testing.expectEqual(@as(usize, 0), none.changes.len);
    try testing.expectEqual(first.next, none.next);

    // A change in the same second as the last row seen, to that same row: the
    // keyset alone would skip it; `since` does not.
    try f.files.trash(1, a.id);
    const gone = try f.files.changedAfter(gpa, 1, .since(first.next.updated_at), 50);
    defer gone.deinit(gpa);
    const trashed = for (gone.changes) |c| {
        if (c.id == a.id) break c;
    } else return error.TestUnexpectedResult;
    try testing.expect(trashed.deleted);
    try testing.expectEqualStrings("/Note/a.note", trashed.path);
    // Seconds before are not reread.
    try f.db.exec("UPDATE files SET updated_at = 5 WHERE user_id = 1;");
    const later = try f.files.changedAfter(gpa, 1, .since(6), 50);
    defer later.deinit(gpa);
    try testing.expectEqual(@as(usize, 0), later.changes.len);
}

test "changedAfter: a page boundary inside one second continues by id" {
    var f = try fx.Fixture.init();
    defer f.deinit();
    const gpa = testing.allocator;
    for ([_][]const u8{ "A", "B", "C" }) |n| fx.freeEntry(try f.files.createFolder(1, null, n));
    try f.db.exec("UPDATE files SET updated_at = 100;");

    const p1 = try f.files.changedAfter(gpa, 1, .{ .updated_at = 0, .id = 0 }, 2);
    defer p1.deinit(gpa);
    try testing.expectEqual(@as(usize, 2), p1.changes.len);
    const p2 = try f.files.changedAfter(gpa, 1, p1.next, 2);
    defer p2.deinit(gpa);
    try testing.expectEqual(@as(usize, 1), p2.changes.len);
    try testing.expectEqualStrings("/C", p2.changes[0].path);
}
