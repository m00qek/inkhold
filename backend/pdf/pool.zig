//! A memory pool per MuPDF context: the server's bound on what MuPDF may hold,
//! counted where the system sees it. `budget.c` routes every allocation of a
//! context (MuPDF's and its libraries') here.
//!
//! What is counted is what the pool has mapped from the system, not what was
//! asked for: a block's header, its size class's rounding and a slab's unused
//! room are all inside the count, so the ceiling is a ceiling on the process's
//! anonymous memory. And when the context is done, the pool unmaps everything
//! it mapped (`ink_pool_close`): nothing a document cost outlives it, neither
//! the C library's habit of keeping freed memory nor a block MuPDF forgot.
//! HarfBuzz alone allocates elsewhere (`budget.c`), still under the ceiling:
//! it keeps a few hundred bytes in statics for the life of the process, which an
//! unmapped pool would leave pointing at nothing.
//!
//! Measured on a Pi 1 B+ before this pool (musl's `malloc` under a counting
//! ceiling): a text pass counted 27 MB and took 48 MB, and the process kept
//! 80 MB after two documents.
//!
//! Small blocks (at most 8 KiB) come from 64 KiB slabs, one list per size
//! class, and a freed block is reused; a slab whose last block is freed goes
//! back to the system, unless it is the last one of its class with room. A
//! larger block is a mapping of its own. One thread at a time per pool: the
//! worker's.

const std = @import("std");
const Alignment = std.mem.Alignment;
const page_allocator = std.heap.page_allocator;

/// Mirrors `struct ink_budget` in `budget.h`.
pub const Budget = extern struct {
    /// Bytes mapped from the system for this pool: what the ceiling bounds.
    used: usize,
    peak: usize,
    cap: usize,
    /// Bytes in blocks MuPDF holds (their capacity). At close, what MuPDF
    /// leaked: 0 unless it forgot a block.
    live: usize,
    /// Requests refused at the ceiling, recovered from or not.
    refusals: c_uint,
    /// What the last request came to: `met`, `refused` or `system`.
    last: c_int,
    /// Kept by `budget.c`'s hooks, not here: requests the system had no
    /// memory for; refusals MuPDF's retry did not get past; the size of a
    /// refused request not yet retried.
    system_failures: c_uint,
    unrecovered: c_uint,
    pending: usize,
    pool: ?*Pool,
};

const met: c_int = 0;
const refused: c_int = 1;
const system: c_int = 2;

const slab_size: usize = 64 * 1024;
const slab_align: Alignment = .fromByteUnits(slab_size);
/// In front of every block: its capacity, so `free` and `realloc` know it.
/// 16 bytes keeps the block as aligned as `malloc`'s.
const header: usize = 16;

/// Slot sizes, header included; each a multiple of 16, so every slot is
/// aligned. Steps of about a quarter keep a class's rounding small.
const slot_sizes = [_]u32{
    32,   48,   64,   80,  96,   112,  128,  160,  192,  224,  256,  320,  384,  448,
    512,  640,  768,  896, 1024, 1280, 1536, 1792, 2048, 2560, 3072, 3584, 4096, 5120,
    6144, 7168, 8192,
};
const max_small: usize = slot_sizes[slot_sizes.len - 1] - header;

/// Size (in 16-byte steps) to class, so the hot path is one load.
const class_of_steps = blk: {
    var t: [max_small / 16 + 1]u8 = undefined;
    var c: usize = 0;
    for (&t, 0..) |*e, steps| {
        while (slot_sizes[c] - header < steps * 16) c += 1;
        e.* = c;
    }
    break :blk t;
};

fn classOf(size: usize) usize {
    return class_of_steps[(size + 15) / 16];
}

const FreeSlot = struct { next: ?*FreeSlot };

const Slab = struct {
    class: u32,
    live: u32,
    /// Offset of the first slot never handed out.
    bump: u32,
    free: ?*FreeSlot,
    /// Every slab of the pool, for `ink_pool_close`.
    all_prev: ?*Slab,
    all_next: ?*Slab,
    /// The slabs of this class with room.
    avail_prev: ?*Slab,
    avail_next: ?*Slab,
    in_avail: bool,
};
const slab_head = std.mem.alignForward(usize, @sizeOf(Slab), 16);

