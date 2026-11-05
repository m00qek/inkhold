//! The tablet's To-Do sync: `/api/file/schedule/…`, the calls the To-Do app
//! makes (decompiled `TaskService`/`TaskSync`), with the wire shapes of the
//! July capture of the official server. Storage and the rules that keep it
//! safe are `services/todo.zig`.
//!
//! OFF unless `config.todo_sync`: until it is proven on a tablet, every call
//! is refused with `success: false` at HTTP 200, which ends the app's sync
//! with a generic error before it compares anything. An empty "no lists"
//! would instead make it delete every list it once synced; 401/403/404 take
//! other paths in the app (sign-out prompts, "not found").
//!
//! Deletes always succeed, even of something already gone: the app aborts
//! its whole sync on any failed delete.

const std = @import("std");
const router = @import("../../http/router.zig");
const context = @import("../../http/context.zig");
const json = @import("../../http/json.zig");
const reply = @import("../../http/reply.zig");
const todo = @import("../../services/todo.zig");

const Context = context.Context;
const Request = router.Request;
const Params = router.Params;

const fail = reply.fail;
const serverError = reply.serverError;

pub const unsupported = "TODO_SYNC_UNSUPPORTED";
const unsupported_msg = "To-Do sync is not supported by this server yet";

/// The app asks for 20 (tasks) or 200 (lists) a page; cap what it may ask.
const default_page = 100;
const max_page = 500;

// ---- wire shapes (the tablet's Gson classes) ----

/// `TaskListData`.
const ListWire = struct {
    taskListId: ?[]const u8 = null,
    title: ?[]const u8 = null,
    createTime: ?i64 = null,
    lastModified: ?i64 = null,
    isDeleted: ?[]const u8 = null,
    userId: ?[]const u8 = null,
};

/// `TaskData`; `planerSort` is the app's own spelling.
const TaskWire = struct {
    taskId: ?[]const u8 = null,
    taskListId: ?[]const u8 = null,
    title: ?[]const u8 = null,
    detail: ?[]const u8 = null,
    status: ?[]const u8 = null,
    importance: ?[]const u8 = null,
    recurrence: ?[]const u8 = null,
    links: ?[]const u8 = null,
    isReminderOn: ?[]const u8 = null,
    dueTime: ?i64 = null,
    completedTime: ?i64 = null,
    lastModified: ?i64 = null,
    sort: ?i64 = null,
    sortCompleted: ?i64 = null,
    sortTime: ?i64 = null,
    planerSort: ?i64 = null,
    planerSortTime: ?i64 = null,
    isDeleted: ?[]const u8 = null,
};

/// `GroupArg`: numbers arrive as strings.
const GroupAllReq = struct { maxResults: ?[]const u8 = null, pageToken: ?[]const u8 = null };
/// `TasksArg`: note the request's `nextPageTokens`, plural.
const TaskAllReq = struct { maxResults: ?[]const u8 = null, nextPageTokens: ?[]const u8 = null, nextSyncToken: ?[]const u8 = null };
/// `TasksRequest`.
const TaskBatchReq = struct { taskListId: ?[]const u8 = null, updateScheduleTaskList: ?[]const TaskWire = null };

const GroupAllVO = struct { success: bool = true, pageToken: ?[]const u8 = null, scheduleTaskGroup: []const ListOut };
const TaskAllVO = struct { success: bool = true, nextPageToken: ?[]const u8 = null, nextSyncToken: i64, scheduleTask: []const TaskOut };
const InsertListVO = struct { success: bool = true, taskListId: []const u8 };
const InsertTaskVO = struct { success: bool = true, taskId: []const u8 };

const ListOut = struct {
    taskListId: []const u8,
    title: []const u8,
    createTime: i64,
    lastModified: i64,
    isDeleted: []const u8,
    userId: []const u8,
};

const TaskOut = struct {
    taskId: []const u8,
    taskListId: ?[]const u8,
    title: []const u8,
    detail: ?[]const u8,
    lastModified: i64,
    recurrence: ?[]const u8,
    isReminderOn: []const u8,
    status: []const u8,
    importance: ?[]const u8,
    dueTime: i64,
    completedTime: i64,
    links: ?[]const u8,
    isDeleted: []const u8,
    sort: i64,
    sortCompleted: i64,
    planerSort: i64,
    sortTime: i64,
    planerSortTime: i64,
};

// ---- lists ----

