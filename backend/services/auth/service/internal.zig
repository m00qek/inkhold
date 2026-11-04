//! Helpers the `Service` pieces share and nothing else calls.

const std = @import("std");
const password = @import("../password.zig");
const Service = @import("../service.zig").Service;

pub fn encryptCred(self: *Service, md5: []const u8) [password.cred_enc_hex_len]u8 {
    var src: std.Random.IoSource = .{ .io = self.io };
    return password.encryptCred(self.cred_key, md5, src.interface());
}

pub fn decryptCred(self: *Service, cred_enc_hex: []const u8) password.CredError!password.Md5Hex {
    return password.decryptCred(self.cred_key, cred_enc_hex);
}

/// Epoch seconds (0.16 has no `std.time.timestamp`).
pub fn randomHex(self: *Service, comptime n: usize) [n]u8 {
    var raw: [n / 2]u8 = undefined;
    var src: std.Random.IoSource = .{ .io = self.io };
    src.interface().bytes(&raw);
    const digits = "0123456789abcdef";
    var out: [n]u8 = undefined;
    for (raw, 0..) |b, i| {
        out[2 * i] = digits[b >> 4];
        out[2 * i + 1] = digits[b & 0x0f];
    }
    return out;
}
