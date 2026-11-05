//! The browser's To-Do: `/api/controlplane/todo…`, the signed-in person's own
//! lists and tasks (`services/todo_web.zig`). Everything here also reaches the
//! tablet, at its next sync. Off with `config.todo_sync`, like the tablet's
//! side: the listing then says `enabled: false` and edits are refused.

const std = @import("std");
const router = @import("../http/router.zig");
const context = @import("../http/context.zig");
const json = @import("../http/json.zig");
const reply = @import("../http/reply.zig");
const todo = @import("../services/todo.zig");
const web = @import("../services/todo_web.zig");

const Context = context.Context;
const Request = router.Request;
const Params = router.Params;
const fail = reply.fail;
const badRequest = reply.badRequest;
const serverError = reply.serverError;

/// Longest list or task title kept; the tablet's own field is shorter in practice.
const max_title = 200;

// ---- bodies ----

const ListVO = struct { id: []const u8, title: []const u8, waiting: bool };

const TaskVO = struct {
    id: []const u8,
    /// Absent: the Inbox.
    listId: ?[]const u8,
    title: []const u8,
    done: bool,
    /// Epoch ms; absent when there is no date.
    due: ?i64,
    completedAt: ?i64,
    sort: i64,
    sortTime: i64,
    /// Lassoed from a notebook page on the tablet.
    linked: bool,
    waiting: bool,
};

const TodoVO = struct {
    success: bool = true,
    enabled: bool,
    lists: []const ListVO = &.{},
    tasks: []const TaskVO = &.{},
    /// Epoch ms; absent until a tablet has fetched these to-dos.
    tabletSyncedAt: ?i64 = null,
    /// Something changed here that no tablet has fetched yet.
    waiting: bool = false,
};

const TitleReq = struct { title: ?[]const u8 = null };
const NewTaskReq = struct { title: ?[]const u8 = null, listId: ?[]const u8 = null, due: ?i64 = null };
/// Absent fields stay as they are. `listId` "" is the Inbox; `due` 0 removes the date.
const PatchReq = struct { title: ?[]const u8 = null, listId: ?[]const u8 = null, due: ?i64 = null, done: ?bool = null };
/// `listId` absent or "": the Inbox.
const OrderReq = struct { listId: ?[]const u8 = null, ids: ?[]const []const u8 = null };

const CreatedVO = struct { success: bool = true, id: []const u8 };

// ---- handlers ----

/// GET /api/controlplane/todo
pub fn get(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.todo_sync) return json.respond(ctx.gpa, req, .ok, TodoVO{ .enabled = false }, null);
    var arena = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const snap = web.snapshot(ctx.db, a, ctx.caller.?.user_id) catch return serverError(ctx, req);

    const lists = try a.alloc(ListVO, snap.lists.len);
    for (snap.lists, lists) |l, *o| o.* = .{ .id = l.l.id, .title = l.l.title, .waiting = l.waiting };
    const tasks = try a.alloc(TaskVO, snap.tasks.len);
    for (snap.tasks, tasks) |w, *o| {
        const t = w.t;
        const done = std.mem.eql(u8, t.status, "completed");
        o.* = .{
            .id = t.id,
            .listId = t.list_id,
            .title = t.title,
            .done = done,
            .due = if (t.due_time > 0) t.due_time else null,
            .completedAt = if (done and t.completed_time > 0) t.completed_time else null,
            .sort = t.sort,
            .sortTime = t.sort_time,
            .linked = t.links != null,
            .waiting = w.waiting,
        };
    }
    try json.respond(ctx.gpa, req, .ok, TodoVO{
        .enabled = true,
        .lists = lists,
        .tasks = tasks,
        .tabletSyncedAt = snap.tablet_listed_at,
        .waiting = snap.waiting,
    }, null);
}

/// POST /api/controlplane/todo/lists {title}
pub fn createList(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.todo_sync) return off(ctx, req);
    var parsed = json.readBody(TitleReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const title = cleanTitle(parsed.value.title) orelse return badTitle(ctx, req);
    const id = newId(ctx);
    web.createList(ctx.db, ctx.caller.?.user_id, &id, title, nowMs(ctx)) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, CreatedVO{ .id = &id }, null);
}

