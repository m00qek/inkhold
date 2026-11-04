//! Sweeping for the small in-memory maps that expire. Keys are collected into a
//! fixed buffer and removed after the walk (removing invalidates the iterator);
//! no allocation, because a sweep must not fail on the path making room.

const std = @import("std");

/// Removes up to 128 entries `isExpired` accepts, freeing each key with `gpa`.
/// `now` is in the caller's clock.
pub fn sweep(
    comptime V: type,
    gpa: std.mem.Allocator,
    map: *std.StringHashMapUnmanaged(V),
    now: i64,
    comptime isExpired: fn (V, i64) bool,
) void {
    var stale: [128][]const u8 = undefined;
    var n: usize = 0;
    var it = map.iterator();
    while (it.next()) |e| {
        if (isExpired(e.value_ptr.*, now)) {
            stale[n] = e.key_ptr.*;
            n += 1;
            if (n == stale.len) break;
        }
    }
    for (stale[0..n]) |k| {
        if (map.fetchRemove(k)) |kv| gpa.free(kv.key);
    }
}

test "sweep removes exactly the expired entries, and frees their keys" {
    const gpa = std.testing.allocator;
    const V = struct { expires: i64 };
    var map: std.StringHashMapUnmanaged(V) = .empty;
    defer {
        var it = map.iterator();
        while (it.next()) |e| gpa.free(e.key_ptr.*);
        map.deinit(gpa);
    }

    for ([_]struct { k: []const u8, e: i64 }{
        .{ .k = "old-1", .e = 10 },
        .{ .k = "live", .e = 100 },
        .{ .k = "old-2", .e = 20 },
    }) |row| try map.put(gpa, try gpa.dupe(u8, row.k), .{ .expires = row.e });

    sweep(V, gpa, &map, 50, struct {
        fn f(v: V, now: i64) bool {
            return now > v.expires;
        }
    }.f);

    try std.testing.expectEqual(@as(usize, 1), map.count());
    try std.testing.expect(map.contains("live"));
}

test "a sweep that finds nothing leaves the map alone" {
    const gpa = std.testing.allocator;
    const V = struct { expires: i64 };
    var map: std.StringHashMapUnmanaged(V) = .empty;
    defer {
        var it = map.iterator();
        while (it.next()) |e| gpa.free(e.key_ptr.*);
        map.deinit(gpa);
    }
    try map.put(gpa, try gpa.dupe(u8, "live"), .{ .expires = 100 });

    sweep(V, gpa, &map, 1, struct {
        fn f(v: V, now: i64) bool {
            return now > v.expires;
        }
    }.f);

    try std.testing.expectEqual(@as(usize, 1), map.count());
}

test "sweeping past the buffer takes 128 and leaves the rest for next time" {
    const gpa = std.testing.allocator;
    const V = struct { expires: i64 };
    var map: std.StringHashMapUnmanaged(V) = .empty;
    defer {
        var it = map.iterator();
        while (it.next()) |e| gpa.free(e.key_ptr.*);
        map.deinit(gpa);
    }

    for (0..200) |i| {
        const k = try std.fmt.allocPrint(gpa, "k{d}", .{i});
        try map.put(gpa, k, .{ .expires = 0 });
    }

    const expired = struct {
        fn f(v: V, now: i64) bool {
            return now > v.expires;
        }
    }.f;
    sweep(V, gpa, &map, 1, expired);
    try std.testing.expectEqual(@as(usize, 200 - 128), map.count());

    sweep(V, gpa, &map, 1, expired); // the rest, next time
    try std.testing.expectEqual(@as(usize, 0), map.count());
}
