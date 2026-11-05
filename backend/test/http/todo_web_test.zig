//! The browser's To-Do over HTTP: the person's own lists and tasks, edited the
//! way the tablet's app edits them, and the "waiting for the tablet" signal.

const std = @import("std");
const testing = std.testing;
const gpa = testing.allocator;
const harness = @import("harness.zig");
const Fixture = harness.Fixture;
const onboardWeb = harness.onboardWeb;
const requestWithCookie = harness.requestWithCookie;
const deviceRequest = harness.deviceRequest;
const deviceLogin = harness.deviceLogin;
const expectFailure = harness.expectFailure;
const expectSuccess = harness.expectSuccess;

const Todo = struct {
    enabled: bool,
    lists: []const struct { id: []const u8, title: []const u8, waiting: bool } = &.{},
    tasks: []const struct {
        id: []const u8,
        listId: ?[]const u8 = null,
        title: []const u8,
        done: bool,
        due: ?i64 = null,
        completedAt: ?i64 = null,
        sort: i64,
        linked: bool,
        waiting: bool,
    } = &.{},
    tabletSyncedAt: ?i64 = null,
    waiting: bool = false,
};

const Bufs = struct { obuf: [8192]u8 = undefined, reqbuf: [2048]u8 = undefined };

fn call(f: *Fixture, b: *Bufs, method: []const u8, path: []const u8, tok: []const u8, body: []const u8) !harness.Response {
    return requestWithCookie(&f.ctx, &b.obuf, &b.reqbuf, method, path, tok, body);
}

fn snapshot(f: *Fixture, b: *Bufs, tok: []const u8) !std.json.Parsed(Todo) {
    const resp = try call(f, b, "GET", "/api/controlplane/todo", tok, "");
    try testing.expectEqual(@as(u16, 200), resp.status);
    return std.json.parseFromSlice(Todo, gpa, resp.body, .{ .ignore_unknown_fields = true, .allocate = .alloc_always });
}

