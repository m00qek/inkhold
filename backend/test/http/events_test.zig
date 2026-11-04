//! The held SSE stream at /api/controlplane/events.

const std = @import("std");
const eventstreams = @import("../../http/event_streams.zig");
const pendingsvc = @import("../../services/pending.zig");
const deferredsvc = @import("../../services/deferred.zig");
const context = @import("../../http/context.zig");
const Context = context.Context;
const gpa = std.testing.allocator;
const harness = @import("harness.zig");
const onboardWeb = harness.onboardWeb;
const Fixture = harness.Fixture;
const requestWithCookie = harness.requestWithCookie;

/// Runs one events request on its own thread with its own `Context` copy, as
/// `connThread` does, keeping the raw response.
const StreamRunner = struct {
    ctx: *Context,
    token: [32]u8,
    /// Cleared when the handler returns — "is the stream still held?".
    running: std.atomic.Value(bool) = .init(true),
    status: u16 = 0,
    failed: bool = false,
    raw: [8192]u8 = undefined,
    raw_len: usize = 0,

    fn run(self: *StreamRunner) void {
        defer self.running.store(false, .release);
        var reqbuf: [1024]u8 = undefined;
        var local = self.ctx.*; // exactly what connThread does with ctx
        const resp = requestWithCookie(&local, &self.raw, &reqbuf, "GET", "/api/controlplane/events", &self.token, "") catch {
            self.failed = true;
            return;
        };
        self.status = resp.status;
        self.raw_len = resp.head.len + 4 + resp.body.len;
    }

    fn output(self: *const StreamRunner) []const u8 {
        return self.raw[0..self.raw_len];
    }

    /// Blocks until the stream holds its slot, so tests never race the spawn.
    fn waitUntilHeld(self: *StreamRunner, streams: *eventstreams.EventStreams) !void {
        for (0..2000) |_| {
            if (streams.count(std.testing.io) == 1) return;
            if (!self.running.load(.acquire)) return error.StreamEndedBeforeItStarted;
            try std.testing.io.sleep(.fromMilliseconds(1), .awake);
        }
        return error.StreamNeverStarted;
    }
};

fn onboardedAdmin(f: *Fixture) !struct { id: u64, token: [32]u8 } {
    const id = try f.svc.bootstrapAdmin("admin", "temp0000");
    const token = try onboardWeb(&f.ctx, "admin", "temp0000", "s3cret-pw");
    return .{ .id = id, .token = token };
}

test "a HELD SSE stream never parks the global DB lock: concurrent requests are served throughout" {
    // Ordinary DB routes must be served while the stream stays held.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;

    // Without serve mode's lock, lockDb is a no-op and the test is vacuous.
    var lock: std.Io.Mutex = .init;
    ctx.db_lock = &lock;

    const who = try onboardedAdmin(f);

    var streams: eventstreams.EventStreams = .{
        .poll_interval_ms = 10,
        .heartbeat_ms = 1_000_000, // no heartbeat: this test is about the lock only
        .max_lifetime_ms = 2_000, // ample headroom over the ~ms of work below
    };
    ctx.event_streams = &streams;

    var runner: StreamRunner = .{ .ctx = ctx, .token = who.token };
    const t = try std.Thread.spawn(.{}, StreamRunner.run, .{&runner});
    defer t.join();
    try runner.waitUntilHeld(&streams);

    var obuf: [8192]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    for (0..20) |_| {
        const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/tree", &who.token, "");
        try std.testing.expectEqual(@as(u16, 200), resp.status);
    }

    try std.testing.expectEqual(@as(u32, 1), streams.count(std.testing.io));
}

test "a held stream pushes a NEW syncVersion when the tree changes, then releases its slot" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    var lock: std.Io.Mutex = .init;
    ctx.db_lock = &lock;

    const who = try onboardedAdmin(f);

    var streams: eventstreams.EventStreams = .{
        .poll_interval_ms = 5,
        .heartbeat_ms = 1_000_000,
        .max_lifetime_ms = 400,
    };
    ctx.event_streams = &streams;

    var runner: StreamRunner = .{ .ctx = ctx, .token = who.token };
    const t = try std.Thread.spawn(.{}, StreamRunner.run, .{&runner});
    try runner.waitUntilHeld(&streams);

    {
        lock.lockUncancelable(std.testing.io);
        defer lock.unlock(std.testing.io);
        const dir = try f.files.createFolder(who.id, null, "Dir");
        gpa.free(dir.name);
    }

    t.join();
    try std.testing.expectEqual(@as(u16, 200), runner.status);

    const out = runner.output();
    try std.testing.expect(std.ascii.findIgnoreCase(out, "transfer-encoding: chunked") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "text/event-stream") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "retry: ") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "data: 0") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "data: 1") != null);

    // A leaked slot would silently downgrade the endpoint to one-shot forever.
    try std.testing.expectEqual(@as(u32, 0), streams.count(std.testing.io));
    try std.testing.expectEqual(@as(u32, 0), streams.countFor(std.testing.io, who.id));
}

