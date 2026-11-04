//! The wall clock, as the database stores it.

const std = @import("std");

/// Seconds since the epoch, from the real clock behind `io`.
pub fn nowSeconds(io: std.Io) i64 {
    return std.Io.Clock.real.now(io).toSeconds();
}
