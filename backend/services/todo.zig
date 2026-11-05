//! The tablet's To-Do lists and tasks (schema v20), stored as the To-Do app
//! sends them. The tablet decides every merge: it compares `last_modified`
//! and the sort times itself and sends what should change. The server's job
//! is to keep exactly what it was given and list ALL of it back, because a
//! full sync deletes from the tablet any synced list or task the server does
//! not list (decompiled `TaskSync.syncTaskList`/`syncTask`). So rows leave
//! only by an explicit delete from a tablet, or with their account; a delete
//! of something already gone succeeds.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");

pub const Error = sqlite.Error || std.mem.Allocator.Error;

/// The tablet's ids are 32 hex characters; anything longer or with control
/// bytes is refused rather than stored.
pub const max_id_len = 128;

pub fn validId(id: []const u8) bool {
    if (id.len == 0 or id.len > max_id_len) return false;
    for (id) |c| if (c < 0x21 or c > 0x7e) return false;
    return true;
}

pub const List = struct {
    id: []const u8,
    title: []const u8 = "",
    create_time: i64 = 0,
    last_modified: i64 = 0,
    deleted: bool = false,
};

pub const Task = struct {
    id: []const u8,
    /// Null: the Inbox.
    list_id: ?[]const u8 = null,
    title: []const u8 = "",
    detail: ?[]const u8 = null,
    /// `needsAction` or `completed`.
    status: []const u8 = "needsAction",
    importance: ?[]const u8 = null,
    recurrence: ?[]const u8 = null,
    /// The notebook page a lassoed task came from, as the tablet's JSON.
    links: ?[]const u8 = null,
    reminder_on: bool = false,
    due_time: i64 = 0,
    completed_time: i64 = 0,
    last_modified: i64 = 0,
    sort: i64 = 0,
    sort_completed: i64 = 0,
    sort_time: i64 = 0,
    planner_sort: i64 = 0,
    planner_sort_time: i64 = 0,
    deleted: bool = false,
};

/// One page of a listing, keyed by id; `next` is the id to continue after,
/// null on the last page. Strings live in the arena the page was read into.
pub fn Page(comptime T: type) type {
    return struct { items: []T, next: ?[]const u8 };
}

// ---- lists ----

/// Creates or replaces a list: an insert retried after a lost reply, or an
/// update of a list another tablet never saw, both land.
pub fn putList(db: sqlite.Db, user_id: u64, l: List) sqlite.Error!void {
    try db.runCached(
        \\INSERT INTO todo_lists (user_id, list_id, title, create_time, last_modified, deleted)
        \\VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        \\ON CONFLICT (user_id, list_id) DO UPDATE SET
        \\  title = excluded.title, create_time = excluded.create_time,
        \\  last_modified = excluded.last_modified, deleted = excluded.deleted;
    , &.{
        .{ .int = @intCast(user_id) }, .{ .text = l.id },             .{ .text = l.title },
        .{ .int = l.create_time },     .{ .int = l.last_modified },   .{ .int = @intFromBool(l.deleted) },
    });
}

/// Deletes a list and every task in it, as deleting a list on the tablet
/// does. Nothing to delete is not an error.
pub fn deleteList(db: sqlite.Db, user_id: u64, list_id: []const u8) sqlite.Error!void {
    try db.exec("BEGIN IMMEDIATE;");
    errdefer db.exec("ROLLBACK;") catch {};
    const binds: []const sqlite.Bind = &.{ .{ .int = @intCast(user_id) }, .{ .text = list_id } };
    try db.runCached("DELETE FROM todo_tasks WHERE user_id = ?1 AND list_id = ?2;", binds);
    try db.runCached("DELETE FROM todo_lists WHERE user_id = ?1 AND list_id = ?2;", binds);
    try db.exec("COMMIT;");
}

/// Up to `limit` lists after `after` (an id), in id order.
pub fn listsPage(db: sqlite.Db, arena: std.mem.Allocator, user_id: u64, after: ?[]const u8, limit: u32) Error!Page(List) {
    var st = try db.prepareCached(
        \\SELECT list_id, title, create_time, last_modified, deleted FROM todo_lists
        \\WHERE user_id = ?1 AND list_id > ?2 ORDER BY list_id LIMIT ?3;
    );
    defer st.finalize();
    st.bindInt(1, @intCast(user_id));
    st.bindText(2, after orelse "");
    st.bindInt(3, @as(i64, limit) + 1); // one more says whether a next page exists
    var out: std.ArrayList(List) = .empty;
    while (try st.step()) {
        try out.append(arena, .{
            .id = try arena.dupe(u8, st.columnText(0)),
            .title = try arena.dupe(u8, st.columnText(1)),
            .create_time = st.columnInt(2),
            .last_modified = st.columnInt(3),
            .deleted = st.columnInt(4) != 0,
        });
    }
    return pageOf(List, out.items, limit);
}

