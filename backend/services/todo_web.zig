//! The browser's side of To-Do: the same rows the tablet syncs
//! (`services/todo.zig`), edited the way the tablet's own app edits them, so
//! its next sync takes each change. The tablet merges by time: a newer
//! `last_modified` wins a row, a newer `sort_time` wins its order. So every
//! edit here stamps the server's clock, never the browser's: a browser with a
//! wrong clock can neither win nor lose an edit it did not make. And never
//! less than the row's own time plus one: a tablet whose clock runs ahead
//! stamps its edits in our future, and an edit here stamped behind that (or
//! level with it: the tablet takes only a strictly newer row) would be
//! silently overwritten at its next sync (decompiled `TaskSync.syncTask`).
//!
//! Every edit also sets the row's `web_changed_at` and the account's
//! (`todo_sync_state`), which is how "Waiting for the tablet" is told: a change
//! is waiting until a tablet lists the account's tasks after it.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");
const todo = @import("todo.zig");

pub const Error = sqlite.Error || std.mem.Allocator.Error;

/// The tablet's ids: 32 lowercase hex characters.
pub const id_len = 32;

pub fn newId(random: [16]u8) [id_len]u8 {
    return std.fmt.bytesToHex(random, .lower);
}

pub const Task = struct {
    t: todo.Task,
    /// Changed here and not yet listed by a tablet.
    waiting: bool,
};

pub const List = struct { l: todo.List, waiting: bool };

/// Everything an account has, for the browser, lists in the tablet's order
/// (creation time) and tasks in id order; the page orders them.
pub const Snapshot = struct {
    lists: []List,
    tasks: []Task,
    /// When a tablet last fetched this account's to-dos; null: never.
    tablet_listed_at: ?i64,
    /// Something changed here after that (deletes included).
    waiting: bool,
};

const max_rows = 100_000;

pub fn snapshot(db: sqlite.Db, arena: std.mem.Allocator, user_id: u64) Error!Snapshot {
    const state = try syncState(db, user_id);
    const after = state.tablet_listed_at orelse std.math.minInt(i64);

    const lists = try todo.listsPage(db, arena, user_id, null, max_rows);
    const tasks = try todo.tasksPage(db, arena, user_id, null, max_rows);
    var waiting_lists = try idSet(db, arena, "SELECT list_id FROM todo_lists WHERE user_id = ?1 AND web_changed_at > ?2;", user_id, after);
    var waiting_tasks = try idSet(db, arena, "SELECT task_id FROM todo_tasks WHERE user_id = ?1 AND web_changed_at > ?2;", user_id, after);

    const out_lists = try arena.alloc(List, lists.items.len);
    for (lists.items, out_lists) |l, *o| o.* = .{ .l = l, .waiting = waiting_lists.contains(l.id) };
    std.mem.sort(List, out_lists, {}, struct {
        fn lt(_: void, a: List, b: List) bool {
            return a.l.create_time < b.l.create_time;
        }
    }.lt);
    const out_tasks = try arena.alloc(Task, tasks.items.len);
    for (tasks.items, out_tasks) |t, *o| o.* = .{ .t = t, .waiting = waiting_tasks.contains(t.id) };

    const web = state.web_changed_at orelse std.math.minInt(i64);
    return .{
        .lists = out_lists,
        .tasks = out_tasks,
        .tablet_listed_at = state.tablet_listed_at,
        .waiting = state.web_changed_at != null and web > after,
    };
}

const SyncState = struct { tablet_listed_at: ?i64 = null, web_changed_at: ?i64 = null };

fn syncState(db: sqlite.Db, user_id: u64) sqlite.Error!SyncState {
    var r = (try db.rowCached("SELECT tablet_listed_at, web_changed_at FROM todo_sync_state WHERE user_id = ?1;", &.{.{ .int = @intCast(user_id) }})) orelse return .{};
    defer r.finalize();
    return .{ .tablet_listed_at = r.intOpt(0), .web_changed_at = r.intOpt(1) };
}

fn idSet(db: sqlite.Db, arena: std.mem.Allocator, comptime sql: []const u8, user_id: u64, after: i64) Error!std.StringHashMapUnmanaged(void) {
    var set: std.StringHashMapUnmanaged(void) = .empty;
    var st = try db.prepareCached(sql);
    defer st.finalize();
    st.bindInt(1, @intCast(user_id));
    st.bindInt(2, after);
    while (try st.step()) try set.put(arena, try arena.dupe(u8, st.columnText(0)), {});
    return set;
}

