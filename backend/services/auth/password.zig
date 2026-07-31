//! Password hashing + verification (the pinned Supernote scheme; see docs/auth.md).
//!
//! Stored credential = `md5_hex(plaintext)` (32 lowercase hex). The login
//! challenge (device and web both use it) is `sha256_hex(stored_md5 + randomCode)`.
//! Verify accepts a fallback `md5_hex(stored_md5 + randomCode)` too, for clients
//! that use the alternate form.

const std = @import("std");
const wordlist = @import("wordlist.zig");
const Md5 = std.crypto.hash.Md5;
const Sha256 = std.crypto.hash.sha2.Sha256;
const XChaCha = std.crypto.aead.chacha_poly.XChaCha20Poly1305;

pub const md5_len = 32;
pub const sha256_len = 64;

// ---- encrypt-at-rest of the md5 credential (docs/design/auth.md §5b) ----
//
// The fixed device protocol needs `md5(pw)` RECOVERABLE to answer
// `sha256(md5+code)`, so it cannot be one-way hashed — bcrypt/argon2 are
// impossible here. Instead the stored credential is ENCRYPTED at rest under a key
// held OUTSIDE the DB (a 0600 key file), defeating the backup-theft vector. A
// full-host compromise still loses the credential — a higher threat tier we accept.

/// Length of the credential-encryption key (32 bytes; loaded from `cred_key_path`).
pub const cred_key_len = XChaCha.key_length;

/// A decrypted md5-hex credential.
pub const Md5Hex = [md5_len]u8;

/// Hex length of a `users.cred_enc` blob = `nonce || ciphertext(md5) || tag`.
pub const cred_enc_hex_len = (XChaCha.nonce_length + md5_len + XChaCha.tag_length) * 2;

pub const CredError = error{BadCredential};

/// Encrypts an `md5_len`-byte credential under `key` with a FRESH per-row random
/// nonce, returning `hex(nonce || ciphertext || tag)` for `users.cred_enc`. AEAD
/// (XChaCha20-Poly1305), no associated data.
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

/// Decrypts a `users.cred_enc` hex blob back to the `md5_len`-byte credential, or
/// `error.BadCredential` if it is malformed, or the tag fails to verify (wrong key
/// or tampering/truncation).
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

/// Lowercase MD5 hex of `plaintext` — what we store in `users.password_md5`.
pub fn md5Hex(plaintext: []const u8) [md5_len]u8 {
    var d: [Md5.digest_length]u8 = undefined;
    Md5.hash(plaintext, &d, .{});
    return std.fmt.bytesToHex(d, .lower);
}

/// Lowercase SHA-256 hex of an opaque session token — what `sessions.token_hash`
/// stores. The DB holds only the hash, so a stolen backup yields no live tokens;
/// the raw token (returned to the client, in a cookie or response body) never
/// touches disk. A SINGLE SHA-256, deliberately NOT bcrypt/argon2: a 128-bit token
/// has no low-entropy password space to brute-force, so stretching would only add
/// latency to the session-resolve hot path. Lookup is by hash equality.
pub fn hashToken(token: []const u8) [sha256_len]u8 {
    var d: [Sha256.digest_length]u8 = undefined;
    Sha256.hash(token, &d, .{});
    return std.fmt.bytesToHex(d, .lower);
}

/// The login challenge hash a client sends: `sha256_hex(stored_md5 + randomCode)`.
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

/// Words in a server-generated temporary password. Four EFF-large words →
/// `4 * log2(7776) ≈ 51.7` bits. That is below the old 72-bit hex, and it is fine
/// HERE: every caller forces `must_change_password = 1`, so a generated password is
/// EPHEMERAL — read once, typed into the change-password form, then replaced. It
/// never persists as a stored credential, so the fast-hash-at-rest concern that
/// motivated 72 bits does not apply, and human-transcribability is worth far more
/// day to day than the surplus bits. Charset/length is invisible to the protocol
/// (the challenge hashes `md5(pw)`).
pub const temp_words = 4;

/// Maximum length of a generated temporary password: `temp_words` longest words
/// plus the `temp_words - 1` hyphen separators. The `TempPassword` buffer is sized
/// from this.
pub const max_temp_len = temp_words * wordlist.max_word_len + (temp_words - 1);

/// A server-generated temporary password: a fixed-capacity buffer plus its used
/// length — a value type, no allocation. Read the string via `slice()`.
pub const TempPassword = struct {
    buf: [max_temp_len]u8 = undefined,
    len: usize = 0,

    pub fn slice(self: *const TempPassword) []const u8 {
        return self.buf[0..self.len];
    }
};

