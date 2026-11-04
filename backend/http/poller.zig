//! Parks keep-alive connections between requests. One thread `poll`s every
//! parked socket and hands a readable one to the workers, so a browser tab's
//! six idle keep-alives cost six sockets and six `Conn`s, not six threads.
//! The same pass closes connections idle past the configured timeout and
//! drops ones the peer closed.

const std = @import("std");
const Io = std.Io;
const linux = std.os.linux;
const Conn = @import("conn.zig").Conn;
const transport = @import("transport.zig");

const log = std.log.scoped(.http);

/// Longest a poll sleeps, so the idle sweep runs at least this often.
const tick_ms: i32 = 1000;

pub const Poller = struct {
    io: Io,
    gpa: std.mem.Allocator,
    serve: *transport.Serve,
    idle_ms: i64,
    mutex: Io.Mutex = .init,
    parked: std.ArrayList(*Conn) = .empty,
    /// Scratch for one poll: `[0]` is the wake pipe, then one per parked socket.
    fds: std.ArrayList(linux.pollfd) = .empty,
    snapshot: std.ArrayList(*Conn) = .empty,
    /// `park` writes a byte so a sleeping `poll` picks the new socket up at once.
    wake: [2]linux.fd_t,

    pub fn init(io: Io, gpa: std.mem.Allocator, serve: *transport.Serve, idle_timeout_s: u32) !Poller {
        var wake: [2]linux.fd_t = undefined;
        if (linux.errno(linux.pipe2(&wake, .{ .CLOEXEC = true, .NONBLOCK = true })) != .SUCCESS) return error.PipeFailed;
        return .{ .io = io, .gpa = gpa, .serve = serve, .idle_ms = @as(i64, idle_timeout_s) * 1000, .wake = wake };
    }

    /// Starts the one poller thread; it lives as long as the process.
    pub fn start(self: *Poller) !void {
        const t = try std.Thread.spawn(.{}, run, .{self});
        t.detach();
    }

    /// Interrupts a sleeping `poll`, so a stop is seen at once.
    pub fn interrupt(self: *Poller) void {
        _ = linux.write(self.wake[1], "x", 1);
    }

    /// Parks `conn` until its socket is readable, closed or idle too long.
    pub fn park(self: *Poller, conn: *Conn) void {
        conn.parked_at_ms = self.nowMs();
        self.mutex.lockUncancelable(self.io);
        const appended = self.parked.append(self.gpa, conn);
        self.mutex.unlock(self.io);
        if (appended) |_| {
            self.interrupt();
        } else |err| {
            log.warn("park list full ({t}); closing a connection", .{err});
            self.serve.finish(conn);
        }
    }

    pub fn parkedCount(self: *Poller) usize {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        return self.parked.items.len;
    }

    fn nowMs(self: *Poller) i64 {
        return Io.Clock.awake.now(self.io).toMilliseconds();
    }

    fn run(self: *Poller) void {
        while (true) self.pass();
    }

    /// One poll and its consequences. Errors here are per socket and never stop
    /// the loop; an allocation failure drops the pass and retries on the next tick.
    fn pass(self: *Poller) void {
        // Stopping: hand nothing more to the workers; the process exits soon,
        // closing every parked socket with it.
        if (self.serve.isStopping()) {
            self.io.sleep(.fromMilliseconds(tick_ms), .awake) catch {};
            return;
        }
        // Under the lock: snapshot who is parked and build the fd list.
        self.mutex.lockUncancelable(self.io);
        self.fds.clearRetainingCapacity();
        self.snapshot.clearRetainingCapacity();
        const built = blk: {
            self.fds.append(self.gpa, .{ .fd = self.wake[0], .events = linux.POLL.IN, .revents = 0 }) catch break :blk false;
            for (self.parked.items) |c| {
                self.fds.append(self.gpa, .{ .fd = c.fd(), .events = linux.POLL.IN, .revents = 0 }) catch break :blk false;
                self.snapshot.append(self.gpa, c) catch break :blk false;
            }
            break :blk true;
        };
        self.mutex.unlock(self.io);
        if (!built) {
            self.io.sleep(.fromMilliseconds(tick_ms), .awake) catch {};
            return;
        }

        const rc = linux.poll(self.fds.items.ptr, @intCast(self.fds.items.len), tick_ms);
        switch (linux.errno(rc)) {
            .SUCCESS, .INTR => {},
            else => |e| {
                log.warn("poll failed: {t}", .{e});
                self.io.sleep(.fromMilliseconds(tick_ms), .awake) catch {};
                return;
            },
        }
        if (self.fds.items[0].revents != 0) self.drainWake();

        const now = self.nowMs();
        for (self.snapshot.items, self.fds.items[1..]) |c, pfd| {
            const readable = pfd.revents & linux.POLL.IN != 0;
            const gone = pfd.revents & (linux.POLL.ERR | linux.POLL.HUP | linux.POLL.NVAL) != 0;
            const idle = now - c.parked_at_ms >= self.idle_ms;
            if (!readable and !gone and !idle) continue;
            if (!self.unpark(c)) continue; // a worker beat us to it: cannot happen, but never double-hand
            if (readable) {
                self.serve.pool.push(c);
            } else {
                // `gone` or `idle`: the peer left, or we leave. HUP with bytes still
                // buffered is `readable` too and served above.
                self.serve.finish(c);
            }
        }
    }

    fn unpark(self: *Poller, conn: *Conn) bool {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        for (self.parked.items, 0..) |c, i| {
            if (c == conn) {
                _ = self.parked.swapRemove(i);
                return true;
            }
        }
        return false;
    }

    fn drainWake(self: *Poller) void {
        var buf: [64]u8 = undefined;
        while (true) {
            const n = linux.read(self.wake[0], &buf, buf.len);
            if (linux.errno(n) != .SUCCESS or n < buf.len) return;
        }
    }
};