/// The account changed something at `now`.
fn touch(db: sqlite.Db, user_id: u64, now: i64) sqlite.Error!void {
    try db.runCached(
        \\INSERT INTO todo_sync_state (user_id, web_changed_at) VALUES (?1, ?2)
        \\ON CONFLICT (user_id) DO UPDATE SET web_changed_at = excluded.web_changed_at;
    , &.{ .{ .int = @intCast(user_id) }, .{ .int = now } });
}

fn listExists(db: sqlite.Db, user_id: u64, list_id: []const u8) sqlite.Error!bool {
    var r = (try db.rowCached("SELECT 1 FROM todo_lists WHERE user_id = ?1 AND list_id = ?2;", &.{ .{ .int = @intCast(user_id) }, .{ .text = list_id } })) orelse return false;
    r.finalize();
    return true;
}

// ---- lists ----

pub fn createList(db: sqlite.Db, user_id: u64, id: []const u8, title: []const u8, now: i64) sqlite.Error!void {
    try db.exec("BEGIN IMMEDIATE;");
    errdefer db.exec("ROLLBACK;") catch {};
    try db.runCached(
        \\INSERT INTO todo_lists (user_id, list_id, title, create_time, last_modified, web_changed_at)
        \\VALUES (?1, ?2, ?3, ?4, ?4, ?4);
    , &.{ .{ .int = @intCast(user_id) }, .{ .text = id }, .{ .text = title }, .{ .int = now } });
    try touch(db, user_id, now);
    try db.exec("COMMIT;");
}

/// False when there is no such list.
pub fn renameList(db: sqlite.Db, user_id: u64, id: []const u8, title: []const u8, now: i64) sqlite.Error!bool {
    try db.exec("BEGIN IMMEDIATE;");
    errdefer db.exec("ROLLBACK;") catch {};
    try db.runCached(
        \\UPDATE todo_lists SET title = ?3, last_modified = MAX(?4, last_modified + 1), web_changed_at = ?4
        \\WHERE user_id = ?1 AND list_id = ?2;
    , &.{ .{ .int = @intCast(user_id) }, .{ .text = id }, .{ .text = title }, .{ .int = now } });
    const found = db.changes() > 0;
    if (found) try touch(db, user_id, now);
    try db.exec("COMMIT;");
    return found;
}

/// The list and its tasks; the tablet drops them at its next sync, since it
/// deletes whatever synced item the server stops listing.
pub fn deleteList(db: sqlite.Db, user_id: u64, id: []const u8, now: i64) sqlite.Error!void {
    try todo.deleteList(db, user_id, id);
    try touch(db, user_id, now);
}

// ---- tasks ----

pub const NewTask = struct {
    title: []const u8,
    /// Null: the Inbox. Must name an existing list.
    list_id: ?[]const u8 = null,
    due: i64 = 0,
};

pub const CreateError = sqlite.Error || error{NoSuchList};

/// A new task goes on top of its list, as the tablet's "Add" does: sort 0,
/// newest sort time (the tablet orders by sort, then newest sort time).
pub fn createTask(db: sqlite.Db, user_id: u64, id: []const u8, n: NewTask, now: i64) CreateError!void {
    if (n.list_id) |l| if (!try listExists(db, user_id, l)) return error.NoSuchList;
    try db.exec("BEGIN IMMEDIATE;");
    errdefer db.exec("ROLLBACK;") catch {};
    try db.runCached(
        \\INSERT INTO todo_tasks (user_id, task_id, list_id, title, due_time, last_modified, sort, sort_time, web_changed_at)
        \\VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?6, ?6);
    , &.{ .{ .int = @intCast(user_id) }, .{ .text = id }, .{ .text_opt = n.list_id }, .{ .text = n.title }, .{ .int = n.due }, .{ .int = now } });
    try touch(db, user_id, now);
    try db.exec("COMMIT;");
}

/// What an edit changes; null leaves a field as it is.
pub const Patch = struct {
    title: ?[]const u8 = null,
    /// `.inbox` or a list id.
    move_to: ?Where = null,
    /// 0 removes the date.
    due: ?i64 = null,
    done: ?bool = null,

    pub const Where = union(enum) { inbox, list: []const u8 };
};