/// At the start of a large block's mapping, before its header.
const Large = struct {
    prev: ?*Large,
    next: ?*Large,
    mapped: usize,
};
const large_head = std.mem.alignForward(usize, @sizeOf(Large), 16);

pub const Pool = struct {
    avail: [slot_sizes.len]?*Slab = @splat(null),
    slabs: ?*Slab = null,
    large: ?*Large = null,
};

// ---- the system's pages, counted ----

fn map(b: *Budget, len: usize, alignment: Alignment) ?[*]u8 {
    if (len > b.cap - b.used) {
        b.refusals += 1;
        b.last = refused;
        return null;
    }
    const p = page_allocator.rawAlloc(len, alignment, @returnAddress()) orelse {
        b.last = system;
        return null;
    };
    b.used += len;
    if (b.used > b.peak) b.peak = b.used;
    return p;
}

fn unmap(b: *Budget, p: [*]u8, len: usize, alignment: Alignment) void {
    page_allocator.rawFree(p[0..len], alignment, @returnAddress());
    b.used -= len;
}

// ---- slabs ----

fn availPush(pool: *Pool, s: *Slab) void {
    s.avail_prev = null;
    s.avail_next = pool.avail[s.class];
    if (s.avail_next) |n| n.avail_prev = s;
    pool.avail[s.class] = s;
    s.in_avail = true;
}

fn availRemove(pool: *Pool, s: *Slab) void {
    if (s.avail_prev) |p| p.avail_next = s.avail_next else pool.avail[s.class] = s.avail_next;
    if (s.avail_next) |n| n.avail_prev = s.avail_prev;
    s.avail_prev = null;
    s.avail_next = null;
    s.in_avail = false;
}

fn newSlab(b: *Budget, pool: *Pool, class: usize) ?*Slab {
    const p = map(b, slab_size, slab_align) orelse return null;
    const s: *Slab = @ptrCast(@alignCast(p));
    s.* = .{
        .class = @intCast(class),
        .live = 0,
        .bump = slab_head,
        .free = null,
        .all_prev = null,
        .all_next = pool.slabs,
        .avail_prev = null,
        .avail_next = null,
        .in_avail = false,
    };
    if (pool.slabs) |n| n.all_prev = s;
    pool.slabs = s;
    availPush(pool, s);
    return s;
}

fn slabFull(s: *const Slab) bool {
    return s.free == null and s.bump + slot_sizes[s.class] > slab_size;
}

fn allocSmall(b: *Budget, pool: *Pool, class: usize) ?[*]u8 {
    const s = pool.avail[class] orelse newSlab(b, pool, class) orelse return null;
    const slot: [*]u8 = if (s.free) |f| blk: {
        s.free = f.next;
        break :blk @ptrCast(f);
    } else blk: {
        const at = @as([*]u8, @ptrCast(s)) + s.bump;
        s.bump += slot_sizes[class];
        break :blk at;
    };
    s.live += 1;
    if (slabFull(s)) availRemove(pool, s);
    return slot;
}

fn freeSmall(b: *Budget, pool: *Pool, slot: [*]u8) void {
    const s: *Slab = @ptrFromInt(@intFromPtr(slot) & ~(slab_size - 1));
    const f: *FreeSlot = @ptrCast(@alignCast(slot));
    f.next = s.free;
    s.free = f;
    s.live -= 1;
    if (!s.in_avail) availPush(pool, s);
    // An empty slab goes back, unless it is its class's only room: a block
    // freed and asked for again must not cost a mapping each time.
    if (s.live == 0 and (s.avail_prev != null or s.avail_next != null)) {
        availRemove(pool, s);
        if (s.all_prev) |p| p.all_next = s.all_next else pool.slabs = s.all_next;
        if (s.all_next) |n| n.all_prev = s.all_prev;
        unmap(b, @ptrCast(s), slab_size, slab_align);
    }
}

// ---- large blocks ----

