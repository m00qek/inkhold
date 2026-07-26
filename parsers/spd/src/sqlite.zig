//! The single SQLite binding for the `.spd` parser.
//!
//! It is deliberately just `@cImport` over the **vendored** amalgamation
//! (`vendor/sqlite/sqlite3.h`, wired up in this package's `build.zig`) — NOT a
//! hand-written `extern` stub. Two reasons this matters here specifically:
//!
//!   1. One SQLite in the build. A `.spd` is opened alongside the rest of the
//!      project's SQLite usage; a second, minimal stub would risk a second
//!      libsqlite with different compile flags linked into the same binary.
//!   2. `sqlite3_deserialize` / `SQLITE_DESERIALIZE_READONLY` are the entire
//!      trust model (see `spd.zig`). They are real symbols in the vendored
//!      header — a stub would have to re-declare them by hand, and getting the
//!      flag constant wrong silently drops the read-only guarantee.

pub const c = @cImport({
    @cInclude("sqlite3.h");
});

/// `SQLITE_TRANSIENT = (void*)-1`: ask SQLite to copy bound blobs/text so the
/// source need not outlive the bind. `@cImport` cannot translate the cast-macro,
/// so we reconstruct it. Only the in-test `.spd` builders bind values; the parse
/// path is read-only and binds nothing but transient key strings.
// The sentinel address is intentionally UNaligned; a function pointer on 32-bit
// ARM has alignment > 1, so a *comptime* `@ptrFromInt` to the destructor type is
// a hard "requires aligned address" error there. SQLite only COMPARES this value,
// never calls it, so we build it at RUNTIME: the `noinline` barrier hides the
// address from comptime, safety-off skips the runtime alignment assert. armv6.
noinline fn transientAddr() usize {
    return @bitCast(@as(isize, -1));
}
pub inline fn transient() c.sqlite3_destructor_type {
    @setRuntimeSafety(false);
    return @ptrFromInt(transientAddr());
}