fn created(resp: harness.Response, buf: []u8) ![]const u8 {
    try testing.expectEqual(@as(u16, 200), resp.status);
    var p = try std.json.parseFromSlice(struct { id: []const u8 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
    defer p.deinit();
    @memcpy(buf[0..p.value.id.len], p.value.id);
    return buf[0..p.value.id.len];
}

test "off: the listing says so and every edit is refused" {
    const f = try Fixture.init();
    defer f.deinit();
    _ = try f.svc.bootstrapAdmin("ana", "temp0000");
    const tok = try onboardWeb(&f.ctx, "ana", "temp0000", "anapass1");
    var b: Bufs = .{};

    var s = try snapshot(f, &b, &tok);
    defer s.deinit();
    try testing.expect(!s.value.enabled);
    const resp = try call(f, &b, "POST", "/api/controlplane/todo/tasks", &tok, "{\"title\":\"x\"}");
    try testing.expectEqual(@as(u16, 409), resp.status);
    try expectFailure(resp.body, "TODO_SYNC_OFF");
}

test "a person's lists and tasks: create, edit, move, reorder, delete; another person sees none of it" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.todo_sync = true;
    const admin = try f.svc.bootstrapAdmin("ana", "temp0000");
    const ana = try onboardWeb(&f.ctx, "ana", "temp0000", "anapass1");
    const rui_new = try f.svc.createUser(admin, "rui", false);
    var b: Bufs = .{};

    var lbuf: [32]u8 = undefined;
    const list = try created(try call(f, &b, "POST", "/api/controlplane/todo/lists", &ana, "{\"title\":\"  Groceries \"}"), &lbuf);

    var body_buf: [256]u8 = undefined;
    var t1buf: [32]u8 = undefined;
    const t1 = try created(try call(f, &b, "POST", "/api/controlplane/todo/tasks", &ana, try std.fmt.bufPrint(&body_buf, "{{\"title\":\"milk\",\"listId\":\"{s}\",\"due\":1794571129470}}", .{list})), &t1buf);
    var t2buf: [32]u8 = undefined;
    const t2 = try created(try call(f, &b, "POST", "/api/controlplane/todo/tasks", &ana, "{\"title\":\"call mum\"}"), &t2buf);

    {
        var s = try snapshot(f, &b, &ana);
        defer s.deinit();
        try testing.expect(s.value.enabled and s.value.waiting);
        try testing.expectEqualStrings("Groceries", s.value.lists[0].title);
        try testing.expectEqual(@as(usize, 2), s.value.tasks.len);
        for (s.value.tasks) |t| {
            try testing.expect(t.waiting);
            if (std.mem.eql(u8, t.id, t1)) {
                try testing.expectEqualStrings(list, t.listId.?);
                try testing.expectEqual(@as(?i64, 1794571129470), t.due);
            } else try testing.expectEqual(@as(?[]const u8, null), t.listId); // the Inbox
        }
    }

    // Done, renamed, date removed, moved to the Inbox: one edit.
    const path1 = try std.fmt.bufPrint(&body_buf, "/api/controlplane/todo/tasks/{s}", .{t1});
    var p1: [64]u8 = undefined;
    @memcpy(p1[0..path1.len], path1);
    try expectSuccess((try call(f, &b, "PUT", p1[0..path1.len], &ana, "{\"done\":true,\"title\":\"oat milk\",\"due\":0,\"listId\":\"\"}")).body);
    try expectSuccess((try call(f, &b, "PUT", try std.fmt.bufPrint(&body_buf, "/api/controlplane/todo/lists/{s}", .{list}), &ana, "{\"title\":\"Shopping\"}")).body);
    {
        var s = try snapshot(f, &b, &ana);
        defer s.deinit();
        try testing.expectEqualStrings("Shopping", s.value.lists[0].title);
        for (s.value.tasks) |t| if (std.mem.eql(u8, t.id, t1)) {
            try testing.expect(t.done);
            try testing.expect(t.completedAt != null);
            try testing.expectEqualStrings("oat milk", t.title);
            try testing.expectEqual(@as(?i64, null), t.due);
            try testing.expectEqual(@as(?[]const u8, null), t.listId);
        };
    }

    // Reorder the Inbox's open tasks (only t2 is open there now).
    try expectSuccess((try call(f, &b, "PUT", "/api/controlplane/todo/order", &ana, try std.fmt.bufPrint(&body_buf, "{{\"ids\":[\"{s}\"]}}", .{t2}))).body);

    // Unknown ids are a 404, empty titles a 400.
    try testing.expectEqual(@as(u16, 404), (try call(f, &b, "PUT", "/api/controlplane/todo/tasks/ffffffffffffffffffffffffffffffff", &ana, "{\"done\":true}")).status);
    try testing.expectEqual(@as(u16, 404), (try call(f, &b, "POST", "/api/controlplane/todo/tasks", &ana, "{\"title\":\"x\",\"listId\":\"ffffffffffffffffffffffffffffffff\"}")).status);
    try testing.expectEqual(@as(u16, 400), (try call(f, &b, "POST", "/api/controlplane/todo/lists", &ana, "{\"title\":\"   \"}")).status);

    // Rui sees an empty To-Do and cannot touch Ana's rows.
    const rui = try onboardWeb(&f.ctx, "rui", rui_new.temp_password.slice(), "ruipass11");
    {
        var s = try snapshot(f, &b, &rui);
        defer s.deinit();
        try testing.expectEqual(@as(usize, 0), s.value.tasks.len);
        try testing.expectEqual(@as(usize, 0), s.value.lists.len);
    }
    try testing.expectEqual(@as(u16, 404), (try call(f, &b, "PUT", p1[0..path1.len], &rui, "{\"done\":false}")).status);

    // Deleting the list takes nothing else; deleting a task twice is fine.
    try expectSuccess((try call(f, &b, "DELETE", try std.fmt.bufPrint(&body_buf, "/api/controlplane/todo/lists/{s}", .{list}), &ana, "")).body);
    try expectSuccess((try call(f, &b, "DELETE", p1[0..path1.len], &ana, "")).body);
    try expectSuccess((try call(f, &b, "DELETE", p1[0..path1.len], &ana, "")).body);
    var s = try snapshot(f, &b, &ana);
    defer s.deinit();
    try testing.expectEqual(@as(usize, 0), s.value.lists.len);
    try testing.expectEqual(@as(usize, 1), s.value.tasks.len);
}

test "a browser change waits until the tablet lists the tasks, then the tablet gets it" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.todo_sync = true;
    _ = try f.svc.bootstrapAdmin("ana", "temp0000");
    const ana = try onboardWeb(&f.ctx, "ana", "temp0000", "anapass1");
    var b: Bufs = .{};
    const dev = try deviceLogin(&f.ctx, &b.obuf, &b.reqbuf, "ana", "anapass1", "SN1");

    var tbuf: [32]u8 = undefined;
    const t = try created(try call(f, &b, "POST", "/api/controlplane/todo/tasks", &ana, "{\"title\":\"from the browser\"}"), &tbuf);
    {
        var s = try snapshot(f, &b, &ana);
        defer s.deinit();
        try testing.expect(s.value.waiting and s.value.tasks[0].waiting);
        try testing.expectEqual(@as(?i64, null), s.value.tabletSyncedAt);
    }

    // The tablet's full sync starts with the first page of its task listing.
    const resp = try deviceRequest(&f.ctx, &b.obuf, &b.reqbuf, "POST", "/api/file/schedule/task/all", &dev, "SN1", "{\"maxResults\":\"20\",\"nextSyncToken\":null,\"nextPageTokens\":null}");
    try expectSuccess(resp.body);
    try testing.expect(std.mem.indexOf(u8, resp.body, t) != null);
    try testing.expect(std.mem.indexOf(u8, resp.body, "from the browser") != null);

    var s = try snapshot(f, &b, &ana);
    defer s.deinit();
    try testing.expect(!s.value.waiting);
    try testing.expect(!s.value.tasks[0].waiting);
    try testing.expect(s.value.tabletSyncedAt != null);
}