fn allocLarge(b: *Budget, pool: *Pool, size: usize) ?[*]u8 {
    const page = std.heap.pageSize();
    if (size > std.math.maxInt(usize) - large_head - header - page) {
        b.refusals += 1;
        b.last = refused;
        return null;
    }
    const mapped = std.mem.alignForward(usize, large_head + header + size, page);
    const p = map(b, mapped, .@"16") orelse return null;
    const l: *Large = @ptrCast(@alignCast(p));
    l.* = .{ .prev = null, .next = pool.large, .mapped = mapped };
    if (pool.large) |n| n.prev = l;
    pool.large = l;
    return p + large_head;
}

fn freeLarge(b: *Budget, pool: *Pool, slot: [*]u8) void {
    const l: *Large = @ptrCast(@alignCast(slot - large_head));
    if (l.prev) |p| p.next = l.next else pool.large = l.next;
    if (l.next) |n| n.prev = l.prev;
    unmap(b, @ptrCast(l), l.mapped, .@"16");
}

// ---- the C side (`budget.c`) ----

fn capOf(ptr: [*]u8) usize {
    return @as(*const usize, @ptrCast(@alignCast(ptr - header))).*;
}

/// 0, or -1 when the pool itself could not be had.
export fn ink_pool_open(b: *Budget, cap: usize) c_int {
    b.* = .{ .used = 0, .peak = 0, .cap = cap, .live = 0, .refusals = 0, .last = met, .system_failures = 0, .unrecovered = 0, .pending = 0, .pool = null };
    const pool = page_allocator.create(Pool) catch return -1;
    pool.* = .{};
    b.pool = pool;
    return 0;
}

export fn ink_pool_alloc(b: *Budget, size: usize) ?*anyopaque {
    const pool = b.pool.?;
    const slot, const cap = if (size <= max_small) blk: {
        const class = classOf(size);
        break :blk .{ allocSmall(b, pool, class) orelse return null, slot_sizes[class] - header };
    } else blk: {
        const s = allocLarge(b, pool, size) orelse return null;
        const l: *const Large = @ptrCast(@alignCast(s - large_head));
        break :blk .{ s, l.mapped - large_head - header };
    };
    @as(*usize, @ptrCast(@alignCast(slot))).* = cap;
    b.live += cap;
    b.last = met;
    return slot + header;
}

export fn ink_pool_free(b: *Budget, ptr: ?*anyopaque) void {
    const p: [*]u8 = @ptrCast(ptr orelse return);
    const cap = capOf(p);
    b.live -= cap;
    if (cap > max_small) freeLarge(b, b.pool.?, p - header) else freeSmall(b, b.pool.?, p - header);
}

export fn ink_pool_realloc(b: *Budget, ptr: ?*anyopaque, size: usize) ?*anyopaque {
    const p: [*]u8 = @ptrCast(ptr orelse return ink_pool_alloc(b, size));
    if (size == 0) {
        ink_pool_free(b, ptr);
        return null;
    }
    const cap = capOf(p);
    // It still fits: kept in place, unless a large block would keep more than
    // twice what it holds.
    if (size <= cap and !(cap > max_small and size < cap / 2)) {
        b.last = met;
        return ptr;
    }
    // A new block, a copy and a free: both live at once, and both counted.
    const q: [*]u8 = @ptrCast(ink_pool_alloc(b, size) orelse return null);
    @memcpy(q[0..@min(size, cap)], p[0..@min(size, cap)]);
    ink_pool_free(b, ptr);
    return q;
}

