//! The To-Do app's sync over HTTP, driven with the request bodies of the July
//! capture of a Nomad talking to the official server.

const std = @import("std");
const password = @import("../../services/auth/password.zig");
const harness = @import("harness.zig");
const Fixture = harness.Fixture;
const deviceRequest = harness.deviceRequest;
const deviceLogin = harness.deviceLogin;
const expectSuccess = harness.expectSuccess;
const expectFailure = harness.expectFailure;
const gpa = std.testing.allocator;

/// The capture's insert, byte for byte.
const captured_insert =
    \\{"completedTime":0,"detail":null,"dueTime":0,"importance":null,"isDeleted":"N","isReminderOn":"N","lastModified":1784901382926,"links":null,"recurrence":null,"status":"needsAction","taskId":"f4c4cf48bfe1726d83037156c02350e4","taskListId":null,"title":"buy groceries","sort":0,"sortCompleted":0,"sortTime":1784901382926,"planerSort":0,"planerSortTime":0}
;

/// The capture's batch update: the same task, ticked off.
const captured_batch =
    \\{"updateScheduleTaskList":[{"completedTime":1784901397452,"detail":null,"dueTime":0,"importance":null,"isDeleted":"N","isReminderOn":"N","lastModified":1784901397452,"links":null,"recurrence":null,"status":"needsAction","taskId":"f4c4cf48bfe1726d83037156c02350e4","taskListId":null,"title":"buy groceries","sort":0,"sortCompleted":0,"sortTime":1784901382926,"planerSort":0,"planerSortTime":0}],"taskListId":null}
;

/// The capture's listing requests.
const captured_task_all = "{\"maxResults\":\"20\",\"nextSyncToken\":null,\"nextPageTokens\":null}";
const captured_group_all = "{\"maxResults\":null,\"pageToken\":null}";

const Tasks = struct {
    success: bool,
    nextPageToken: ?[]const u8 = null,
    nextSyncToken: i64,
    scheduleTask: []const struct {
        taskId: []const u8,
        taskListId: ?[]const u8 = null,
        title: []const u8,
        status: []const u8,
        completedTime: i64,
        lastModified: i64,
        sortTime: i64,
        isDeleted: []const u8,
        isReminderOn: []const u8,
    },
};

const Lists = struct {
    success: bool,
    pageToken: ?[]const u8 = null,
    scheduleTaskGroup: []const struct { taskListId: []const u8, title: []const u8, isDeleted: []const u8, lastModified: i64 },
};

fn signedIn(f: *Fixture, obuf: []u8, reqbuf: []u8, who: []const u8, eno: []const u8) ![32]u8 {
    const admin_id = f.svc.userIdByEmail("admin") catch null;
    const admin = admin_id orelse try f.svc.bootstrapAdmin("admin", "temp0000");
    const id = (try f.svc.createUser(admin, who, false)).id;
    _ = try f.svc.changePassword(id, null, &password.md5Hex("apass111"));
    return deviceLogin(&f.ctx, obuf, reqbuf, who, "apass111", eno);
}

test "To-Do sync is refused, touching nothing, until todo_sync is on" {
    const f = try Fixture.init();
    defer f.deinit();
    var obuf: [8192]u8 = undefined;
    var reqbuf: [4096]u8 = undefined;
    const tok = try signedIn(f, &obuf, &reqbuf, "alice", "SN1");

    const calls = [_][3][]const u8{
        .{ "POST", "/api/file/schedule/group/all", captured_group_all },
        .{ "POST", "/api/file/schedule/group", "{\"taskListId\":\"l1\",\"title\":\"x\"}" },
        .{ "PUT", "/api/file/schedule/group", "{\"taskListId\":\"l1\",\"title\":\"x\"}" },
        .{ "DELETE", "/api/file/schedule/group/l1", "" },
        .{ "POST", "/api/file/schedule/task/all", captured_task_all },
        .{ "POST", "/api/file/schedule/task", captured_insert },
        .{ "PUT", "/api/file/schedule/task", captured_insert },
        .{ "PUT", "/api/file/schedule/task/list", captured_batch },
        .{ "DELETE", "/api/file/schedule/task/f4c4cf48bfe1726d83037156c02350e4", "" },
    };
    for (calls) |c| {
        const resp = try deviceRequest(&f.ctx, &obuf, &reqbuf, c[0], c[1], &tok, "SN1", c[2]);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectFailure(resp.body, "TODO_SYNC_UNSUPPORTED");
    }
    var r = (try f.ctx.db.row("SELECT (SELECT COUNT(*) FROM todo_lists) + (SELECT COUNT(*) FROM todo_tasks);", &.{})).?;
    defer r.finalize();
    try std.testing.expectEqual(@as(i64, 0), r.int(0));
}