test "`event: index` is emitted when a derive completes, and NOT when an unrelated file is renamed" {
    // Frames only on change (the link is treated as 3G): a tree change emits
    // `event: sync` and leaves `event: index` silent.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    var lock: std.Io.Mutex = .init;
    ctx.db_lock = &lock;

    const who = try onboardedAdmin(f);

    {
        lock.lockUncancelable(std.testing.io);
        defer lock.unlock(std.testing.io);
        var r = std.Io.Reader.fixed("A paragraph.\n\nAnd a second one.\n");
        const e = try f.files.putFile(who.id, null, "notes.txt", &r, null);
        e.deinit(gpa);
    }

    var worker: deferredsvc.Worker = .{
        .gpa = gpa,
        .db = f.db,
        .blobs = f.files.blobs,
        .lock = &lock,
        .io = std.testing.io,
    };
    var pulse: pendingsvc.Pulse = .{
        .db = f.db,
        .db_lock = &lock,
        .io = std.testing.io,
        .worker = &worker,
        .max_age_ms = 1_000_000,
    };
    ctx.pending = &pulse;

    var streams: eventstreams.EventStreams = .{
        .poll_interval_ms = 5,
        .heartbeat_ms = 1_000_000,
        .max_lifetime_ms = 600,
    };
    ctx.event_streams = &streams;

    var runner: StreamRunner = .{ .ctx = ctx, .token = who.token };
    const t = try std.Thread.spawn(.{}, StreamRunner.run, .{&runner});
    try runner.waitUntilHeld(&streams);

    {
        lock.lockUncancelable(std.testing.io);
        defer lock.unlock(std.testing.io);
        const dir = try f.files.createFolder(who.id, null, "Dir");
        gpa.free(dir.name);
    }
    // Let the stream see the rename before the derive, so the two can't share a frame.
    try std.testing.io.sleep(.fromMilliseconds(60), .awake);

    worker.drain();

    t.join();
    try std.testing.expectEqual(@as(u16, 200), runner.status);
    const out = runner.output();

    try std.testing.expect(std.mem.indexOf(u8, out, "event: index\ndata: {\"pending\":1,") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "event: index\ndata: {\"pending\":0,") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "event: sync") != null);

    var frames: usize = 0;
    var at: usize = 0;
    while (std.mem.indexOfPos(u8, out, at, "event: index")) |i| : (at = i + 1) frames += 1;
    try std.testing.expectEqual(@as(usize, 2), frames);
}

test "with no pending pulse the endpoint says NOTHING about indexing rather than claiming zero" {
    // `ctx.pending == null` must send no `event: index`; `pending: 0` would be
    // an unchecked claim.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const who = try onboardedAdmin(f);
    try std.testing.expect(ctx.pending == null);

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/events", &who.token, "");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try std.testing.expect(std.mem.indexOf(u8, resp.body, "event: sync") != null);
    try std.testing.expect(std.mem.indexOf(u8, resp.body, "event: index") == null);
}

test "the DEGRADED one-shot shape carries the index frame too — it is the client furthest from the next one" {
    // An over-cap caller gets a full one-shot answer and reconnects on `retry:`.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    var lock: std.Io.Mutex = .init;
    ctx.db_lock = &lock;
    const who = try onboardedAdmin(f);

    {
        lock.lockUncancelable(std.testing.io);
        defer lock.unlock(std.testing.io);
        var r = std.Io.Reader.fixed("A paragraph.\n\nAnd a second one.\n");
        const e = try f.files.putFile(who.id, null, "notes.txt", &r, null);
        e.deinit(gpa);
    }
    var pulse: pendingsvc.Pulse = .{ .db = f.db, .db_lock = &lock, .io = std.testing.io };
    ctx.pending = &pulse;

    var streams: eventstreams.EventStreams = .{ .max_total = 8, .max_per_user = 1 };
    ctx.event_streams = &streams;
    try std.testing.expect(streams.tryAcquire(std.testing.io, who.id)); // occupy it
    defer streams.release(std.testing.io, who.id);

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/events", &who.token, "");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try std.testing.expect(std.ascii.findIgnoreCase(resp.head, "chunked") == null); // really one-shot
    try std.testing.expect(std.mem.indexOf(u8, resp.body, "event: index\ndata: {\"pending\":1,") != null);
}

