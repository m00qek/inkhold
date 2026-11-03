//! Fixture and helpers shared by the `pending` tests.

const std = @import("std");
const pending = @import("pending.zig");
const owesDerive = pending.owesDerive;

pub const owes_derive_d = owesDerive("d");