// ---- tasks ----

/// Creates or replaces a task (see `putList`).
pub fn putTask(db: sqlite.Db, user_id: u64, t: Task) sqlite.Error!void {
    try db.runCached(
        \\INSERT INTO todo_tasks (user_id, task_id, list_id, title, detail, status, importance,
        \\  recurrence, links, reminder_on, due_time, completed_time, last_modified, sort,
        \\  sort_completed, sort_time, planner_sort, planner_sort_time, deleted)
        \\VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
        \\ON CONFLICT (user_id, task_id) DO UPDATE SET
        \\  list_id = excluded.list_id, title = excluded.title, detail = excluded.detail,
        \\  status = excluded.status, importance = excluded.importance,
        \\  recurrence = excluded.recurrence, links = excluded.links,
        \\  reminder_on = excluded.reminder_on, due_time = excluded.due_time,
        \\  completed_time = excluded.completed_time, last_modified = excluded.last_modified,
        \\  sort = excluded.sort, sort_completed = excluded.sort_completed,
        \\  sort_time = excluded.sort_time, planner_sort = excluded.planner_sort,
        \\  planner_sort_time = excluded.planner_sort_time, deleted = excluded.deleted;
    , &.{
        .{ .int = @intCast(user_id) },     .{ .text = t.id },                    .{ .text_opt = t.list_id },
        .{ .text = t.title },              .{ .text_opt = t.detail },            .{ .text = t.status },
        .{ .text_opt = t.importance },     .{ .text_opt = t.recurrence },        .{ .text_opt = t.links },
        .{ .int = @intFromBool(t.reminder_on) }, .{ .int = t.due_time },         .{ .int = t.completed_time },
        .{ .int = t.last_modified },       .{ .int = t.sort },                   .{ .int = t.sort_completed },
        .{ .int = t.sort_time },           .{ .int = t.planner_sort },           .{ .int = t.planner_sort_time },
        .{ .int = @intFromBool(t.deleted) },
    });
}

/// The batch update: all or none, so a failed batch is simply sent again.
pub fn putTasks(db: sqlite.Db, user_id: u64, tasks: []const Task) sqlite.Error!void {
    try db.exec("BEGIN IMMEDIATE;");
    errdefer db.exec("ROLLBACK;") catch {};
    for (tasks) |t| try putTask(db, user_id, t);
    try db.exec("COMMIT;");
}

/// Nothing to delete is not an error.
pub fn deleteTask(db: sqlite.Db, user_id: u64, task_id: []const u8) sqlite.Error!void {
    try db.runCached("DELETE FROM todo_tasks WHERE user_id = ?1 AND task_id = ?2;", &.{
        .{ .int = @intCast(user_id) }, .{ .text = task_id },
    });
}

/// Up to `limit` tasks after `after` (an id), in id order.
pub fn tasksPage(db: sqlite.Db, arena: std.mem.Allocator, user_id: u64, after: ?[]const u8, limit: u32) Error!Page(Task) {
    var st = try db.prepareCached(
        \\SELECT task_id, list_id, title, detail, status, importance, recurrence, links,
        \\  reminder_on, due_time, completed_time, last_modified, sort, sort_completed,
        \\  sort_time, planner_sort, planner_sort_time, deleted
        \\FROM todo_tasks WHERE user_id = ?1 AND task_id > ?2 ORDER BY task_id LIMIT ?3;
    );
    defer st.finalize();
    st.bindInt(1, @intCast(user_id));
    st.bindText(2, after orelse "");
    st.bindInt(3, @as(i64, limit) + 1);
    var out: std.ArrayList(Task) = .empty;
    while (try st.step()) {
        try out.append(arena, .{
            .id = try arena.dupe(u8, st.columnText(0)),
            .list_id = try optText(arena, st, 1),
            .title = try arena.dupe(u8, st.columnText(2)),
            .detail = try optText(arena, st, 3),
            .status = try arena.dupe(u8, st.columnText(4)),
            .importance = try optText(arena, st, 5),
            .recurrence = try optText(arena, st, 6),
            .links = try optText(arena, st, 7),
            .reminder_on = st.columnInt(8) != 0,
            .due_time = st.columnInt(9),
            .completed_time = st.columnInt(10),
            .last_modified = st.columnInt(11),
            .sort = st.columnInt(12),
            .sort_completed = st.columnInt(13),
            .sort_time = st.columnInt(14),
            .planner_sort = st.columnInt(15),
            .planner_sort_time = st.columnInt(16),
            .deleted = st.columnInt(17) != 0,
        });
    }
    return pageOf(Task, out.items, limit);
}

fn optText(arena: std.mem.Allocator, st: sqlite.Stmt, col: c_int) Error!?[]const u8 {
    if (st.columnIsNull(col)) return null;
    return try arena.dupe(u8, st.columnText(col));
}

