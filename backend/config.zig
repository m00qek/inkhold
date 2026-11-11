//! Server configuration, loaded from ZON. Every field has a default.

const std = @import("std");

pub const Tls = struct {
    enabled: bool = false,
    cert_path: []const u8 = "certs/cert.pem",
    key_path: []const u8 = "certs/key.pem",
    /// TLS 1.3 suite names (tls.zig `CipherSuite` tags), most preferred first;
    /// empty = library default.
    cipher_suites: []const []const u8 = &.{},
};

/// File version history: a synced edit retains the superseded blob in
/// `file_history` instead of pruning it.
pub const History = struct {
    /// Default versions kept per file, and the clamp on `users.history_keep`.
    /// 0 disables versioning.
    keep: u32 = 5,
    /// The most a user may raise their own `keep` to. Read as
    /// `@max(keep, max_keep)`, so a config with `keep` above it still works. Quota
    /// is the real limit; this stops one person setting the install's disk policy.
    max_keep: u32 = 15,
    /// Global byte ceiling on retained history, a backstop behind per-user quota;
    /// eviction takes only the writing user's oldest versions.
    max_bytes: u64 = 500_000_000,
};

pub const Config = struct {
    host: []const u8 = "127.0.0.1",
    port: u16 = 8089,
    /// SQLite file (created if absent); ":memory:" for an ephemeral db.
    db_path: []const u8 = "inkhold.db",
    /// The 32-byte credential-encryption key, kept outside the DB (ideally outside
    /// the backup) so a stolen `inkhold.db` yields no credentials. Created 0600 on
    /// first run. Losing it forces every password reset.
    cred_key_path: []const u8 = "cred.key",
    data_dir: []const u8 = "data",
    /// Built SPA to serve as static files; empty disables static serving.
    web_dir: []const u8 = "",
    /// The first-run admin's login. Must be an email: the sign-in field is
    /// `type="email"`, so a non-email default could never sign in.
    admin_email: []const u8 = "admin@home.lan",
    /// Open sockets at once: parked keep-alives, requests in flight and held
    /// streams. Over the cap, new connections are closed. A parked plaintext
    /// socket costs ~34 KB and no thread (a browser parks ~6 per tab), so this
    /// is a file-descriptor budget more than a memory one.
    max_connections: u16 = 192,
    /// Threads serving requests. Concurrency past `db_lock` is tiny, so a few
    /// suffice; each reserves `conn_stack_size`. Memory follows this, not the
    /// socket count.
    workers: u8 = 4,
    /// Threads for held streams (SSE), beyond the workers. Over the cap a new
    /// stream is dropped and its `EventSource` retries.
    max_held: u16 = 24,
    /// A keep-alive socket idle this long is closed; the browser reopens one
    /// on the next click. Generous, since under TLS a reopen is a handshake.
    idle_timeout_s: u32 = 300,
    /// The one reverse proxy allowed to speak for its clients. When the peer
    /// is exactly this address, IP rate limits key on the client it names in
    /// `X-Real-IP` (else the last `X-Forwarded-For` hop) instead of on the
    /// proxy itself, which would give every client one shared bucket. Empty
    /// (the default, TLS terminated here) trusts no header from anyone.
    trusted_proxy: []const u8 = "",
    /// The admin notice calls backups late when the newest successful
    /// `inkhold backup create` (any directory) is older than this.
    backup_warn_after_hours: u32 = 48,
    /// Store and serve the tablet's To-Do lists (`handlers/device/todo.zig`).
    /// Off until it is proven on a tablet: while off, the To-Do app's calls are
    /// refused and its sync stops with an error, touching nothing.
    todo_sync: bool = false,
    /// Store and serve the tablet's digests (`handlers/device/digest.zig`).
    /// Off until it is proven on a tablet: while off, the Digest app's calls
    /// are refused and its sync stops with an error, touching nothing.
    digest_sync: bool = false,
    tls: Tls = .{},
    history: History = .{},
};

/// A parsed config plus the arena that owns its string allocations.
pub const Loaded = struct {
    config: Config,
    arena: std.heap.ArenaAllocator,

    pub fn deinit(self: *Loaded) void {
        self.arena.deinit();
    }
};

