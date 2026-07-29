//! Search rowid masking: the partition table and the sequence allocator behind
//! `segment_search.id` (see docs/scratch/search-architecture.md, decisions 2-4).
//!
//! ## The rowid layout — 15-bit partition, 48-bit sequence
//!
//! ```
//! bit  63    : 0 — sign, always clear (partitions never straddle zero)
//! bits 48-62 : partition id (15 bits → 32,768, NEVER reused)
//! bits 0-47  : sequence     (48 bits → 2.8e14 per partition, NEVER reused)
//! ```
//!
//! Nibble-aligned on purpose: `partition = rowid >> 48`, so the partition reads
//! off the TOP FOUR HEX DIGITS of any rowid in any EXPLAIN or debug dump —
//! `0x0002_0000_0000_001a` is partition 2, sequence 26, at a glance. Range ops
//! are `BETWEEN (p << 48) AND ((p + 1) << 48) - 1`, which FTS5 pushes into its
//! index (the `M1><` plan signature `search/query.zig` pins).
//!
//! ## Why a table and not `users.id`
//!
//! `users.id` is `INTEGER PRIMARY KEY` without AUTOINCREMENT (schema v1), and
//! SQLite recycles such ids — a recycled id would inherit the old partition's
//! rowid space, and any straggler row would become the new person's. So the
//! partition key is `search_partitions.id`, AUTOINCREMENT on a NEW table (no
//! `users` rebuild), which SQLite guarantees never to reuse. Deleting a user
//! range-deletes their partitions' rows and cascades the mapping row.
//!
//! ## Generation reminting — the safe re-index story
//!
//! A rebuild of a user's search rows mints a FRESH partition, populates it,
//! flips `active`, and range-deletes the old one — atomic from search's point
//! of view, no in-place mask rewriting, no scramble risk. Burning partition ids
//! is the design (the 15-bit space absorbs ~80 years of pathological churn);
//! sequences within a partition are likewise monotonic and never handed out
//! twice (`allocSeq` under the caller's write transaction).
//!
//! The MASK IS NEVER THE ACCESS CHECK: it scopes the FTS scan for speed, and
//! the `files` join in `search/query.zig` remains the ownership/tombstone boundary.

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");

/// Bits below the partition field. `partition = rowid >> seq_bits`.
pub const seq_bits: u6 = 48;

/// Highest partition id the 15-bit field can carry with bit 63 still clear.
pub const max_partition: i64 = 0x7FFF;

/// The first masked rowid of `p` — also the SQL range's lower bound.
pub fn base(p: i64) i64 {
    std.debug.assert(p >= 0 and p <= max_partition);
    return p << seq_bits;
}

/// The last masked rowid of `p` — the SQL range's upper bound (inclusive).
pub fn last(p: i64) i64 {
    return base(p + 1) - 1;
}

/// The partition a masked rowid belongs to: its top four hex digits.
pub fn partitionOf(rowid: i64) i64 {
    std.debug.assert(rowid >= 0);
    return rowid >> seq_bits;
}

/// `(p << 48) | seq` — the masked rowid of sequence `seq` in partition `p`.
pub fn rowidOf(p: i64, seq: i64) i64 {
    std.debug.assert(seq >= 0 and seq < (@as(i64, 1) << seq_bits));
    return base(p) | seq;
}

/// The user's ACTIVE partition id, or null when they have none yet (no ingest
/// has minted one). Read-only — search paths must not write, and a user with
/// no partition has no segment rows to find.
pub fn active(db: sqlite.Db, user_id: u64) !?i64 {
    var r = (try db.row("SELECT id FROM search_partitions WHERE user_id = ?1 AND active = 1;", &.{.{ .int = @intCast(user_id) }})) orelse return null;
    defer r.finalize();
    return r.int(0);
}

/// The user's active partition, minted on first need. MUST run inside the
/// caller's write transaction (ingest paths call it; the migration backfill is
/// the only other minter). Exhausting the 15-bit space is a structural error —
/// see the module docs for why it cannot happen at human rates.
pub fn ensureActive(db: sqlite.Db, user_id: u64, now: i64) !i64 {
    if (try active(db, user_id)) |p| return p;
    return mint(db, user_id, true, now);
}

/// Mints a fresh partition row for `user_id` (never reused — AUTOINCREMENT is
/// the guarantee) and returns its id. `is_active = false` is the reminting
/// pattern: populate the fresh partition first, flip `active` after.
pub fn mint(db: sqlite.Db, user_id: u64, is_active: bool, now: i64) !i64 {
    var s = try db.prepare(
        "INSERT INTO search_partitions(user_id, active, next_seq, created_at) VALUES(?1, ?2, 0, ?3);",
    );
    defer s.finalize();
    s.bindInt(1, @intCast(user_id));
    s.bindInt(2, if (is_active) 1 else 0);
    s.bindInt(3, now);
    _ = try s.step();
    const id = db.lastInsertRowId();
    if (id > max_partition) return error.PartitionSpaceExhausted;
    return id;
}

