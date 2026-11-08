//! The library's identity: a random id made once per library by schema step
//! v18. Tablets compare it at every private-cloud sign-in (`uniqueMachineId`
//! from `check/exists/server`) and drop their file-sync records when it
//! changed, so a tablet moved to another library, or back to a restored one,
//! syncs from scratch instead of deleting what the server lacks (docs/content/contributor/device-protocol.md).

const std = @import("std");
const sqlite = @import("../db/sqlite.zig");

/// 16 random bytes as lowercase hex; the official server sends 32 characters too.
pub const machine_id_len = 32;

pub const Error = sqlite.Error || error{NoLibraryRow};

/// The library's id. `error.NoLibraryRow` only on a database below v18.
pub fn machineId(db: sqlite.Db) Error![machine_id_len]u8 {
    var r = (try db.row("SELECT machine_id FROM library WHERE id = 1;", &.{})) orelse return error.NoLibraryRow;
    defer r.finalize();
    const t = r.text(0);
    if (t.len != machine_id_len) return error.NoLibraryRow;
    var out: [machine_id_len]u8 = undefined;
    @memcpy(&out, t);
    return out;
}

/// A new id for a library that is no longer the one tablets synced with: a
/// restored snapshot is older than they are.
pub fn renew(db: sqlite.Db) sqlite.Error!void {
    try db.run("UPDATE library SET machine_id = lower(hex(randomblob(16))) WHERE id = 1;", &.{});
}

const testing = std.testing;
const schema = @import("../db/schema.zig");

test "a migrated library has a 32-hex id that stays put until renewed" {
    var db = try sqlite.Db.openMemory();
    defer db.close();
    try schema.migrate(db);

    const first = try machineId(db);
    for (first) |c| try testing.expect(std.ascii.isDigit(c) or (c >= 'a' and c <= 'f'));
    try testing.expectEqualSlices(u8, &first, &(try machineId(db)));

    try renew(db);
    const second = try machineId(db);
    try testing.expect(!std.mem.eql(u8, &first, &second));
}

test "two libraries get different ids" {
    var a = try sqlite.Db.openMemory();
    defer a.close();
    var b = try sqlite.Db.openMemory();
    defer b.close();
    try schema.migrate(a);
    try schema.migrate(b);
    try testing.expect(!std.mem.eql(u8, &(try machineId(a)), &(try machineId(b))));
}