/// POST /api/file/schedule/group/all
pub fn groupAll(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.todo_sync) return refuse(ctx, req);
    const user_id = ctx.caller.?.user_id;
    var parsed = json.readBody(GroupAllReq, ctx.gpa, req) catch return badBody(ctx, req);
    defer parsed.deinit();

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const page = todo.listsPage(ctx.db, a, user_id, token(parsed.value.pageToken), pageSize(parsed.value.maxResults)) catch
        return serverError(ctx, req);
    var user_buf: [24]u8 = undefined;
    const user = std.fmt.bufPrint(&user_buf, "{d}", .{user_id}) catch unreachable;
    const out = try a.alloc(ListOut, page.items.len);
    for (page.items, out) |l, *o| o.* = .{
        .taskListId = l.id,
        .title = l.title,
        .createTime = l.create_time,
        .lastModified = l.last_modified,
        .isDeleted = yn(l.deleted),
        .userId = user,
    };
    try json.respond(ctx.gpa, req, .ok, GroupAllVO{ .pageToken = page.next, .scheduleTaskGroup = out }, null);
}

/// POST /api/file/schedule/group
pub fn groupInsert(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.todo_sync) return refuse(ctx, req);
    var parsed = json.readBody(ListWire, ctx.gpa, req) catch return badBody(ctx, req);
    defer parsed.deinit();
    const list = listOf(parsed.value) orelse return badBody(ctx, req);
    todo.putList(ctx.db, ctx.caller.?.user_id, list) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, InsertListVO{ .taskListId = list.id }, null);
}

/// PUT /api/file/schedule/group
pub fn groupUpdate(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.todo_sync) return refuse(ctx, req);
    var parsed = json.readBody(ListWire, ctx.gpa, req) catch return badBody(ctx, req);
    defer parsed.deinit();
    const list = listOf(parsed.value) orelse return badBody(ctx, req);
    todo.putList(ctx.db, ctx.caller.?.user_id, list) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// DELETE /api/file/schedule/group/:id — the list and its tasks.
pub fn groupDelete(ctx: *Context, req: *Request, params: Params) anyerror!void {
    if (!ctx.config.todo_sync) return refuse(ctx, req);
    const id = params.get("id") orelse return badBody(ctx, req);
    if (!todo.validId(id)) return badBody(ctx, req);
    todo.deleteList(ctx.db, ctx.caller.?.user_id, id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

// ---- tasks ----

/// POST /api/file/schedule/task/all. A full sync starts at token 0 and needs
/// EVERYTHING stored (absence reads as deleted), so the incoming
/// `nextSyncToken` never narrows the listing; the one returned is the time of
/// this listing, which the app only keeps.
pub fn taskAll(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.todo_sync) return refuse(ctx, req);
    const user_id = ctx.caller.?.user_id;
    var parsed = json.readBody(TaskAllReq, ctx.gpa, req) catch return badBody(ctx, req);
    defer parsed.deinit();

    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const page = todo.tasksPage(ctx.db, a, user_id, token(parsed.value.nextPageTokens), pageSize(parsed.value.maxResults)) catch
        return serverError(ctx, req);
    const out = try a.alloc(TaskOut, page.items.len);
    for (page.items, out) |t, *o| o.* = taskOut(t);
    const now_ms = std.Io.Clock.real.now(ctx.io).toMilliseconds();
    // The first page is the start of a sync: what the browser changed is fetched now.
    if (parsed.value.nextPageTokens == null or parsed.value.nextPageTokens.?.len == 0)
        todo.markTabletListed(ctx.db, user_id, now_ms) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, TaskAllVO{ .nextPageToken = page.next, .nextSyncToken = now_ms, .scheduleTask = out }, null);
}

/// POST /api/file/schedule/task
pub fn taskInsert(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.todo_sync) return refuse(ctx, req);
    var parsed = json.readBody(TaskWire, ctx.gpa, req) catch return badBody(ctx, req);
    defer parsed.deinit();
    const task = taskOf(parsed.value) orelse return badBody(ctx, req);
    todo.putTask(ctx.db, ctx.caller.?.user_id, task) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, InsertTaskVO{ .taskId = task.id }, null);
}

/// PUT /api/file/schedule/task
pub fn taskUpdate(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.todo_sync) return refuse(ctx, req);
    var parsed = json.readBody(TaskWire, ctx.gpa, req) catch return badBody(ctx, req);
    defer parsed.deinit();
    const task = taskOf(parsed.value) orelse return badBody(ctx, req);
    todo.putTask(ctx.db, ctx.caller.?.user_id, task) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// PUT /api/file/schedule/task/list: up to 400 tasks, all or none.