/// Reserves `count` fresh sequences in partition `p` and returns the FIRST of
/// the batch. One UPDATE per ingested batch, not per segment — this is the one
/// new write-path serialization, and it must run under the caller's write
/// transaction so two ingests cannot read the same `next_seq`.
pub fn allocSeq(db: sqlite.Db, p: i64, count: i64) !i64 {
    std.debug.assert(count > 0);
    var first: i64 = undefined;
    {
        var r = (try db.row("SELECT next_seq FROM search_partitions WHERE id = ?1;", &.{.{ .int = p }})) orelse return error.NoPartition;
        defer r.finalize();
        first = r.int(0);
    }
    var u = try db.prepare("UPDATE search_partitions SET next_seq = next_seq + ?2 WHERE id = ?1;");
    defer u.finalize();
    u.bindInt(1, p);
    u.bindInt(2, count);
    _ = try u.step();
    return first;
}

/// Flips the user's active partition to `fresh` and deletes the old mapping
/// row(s). The caller has already populated `fresh` and range-deleted the old
/// partition's segment rows — this is the last step of a remint, inside the
/// same transaction.
pub fn activate(db: sqlite.Db, user_id: u64, fresh: i64) !void {
    {
        var s = try db.prepare("DELETE FROM search_partitions WHERE user_id = ?1 AND id <> ?2;");
        defer s.finalize();
        s.bindInt(1, @intCast(user_id));
        s.bindInt(2, fresh);
        _ = try s.step();
    }
    var s = try db.prepare("UPDATE search_partitions SET active = 1 WHERE id = ?1;");
    defer s.finalize();
    s.bindInt(1, fresh);
    _ = try s.step();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;
const schema = @import("../db/schema.zig");

test "mask layout: nibble-aligned, hex-readable, bit 63 clear" {
    // Partition 2, sequence 26 — the top four hex digits ARE the partition.
    const r = rowidOf(2, 26);
    try testing.expectEqual(@as(i64, 0x0002_0000_0000_001a), r);
    try testing.expectEqual(@as(i64, 2), partitionOf(r));
    try testing.expectEqual(@as(i64, 2) << 48, base(2));
    try testing.expectEqual((@as(i64, 3) << 48) - 1, last(2));
    // The highest legal partition still leaves the sign bit clear.
    try testing.expect(rowidOf(max_partition, (@as(i64, 1) << 48) - 1) > 0);
}

test "allocSeq batches are monotonic and never re-issued" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);
    try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(1, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);");

    const p = try ensureActive(db, 1, 0);
    try testing.expectEqual(p, (try ensureActive(db, 1, 0))); // minted once
    try testing.expectEqual(@as(i64, 0), try allocSeq(db, p, 5));
    try testing.expectEqual(@as(i64, 5), try allocSeq(db, p, 1));
    try testing.expectEqual(@as(i64, 6), try allocSeq(db, p, 3));
    // The counter survives in the row, not in memory.
    var s = try db.prepare("SELECT next_seq FROM search_partitions WHERE id = ?1;");
    defer s.finalize();
    s.bindInt(1, p);
    try testing.expect(try s.step());
    try testing.expectEqual(@as(i64, 9), s.columnInt(0));
}

test "THE NEVER-REUSE PIN: a partition id is not recycled across delete/recreate" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);
    try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(7, 'a@b.c', '0123456789abcdef0123456789abcdef', 0);");

    const p1 = try ensureActive(db, 7, 0);
    // Delete the user: the FK cascade reaps the mapping row…
    try db.exec("DELETE FROM users WHERE id = 7;");
    {
        var s = try db.prepare("SELECT COUNT(*) FROM search_partitions;");
        defer s.finalize();
        _ = try s.step();
        try testing.expectEqual(@as(i64, 0), s.columnInt(0));
    }
    // …and recreating the SAME user id (which plain-rowid `users` recycles)
    // mints a FRESH partition — AUTOINCREMENT never hands the old one back, so
    // no straggler row in the old rowid space can ever become the new person's.
    try db.exec("INSERT INTO users(id, email, password_md5, created_at) VALUES(7, 'x@y.z', '0123456789abcdef0123456789abcdef', 0);");
    const p2 = try ensureActive(db, 7, 0);
    try testing.expect(p2 > p1);

    // A remint burns another id, by design.
    const p3 = try mint(db, 7, false, 0);
    try testing.expect(p3 > p2);
    try activate(db, 7, p3);
    try testing.expectEqual(@as(?i64, p3), try active(db, 7));
    // The flip removed the superseded mapping row.
    var s = try db.prepare("SELECT COUNT(*) FROM search_partitions;");
    defer s.finalize();
    _ = try s.step();
    try testing.expectEqual(@as(i64, 1), s.columnInt(0));
}