/// Once the context is dropped: every mapping goes back to the system, with
/// whatever MuPDF still held in it. `live` is left as what it held.
export fn ink_pool_close(b: *Budget) void {
    const pool = b.pool orelse return;
    while (pool.slabs) |s| {
        pool.slabs = s.all_next;
        unmap(b, @ptrCast(s), slab_size, slab_align);
    }
    while (pool.large) |l| {
        pool.large = l.next;
        unmap(b, @ptrCast(l), l.mapped, .@"16");
    }
    page_allocator.destroy(pool);
    b.pool = null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;

fn opened(cap: usize) !Budget {
    var b: Budget = undefined;
    try testing.expectEqual(@as(c_int, 0), ink_pool_open(&b, cap));
    return b;
}

test "every block is as aligned as malloc's, and holds what was asked" {
    var b = try opened(32 << 20);
    defer ink_pool_close(&b);
    for ([_]usize{ 1, 15, 16, 17, 100, 1000, 8176, 8177, 70_000, 1 << 20 }) |n| {
        const p: [*]u8 = @ptrCast(ink_pool_alloc(&b, n).?);
        try testing.expect(@intFromPtr(p) % 16 == 0);
        try testing.expect(capOf(p) >= n);
        @memset(p[0..n], 0xab);
    }
}

test "the count is the pages mapped: a slab per class, a mapping per large block" {
    var b = try opened(32 << 20);
    defer ink_pool_close(&b);
    const small = ink_pool_alloc(&b, 24).?;
    try testing.expectEqual(slab_size, b.used);
    // Same class: the same slab.
    const again = ink_pool_alloc(&b, 30).?;
    try testing.expectEqual(slab_size, b.used);
    const big = ink_pool_alloc(&b, 100_000).?;
    try testing.expect(b.used >= slab_size + 100_000 and b.used <= slab_size + 100_000 + std.heap.pageSize() + 64);
    ink_pool_free(&b, big);
    try testing.expectEqual(slab_size, b.used);
    ink_pool_free(&b, small);
    ink_pool_free(&b, again);
    // The class's only slab is kept, empty, for the next block.
    try testing.expectEqual(slab_size, b.used);
    try testing.expectEqual(@as(usize, 0), b.live);
}

test "a freed block is reused, and an empty slab that is not the last goes back" {
    var b = try opened(32 << 20);
    defer ink_pool_close(&b);
    const n = 64; // class of 80-byte slots: about 800 per slab
    var ptrs: [2000]*anyopaque = undefined;
    for (&ptrs) |*p| p.* = ink_pool_alloc(&b, n).?;
    const three = b.used;
    try testing.expectEqual(3 * slab_size, three);
    const first = ptrs[0];
    ink_pool_free(&b, first);
    try testing.expectEqual(first, ink_pool_alloc(&b, n).?); // reused, not a new slot
    for (ptrs) |p| ink_pool_free(&b, p);
    try testing.expectEqual(slab_size, b.used); // two went back, one kept
    try testing.expectEqual(three, b.peak);
}

test "past the ceiling a request is refused, and says so; under it again it is met" {
    var b = try opened(256 * 1024);
    defer ink_pool_close(&b);
    try testing.expectEqual(@as(?*anyopaque, null), ink_pool_alloc(&b, 300 * 1024));
    try testing.expectEqual(refused, b.last);
    try testing.expectEqual(@as(c_uint, 1), b.refusals);
    _ = ink_pool_alloc(&b, 100).?;
    try testing.expectEqual(met, b.last);
    try testing.expectEqual(@as(?*anyopaque, null), ink_pool_alloc(&b, std.math.maxInt(usize) - 8));
    try testing.expectEqual(refused, b.last);
}

test "realloc keeps a block that still fits, and a growing one holds both while it copies" {
    var b = try opened(32 << 20);
    defer ink_pool_close(&b);
    const p: [*]u8 = @ptrCast(ink_pool_alloc(&b, 100).?);
    @memset(p[0..100], 7);
    try testing.expectEqual(@as(?*anyopaque, p), ink_pool_realloc(&b, p, 110)); // same 112-byte class
    const big: [*]u8 = @ptrCast(ink_pool_realloc(&b, p, 50_000).?);
    try testing.expectEqual(@as(u8, 7), big[99]);
    const small: [*]u8 = @ptrCast(ink_pool_realloc(&b, big, 1_000).?); // more than half spare: moved
    try testing.expectEqual(@as(u8, 7), small[99]);
    // The large mapping went back; two slabs are left (the 100's class, kept
    // empty, and the 1,000's).
    try testing.expectEqual(2 * slab_size, b.used);
    try testing.expectEqual(@as(?*anyopaque, null), ink_pool_realloc(&b, small, 0));
    try testing.expectEqual(@as(usize, 0), b.live);
}

test "closing the pool gives every mapping back, a forgotten block's too" {
    var b = try opened(32 << 20);
    _ = ink_pool_alloc(&b, 40).?;
    _ = ink_pool_alloc(&b, 1 << 20).?; // never freed: what a leak looks like
    try testing.expect(b.live > 0);
    ink_pool_close(&b);
    try testing.expectEqual(@as(usize, 0), b.used);
    try testing.expect(b.live > 0); // kept as the measure of what was forgotten
}