test "an idle held stream emits heartbeat comment frames" {
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    var lock: std.Io.Mutex = .init;
    ctx.db_lock = &lock;

    const who = try onboardedAdmin(f);

    // No tree changes: without a heartbeat a dead peer looks like a quiet one.
    var streams: eventstreams.EventStreams = .{
        .poll_interval_ms = 5,
        .heartbeat_ms = 10,
        .max_lifetime_ms = 200,
    };
    ctx.event_streams = &streams;

    var runner: StreamRunner = .{ .ctx = ctx, .token = who.token };
    const t = try std.Thread.spawn(.{}, StreamRunner.run, .{&runner});
    t.join();

    try std.testing.expectEqual(@as(u16, 200), runner.status);
    // `:` is an SSE comment: ignored by EventSource but real bytes on the wire.
    try std.testing.expect(std.mem.indexOf(u8, runner.output(), ": ping") != null);
    try std.testing.expectEqual(@as(u32, 0), streams.count(std.testing.io));
}

test "at the per-user cap the events endpoint DEGRADES to one-shot rather than refusing" {
    // Over cap degrades to one-shot, not 503.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    var lock: std.Io.Mutex = .init;
    ctx.db_lock = &lock;

    const who = try onboardedAdmin(f);

    var streams: eventstreams.EventStreams = .{ .max_total = 8, .max_per_user = 1 };
    ctx.event_streams = &streams;

    try std.testing.expect(streams.tryAcquire(std.testing.io, who.id));
    defer streams.release(std.testing.io, who.id);

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/events", &who.token, "");

    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try std.testing.expect(std.mem.indexOf(u8, resp.head, "text/event-stream") != null);
    try std.testing.expect(std.mem.indexOf(u8, resp.body, "event: sync") != null);
    try std.testing.expect(std.mem.indexOf(u8, resp.body, "retry: ") != null);
    try std.testing.expect(std.ascii.findIgnoreCase(resp.head, "content-length:") != null);
    try std.testing.expect(std.ascii.findIgnoreCase(resp.head, "chunked") == null);
    try std.testing.expectEqual(@as(u32, 1), streams.count(std.testing.io));
}

test "with no stream registry (the single-threaded harness) the endpoint is one-shot" {
    // With no `ctx.event_streams` there is no thread to park; holding would hang.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    const who = try onboardedAdmin(f);
    try std.testing.expect(ctx.event_streams == null);

    var obuf: [4096]u8 = undefined;
    var reqbuf: [1024]u8 = undefined;
    const resp = try requestWithCookie(ctx, &obuf, &reqbuf, "GET", "/api/controlplane/events", &who.token, "");
    try std.testing.expectEqual(@as(u16, 200), resp.status);
    try std.testing.expect(std.mem.indexOf(u8, resp.body, "event: sync") != null);
    try std.testing.expect(std.ascii.findIgnoreCase(resp.head, "chunked") == null);
}

test "a dead client tears the stream down and returns its slot, long before the lifetime cap" {
    // A dead peer surfaces only as a failing write (the heartbeat's job),
    // modelled by a response buffer that fills up.
    const f = try Fixture.init();
    defer f.deinit();
    const ctx = &f.ctx;
    var lock: std.Io.Mutex = .init;
    ctx.db_lock = &lock;

    const who = try onboardedAdmin(f);

    // Long lifetime: teardown must come from the write failure.
    var streams: eventstreams.EventStreams = .{
        .poll_interval_ms = 1,
        .heartbeat_ms = 1,
        .max_lifetime_ms = 30_000,
    };
    ctx.event_streams = &streams;

    var reqbuf: [1024]u8 = undefined;
    var small: [640]u8 = undefined; // head + the first frame, then no room
    const started = std.Io.Timestamp.now(std.testing.io, .awake);
    _ = requestWithCookie(ctx, &small, &reqbuf, "GET", "/api/controlplane/events", &who.token, "") catch {};
    const elapsed_ms = started.durationTo(std.Io.Timestamp.now(std.testing.io, .awake)).toMilliseconds();

    try std.testing.expect(elapsed_ms < 10_000);
    try std.testing.expectEqual(@as(u32, 0), streams.count(std.testing.io));
    try std.testing.expectEqual(@as(u32, 0), streams.countFor(std.testing.io, who.id));
}