/// Shaped like an email by the HTML5 rule, not RFC 5322: the question is whether
/// the sign-in form will submit it. No dot required (`admin@home` is valid).
pub fn looksLikeEmail(s: []const u8) bool {
    const at = std.mem.indexOfScalar(u8, s, '@') orelse return false;
    if (at == 0 or at + 1 == s.len) return false;
    if (std.mem.indexOfScalarPos(u8, s, at + 1, '@') != null) return false;
    for (s) |c| if (std.ascii.isWhitespace(c)) return false;
    return true;
}

pub const ParseError = error{ OutOfMemory, ParseZon };

pub fn parse(gpa: std.mem.Allocator, source: [:0]const u8) ParseError!Loaded {
    var arena = std.heap.ArenaAllocator.init(gpa);
    errdefer arena.deinit();
    var diagnostics: std.zon.parse.Diagnostics = undefined;
    const cfg = try std.zon.parse.fromSlice(Config, .{
        .gpa = gpa,
        .arena = arena.allocator(),
        .source = source,
        .diagnostics = &diagnostics,
    });
    return .{ .config = cfg, .arena = arena };
}

/// Rewrites relative paths against the config file's own directory, so
/// `-c <path>` names that install from any cwd. Absolute paths are kept.
fn rebase(arena: std.mem.Allocator, cfg: *Config, dir: []const u8) !void {
    if (dir.len == 0) return;
    const fields = [_]*[]const u8{
        &cfg.db_path,
        &cfg.cred_key_path,
        &cfg.data_dir,
        &cfg.web_dir,
        &cfg.tls.cert_path,
        &cfg.tls.key_path,
    };
    for (fields) |f| {
        const v = f.*;
        if (v.len == 0) continue; // "" means "unset", not "the config's directory"
        if (std.fs.path.isAbsolute(v)) continue;
        f.* = try std.fs.path.join(arena, &.{ dir, v });
    }
}

/// Loads config from `path`, or defaults if absent (then relative to cwd).
pub fn loadFileOrDefault(gpa: std.mem.Allocator, io: std.Io, path: []const u8) !Loaded {
    const src = std.Io.Dir.cwd().readFileAllocOptions(
        io,
        path,
        gpa,
        .limited(1 << 20),
        .of(u8),
        0, // null sentinel -> [:0]u8 for the ZON parser
    ) catch |err| switch (err) {
        error.FileNotFound => {
            const arena = std.heap.ArenaAllocator.init(gpa);
            return .{ .config = .{}, .arena = arena };
        },
        else => return err,
    };
    defer gpa.free(src);
    var loaded = try parse(gpa, src);
    errdefer loaded.deinit();
    rebase(loaded.arena.allocator(), &loaded.config, std.fs.path.dirname(path) orelse "") catch |e| {
        return e;
    };
    return loaded;
}

test "relative paths resolve against the CONFIG's directory, not the caller's cwd" {
    // A cwd-relative `db_path` once made a CLI run change a different install.
    var loaded = try parse(std.testing.allocator,
        \\.{
        \\    .db_path = "minicloud.db",
        \\    .cred_key_path = "cred.key",
        \\    .data_dir = "data",
        \\    .web_dir = "../../webapp/dist",
        \\}
    );
    defer loaded.deinit();
    try rebase(loaded.arena.allocator(), &loaded.config, "server/8089");

    try std.testing.expectEqualStrings("server/8089/minicloud.db", loaded.config.db_path);
    try std.testing.expectEqualStrings("server/8089/cred.key", loaded.config.cred_key_path);
    try std.testing.expectEqualStrings("server/8089/data", loaded.config.data_dir);
    try std.testing.expectEqualStrings("server/8089/../../webapp/dist", loaded.config.web_dir);
}

test "rebase leaves absolute paths alone, and leaves an empty field empty" {
    var loaded = try parse(std.testing.allocator,
        \\.{ .db_path = "/srv/inkhold/mini.db", .data_dir = "data" }
    );
    defer loaded.deinit();
    try rebase(loaded.arena.allocator(), &loaded.config, "/etc/inkhold");

    try std.testing.expectEqualStrings("/srv/inkhold/mini.db", loaded.config.db_path);
    try std.testing.expectEqualStrings("/etc/inkhold/data", loaded.config.data_dir);
    // "" means serve nothing; rebasing it would invent a directory.
    try std.testing.expectEqualStrings("", loaded.config.web_dir);
}

