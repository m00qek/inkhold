//! Password hashing and verification for the Supernote login scheme:
//! stored `md5_hex(pw)`, challenge `sha256_hex(md5 + randomCode)`.

const std = @import("std");
const wordlist = @import("wordlist.zig");
const Md5 = std.crypto.hash.Md5;
const Sha256 = std.crypto.hash.sha2.Sha256;
const XChaCha = std.crypto.aead.chacha_poly.XChaCha20Poly1305;

pub const md5_len = 32;
pub const sha256_len = 64;

// ---- encrypt-at-rest of the md5 credential ----
// The protocol needs md5(pw) recoverable, so it is encrypted under a key outside
// the DB rather than one-way hashed.

pub const cred_key_len = XChaCha.key_length;

pub const Md5Hex = [md5_len]u8;

/// Hex of `nonce || ciphertext(md5) || tag`.
pub const cred_enc_hex_len = (XChaCha.nonce_length + md5_len + XChaCha.tag_length) * 2;

pub const CredError = error{BadCredential};

/// XChaCha20-Poly1305 with a fresh per-row nonce; returns hex for `users.cred_enc`.
pub fn encryptCred(key: [cred_key_len]u8, md5: []const u8, rng: std.Random) [cred_enc_hex_len]u8 {
    std.debug.assert(md5.len == md5_len);
    var nonce: [XChaCha.nonce_length]u8 = undefined;
    rng.bytes(&nonce);
    var ct: [md5_len]u8 = undefined;
    var tag: [XChaCha.tag_length]u8 = undefined;
    XChaCha.encrypt(&ct, &tag, md5[0..md5_len], "", nonce, key);
    var raw: [XChaCha.nonce_length + md5_len + XChaCha.tag_length]u8 = undefined;
    @memcpy(raw[0..XChaCha.nonce_length], &nonce);
    @memcpy(raw[XChaCha.nonce_length..][0..md5_len], &ct);
    @memcpy(raw[XChaCha.nonce_length + md5_len ..][0..XChaCha.tag_length], &tag);
    return std.fmt.bytesToHex(raw, .lower);
}

/// `error.BadCredential` on malformed input, wrong key or tampering.
pub fn decryptCred(key: [cred_key_len]u8, cred_enc_hex: []const u8) CredError!Md5Hex {
    if (cred_enc_hex.len != cred_enc_hex_len) return error.BadCredential;
    var raw: [XChaCha.nonce_length + md5_len + XChaCha.tag_length]u8 = undefined;
    _ = std.fmt.hexToBytes(&raw, cred_enc_hex) catch return error.BadCredential;
    var nonce: [XChaCha.nonce_length]u8 = undefined;
    @memcpy(&nonce, raw[0..XChaCha.nonce_length]);
    var tag: [XChaCha.tag_length]u8 = undefined;
    @memcpy(&tag, raw[XChaCha.nonce_length + md5_len ..][0..XChaCha.tag_length]);
    var md5: Md5Hex = undefined;
    XChaCha.decrypt(&md5, raw[XChaCha.nonce_length..][0..md5_len], tag, "", nonce, key) catch return error.BadCredential;
    return md5;
}

pub fn md5Hex(plaintext: []const u8) [md5_len]u8 {
    var d: [Md5.digest_length]u8 = undefined;
    Md5.hash(plaintext, &d, .{});
    return std.fmt.bytesToHex(d, .lower);
}

/// SHA-256 hex of a session token; only the hash is stored. No stretching: a
/// 128-bit token has no low-entropy space to brute-force.
pub fn hashToken(token: []const u8) [sha256_len]u8 {
    var d: [Sha256.digest_length]u8 = undefined;
    Sha256.hash(token, &d, .{});
    return std.fmt.bytesToHex(d, .lower);
}

/// `sha256_hex(stored_md5 + randomCode)`.
pub fn challengeHash(stored_md5: []const u8, random_code: []const u8) [sha256_len]u8 {
    var h = Sha256.init(.{});
    h.update(stored_md5);
    h.update(random_code);
    var d: [Sha256.digest_length]u8 = undefined;
    h.final(&d);
    return std.fmt.bytesToHex(d, .lower);
}

fn md5Concat(stored_md5: []const u8, random_code: []const u8) [md5_len]u8 {
    var h = Md5.init(.{});
    h.update(stored_md5);
    h.update(random_code);
    var d: [Md5.digest_length]u8 = undefined;
    h.final(&d);
    return std.fmt.bytesToHex(d, .lower);
}

fn constEql(a: []const u8, b: []const u8) bool {
    if (a.len != b.len) return false;
    var diff: u8 = 0;
    for (a, b) |x, y| diff |= x ^ y;
    return diff == 0;
}

/// Four EFF-large words, ~51.7 bits: enough because every generated password is
/// forced to change on first login.
pub const temp_words = 4;

pub const max_temp_len = temp_words * wordlist.max_word_len + (temp_words - 1);

pub const TempPassword = struct {
    buf: [max_temp_len]u8 = undefined,
    len: usize = 0,

    pub fn slice(self: *const TempPassword) []const u8 {
        return self.buf[0..self.len];
    }
};