/// A uniform index into the 7776-word list via REJECTION SAMPLING off `rng`, so
/// there is no modulo bias. 7776 does not divide 2^16, so a u16 draw landing in the
/// non-uniform tail is redrawn: `62208 = 8 * 7776` is the largest multiple of 7776
/// that fits a u16, and only draws in `[0, 62208)` are accepted (~5% redraw rate).
fn pickWordIndex(rng: std.Random) usize {
    const n: u32 = wordlist.words.len; // 7776 = 6^5
    const accept: u32 = (65536 / n) * n; // 62208
    while (true) {
        const r: u32 = rng.int(u16);
        if (r < accept) return @intCast(r % n);
    }
}

/// A random temporary password: `temp_words` EFF-large diceware words, lowercase,
/// hyphen-joined (e.g. `cobalt-river-tiger-mellow`).
///
/// THE ONLY generator of temporary passwords in the server. First-run bootstrap
/// (`transport.ensureAdmin`), admin user creation and admin password reset all
/// call this — a second implementation would be a second entropy decision to get
/// wrong, and the whole point of the server generating these (rather than an
/// admin inventing one) is that nobody but the recipient ever chooses them.
///
/// It RETURNS the password rather than printing or logging it anywhere: the
/// plaintext exists for exactly one response body / one terminal banner, and the
/// caller decides which.
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

/// True if `submitted` is the account's current credential — a DIRECT
/// `md5_hex(pw)` comparison, not a challenge response. Used by the self-service
/// password change, where the client already holds the new password's md5 and
/// hashes the current one the same way at the same seam (there is no random code
/// in that request). Constant-time, and length-checked first so a short body can
/// never index past the stored value.
pub fn verifyCurrent(stored_md5: []const u8, submitted: []const u8) bool {
    return constEql(stored_md5, submitted);
}

/// True if `submitted` is a valid challenge response for `stored_md5`+`random_code`.
pub fn verifyChallenge(stored_md5: []const u8, random_code: []const u8, submitted: []const u8) bool {
    const primary = challengeHash(stored_md5, random_code);
    if (constEql(&primary, submitted)) return true;
    const fallback = md5Concat(stored_md5, random_code);
    return constEql(&fallback, submitted);
}

/// Whether `w` is a member of the diceware list.
fn isListWord(w: []const u8) bool {
    for (wordlist.words) |x| if (std.mem.eql(u8, x, w)) return true;
    return false;
}

/// Whether `s` decomposes into exactly `n` list words joined by single hyphens.
/// Backtracking, because four list entries themselves contain a hyphen, so a plain
/// split on '-' can over-count — the recursion tries each hyphen as a JOIN and
/// falls back if a segment is not a list word.
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

    // CSPRNG: two draws differ (a stuck source would repeat).
    const b = generateTemp(rng);
    try std.testing.expect(!std.mem.eql(u8, s, b.slice()));

    // Rejection sampling covers the whole index range without bias or panic: many
    // draws all land in 0..7775 (out-of-range would index past the list and trap).
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

    // The per-row nonce makes two encryptions of the SAME credential differ.
    const enc2 = encryptCred(key, &md5, rng);
    try std.testing.expect(!std.mem.eql(u8, &enc, &enc2));

    // A different key cannot decrypt (the AEAD tag fails) — fail closed.
    const wrong: [cred_key_len]u8 = @splat(0x25);
    try std.testing.expectError(error.BadCredential, decryptCred(wrong, &enc));

    // Tampering with the ciphertext is caught.
    var bad = enc;
    bad[bad.len - 1] = if (bad[bad.len - 1] == 'a') 'b' else 'a';
    try std.testing.expectError(error.BadCredential, decryptCred(key, &bad));

    // A malformed (short) blob is rejected without touching the cipher.
    try std.testing.expectError(error.BadCredential, decryptCred(key, "deadbeef"));
}

test "hashToken is a stable lowercase sha256 hex; distinct tokens hash apart" {
    const a = hashToken("0123456789abcdef0123456789abcdef");
    // Deterministic (same token → same hash), 64 lowercase hex chars.
    try std.testing.expectEqualStrings(&a, &hashToken("0123456789abcdef0123456789abcdef"));
    try std.testing.expectEqual(@as(usize, sha256_len), a.len);
    for (a) |ch| try std.testing.expect(std.ascii.isHex(ch) and !std.ascii.isUpper(ch));
    // A different token hashes to a different value — the stored key is opaque.
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