test "the captured task round-trips: inserted, ticked off in a batch, listed back, deleted twice" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.todo_sync = true;
    var obuf: [8192]u8 = undefined;
    var reqbuf: [4096]u8 = undefined;
    const tok = try signedIn(f, &obuf, &reqbuf, "alice", "SN1");

    {
        const resp = try deviceRequest(&f.ctx, &obuf, &reqbuf, "POST", "/api/file/schedule/task", &tok, "SN1", captured_insert);
        try expectSuccess(resp.body);
        var p = try std.json.parseFromSlice(struct { taskId: []const u8 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("f4c4cf48bfe1726d83037156c02350e4", p.value.taskId);
    }
    {
        const resp = try deviceRequest(&f.ctx, &obuf, &reqbuf, "PUT", "/api/file/schedule/task/list", &tok, "SN1", captured_batch);
        try expectSuccess(resp.body);
    }
    {
        const resp = try deviceRequest(&f.ctx, &obuf, &reqbuf, "POST", "/api/file/schedule/task/all", &tok, "SN1", captured_task_all);
        try expectSuccess(resp.body);
        var p = try std.json.parseFromSlice(Tasks, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(?[]const u8, null), p.value.nextPageToken);
        try std.testing.expect(p.value.nextSyncToken > 1784901397452);
        try std.testing.expectEqual(@as(usize, 1), p.value.scheduleTask.len);
        const t = p.value.scheduleTask[0];
        try std.testing.expectEqualStrings("buy groceries", t.title);
        try std.testing.expectEqual(@as(?[]const u8, null), t.taskListId); // the Inbox
        try std.testing.expectEqual(@as(i64, 1784901397452), t.completedTime);
        try std.testing.expectEqual(@as(i64, 1784901397452), t.lastModified);
        try std.testing.expectEqual(@as(i64, 1784901382926), t.sortTime);
        try std.testing.expectEqualStrings("N", t.isDeleted);
        try std.testing.expectEqualStrings("N", t.isReminderOn);
    }
    // A delete of what is already gone must still succeed: the app aborts its
    // whole sync on a failed delete.
    for (0..2) |_| {
        const resp = try deviceRequest(&f.ctx, &obuf, &reqbuf, "DELETE", "/api/file/schedule/task/f4c4cf48bfe1726d83037156c02350e4", &tok, "SN1", "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectSuccess(resp.body);
    }
    {
        const resp = try deviceRequest(&f.ctx, &obuf, &reqbuf, "POST", "/api/file/schedule/task/all", &tok, "SN1", captured_task_all);
        var p = try std.json.parseFromSlice(Tasks, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 0), p.value.scheduleTask.len);
    }
}

test "lists: create, rename, list back; deleting one takes its tasks; another account sees none of it" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.todo_sync = true;
    var obuf: [8192]u8 = undefined;
    var reqbuf: [4096]u8 = undefined;
    const alice = try signedIn(f, &obuf, &reqbuf, "alice", "SN1");
    const bob = try signedIn(f, &obuf, &reqbuf, "bob", "SN2");

    {
        const resp = try deviceRequest(&f.ctx, &obuf, &reqbuf, "POST", "/api/file/schedule/group", &alice, "SN1", "{\"taskListId\":\"aaaa\",\"title\":\"Groceries\",\"createTime\":1,\"lastModified\":1,\"isDeleted\":\"N\"}");
        try expectSuccess(resp.body);
        var p = try std.json.parseFromSlice(struct { taskListId: []const u8 }, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqualStrings("aaaa", p.value.taskListId);
    }
    try expectSuccess((try deviceRequest(&f.ctx, &obuf, &reqbuf, "PUT", "/api/file/schedule/group", &alice, "SN1", "{\"taskListId\":\"aaaa\",\"title\":\"Shopping\",\"createTime\":1,\"lastModified\":2,\"isDeleted\":\"N\"}")).body);
    try expectSuccess((try deviceRequest(&f.ctx, &obuf, &reqbuf, "POST", "/api/file/schedule/task", &alice, "SN1", "{\"taskId\":\"t1\",\"taskListId\":\"aaaa\",\"title\":\"milk\"}")).body);
    try expectSuccess((try deviceRequest(&f.ctx, &obuf, &reqbuf, "POST", "/api/file/schedule/task", &alice, "SN1", "{\"taskId\":\"t2\",\"title\":\"call mum\"}")).body);

    {
        const resp = try deviceRequest(&f.ctx, &obuf, &reqbuf, "POST", "/api/file/schedule/group/all", &alice, "SN1", captured_group_all);
        var p = try std.json.parseFromSlice(Lists, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 1), p.value.scheduleTaskGroup.len);
        try std.testing.expectEqualStrings("Shopping", p.value.scheduleTaskGroup[0].title);
        try std.testing.expectEqual(@as(i64, 2), p.value.scheduleTaskGroup[0].lastModified);
    }
    // Bob's tablet sees an empty account, not Alice's lists.
    {
        const resp = try deviceRequest(&f.ctx, &obuf, &reqbuf, "POST", "/api/file/schedule/group/all", &bob, "SN2", captured_group_all);
        var p = try std.json.parseFromSlice(Lists, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 0), p.value.scheduleTaskGroup.len);
    }

    try expectSuccess((try deviceRequest(&f.ctx, &obuf, &reqbuf, "DELETE", "/api/file/schedule/group/aaaa", &alice, "SN1", "")).body);
    {
        const resp = try deviceRequest(&f.ctx, &obuf, &reqbuf, "POST", "/api/file/schedule/task/all", &alice, "SN1", captured_task_all);
        var p = try std.json.parseFromSlice(Tasks, gpa, resp.body, .{ .ignore_unknown_fields = true });
        defer p.deinit();
        try std.testing.expectEqual(@as(usize, 1), p.value.scheduleTask.len);
        try std.testing.expectEqualStrings("t2", p.value.scheduleTask[0].taskId); // the Inbox task stays
    }
}