pub const UpdateError = sqlite.Error || error{ NoSuchTask, NoSuchList };

pub fn updateTask(db: sqlite.Db, user_id: u64, id: []const u8, p: Patch, now: i64) UpdateError!void {
    if (p.move_to) |w| switch (w) {
        .inbox => {},
        .list => |l| if (!try listExists(db, user_id, l)) return error.NoSuchList,
    };
    try db.exec("BEGIN IMMEDIATE;");
    errdefer db.exec("ROLLBACK;") catch {};
    const uid: i64 = @intCast(user_id);
    {
        var r = (try db.rowCached("SELECT 1 FROM todo_tasks WHERE user_id = ?1 AND task_id = ?2;", &.{ .{ .int = uid }, .{ .text = id } })) orelse return error.NoSuchTask;
        r.finalize();
    }
    const base: []const sqlite.Bind = &.{ .{ .int = uid }, .{ .text = id }, .{ .int = now } };
    try db.runCached("UPDATE todo_tasks SET last_modified = MAX(?3, last_modified + 1), web_changed_at = ?3 WHERE user_id = ?1 AND task_id = ?2;", base);
    if (p.title) |t| try db.runCached("UPDATE todo_tasks SET title = ?3 WHERE user_id = ?1 AND task_id = ?2;", &.{ .{ .int = uid }, .{ .text = id }, .{ .text = t } });
    if (p.due) |d| try db.runCached("UPDATE todo_tasks SET due_time = ?3 WHERE user_id = ?1 AND task_id = ?2;", &.{ .{ .int = uid }, .{ .text = id }, .{ .int = d } });
    if (p.done) |d| {
        if (d) {
            try db.runCached("UPDATE todo_tasks SET status = 'completed', completed_time = ?3 WHERE user_id = ?1 AND task_id = ?2;", base);
        } else {
            try db.runCached("UPDATE todo_tasks SET status = 'needsAction', completed_time = 0 WHERE user_id = ?1 AND task_id = ?2;", &.{ .{ .int = uid }, .{ .text = id } });
        }
    }
    // Moved: on top of the new list, like a new task there.
    if (p.move_to) |w| try db.runCached(
        "UPDATE todo_tasks SET list_id = ?3, sort = 0, sort_time = MAX(?4, sort_time + 1) WHERE user_id = ?1 AND task_id = ?2;",
        &.{ .{ .int = uid }, .{ .text = id }, .{ .text_opt = switch (w) {
            .inbox => null,
            .list => |l| l,
        } }, .{ .int = now } },
    );
    try touch(db, user_id, now);
    try db.exec("COMMIT;");
}

/// Gone at the tablet's next sync. Nothing to delete is not an error.
pub fn deleteTask(db: sqlite.Db, user_id: u64, id: []const u8, now: i64) sqlite.Error!void {
    try todo.deleteTask(db, user_id, id);
    try touch(db, user_id, now);
}

/// Sets the open tasks of one list (null: the Inbox) to `ids`' order, as the
/// tablet records a reorder: `sort` is the position, and one new sort time
/// for the whole list, so its next sync takes this order. Ids not in that
/// list are ignored; open tasks missing from `ids` keep their place after.
pub fn reorder(db: sqlite.Db, user_id: u64, list_id: ?[]const u8, ids: []const []const u8, now: i64) sqlite.Error!void {
    try db.exec("BEGIN IMMEDIATE;");
    errdefer db.exec("ROLLBACK;") catch {};
    const uid: i64 = @intCast(user_id);
    // One sort time for the list, past every one it already has (see the top).
    const stamp: i64 = blk: {
        var r = (try db.rowCached(
            "SELECT MAX(sort_time) FROM todo_tasks WHERE user_id = ?1 AND list_id IS ?2 AND status <> 'completed';",
            &.{ .{ .int = uid }, .{ .text_opt = list_id } },
        )) orelse break :blk now;
        defer r.finalize();
        break :blk if (r.isNull(0)) now else @max(now, r.int(0) + 1);
    };
    // Everything after the given ids, in their current order.
    try db.runCached(
        \\UPDATE todo_tasks SET sort = sort + ?3, sort_time = ?4, web_changed_at = ?5
        \\WHERE user_id = ?1 AND list_id IS ?2 AND status <> 'completed';
    , &.{ .{ .int = uid }, .{ .text_opt = list_id }, .{ .int = @intCast(ids.len) }, .{ .int = stamp }, .{ .int = now } });
    for (ids, 0..) |id, i| try db.runCached(
        \\UPDATE todo_tasks SET sort = ?4, sort_time = ?5, web_changed_at = ?6
        \\WHERE user_id = ?1 AND task_id = ?2 AND list_id IS ?3 AND status <> 'completed';
    , &.{ .{ .int = uid }, .{ .text = id }, .{ .text_opt = list_id }, .{ .int = @intCast(i) }, .{ .int = stamp }, .{ .int = now } });
    try touch(db, user_id, now);
    try db.exec("COMMIT;");
}