test "a config in the CURRENT directory is unchanged, so the common case is untouched" {
    var loaded = try parse(std.testing.allocator,
        \\.{ .db_path = "inkhold.db", .data_dir = "data" }
    );
    defer loaded.deinit();
    try rebase(loaded.arena.allocator(), &loaded.config, std.fs.path.dirname("config.zon") orelse "");

    try std.testing.expectEqualStrings("inkhold.db", loaded.config.db_path);
    try std.testing.expectEqualStrings("data", loaded.config.data_dir);
}

test "parse full config" {
    var loaded = try parse(std.testing.allocator,
        \\.{
        \\    .host = "0.0.0.0",
        \\    .port = 9443,
        \\    .trusted_proxy = "127.0.0.1",
        \\    .tls = .{
        \\        .enabled = true,
        \\        .cert_path = "/etc/sn/cert.pem",
        \\        .key_path = "/etc/sn/key.pem",
        \\        .cipher_suites = .{ "AES_256_GCM_SHA384" },
        \\    },
        \\}
    );
    defer loaded.deinit();
    const c = loaded.config;
    try std.testing.expectEqualStrings("0.0.0.0", c.host);
    try std.testing.expectEqual(@as(u16, 9443), c.port);
    try std.testing.expectEqualStrings("127.0.0.1", c.trusted_proxy);
    try std.testing.expect(c.tls.enabled);
    try std.testing.expectEqualStrings("/etc/sn/cert.pem", c.tls.cert_path);
    try std.testing.expectEqual(@as(usize, 1), c.tls.cipher_suites.len);
    try std.testing.expectEqualStrings("AES_256_GCM_SHA384", c.tls.cipher_suites[0]);
}

test "defaults fill in for a minimal config" {
    var loaded = try parse(std.testing.allocator, ".{ .port = 1234 }");
    defer loaded.deinit();
    try std.testing.expectEqual(@as(u16, 1234), loaded.config.port);
    try std.testing.expectEqualStrings("127.0.0.1", loaded.config.host);
    try std.testing.expect(!loaded.config.tls.enabled);
    try std.testing.expectEqualStrings("", loaded.config.trusted_proxy);
    try std.testing.expectEqualStrings("certs/cert.pem", loaded.config.tls.cert_path);
    try std.testing.expectEqualStrings("inkhold.db", loaded.config.db_path);
    try std.testing.expectEqualStrings("data", loaded.config.data_dir);
    try std.testing.expectEqualStrings("admin@home.lan", loaded.config.admin_email);
    try std.testing.expect(looksLikeEmail(loaded.config.admin_email));
    try std.testing.expectEqual(@as(u32, 5), loaded.config.history.keep);
    try std.testing.expectEqual(@as(u64, 500_000_000), loaded.config.history.max_bytes);
}

test "looksLikeEmail accepts what the sign-in field accepts, and nothing else" {
    try std.testing.expect(!looksLikeEmail("admin"));

    try std.testing.expect(looksLikeEmail("admin@home"));
    try std.testing.expect(looksLikeEmail("admin@home.lan"));
    try std.testing.expect(looksLikeEmail("a@b"));

    try std.testing.expect(!looksLikeEmail(""));
    try std.testing.expect(!looksLikeEmail("@home.lan")); // no local part
    try std.testing.expect(!looksLikeEmail("admin@")); // no domain
    try std.testing.expect(!looksLikeEmail("a@b@c")); // the second `@`
    try std.testing.expect(!looksLikeEmail("admin home@lan")); // whitespace
    try std.testing.expect(!looksLikeEmail("admin@home lan"));
}

test "history bounds parse from a partial config" {
    var loaded = try parse(std.testing.allocator, ".{ .history = .{ .keep = 0, .max_bytes = 1024 } }");
    defer loaded.deinit();
    try std.testing.expectEqual(@as(u32, 0), loaded.config.history.keep); // disables versioning
    try std.testing.expectEqual(@as(u64, 1024), loaded.config.history.max_bytes);
}