test "a request the app would never send is refused, not stored" {
    const f = try Fixture.init();
    defer f.deinit();
    f.ctx.config.todo_sync = true;
    var obuf: [8192]u8 = undefined;
    var reqbuf: [4096]u8 = undefined;
    const tok = try signedIn(f, &obuf, &reqbuf, "alice", "SN1");

    const bad = [_][3][]const u8{
        .{ "POST", "/api/file/schedule/task", "{\"title\":\"no id\"}" },
        .{ "POST", "/api/file/schedule/group", "{\"taskListId\":\"\"}" },
        .{ "PUT", "/api/file/schedule/task/list", "{\"updateScheduleTaskList\":[{\"taskId\":\"ok\"},{\"title\":\"no id\"}]}" },
        .{ "POST", "/api/file/schedule/task", "not json" },
    };
    for (bad) |c| {
        const resp = try deviceRequest(&f.ctx, &obuf, &reqbuf, c[0], c[1], &tok, "SN1", c[2]);
        try std.testing.expectEqual(@as(u16, 200), resp.status);
        try expectFailure(resp.body, "BAD_REQUEST");
    }
    // The half-good batch stored nothing.
    var r = (try f.ctx.db.row("SELECT COUNT(*) FROM todo_tasks;", &.{})).?;
    defer r.finalize();
    try std.testing.expectEqual(@as(i64, 0), r.int(0));
}