/// Rejection sampling: only u16 draws below 62208 (= 8 * 7776) are accepted, so
/// there is no modulo bias.
fn pickWordIndex(rng: std.Random) usize {
    const n: u32 = wordlist.words.len; // 7776 = 6^5
    const accept: u32 = (65536 / n) * n; // 62208
    while (true) {
        const r: u32 = rng.int(u16);
        if (r < accept) return @intCast(r % n);
    }
}

/// The sole temporary-password generator (bootstrap, admin create, admin reset).
/// Returns rather than logs it; the caller shows it exactly once.
pub fn generateTemp(rng: std.Random) TempPassword {
    var out: TempPassword = .{};
    var i: usize = 0;
    var w: usize = 0;
    while (w < temp_words) : (w += 1) {
        if (w != 0) {
            out.buf[i] = '-';
            i += 1;
        }
        const word = wordlist.words[pickWordIndex(rng)];
        @memcpy(out.buf[i..][0..word.len], word);
        i += word.len;
    }
    out.len = i;
    return out;
}

/// Direct `md5_hex(pw)` comparison for the self-service password change (no
/// random code there). Constant-time.
pub fn verifyCurrent(stored_md5: []const u8, submitted: []const u8) bool {
    return constEql(stored_md5, submitted);
}

/// Accepts the sha256 challenge, or the alternate `md5_hex(md5 + randomCode)` form.
pub fn verifyChallenge(stored_md5: []const u8, random_code: []const u8, submitted: []const u8) bool {
    const primary = challengeHash(stored_md5, random_code);
    if (constEql(&primary, submitted)) return true;
    const fallback = md5Concat(stored_md5, random_code);
    return constEql(&fallback, submitted);
}

fn isListWord(w: []const u8) bool {
    for (wordlist.words) |x| if (std.mem.eql(u8, x, w)) return true;
    return false;
}

/// Backtracks because four list words contain a hyphen.
fn splitsIntoListWords(s: []const u8, n: usize) bool {
    if (n == 1) return isListWord(s);
    var i: usize = 1;
    while (i + 1 < s.len) : (i += 1) {
        if (s[i] != '-') continue;
        if (isListWord(s[0..i]) and splitsIntoListWords(s[i + 1 ..], n - 1)) return true;
    }
    return false;
}

test "generateTemp yields temp_words hyphen-joined EFF-list words; two draws differ" {
    var prng = std.Random.DefaultPrng.init(0x5EED_1234);
    const rng = prng.random();

    const a = generateTemp(rng);
    const s = a.slice();
    try std.testing.expect(s.len > 0 and s.len <= max_temp_len);
    for (s) |c| try std.testing.expect((c >= 'a' and c <= 'z') or c == '-'); // lowercase + hyphens only
    try std.testing.expect(splitsIntoListWords(s, temp_words)); // exactly temp_words list words

    const b = generateTemp(rng);
    try std.testing.expect(!std.mem.eql(u8, s, b.slice()));

    for (0..2000) |_| {
        const idx = pickWordIndex(rng);
        try std.testing.expect(idx < wordlist.words.len);
    }
}

test "md5Hex matches the known vector" {
    try std.testing.expectEqualStrings("5f4dcc3b5aa765d61d8327deb882cf99", &md5Hex("password"));
}

test "cred_enc round-trips under its key; wrong key and tampering fail closed" {
    const key: [cred_key_len]u8 = @splat(0x24);
    var rng_impl = std.Random.DefaultPrng.init(0xC0FFEE);
    const rng = rng_impl.random();

    const md5 = md5Hex("hunter2");
    const enc = encryptCred(key, &md5, rng);
    try std.testing.expectEqual(@as(usize, cred_enc_hex_len), enc.len);
    try std.testing.expectEqualSlices(u8, &md5, &(try decryptCred(key, &enc))); // round-trips

    const enc2 = encryptCred(key, &md5, rng);
    try std.testing.expect(!std.mem.eql(u8, &enc, &enc2));

    const wrong: [cred_key_len]u8 = @splat(0x25);
    try std.testing.expectError(error.BadCredential, decryptCred(wrong, &enc));

    var bad = enc;
    bad[bad.len - 1] = if (bad[bad.len - 1] == 'a') 'b' else 'a';
    try std.testing.expectError(error.BadCredential, decryptCred(key, &bad));

    try std.testing.expectError(error.BadCredential, decryptCred(key, "deadbeef"));
}

test "hashToken is a stable lowercase sha256 hex; distinct tokens hash apart" {
    const a = hashToken("0123456789abcdef0123456789abcdef");
    try std.testing.expectEqualStrings(&a, &hashToken("0123456789abcdef0123456789abcdef"));
    try std.testing.expectEqual(@as(usize, sha256_len), a.len);
    for (a) |ch| try std.testing.expect(std.ascii.isHex(ch) and !std.ascii.isUpper(ch));
    try std.testing.expect(!std.mem.eql(u8, &a, &hashToken("ffffffffffffffffffffffffffffffff")));
}

test "challenge round-trips; wrong password rejected" {
    const stored = md5Hex("hunter2");
    const rc = "a1b2c3d4";
    const good = challengeHash(&stored, rc);
    try std.testing.expect(verifyChallenge(&stored, rc, &good));

    const wrong = challengeHash(&md5Hex("nope"), rc);
    try std.testing.expect(!verifyChallenge(&stored, rc, &wrong));
}
