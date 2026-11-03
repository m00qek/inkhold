//! The `.spd` parser's SQLite binding: `@cImport` over the vendored header, so
//! there is one SQLite in the build and `SQLITE_DESERIALIZE_READONLY` comes
//! from the real header rather than a hand-copied constant.

pub const c = @import("c");

// `SQLITE_TRANSIENT = (void*)-1`, which `@cImport` cannot translate. The
// address is unaligned, so a comptime `@ptrFromInt` to a function pointer fails
// on 32-bit ARM; SQLite only compares it, so it is built at runtime behind
// `noinline` with safety off.
noinline fn transientAddr() usize {
    return @bitCast(@as(isize, -1));
}
pub inline fn transient() c.sqlite3_destructor_type {
    @setRuntimeSafety(false);
    return @ptrFromInt(transientAddr());
}