pub fn taskUpdateList(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.todo_sync) return refuse(ctx, req);
    var parsed = json.readBody(TaskBatchReq, ctx.gpa, req) catch return badBody(ctx, req);
    defer parsed.deinit();
    const wires = parsed.value.updateScheduleTaskList orelse &.{};
    const tasks = try ctx.gpa.alloc(todo.Task, wires.len);
    defer ctx.gpa.free(tasks);
    for (wires, tasks) |w, *t| t.* = taskOf(w) orelse return badBody(ctx, req);
    todo.putTasks(ctx.db, ctx.caller.?.user_id, tasks) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// DELETE /api/file/schedule/task/:id
pub fn taskDelete(ctx: *Context, req: *Request, params: Params) anyerror!void {
    if (!ctx.config.todo_sync) return refuse(ctx, req);
    const id = params.get("id") orelse return badBody(ctx, req);
    if (!todo.validId(id)) return badBody(ctx, req);
    todo.deleteTask(ctx.db, ctx.caller.?.user_id, id) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

// ---- helpers ----

fn refuse(ctx: *Context, req: *Request) anyerror!void {
    return fail(ctx, req, .ok, unsupported, unsupported_msg);
}

/// A body the app would never send. `success: false` at 200, like every
/// refusal here, so its sync stops instead of misreading a status code.
fn badBody(ctx: *Context, req: *Request) anyerror!void {
    return fail(ctx, req, .ok, "BAD_REQUEST", "not a To-Do request this server understands");
}

fn listOf(w: ListWire) ?todo.List {
    const id = w.taskListId orelse return null;
    if (!todo.validId(id)) return null;
    return .{
        .id = id,
        .title = w.title orelse "",
        .create_time = w.createTime orelse 0,
        .last_modified = w.lastModified orelse 0,
        .deleted = isY(w.isDeleted),
    };
}

fn taskOf(w: TaskWire) ?todo.Task {
    const id = w.taskId orelse return null;
    if (!todo.validId(id)) return null;
    if (w.taskListId) |l| if (!todo.validId(l)) return null;
    return .{
        .id = id,
        .list_id = w.taskListId,
        .title = w.title orelse "",
        .detail = w.detail,
        .status = w.status orelse "needsAction",
        .importance = w.importance,
        .recurrence = w.recurrence,
        .links = w.links,
        .reminder_on = isY(w.isReminderOn),
        .due_time = w.dueTime orelse 0,
        .completed_time = w.completedTime orelse 0,
        .last_modified = w.lastModified orelse 0,
        .sort = w.sort orelse 0,
        .sort_completed = w.sortCompleted orelse 0,
        .sort_time = w.sortTime orelse 0,
        .planner_sort = w.planerSort orelse 0,
        .planner_sort_time = w.planerSortTime orelse 0,
        .deleted = isY(w.isDeleted),
    };
}

fn taskOut(t: todo.Task) TaskOut {
    return .{
        .taskId = t.id,
        .taskListId = t.list_id,
        .title = t.title,
        .detail = t.detail,
        .lastModified = t.last_modified,
        .recurrence = t.recurrence,
        .isReminderOn = yn(t.reminder_on),
        .status = t.status,
        .importance = t.importance,
        .dueTime = t.due_time,
        .completedTime = t.completed_time,
        .links = t.links,
        .isDeleted = yn(t.deleted),
        .sort = t.sort,
        .sortCompleted = t.sort_completed,
        .planerSort = t.planner_sort,
        .sortTime = t.sort_time,
        .planerSortTime = t.planner_sort_time,
    };
}

fn isY(v: ?[]const u8) bool {
    const s = v orelse return false;
    return s.len == 1 and (s[0] == 'Y' or s[0] == 'y');
}

fn yn(b: bool) []const u8 {
    return if (b) "Y" else "N";
}

/// A page token is an id the listing continues after; empty or junk starts over.
fn token(v: ?[]const u8) ?[]const u8 {
    const s = v orelse return null;
    return if (todo.validId(s)) s else null;
}

fn pageSize(v: ?[]const u8) u32 {
    const s = v orelse return default_page;
    const n = std.fmt.parseInt(u32, s, 10) catch return default_page;
    return std.math.clamp(n, 1, max_page);
}

test "the app's numbers-as-strings and Y/N flags" {
    try std.testing.expectEqual(@as(u32, 20), pageSize("20"));
    try std.testing.expectEqual(@as(u32, default_page), pageSize(null));
    try std.testing.expectEqual(@as(u32, default_page), pageSize("x"));
    try std.testing.expectEqual(@as(u32, max_page), pageSize("99999"));
    try std.testing.expectEqual(@as(u32, 1), pageSize("0"));
    try std.testing.expect(isY("Y"));
    try std.testing.expect(!isY("N"));
    try std.testing.expect(!isY(null));
    try std.testing.expectEqual(@as(?[]const u8, null), token(""));
}