// ---- links back to a notebook page ----

/// Where a task lassoed from a notebook points: the tablet's path and page
/// (1-based), from its `links` (Base64 JSON, decompiled `LinkInfo`).
pub const Link = struct { path: []const u8, page: i64 };

pub fn decodeLink(arena: std.mem.Allocator, links: []const u8) ?Link {
    const dec = std.base64.standard.Decoder;
    const n = dec.calcSizeForSlice(links) catch return null;
    const raw = arena.alloc(u8, n) catch return null;
    dec.decode(raw, links) catch return null;
    const Wire = struct { filePath: ?[]const u8 = null, page: ?i64 = null };
    const parsed = std.json.parseFromSliceLeaky(Wire, arena, raw, .{ .ignore_unknown_fields = true }) catch return null;
    const path = parsed.filePath orelse return null;
    const page = parsed.page orelse return null;
    if (page < 1) return null;
    return .{ .path = path, .page = page };
}

/// The tablet's storage root, and its top folders as the library names them
/// (the device syncs `Note` under `NOTE`, `Document` under `DOCUMENT`).
const tablet_root = "/storage/emulated/0/";
const tablet_roots = [_]struct { tablet: []const u8, library: []const u8 }{
    .{ .tablet = "Note", .library = "NOTE/Note" },
    .{ .tablet = "MyStyle", .library = "NOTE/MyStyle" },
    .{ .tablet = "Document", .library = "DOCUMENT/Document" },
};

/// A tablet path in the library's own form, or null for one outside its storage.
pub fn libraryPath(arena: std.mem.Allocator, tablet_path: []const u8) ?[]const u8 {
    if (!std.mem.startsWith(u8, tablet_path, tablet_root)) return null;
    const rest = tablet_path[tablet_root.len..];
    const cut = std.mem.indexOfScalar(u8, rest, '/') orelse return null;
    const top = rest[0..cut];
    for (tablet_roots) |r| if (std.mem.eql(u8, r.tablet, top))
        return std.fmt.allocPrint(arena, "{s}{s}", .{ r.library, rest[cut..] }) catch null;
    return rest;
}

// ---- tests ----

const testing = std.testing;
const schema = @import("../db/schema.zig");

fn testDb() !sqlite.Db {
    var db = try sqlite.Db.openMemory();
    errdefer db.close();
    try schema.migrate(db);
    try db.exec("INSERT INTO users (id, email, password_md5, created_at) VALUES (1, 'ana', '', 0), (2, 'rui', '', 0);");
    return db;
}

fn find(snap: Snapshot, id: []const u8) ?Task {
    for (snap.tasks) |t| if (std.mem.eql(u8, t.t.id, id)) return t;
    return null;
}

test "a browser edit waits for the tablet until it lists the account's tasks" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    try createList(db, 1, "groceries", "Groceries", 1000);
    try createTask(db, 1, "t1", .{ .title = "milk", .list_id = "groceries" }, 1001);
    var s = try snapshot(db, a, 1);
    try testing.expect(s.waiting);
    try testing.expect(find(s, "t1").?.waiting);
    try testing.expect(s.lists[0].waiting);
    try testing.expectEqual(@as(?i64, null), s.tablet_listed_at);

    try todo.markTabletListed(db, 1, 2000);
    s = try snapshot(db, a, 1);
    try testing.expect(!s.waiting);
    try testing.expect(!find(s, "t1").?.waiting);

    // Deleting leaves no row behind, but the account still waits.
    try deleteTask(db, 1, "t1", 3000);
    s = try snapshot(db, a, 1);
    try testing.expect(s.waiting);
    try testing.expectEqual(@as(usize, 0), s.tasks.len);

    // A row the tablet sends is on the tablet: never waiting.
    try todo.putTask(db, 1, .{ .id = "t2", .title = "from the tablet" });
    s = try snapshot(db, a, 1);
    try testing.expect(!find(s, "t2").?.waiting);
}