/// PUT /api/controlplane/todo/lists/:id {title}
pub fn renameList(ctx: *Context, req: *Request, params: Params) anyerror!void {
    if (!ctx.config.todo_sync) return off(ctx, req);
    const id = pathId(params) orelse return noList(ctx, req);
    var parsed = json.readBody(TitleReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const title = cleanTitle(parsed.value.title) orelse return badTitle(ctx, req);
    const found = web.renameList(ctx.db, ctx.caller.?.user_id, id, title, nowMs(ctx)) catch return serverError(ctx, req);
    if (!found) return noList(ctx, req);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// DELETE /api/controlplane/todo/lists/:id — the list and its tasks.
pub fn deleteList(ctx: *Context, req: *Request, params: Params) anyerror!void {
    if (!ctx.config.todo_sync) return off(ctx, req);
    const id = pathId(params) orelse return noList(ctx, req);
    web.deleteList(ctx.db, ctx.caller.?.user_id, id, nowMs(ctx)) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// POST /api/controlplane/todo/tasks {title, listId?, due?}
pub fn createTask(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.todo_sync) return off(ctx, req);
    var parsed = json.readBody(NewTaskReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const v = parsed.value;
    const title = cleanTitle(v.title) orelse return badTitle(ctx, req);
    const list = listOrInbox(v.listId) orelse return noList(ctx, req);
    const id = newId(ctx);
    web.createTask(ctx.db, ctx.caller.?.user_id, &id, .{ .title = title, .list_id = list.id, .due = @max(v.due orelse 0, 0) }, nowMs(ctx)) catch |e| switch (e) {
        error.NoSuchList => return noList(ctx, req),
        else => return serverError(ctx, req),
    };
    try json.respond(ctx.gpa, req, .ok, CreatedVO{ .id = &id }, null);
}

/// PUT /api/controlplane/todo/tasks/:id {title?, listId?, due?, done?}
pub fn updateTask(ctx: *Context, req: *Request, params: Params) anyerror!void {
    if (!ctx.config.todo_sync) return off(ctx, req);
    const id = pathId(params) orelse return noTask(ctx, req);
    var parsed = json.readBody(PatchReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const v = parsed.value;
    var patch: web.Patch = .{ .done = v.done, .due = if (v.due) |d| @max(d, 0) else null };
    if (v.title) |t| patch.title = cleanTitle(t) orelse return badTitle(ctx, req);
    if (v.listId) |l| {
        const where = listOrInbox(l) orelse return noList(ctx, req);
        patch.move_to = if (where.id) |lid| .{ .list = lid } else .inbox;
    }
    web.updateTask(ctx.db, ctx.caller.?.user_id, id, patch, nowMs(ctx)) catch |e| switch (e) {
        error.NoSuchList => return noList(ctx, req),
        error.NoSuchTask => return noTask(ctx, req),
        else => return serverError(ctx, req),
    };
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// DELETE /api/controlplane/todo/tasks/:id
pub fn deleteTask(ctx: *Context, req: *Request, params: Params) anyerror!void {
    if (!ctx.config.todo_sync) return off(ctx, req);
    const id = pathId(params) orelse return noTask(ctx, req);
    web.deleteTask(ctx.db, ctx.caller.?.user_id, id, nowMs(ctx)) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

/// PUT /api/controlplane/todo/order {listId?, ids}
pub fn reorder(ctx: *Context, req: *Request, params: Params) anyerror!void {
    _ = params;
    if (!ctx.config.todo_sync) return off(ctx, req);
    var parsed = json.readBody(OrderReq, ctx.gpa, req) catch return badRequest(ctx, req);
    defer parsed.deinit();
    const list = listOrInbox(parsed.value.listId) orelse return noList(ctx, req);
    const ids = parsed.value.ids orelse return badRequest(ctx, req);
    for (ids) |i| if (!todo.validId(i)) return badRequest(ctx, req);
    web.reorder(ctx.db, ctx.caller.?.user_id, list.id, ids, nowMs(ctx)) catch return serverError(ctx, req);
    try json.respond(ctx.gpa, req, .ok, reply.BaseVO{ .success = true }, null);
}

// ---- helpers ----

fn off(ctx: *Context, req: *Request) anyerror!void {
    return fail(ctx, req, .conflict, "TODO_SYNC_OFF", "To-Do sync is off on this server");
}
fn badTitle(ctx: *Context, req: *Request) anyerror!void {
    return fail(ctx, req, .bad_request, "BAD_TITLE", "a title needs 1 to 200 characters");
}
fn noList(ctx: *Context, req: *Request) anyerror!void {
    return fail(ctx, req, .not_found, "NO_SUCH_LIST", "there is no such list");
}
fn noTask(ctx: *Context, req: *Request) anyerror!void {
    return fail(ctx, req, .not_found, "NO_SUCH_TASK", "there is no such task");
}

fn cleanTitle(v: ?[]const u8) ?[]const u8 {
    const t = std.mem.trim(u8, v orelse return null, " \t\r\n");
    if (t.len == 0 or t.len > max_title) return null;
    return t;
}

const Where = struct { id: ?[]const u8 };

/// Absent or "": the Inbox. Null: not a list id at all.
fn listOrInbox(v: ?[]const u8) ?Where {
    const s = v orelse return .{ .id = null };
    if (s.len == 0) return .{ .id = null };
    if (!todo.validId(s)) return null;
    return .{ .id = s };
}

fn pathId(params: Params) ?[]const u8 {
    const id = params.get("id") orelse return null;
    return if (todo.validId(id)) id else null;
}

fn newId(ctx: *Context) [web.id_len]u8 {
    var raw: [16]u8 = undefined;
    ctx.io.random(&raw);
    return web.newId(raw);
}

fn nowMs(ctx: *Context) i64 {
    return std.Io.Clock.real.now(ctx.io).toMilliseconds();
}