/// `rows` holds up to `limit + 1`: the extra one only says a next page exists.
fn pageOf(comptime T: type, rows: []T, limit: u32) Page(T) {
    if (rows.len <= limit) return .{ .items = rows, .next = null };
    const items = rows[0..limit];
    return .{ .items = items, .next = items[items.len - 1].id };
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

test "a task comes back exactly as the tablet sent it, and a resend replaces it" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();

    // The July capture's task: Inbox (no list), not yet done.
    const sent: Task = .{
        .id = "f4c4cf48bfe1726d83037156c02350e4", .title = "buy groceries",
        .last_modified = 1784901382926, .sort_time = 1784901382926,
    };
    try putTask(db, 1, sent);
    try putTask(db, 1, sent); // a retried insert is no error

    var done = sent;
    done.status = "completed";
    done.completed_time = 1784901397452;
    done.last_modified = 1784901397452;
    done.links = "{\"page\":3}";
    try putTasks(db, 1, &.{done});

    const page = try tasksPage(db, arena.allocator(), 1, null, 20);
    try testing.expectEqual(@as(usize, 1), page.items.len);
    try testing.expectEqual(@as(?[]const u8, null), page.next);
    const got = page.items[0];
    try testing.expectEqualStrings("completed", got.status);
    try testing.expectEqual(@as(i64, 1784901397452), got.completed_time);
    try testing.expectEqual(@as(?[]const u8, null), got.list_id);
    try testing.expectEqualStrings("{\"page\":3}", got.links.?);
    try testing.expectEqualStrings("buy groceries", got.title);
}

test "deleting a list takes its tasks; other lists, the Inbox and other accounts stay" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();

    try putList(db, 1, .{ .id = "groceries", .title = "Groceries" });
    try putList(db, 1, .{ .id = "work", .title = "Work" });
    try putTask(db, 1, .{ .id = "t1", .list_id = "groceries" });
    try putTask(db, 1, .{ .id = "t2", .list_id = "work" });
    try putTask(db, 1, .{ .id = "t3" });
    try putTask(db, 2, .{ .id = "t4", .list_id = "groceries" }); // same list id, rui's

    try deleteList(db, 1, "groceries");
    try deleteList(db, 1, "groceries"); // already gone: still fine
    try deleteTask(db, 1, "nope");

    const lists = try listsPage(db, arena.allocator(), 1, null, 20);
    try testing.expectEqual(@as(usize, 1), lists.items.len);
    try testing.expectEqualStrings("work", lists.items[0].id);
    const tasks = try tasksPage(db, arena.allocator(), 1, null, 20);
    try testing.expectEqual(@as(usize, 2), tasks.items.len);
    try testing.expectEqualStrings("t2", tasks.items[0].id);
    try testing.expectEqualStrings("t3", tasks.items[1].id);
    try testing.expectEqual(@as(usize, 1), (try tasksPage(db, arena.allocator(), 2, null, 20)).items.len);
}

test "listings page by id and the last page has no token" {
    var db = try testDb();
    defer db.close();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const ids = [_][]const u8{ "a", "b", "c", "d", "e" };
    for (ids) |id| try putTask(db, 1, .{ .id = id });

    var seen: usize = 0;
    var after: ?[]const u8 = null;
    var pages: usize = 0;
    while (true) {
        const p = try tasksPage(db, arena.allocator(), 1, after, 2);
        for (p.items) |t| {
            try testing.expectEqualStrings(ids[seen], t.id);
            seen += 1;
        }
        pages += 1;
        after = p.next orelse break;
    }
    try testing.expectEqual(ids.len, seen);
    try testing.expectEqual(@as(usize, 3), pages);
    // Exactly a page's worth: no empty trailing page is promised.
    const two = try listsPage(db, arena.allocator(), 1, null, 2);
    try testing.expectEqual(@as(?[]const u8, null), two.next);
}

test "a deleted account takes its To-Do data" {
    var db = try testDb();
    defer db.close();
    try putList(db, 1, .{ .id = "l" });
    try putTask(db, 1, .{ .id = "t", .list_id = "l" });
    try db.exec("PRAGMA foreign_keys = ON; DELETE FROM users WHERE id = 1;");
    var r = (try db.row("SELECT (SELECT COUNT(*) FROM todo_lists) + (SELECT COUNT(*) FROM todo_tasks);", &.{})).?;
    defer r.finalize();
    try testing.expectEqual(@as(i64, 0), r.int(0));
}

test "ids: the tablet's 32 hex, nothing empty, long or with control bytes" {
    try testing.expect(validId("f4c4cf48bfe1726d83037156c02350e4"));
    try testing.expect(!validId(""));
    try testing.expect(!validId("a b"));
    const too_long: [max_id_len + 1]u8 = @splat('x');
    try testing.expect(!validId(&too_long));
}