test "edits stamp the server's time; done, due, move and title change only what they name" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    try createList(db, 1, "work", "Work", 10);
    try createTask(db, 1, "t1", .{ .title = "call", .due = 500 }, 20);
    try updateTask(db, 1, "t1", .{ .done = true }, 30);
    var t = find(try snapshot(db, a, 1), "t1").?.t;
    try testing.expectEqualStrings("completed", t.status);
    try testing.expectEqual(@as(i64, 30), t.completed_time);
    try testing.expectEqual(@as(i64, 30), t.last_modified);
    try testing.expectEqual(@as(i64, 500), t.due_time);
    try testing.expectEqualStrings("call", t.title);

    try updateTask(db, 1, "t1", .{ .done = false, .due = 0, .title = "call back", .move_to = .{ .list = "work" } }, 40);
    t = find(try snapshot(db, a, 1), "t1").?.t;
    try testing.expectEqualStrings("needsAction", t.status);
    try testing.expectEqual(@as(i64, 0), t.completed_time);
    try testing.expectEqual(@as(i64, 0), t.due_time);
    try testing.expectEqualStrings("call back", t.title);
    try testing.expectEqualStrings("work", t.list_id.?);
    try testing.expectEqual(@as(i64, 40), t.sort_time);

    try updateTask(db, 1, "t1", .{ .move_to = .inbox }, 50);
    try testing.expectEqual(@as(?[]const u8, null), find(try snapshot(db, a, 1), "t1").?.t.list_id);

    try testing.expectError(error.NoSuchList, updateTask(db, 1, "t1", .{ .move_to = .{ .list = "nope" } }, 60));
    try testing.expectError(error.NoSuchTask, updateTask(db, 1, "nope", .{ .done = true }, 60));
    try testing.expectError(error.NoSuchList, createTask(db, 1, "t9", .{ .title = "x", .list_id = "nope" }, 60));
    // Another account's list is no list at all.
    try createList(db, 2, "rui-list", "Rui", 70);
    try testing.expectError(error.NoSuchList, createTask(db, 1, "t9", .{ .title = "x", .list_id = "rui-list" }, 80));
}

test "reorder: positions become sort, one sort time for the list, others after, completed untouched" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    for ([_][]const u8{ "a", "b", "c", "d" }, 0..) |id, i| try createTask(db, 1, id, .{ .title = id }, @intCast(10 + i));
    try updateTask(db, 1, "d", .{ .done = true }, 20);
    try reorder(db, 1, null, &.{ "c", "a" }, 100);
    const s = try snapshot(db, a, 1);
    try testing.expectEqual(@as(i64, 0), find(s, "c").?.t.sort);
    try testing.expectEqual(@as(i64, 1), find(s, "a").?.t.sort);
    try testing.expect(find(s, "b").?.t.sort >= 2);
    try testing.expectEqual(@as(i64, 100), find(s, "b").?.t.sort_time);
    try testing.expectEqual(@as(i64, 13), find(s, "d").?.t.sort_time); // completed: left alone (its creation time)
    try testing.expect(find(s, "c").?.waiting);
}

