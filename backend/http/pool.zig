//! The worker threads: a fixed few, each serving one connection at a time from
//! a queue the poller feeds. Concurrency past `db_lock` is tiny, so a handful
//! of workers is the whole request-side thread budget; memory follows the
//! number of *requests in flight*, not the number of open sockets.

const std = @import("std");
const Io = std.Io;
const Conn = @import("conn.zig").Conn;
const transport = @import("transport.zig");

const log = std.log.scoped(.http);

pub const Pool = struct {
    io: Io,
    gpa: std.mem.Allocator,
    serve: *transport.Serve,
    mutex: Io.Mutex = .init,
    cond: Io.Condition = .init,
    /// Connections with a request waiting; a stack, since order between
    /// clients does not matter and the newest is the one most likely hot.
    ready: std.ArrayList(*Conn) = .empty,

    /// Starts `n` detached workers; they live as long as the process.
    pub fn start(self: *Pool, n: u8) !void {
        for (0..n) |_| {
            const t = try std.Thread.spawn(.{ .stack_size = transport.conn_stack_size }, run, .{self});
            t.detach();
        }
    }

    /// Hands a readable connection to the next free worker.
    pub fn push(self: *Pool, conn: *Conn) void {
        self.mutex.lockUncancelable(self.io);
        const appended = self.ready.append(self.gpa, conn);
        self.mutex.unlock(self.io);
        if (appended) |_| {
            self.cond.signal(self.io);
        } else |err| {
            // No memory for a pointer: refuse this one rather than wedge the poller.
            log.warn("worker queue full ({t}); closing a connection", .{err});
            self.serve.finish(conn);
        }
    }

    fn run(self: *Pool) void {
        while (true) {
            self.mutex.lockUncancelable(self.io);
            while (self.ready.items.len == 0) self.cond.waitUncancelable(self.io, &self.mutex);
            const conn = self.ready.pop().?;
            self.mutex.unlock(self.io);
            self.serve.work(conn);
        }
    }
};