test "a tablet clock ahead of ours: every edit still stamps past the row, so the tablet takes it" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    // The tablet's rows carry its clock: 5000, while ours reads 100.
    try todo.putList(db, 1, .{ .id = "l", .title = "L", .create_time = 5000, .last_modified = 5000 });
    try todo.putTask(db, 1, .{ .id = "t1", .list_id = "l", .title = "x", .status = "needsAction", .last_modified = 5000, .sort_time = 5000 });
    try todo.putTask(db, 1, .{ .id = "t2", .list_id = "l", .title = "y", .status = "needsAction", .last_modified = 5000, .sort_time = 7000 });

    try updateTask(db, 1, "t1", .{ .title = "x2" }, 100);
    var s = try snapshot(db, a, 1);
    try testing.expectEqual(@as(i64, 5001), find(s, "t1").?.t.last_modified);
    // Still waiting: `web_changed_at` keeps our own clock.
    try todo.markTabletListed(db, 1, 99);
    try testing.expect(find(try snapshot(db, a, 1), "t1").?.waiting);

    try testing.expect(try renameList(db, 1, "l", "L2", 100));
    s = try snapshot(db, a, 1);
    try testing.expectEqual(@as(i64, 5001), s.lists[0].l.last_modified);

    // One sort time for the list, past its newest (7000).
    try reorder(db, 1, "l", &.{ "t2", "t1" }, 100);
    s = try snapshot(db, a, 1);
    try testing.expectEqual(@as(i64, 7001), find(s, "t1").?.t.sort_time);
    try testing.expectEqual(@as(i64, 7001), find(s, "t2").?.t.sort_time);

    try updateTask(db, 1, "t1", .{ .move_to = .inbox }, 100);
    try testing.expectEqual(@as(i64, 7002), find(try snapshot(db, a, 1), "t1").?.t.sort_time);

    // With our clock ahead, ours wins as before.
    try updateTask(db, 1, "t2", .{ .title = "y2" }, 9000);
    try testing.expectEqual(@as(i64, 9000), find(try snapshot(db, a, 1), "t2").?.t.last_modified);
}

test "lists: renamed and deleted with their tasks; the snapshot keeps creation order" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    try createList(db, 1, "zzz", "First made", 1);
    try createList(db, 1, "aaa", "Second made", 2);
    try testing.expect(try renameList(db, 1, "zzz", "Renamed", 3));
    try testing.expect(!try renameList(db, 1, "nope", "x", 3));
    try testing.expect(!try renameList(db, 2, "zzz", "not rui's", 3));
    var s = try snapshot(db, a, 1);
    try testing.expectEqualStrings("Renamed", s.lists[0].l.title);
    try testing.expectEqualStrings("Second made", s.lists[1].l.title);

    try createTask(db, 1, "t1", .{ .title = "x", .list_id = "zzz" }, 4);
    try deleteList(db, 1, "zzz", 5);
    s = try snapshot(db, a, 1);
    try testing.expectEqual(@as(usize, 1), s.lists.len);
    try testing.expectEqual(@as(usize, 0), s.tasks.len);
}

test "new ids look like the tablet's" {
    const id = newId(.{ 0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 });
    try testing.expectEqual(@as(usize, id_len), id.len);
    try testing.expect(todo.validId(&id));
    try testing.expectEqualStrings("deadbeef", id[0..8]);
}

test "a lassoed task's link: the tablet path becomes the library's, page 1-based" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // "Haus of gabin", as the tablet stored it.
    const links = "eyJhcHBOYW1lIjoibm90ZSIsImZpbGVJZCI6IkYyMDI2MTEwMzA4MDUzMTc4MDY3NURtSHl1TlRQMGtMciIsImZpbGVQYXRoIjoiL3N0b3JhZ2UvZW11bGF0ZWQvMC9Ob3RlL0ZyYW7Dp2Fpcy9BMC5BMSDDiWNvbGUgRHVmbGUvQXBvc3RpbGEubm90ZSIsInBhZ2UiOjI3LCJwYWdlSWQiOiJQMjAyNjExMDMwODExMjAwMTA2ODVENTlhYWlWalNrTGEifQ==";
    const l = decodeLink(a, links).?;
    try testing.expectEqual(@as(i64, 27), l.page);
    try testing.expectEqualStrings("NOTE/Note/Français/A0.A1 École Dufle/Apostila.note", libraryPath(a, l.path).?);
    try testing.expectEqualStrings("INBOX/a.note", libraryPath(a, "/storage/emulated/0/INBOX/a.note").?);
    try testing.expectEqualStrings("NOTE/MyStyle/x.note", libraryPath(a, "/storage/emulated/0/MyStyle/x.note").?);
    try testing.expectEqual(@as(?[]const u8, null), libraryPath(a, "/sdcard/elsewhere.note"));
    try testing.expectEqual(@as(?Link, null), decodeLink(a, "not base64 at all!"));
}
